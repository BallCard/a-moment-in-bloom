#!/usr/bin/env python
"""Lux3D 花材资产管线：GLB 测量、贴图压缩、归一化参数、manifest 与缩略图编排。

与 `scripts/bouquet_assets.py` 的分工：那个脚本只做「不改二进制」的测量/登记/同步；
本脚本才是**真正加工** GLB 的一步——把 Lux3D 原始产物（每张 PBR 贴图 1.5–4 MB 的
2048×2048 PNG）压成可上线的文件，同时保持几何 bufferView 字节不动，并算出 app 需要的
归一化参数（scale / gripAt / headOffsetY）与花头实测半径。

子命令（全部幂等、可重复执行、写 JSON 证据）：

    prepare       单个 raw GLB → processed/lux-<family>.glb + measure.json
    prepare-all   按 species-plan 扫描 raw 目录批量 prepare（Lead 后台产出的 GLB 用这个）
    manifest      生成 app/public/assets/manifest.json（53 条）并更新 catalog.json（27 条 species）
    thumbs        用 app/scripts/qa-models.mjs 跑 dev-only QA 页面，为 53 条配色落静态缩略图
    qa            4 视角接触表 + 配色变体对比图，输出 app/.verify/lux3d-all/
    compare       raw vs processed 正视图并排，用于验收贴图压缩的色偏
    report        汇总 processed 的尺寸/面数/压缩比表格

归一化参数语义（与 app/src/three/assets/AssetLoader.ts 一致）：

    scale        = targetHeight / rawHeight          应用到模型根节点的均匀缩放
    gripAt       = rawBBoxMin.y * scale + gripLift    缩放后局部空间里的握点 Y（米）
    headOffsetY  = headCenter.y * scale - gripAt      缩放后握点到花头中心的 Y 距离

几何 bufferView 原字节不动（所以三角面/顶点完全不变、UV 与法线不受影响），只有图片
bufferView 换成重编码后的字节；bufferView 重新按 4 字节对齐排布，accessors/images 的
bufferView 索引统一重映射，保证 glTF 2.0 合法。`verify` 里会重新解析产物做校验。

只处理 Lead 已经下载到 `assets/local/raw/` 的 GLB；本脚本**不会**调用任何 Lux3D 生成接口。

用法示例（PowerShell）：

    python scripts/flower_glb_pipeline.py prepare `
        --raw assets/local/raw/20261107-peony-1.glb --family peony --kind main `
        --target-height 0.45 --grip-lift 0.02

    python scripts/flower_glb_pipeline.py prepare-all --strict
    python scripts/flower_glb_pipeline.py manifest
    python scripts/flower_glb_pipeline.py thumbs --start-server
    python scripts/flower_glb_pipeline.py qa --start-server
    python scripts/flower_glb_pipeline.py report
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import pathlib
import re
import shutil
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore[assignment]

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS_LOCAL = PROJECT_ROOT / "assets" / "local"
RAW_DIR = ASSETS_LOCAL / "raw"
PROCESSED_DIR = ASSETS_LOCAL / "processed"
PLAN_FILE = ASSETS_LOCAL / "species-plan.json"
CATALOG = ASSETS_LOCAL / "catalog.json"
APP_DIR = PROJECT_ROOT / "app"
APP_PUBLIC_ASSETS = APP_DIR / "public" / "assets"
MANIFEST_PATH = APP_PUBLIC_ASSETS / "manifest.json"
THUMBS_DIR = APP_PUBLIC_ASSETS / "thumbs"
VERIFY_DIR = APP_DIR / ".verify" / "lux3d-all"
QA_SCRIPT = APP_DIR / "scripts" / "qa-models.mjs"
BUILTIN_TS = APP_DIR / "src" / "data" / "builtin.ts"

PIPELINE_VERSION = "1.1"
# 预算口径（2026-11-07 Lead 修订）：贴图已压到 ~0.1MB，剩下全是几何；单个 ≤2.6MB，
# 27 件总量目标 ≤50MB，超过 55MB 再回来讨论（不重写几何字节、不做 uint16 索引重写）。
TARGET_MAX_BYTES = round(2.6 * 1024 * 1024)  # 单个 lux-*.glb 目标上限 2.6 MB
SINGLE_TARGET_BYTES = TARGET_MAX_BYTES
SINGLE_HARD_CAP_BYTES = TARGET_MAX_BYTES
TOTAL_TARGET_BYTES = 50 * 1024 * 1024  # 27 件合计目标 ≤ 50 MB
TOTAL_DISCUSS_THRESHOLD_BYTES = 55 * 1024 * 1024  # 超过这个值回来讨论

COMPONENT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
TYPE_COMPONENTS = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
    "MAT2": 4,
    "MAT3": 9,
    "MAT4": 16,
}

# 贴图目标参数：role → (最长边, JPEG 质量)
TEXTURE_TARGETS = {
    "baseColor": (1024, 82),
    "metallicRoughness": (512, 75),
    "normal": (1024, 90),
    "occlusion": (1024, 82),
    "emissive": (1024, 82),
    "other": (1024, 82),
}

# 目标整枝高度（米）。species-plan.json 里给了 targetHeightM 就以它为准，这里只是兜底。
DEFAULT_TARGET_HEIGHT = {"main": 0.45, "filler": 0.42, "greenery": 0.50}

# 换色会明显偏弱的花型：基色是米白/浅灰，花瓣色相重映射几乎没差别。
# Lead 约定（2026-11-07）：整条改用 foliage 窗口 55–200，并在 measure 里如实记录偏弱。
FOLIAGE_RECOLOR_FAMILIES = {"rice-flower"}

# 茎叶绿色带的色相范围（黄绿 → 青绿）。换色窗口是「基色色相 ±60°」，暖黄基色
# 会一路扫进这条带：向日葵 #f0cd5c ≈ 45.7° 得到 [346,106]，把绿叶与花茎也重映射成
# 黄色，整枝变成黄的。端点擦到带边缘（≤20°）时只蹭到少量黄绿叶尖，保留；真正深入
# 绿色带（>20°）才把端点截到 69° / 171°，避免把茎叶一起换色。
FOLIAGE_HUE_BAND = (70.0, 170.0)
FOLIAGE_BAND_TOLERANCE = 20.0

# 穗状花序花型：顶部 20% 带量出来的横向半径天然偏小（穗本身细）。口径保持不变
# （与程序化花型一致），只在证据里注明 app 端是球形包络近似。
SPIKE_FAMILIES = {"veronica", "snapdragon"}

# 真实迭代记录：不删失败的痕迹，report 里如实带上。
PIPELINE_ITERATION_NOTES = [
    "2026-11-07 首次 prepare-all 时 spray 的 raw 匹配用了 startswith('spray-')，"
    "把 20261107-spray-chrysanthemum-1.glb 误当成多头玫瑰的产物（两者三角面/尺寸完全一致才暴露）；"
    "已改为「family 之后必须紧跟数字序号」并重跑，spray 现用自己的 raw（35,536 三角面 / 1.78MB）。",
    "穗状花型（veronica / snapdragon）headRadius 按顶部 20% 高度带横向最大半径实测，数值天然偏小；"
    "Lead 决定不改口径（app 对单网格 GLB 走球形包络近似，与尤加利同一路径），视觉重叠可接受。",
]

# ---------------------------------------------------------------------------
# 内置花型兜底表（与 app/src/data/builtin.ts 对齐；运行时优先读 builtin.ts / species-plan.json）
# ---------------------------------------------------------------------------

FALLBACK_SPECIES: list[dict] = [
    # ---- 主花（7 种，各 2 色） ----
    {"family": "peony", "name": "牡丹", "kind": "main", "colors": [["藕粉", "#e6a9bd"], ["象牙", "#f3e6d8"]]},
    {"family": "herbaceous-peony", "name": "芍药", "kind": "main", "colors": [["浅粉", "#f0b9c8"], ["玫粉", "#d97b96"]]},
    {"family": "carnation", "name": "康乃馨", "kind": "main", "colors": [["珊瑚粉", "#ef9f9a"], ["奶白", "#f6ece0"]]},
    {"family": "lily", "name": "百合", "kind": "main", "colors": [["米白", "#f7f0e2"], ["淡粉", "#eec3cd"]]},
    {"family": "sunflower", "name": "向日葵", "kind": "main", "colors": [["明黄", "#e8b437"], ["柠檬", "#f0cd5c"]]},
    {"family": "dahlia", "name": "大丽花", "kind": "main", "colors": [["酒红", "#b24a5e"], ["蜜桃", "#eda183"]]},
    {"family": "calla", "name": "马蹄莲", "kind": "main", "colors": [["象牙", "#f4efe2"], ["深紫", "#6f5a7a"]]},
    # ---- 配花（9 种，各 2 色） ----
    {"family": "lisianthus", "name": "洋桔梗", "kind": "filler", "colors": [["浅紫", "#cdb9dc"], ["白", "#f4efe9"]]},
    {"family": "alstroemeria", "name": "六出花", "kind": "filler", "colors": [["粉橘", "#eaa07a"], ["淡粉", "#f2c4cf"]]},
    {"family": "spray-chrysanthemum", "name": "多头小菊", "kind": "filler", "colors": [["鹅黄", "#efd27a"], ["白", "#f5f1e6"]]},
    {"family": "babys-breath", "name": "满天星", "kind": "filler", "colors": [["白", "#f7f4ec"], ["淡粉", "#f3d6dd"]]},
    {"family": "statice", "name": "补血草", "kind": "filler", "colors": [["薰衣草紫", "#b9a3cf"], ["象牙", "#ece3d3"]]},
    {"family": "waxflower", "name": "澳洲蜡花", "kind": "filler", "colors": [["淡粉", "#efc9d3"], ["玫红", "#d97f96"]]},
    {"family": "rice-flower", "name": "小米花", "kind": "filler", "colors": [["米白", "#f0ead9"], ["浅绿", "#dfe6d2"]]},
    {"family": "veronica", "name": "婆婆纳", "kind": "filler", "colors": [["蓝紫", "#8fa6d4"], ["白", "#eef0f5"]]},
    {"family": "snapdragon", "name": "金鱼草", "kind": "filler", "colors": [["桃红", "#e88e9e"], ["鹅黄", "#ecc95f"]]},
    # ---- 绿叶（9 种，各 1 色） ----
    {"family": "ruscus", "name": "鲁斯卡斯", "kind": "greenery", "colors": [["深绿", "#4b6b45"]]},
    {"family": "salal", "name": "沙柳叶", "kind": "greenery", "colors": [["中绿", "#5d7d4f"]]},
    {"family": "asparagus-fern", "name": "文竹", "kind": "greenery", "colors": [["浅绿", "#8fae7f"]]},
    {"family": "leatherleaf", "name": "皮革蕨", "kind": "greenery", "colors": [["灰绿", "#6f8a63"]]},
    {"family": "boston-fern", "name": "肾蕨", "kind": "greenery", "colors": [["亮绿", "#5b7f4a"]]},
    {"family": "ivy", "name": "常春藤", "kind": "greenery", "colors": [["深绿", "#46653f"]]},
    {"family": "fatsia", "name": "八角金盘", "kind": "greenery", "colors": [["墨绿", "#3f5c3a"]]},
    {"family": "aspidistra", "name": "蜘蛛抱蛋叶", "kind": "greenery", "colors": [["深绿", "#3d5a38"]]},
    {"family": "bear-grass", "name": "熊草", "kind": "greenery", "colors": [["银绿", "#93a98a"]]},
    # ---- V5 遗留两种（assetId 不是 <family>-<n>，见 builtin.ts extensionEntries） ----
    {"family": "spray", "name": "多头玫瑰", "kind": "filler", "colors": [["莓粉", "#ce7896"]],
     "ids": ["spray-rose-pink"]},
    {"family": "daisy", "name": "非洲菊", "kind": "main", "colors": [["杏黄", "#e7ae4b"], ["奶白", "#f5e7d0"]],
     "ids": ["daisy-gold", "daisy-cream"]},
]


def log(message: str) -> None:
    print(message, flush=True)


def now_local() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def rel(path: pathlib.Path) -> str:
    try:
        return str(path.resolve().relative_to(PROJECT_ROOT)).replace("\\", "/")
    except ValueError:
        return str(path)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# GLB 读写
# ---------------------------------------------------------------------------


def read_glb(path: pathlib.Path):
    data = path.read_bytes()
    if len(data) < 12:
        raise ValueError("GLB 文件头不完整")
    magic, version, total = struct.unpack("<4sII", data[:12])
    if magic != b"glTF" or version != 2:
        raise ValueError(f"{path.name}: 只支持 GLB 2 文件")
    if total != len(data):
        raise ValueError(f"{path.name}: GLB 声明长度 {total} 与实际 {len(data)} 不一致")
    pos, model, binary = 12, None, b""
    while pos + 8 <= len(data):
        length, kind = struct.unpack("<I4s", data[pos:pos + 8])
        pos += 8
        chunk = data[pos:pos + length]
        pos += length
        if kind == b"JSON":
            model = json.loads(chunk.decode("utf-8"))
        elif kind == b"BIN\x00":
            binary = chunk
    if not isinstance(model, dict) or model.get("asset", {}).get("version") != "2.0":
        raise ValueError(f"{path.name}: 缺少 glTF 2.0 JSON 元数据")
    return model, binary


def write_glb(model: dict, binary: bytes) -> bytes:
    json_bytes = json.dumps(model, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    bin_padded = binary + b"\x00" * ((4 - len(binary) % 4) % 4)
    total = 12 + 8 + len(json_bytes)
    if bin_padded:
        total += 8 + len(bin_padded)
    header = struct.pack("<4sII", b"glTF", 2, total)
    json_header = struct.pack("<I4s", len(json_bytes), b"JSON")
    out = [header, json_header, json_bytes]
    if bin_padded:
        out.append(struct.pack("<I4s", len(bin_padded), b"BIN\x00"))
        out.append(bin_padded)
    return b"".join(out)


# ---------------------------------------------------------------------------
# 节点变换与访问器解码
# ---------------------------------------------------------------------------


def node_matrix(node: dict):
    if "matrix" in node:
        m = node["matrix"]  # column-major
        return [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]],
                [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]]
    tx, ty, tz = node.get("translation", [0, 0, 0])
    qx, qy, qz, qw = node.get("rotation", [0, 0, 0, 1])
    sx, sy, sz = node.get("scale", [1, 1, 1])
    xx, yy, zz = qx * qx, qy * qy, qz * qz
    xy, xz, yz = qx * qy, qx * qz, qy * qz
    wx, wy, wz = qw * qx, qw * qy, qw * qz
    r = [
        [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
        [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
        [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
    ]
    return [
        [r[0][0] * sx, r[0][1] * sy, r[0][2] * sz, tx],
        [r[1][0] * sx, r[1][1] * sy, r[1][2] * sz, ty],
        [r[2][0] * sx, r[2][1] * sy, r[2][2] * sz, tz],
        [0, 0, 0, 1],
    ]


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


IDENTITY = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def transform_point(m, p):
    x, y, z = p
    return [
        m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3],
        m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3],
        m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3],
    ]


def decode_accessor(model: dict, binary: bytes, index: int):
    acc = model["accessors"][index]
    if "sparse" in acc:
        raise ValueError(f"accessor {index} 使用 sparse，本工具未实现")
    bv_index = acc.get("bufferView")
    if bv_index is None:
        raise ValueError(f"accessor {index} 没有 bufferView")
    bv = model["bufferViews"][bv_index]
    fmt, size = COMPONENT[acc["componentType"]]
    comps = TYPE_COMPONENTS[acc["type"]]
    stride = bv.get("byteStride") or size * comps
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    count = acc["count"]
    out = []
    for i in range(count):
        off = base + i * stride
        out.append(struct.unpack_from("<" + fmt * comps, binary, off))
    return out


def collect_vertices(model: dict, binary: bytes):
    """返回世界坐标顶点、三角面数、网格使用统计、按材质聚合的 primitive 数。"""
    nodes = model.get("nodes", [])
    scene_index = model.get("scene", 0)
    scenes = model.get("scenes", [])
    roots = scenes[scene_index]["nodes"] if scenes and scene_index < len(scenes) else list(range(len(nodes)))
    vertices = []
    triangles = 0
    mesh_uses = []

    def walk(node_index: int, parent_m):
        nonlocal triangles
        node = nodes[node_index]
        world = mat_mul(parent_m, node_matrix(node))
        if "mesh" in node:
            mesh = model["meshes"][node["mesh"]]
            for primitive in mesh.get("primitives", []):
                pos_index = primitive.get("attributes", {}).get("POSITION")
                if pos_index is None:
                    continue
                pts = decode_accessor(model, binary, pos_index)
                for p in pts:
                    vertices.append(transform_point(world, p))
                if "indices" in primitive:
                    idx = decode_accessor(model, binary, primitive["indices"])
                    triangles += len(idx) // 3
                else:
                    triangles += len(pts) // 3
                mesh_uses.append({
                    "node": node_index,
                    "mesh": node["mesh"],
                    "vertices": len(pts),
                    "material": primitive.get("material"),
                    "mode": primitive.get("mode", 4),
                })
        for child in node.get("children", []):
            walk(child, world)

    for r in roots:
        walk(r, IDENTITY)
    return vertices, triangles, mesh_uses


# ---------------------------------------------------------------------------
# 花头测量
# ---------------------------------------------------------------------------


def head_center_of(vertices, bbox_min, bbox_max, fraction: float = 0.25):
    """顶部 fraction 高度带内顶点质心（与 bouquet_assets.py 同口径）。"""
    height = bbox_max[1] - bbox_min[1]
    band = bbox_max[1] - fraction * height
    head_pts = [v for v in vertices if v[1] >= band]
    if not head_pts:
        return [0.0, bbox_max[1], 0.0], 0
    center = [
        sum(p[0] for p in head_pts) / len(head_pts),
        sum(p[1] for p in head_pts) / len(head_pts),
        sum(p[2] for p in head_pts) / len(head_pts),
    ]
    return center, len(head_pts)


def measure_head_radius(vertices, bbox_min, bbox_max, scale: float, band_fraction: float = 0.2, bins: int = 24):
    """缩放后几何的顶部 20% 高度带做横向半径分箱，取最大半径层。

    与 app/src/three/assets/AssetLoader.ts 的 measureProceduralHead 同口径：
    r = hypot(x, z)（绕模型 Y 轴），24 箱取最大半径层，中心 Y 用被选中箱的中点。
    区别：这里用全量顶点而不是步进采样（离线跑得动），坐标先乘 scale 到米制。
    """
    min_y = bbox_min[1] * scale
    max_y = bbox_max[1] * scale
    span = max_y - min_y
    if span <= 1e-9:
        return None
    lower = max_y - span * band_fraction
    upper_span = max_y - lower
    bin_radius = [0.0] * bins
    bin_count = [0] * bins
    for x, y, z in vertices:
        sy = y * scale
        if sy < lower:
            continue
        t = (sy - lower) / max(1e-6, upper_span)
        index = min(bins - 1, int(t * bins))
        r = math.hypot(x * scale, z * scale)
        if r > bin_radius[index]:
            bin_radius[index] = r
        bin_count[index] += 1
    best = -1
    best_radius = 0.0
    for i in range(bins):
        if bin_count[i] == 0:
            continue
        if bin_radius[i] > best_radius:
            best_radius = bin_radius[i]
            best = i
    if best < 0 or best_radius <= 0:
        return None
    center_y = lower + ((best + 0.5) / bins) * upper_span
    center_y = min(max(center_y, lower), max_y - best_radius * 0.35)
    head_height = min(upper_span, max(0.02, best_radius * 2.4))
    return {
        "band_fraction": band_fraction,
        "bins": bins,
        "bin_index": best,
        "bin_vertex_count": bin_count[best],
        "radius_m": round(best_radius, 5),
        "center_y_m": round(center_y, 5),
        "head_height_m": round(head_height, 5),
        "method": "顶部 20% 高度带、24 箱取最大横向半径层（同 AssetLoader.measureProceduralHead）",
    }


# ---------------------------------------------------------------------------
# 贴图角色与重编码
# ---------------------------------------------------------------------------


def image_roles(model: dict) -> dict:
    """image index → 角色集合（baseColor/metallicRoughness/normal/occlusion/emissive/other）。"""
    roles: dict[int, set[str]] = {}
    textures = model.get("textures", [])

    def note(tex_ref, role: str):
        if not isinstance(tex_ref, dict):
            return
        tex_index = tex_ref.get("index")
        if not isinstance(tex_index, int) or tex_index >= len(textures):
            return
        source = textures[tex_index].get("source")
        if not isinstance(source, int):
            return
        roles.setdefault(source, set()).add(role)

    for material in model.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {}) or {}
        note(pbr.get("baseColorTexture"), "baseColor")
        note(pbr.get("metallicRoughnessTexture"), "metallicRoughness")
        note(material.get("normalTexture"), "normal")
        note(material.get("occlusionTexture"), "occlusion")
        note(material.get("emissiveTexture"), "emissive")
    for index in range(len(model.get("images", []))):
        roles.setdefault(index, set()).add("other")
    return roles


def primary_role(role_set: set[str]) -> str:
    for candidate in ("baseColor", "metallicRoughness", "normal", "occlusion", "emissive"):
        if candidate in role_set:
            return candidate
    return "other"


def image_bytes_of(model: dict, binary: bytes, image: dict) -> bytes:
    if "bufferView" in image:
        bv = model["bufferViews"][image["bufferView"]]
        offset = bv.get("byteOffset", 0)
        return binary[offset:offset + bv["byteLength"]]
    uri = image.get("uri", "")
    if uri.startswith("data:"):
        header, payload = uri.split(",", 1)
        if ";base64" in header:
            return base64.b64decode(payload)
        return urllib.parse.unquote_to_bytes(payload)
    raise ValueError(f"image 使用外部 uri，无法内嵌：{uri[:80]}")


def encode_texture(raw: bytes, role: str) -> dict:
    """按角色把贴图压到目标尺寸；有真实 alpha 时改用 PNG 保留透明度。"""
    max_edge, quality = TEXTURE_TARGETS.get(role, TEXTURE_TARGETS["other"])
    img = Image.open(io.BytesIO(raw))
    img.load()
    source_mime = Image.MIME.get(img.format or "", "application/octet-stream")
    source_size = list(img.size)

    has_alpha = False
    alpha_fraction = 0.0
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        alpha = rgba.getchannel("A")
        histogram = alpha.histogram()
        semi = sum(histogram[:250])
        alpha_fraction = semi / float(img.size[0] * img.size[1])
        has_alpha = alpha_fraction > 0.005
        img = rgba
    else:
        img = img.convert("RGB")

    resized = False
    if max(img.size) > max_edge:
        ratio = max_edge / float(max(img.size))
        new_size = (max(1, round(img.size[0] * ratio)), max(1, round(img.size[1] * ratio)))
        resample = Image.LANCZOS
        img = img.resize(new_size, resample)
        resized = True

    buffer = io.BytesIO()
    if has_alpha:
        img.save(buffer, format="PNG", optimize=True)
        mime = "image/png"
        encoding = "png"
    else:
        img.convert("RGB").save(buffer, format="JPEG", quality=quality, optimize=True, subsampling=2)
        mime = "image/jpeg"
        encoding = f"jpeg-q{quality}"
    payload = buffer.getvalue()

    kept_original = False
    if not resized and len(payload) >= len(raw) and source_mime in ("image/png", "image/jpeg"):
        # 原图已经够小，重编码只会变大：保留原字节，但仍记录决策。
        payload = raw
        mime = source_mime
        encoding = "keep-original"
        kept_original = True

    return {
        "role": role,
        "source_mime": source_mime,
        "source_size": source_size,
        "source_bytes": len(raw),
        "has_alpha": has_alpha,
        "alpha_fraction_below_250": round(alpha_fraction, 6),
        "alpha_kept": has_alpha,
        "encoding": encoding,
        "mime": mime,
        "bytes": len(payload),
        "size": [img.size[0], img.size[1]],
        "resized": resized,
        "kept_original_bytes": kept_original,
        "payload": payload,
    }


# ---------------------------------------------------------------------------
# 重建 GLB
# ---------------------------------------------------------------------------


def _remap_buffer_view_refs(node, remap: dict, image_bvs: set, path: str = "") -> None:
    """递归把任意 {"bufferView": n} 引用重映射；指向图片 bufferView 的非 image 引用直接报错。"""
    if isinstance(node, dict):
        for key, value in list(node.items()):
            if key == "bufferView" and isinstance(value, int):
                if value in image_bvs:
                    raise ValueError(f"{path}: 非 image 对象引用了图片 bufferView {value}，不能安全替换")
                if value not in remap:
                    raise ValueError(f"{path}: 引用了不存在的 bufferView {value}")
                node[key] = remap[value]
            else:
                _remap_buffer_view_refs(value, remap, image_bvs, f"{path}/{key}")
    elif isinstance(node, list):
        for i, item in enumerate(node):
            _remap_buffer_view_refs(item, remap, image_bvs, f"{path}[{i}]")


def rebuild_glb_bytes(model: dict, binary: bytes, encoded_images: list[dict]):
    """图片 bufferView 换新字节，其它 bufferView 原字节保留，重新 4 字节对齐排布。

    返回 (new_model, new_binary, 布局信息)。
    """
    new_model = json.loads(json.dumps(model))
    images = new_model.get("images", [])
    old_images = model.get("images", [])

    image_bv_owner = {}
    for index, old_image in enumerate(old_images):
        if "bufferView" in old_image:
            image_bv_owner[old_image["bufferView"]] = index
    image_bvs = set(image_bv_owner.keys())

    for index, acc in enumerate(new_model.get("accessors", [])):
        bv = acc.get("bufferView")
        if bv in image_bvs:
            raise ValueError(f"accessor {index} 与 image 共用 bufferView {bv}，不能替换字节")

    kept_old = [i for i in range(len(new_model.get("bufferViews", []))) if i not in image_bvs]
    remap = {old: new for new, old in enumerate(kept_old)}

    other = {k: v for k, v in new_model.items() if k not in ("bufferViews", "images")}
    _remap_buffer_view_refs(other, remap, image_bvs, "model")
    new_model.update(other)

    # 组装新 bufferViews（先占位，后面按顺序写 byteOffset）
    new_bvs: list[dict] = []
    payloads: list[bytes] = []
    layout: list[dict] = []

    for old_index in kept_old:
        old_bv = model["bufferViews"][old_index]
        offset = old_bv.get("byteOffset", 0)
        length = old_bv["byteLength"]
        payload = binary[offset:offset + length]
        if len(payload) != length:
            raise ValueError(f"bufferView {old_index} 越界")
        bv = {k: v for k, v in old_bv.items() if k not in ("byteOffset", "byteLength", "buffer")}
        bv["buffer"] = 0
        new_bvs.append(bv)
        payloads.append(payload)
        layout.append({"kind": "geometry" if old_bv.get("target") else "data", "old_index": old_index, "bytes": length})

    new_images = []
    for index, encoded in enumerate(encoded_images):
        new_bvs.append({"buffer": 0})
        payloads.append(encoded["payload"])
        layout.append({"kind": "image", "image_index": index, "role": encoded["role"], "bytes": len(encoded["payload"])})
        image = dict(images[index])
        image.pop("uri", None)
        image["bufferView"] = len(new_bvs) - 1
        image["mimeType"] = encoded["mime"]
        new_images.append(image)
    new_model["images"] = new_images

    cursor = 0
    pieces: list[bytes] = []
    for bv, payload in zip(new_bvs, payloads):
        pad = (4 - cursor % 4) % 4
        if pad:
            pieces.append(b"\x00" * pad)
            cursor += pad
        bv["byteOffset"] = cursor
        bv["byteLength"] = len(payload)
        pieces.append(payload)
        cursor += len(payload)
    tail_pad = (4 - cursor % 4) % 4
    if tail_pad:
        pieces.append(b"\x00" * tail_pad)
        cursor += tail_pad

    new_model["bufferViews"] = new_bvs
    new_model["buffers"] = [{"byteLength": cursor}]
    return new_model, b"".join(pieces), {"layout": layout, "bin_bytes": cursor}


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------


def validate_glb_bytes(data: bytes, expected_triangles: int, expected_vertices: int) -> dict:
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as handle:
        handle.write(data)
        tmp = pathlib.Path(handle.name)
    try:
        model, binary = read_glb(tmp)
        vertices, triangles, _ = collect_vertices(model, binary)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass

    problems = []
    buffers = model.get("buffers", [])
    if len(buffers) != 1:
        problems.append(f"buffers 数量 {len(buffers)} != 1")
    elif buffers[0].get("byteLength") != len(binary):
        problems.append(f"buffers[0].byteLength {buffers[0].get('byteLength')} != BIN {len(binary)}")
    for i, bv in enumerate(model.get("bufferViews", [])):
        offset = bv.get("byteOffset", 0)
        if offset % 4:
            problems.append(f"bufferView {i} byteOffset {offset} 未 4 字节对齐")
        if offset + bv["byteLength"] > len(binary):
            problems.append(f"bufferView {i} 越界")
    for i, acc in enumerate(model.get("accessors", [])):
        bv_index = acc.get("bufferView")
        if bv_index is None:
            continue
        bv = model["bufferViews"][bv_index]
        _, size = COMPONENT[acc["componentType"]]
        comps = TYPE_COMPONENTS[acc["type"]]
        stride = bv.get("byteStride") or size * comps
        need = (acc["count"] - 1) * stride + size * comps + acc.get("byteOffset", 0)
        if need > bv["byteLength"]:
            problems.append(f"accessor {i} 数据超出 bufferView（{need} > {bv['byteLength']}）")
    for i, image in enumerate(model.get("images", [])):
        if "bufferView" not in image:
            problems.append(f"image {i} 没有内嵌 bufferView")
        if not image.get("mimeType"):
            problems.append(f"image {i} 缺少 mimeType")
    return {
        "glb_valid": not problems,
        "problems": problems,
        "triangle_count": triangles,
        "vertex_count": len(vertices),
        "triangle_count_match": triangles == expected_triangles,
        "vertex_count_match": len(vertices) == expected_vertices,
        "json_bytes": len(json.dumps(model, ensure_ascii=False).encode("utf-8")),
        "bin_bytes": len(binary),
    }


# ---------------------------------------------------------------------------
# 配色辅助（HSL）
# ---------------------------------------------------------------------------


def hex_to_rgb(value: str):
    clean = value.strip().lstrip("#")
    if len(clean) == 3:
        clean = "".join(c * 2 for c in clean)
    return tuple(int(clean[i:i + 2], 16) for i in (0, 2, 4))


def rgb_to_hsl(rgb):
    r, g, b = (c / 255.0 for c in rgb)
    max_v, min_v = max(r, g, b), min(r, g, b)
    lightness = (max_v + min_v) / 2
    delta = max_v - min_v
    if delta == 0:
        return 0.0, 0.0, lightness
    saturation = delta / (2 - max_v - min_v) if lightness > 0.5 else delta / (max_v + min_v)
    if max_v == r:
        hue = ((g - b) / delta + (6 if g < b else 0)) * 60
    elif max_v == g:
        hue = ((b - r) / delta + 2) * 60
    else:
        hue = ((r - g) / delta + 4) * 60
    return hue % 360, saturation, lightness


def color_profile(hex_value: str) -> dict:
    """基色色相与「低饱和」判定。

    饱和度阈值用 chroma = (max-min)/max（感知色度）：HSL 的 s 对近白/米色会虚高
    （#f3e6d8 的 HSL s≈0.53），用它判「低饱和」会漏掉所有奶白/米白变体，
    而这些正是换色最弱的。chroma 能正确标出 #f7f4ec≈0.04、#f3e6d8≈0.11。
    """
    rgb = hex_to_rgb(hex_value)
    hue, hsl_s, lightness = rgb_to_hsl(rgb)
    max_v = max(rgb)
    chroma = (max_v - min(rgb)) / max_v if max_v else 0.0
    return {
        "hex": hex_value,
        "hue": round(hue, 1),
        "hsl_saturation": round(hsl_s, 3),
        "chroma": round(chroma, 3),
        "lightness": round(lightness, 3),
        "low_saturation": chroma < 0.12,
    }


def clamp_petal_window(start: float, end: float, base_hue: float) -> tuple[int, int, bool]:
    """把 petals 窗口截断在茎叶绿色带外，返回 (start, end, 是否截断)。

    窗口是「start 起、按色相增大方向跨 span」的环绕区间；基色不在绿色带时，
    若某端点深入 70–170° 超过容差，把该端截到带外（69° / 171°），保留花瓣所在的一段。
    """
    if FOLIAGE_HUE_BAND[0] <= base_hue <= FOLIAGE_HUE_BAND[1]:
        return round(start), round(end), False
    clamped = False
    if FOLIAGE_HUE_BAND[0] <= end <= FOLIAGE_HUE_BAND[1] and end - FOLIAGE_HUE_BAND[0] > FOLIAGE_BAND_TOLERANCE:
        end = FOLIAGE_HUE_BAND[0] - 1.0
        clamped = True
    if FOLIAGE_HUE_BAND[0] <= start <= FOLIAGE_HUE_BAND[1] and FOLIAGE_HUE_BAND[1] - start > FOLIAGE_BAND_TOLERANCE:
        start = FOLIAGE_HUE_BAND[1] + 1.0
        clamped = True
    return round(start), round(end), clamped


def hue_window(hex_value: str, kind: str, family: str = "", half_width: float = 60.0) -> dict:
    # 特例：米白基色的换色本来就偏弱，Lead 约定改用 foliage 窗口并在 measure 里如实记录。
    if family in FOLIAGE_RECOLOR_FAMILIES:
        profile = color_profile(hex_value)
        return {
            "mode": "foliage",
            "hue": [55, 200],
            "half_width": None,
            "note": "换色偏弱：基色接近米白/浅灰，花瓣重映射几乎无差别，按约定整条改用 foliage 窗口 55–200",
            "profile": profile,
        }
    if kind == "greenery":
        return {
            "mode": "foliage",
            "hue": [55, 200],
            "half_width": None,
            "note": "绿叶统一用 foliage 模式，色相窗口固定 55–200（黄绿→蓝绿）",
            "profile": color_profile(hex_value),
        }
    profile = color_profile(hex_value)
    width = half_width
    note = f"花瓣按基色色相 ±{int(width)}° 取窗口"
    if profile["low_saturation"]:
        width = 90.0
        note = "低饱和基色换色偏弱：基色 chroma < 0.12，色相窗口放宽到 ±90°"
    hue = profile["hue"]
    start = round((hue - width) % 360)
    end = round((hue + width) % 360)
    start, end, clamped = clamp_petal_window(start, end, hue)
    if clamped:
        note += "；窗口在绿色带 70–170° 外截断，避免把茎叶一起换色"
    return {
        "mode": "petals",
        "hue": [start, end],
        "half_width": width,
        "note": note,
        "profile": profile,
    }


def read_json_file(path: pathlib.Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _parse_time(value):
    if not isinstance(value, str):
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S%f%z"):
        try:
            return time.mktime(time.strptime(value, fmt))
        except ValueError:
            continue
    return None


def load_batch_row(family: str) -> dict | None:
    """从 assets/local/runs/batch-*/summary.json 的 rows 里找该花型的批次记录。

    generation.json 的 credits_consumed 由 batch 脚本回填；回填前批次 summary 里
    已经有每个任务的 consumedCredits，这里用它补齐（仍是真实值，不是估算）。
    """
    runs_dir = ASSETS_LOCAL / "runs"
    if not runs_dir.exists():
        return None
    for summary_path in sorted(runs_dir.glob("batch-*/summary.json")):
        summary = read_json_file(summary_path)
        if not isinstance(summary, dict):
            continue
        for row in summary.get("rows", []):
            if isinstance(row, dict) and row.get("family") == family:
                return {**row, "summary_file": rel(summary_path), "batch_id": summary.get("batch_id")}
    return None


def load_generation_info(family: str, run_id: str | None = None) -> dict:
    """从 assets/local/runs/<run>/task.json + generation.json 读生成记录。

    拿不到就如实写 null（batch 回填前 credits_consumed 本来就是 null），不编造。
    """
    runs_dir = ASSETS_LOCAL / "runs"
    candidates: list[tuple[pathlib.Path, dict]] = []
    if runs_dir.exists():
        for path in sorted(runs_dir.iterdir()):
            if not path.is_dir():
                continue
            task = read_json_file(path / "task.json") or {}
            name_match = False
            if run_id:
                name_match = path.name == run_id or path.name.endswith(f"-{run_id}") or path.name.endswith(run_id)
            else:
                name_match = path.name == family or path.name.endswith(f"-{family}")
            if name_match or task.get("family") == family:
                candidates.append((path, task))
    if not candidates:
        return {
            "run_dir": None,
            "task_id": None,
            "credits_consumed": None,
            "credits_known": False,
            "duration_seconds": None,
            "requested_at": None,
            "finished_at": None,
            "final_status": None,
            "note": "runs/ 下没有找到该花型的生成记录（batch 回填前属正常）",
        }
    # 优先精确 run_id / 目录名，其次取最新修改的目录
    def rank(item):
        path, task = item
        exact = 1 if (run_id and path.name == run_id) or (not run_id and path.name == family) else 0
        return (exact, path.stat().st_mtime)

    run_dir, task = max(candidates, key=rank)
    generation = read_json_file(run_dir / "generation.json") or {}
    task_result = read_json_file(run_dir / "task_result.json") or {}
    task_id = task.get("taskId") or task.get("task_id")
    if task_id is None:
        response = task_result.get("response") or {}
        data = response.get("d") if isinstance(response, dict) else None
        if isinstance(data, dict):
            task_id = data.get("taskId")
    duration = generation.get("duration_seconds")
    if duration is None:
        duration = task_result.get("elapsed_s")
    if duration is None:
        start, end = _parse_time(generation.get("requested_at")), _parse_time(generation.get("finished_at"))
        if start is not None and end is not None and end >= start:
            duration = round(end - start, 1)
    credits = generation.get("credits_consumed")
    batch_row = load_batch_row(family)
    credits_source = "runs/<run>/generation.json" if isinstance(credits, (int, float)) else None
    if not isinstance(credits, (int, float)) and batch_row is not None:
        if isinstance(batch_row.get("consumedCredits"), (int, float)):
            credits = batch_row["consumedCredits"]
            credits_source = f"{batch_row['summary_file']}（rows[].consumedCredits）"
    if task_id is None and batch_row is not None:
        task_id = batch_row.get("taskId")
    requested_at = generation.get("requested_at") or (batch_row or {}).get("created_at")
    finished_at = generation.get("finished_at") or (batch_row or {}).get("downloaded_at")
    if duration is None:
        start, end = _parse_time(requested_at), _parse_time(finished_at)
        if start is not None and end is not None and end >= start:
            duration = round(end - start, 1)
    downloads = read_json_file(run_dir / "downloads.json") or {}
    return {
        "run_dir": rel(run_dir),
        "task_id": task_id,
        "credits_consumed": credits,
        "credits_known": isinstance(credits, (int, float)),
        "credits_source": credits_source,
        "batch_id": (batch_row or {}).get("batch_id"),
        "duration_seconds": duration,
        "requested_at": requested_at,
        "finished_at": finished_at,
        "final_status": generation.get("final_status"),
        "note": generation.get("note"),
        "downloaded_at": downloads.get("downloaded_at") or (batch_row or {}).get("downloaded_at"),
        "source_files": [rel(run_dir / name) for name in ("task.json", "generation.json", "downloads.json")
                         if (run_dir / name).exists()],
    }


# ---------------------------------------------------------------------------
# prepare
# ---------------------------------------------------------------------------


def measure_and_prepare(raw: pathlib.Path, family: str, kind: str, target_height: float,
                        grip_lift: float, rotation_y: float, out_dir: pathlib.Path,
                        force: bool = False, run_id: str | None = None) -> dict:
    if Image is None:
        raise SystemExit("缺少 Pillow：请先安装 Pillow（或通过 load_workspace_dependencies 的 Python 运行）")

    asset_id = f"lux-{family}"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_glb = out_dir / f"{asset_id}.glb"
    out_measure = out_dir / f"{asset_id}.measure.json"

    raw_bytes = raw.read_bytes()
    raw_sha = sha256_bytes(raw_bytes)

    if not force and out_glb.exists() and out_measure.exists():
        try:
            previous = json.loads(out_measure.read_text(encoding="utf-8"))
            params = previous.get("parameters", {})
            same = (
                previous.get("raw", {}).get("sha256") == raw_sha
                and params.get("family") == family
                and params.get("kind") == kind
                and abs(float(params.get("target_height_m", -1)) - target_height) < 1e-9
                and abs(float(params.get("grip_lift_m", -1)) - grip_lift) < 1e-9
                and abs(float(params.get("rotationY_deg", -1)) - rotation_y) < 1e-9
                and previous.get("processed", {}).get("sha256") == sha256_bytes(out_glb.read_bytes())
            )
            if same:
                # 生成记录可能后到（runs 目录的 batch 回填晚于 GLB），跳过重编码时也刷新它。
                generation = load_generation_info(family, run_id)
                if previous.get("generation") != generation:
                    previous["generation"] = generation
                    out_measure.write_text(json.dumps(previous, ensure_ascii=False, indent=2), encoding="utf-8")
                log(f"[prepare] {asset_id} 已是最新（raw sha 与参数一致），跳过重编码"
                    f"（taskId={generation.get('task_id')}）")
                return previous
        except (json.JSONDecodeError, OSError, ValueError):
            pass

    started = time.time()
    model, binary = read_glb(raw)
    vertices, triangles, mesh_uses = collect_vertices(model, binary)
    if not vertices:
        raise ValueError(f"{raw.name}: 模型没有可解码的顶点")

    xs = [v[0] for v in vertices]
    ys = [v[1] for v in vertices]
    zs = [v[2] for v in vertices]
    bbox_min = [min(xs), min(ys), min(zs)]
    bbox_max = [max(xs), max(ys), max(zs)]
    height = bbox_max[1] - bbox_min[1]
    if height <= 1e-9:
        raise ValueError(f"{raw.name}: 模型 Y 轴高度为 0，可能不是 Y-up")
    scale = target_height / height
    grip_at = bbox_min[1] * scale + grip_lift

    head_center_raw, head_band_count = head_center_of(vertices, bbox_min, bbox_max, 0.25)
    head_offset = head_center_raw[1] * scale - grip_at
    head_radius = measure_head_radius(vertices, bbox_min, bbox_max, scale)
    if head_radius is not None and family in SPIKE_FAMILIES:
        head_radius["note"] = ("穗状花型：顶部 20% 高度带的横向最大半径天然偏小；app 对单网格 GLB 用球形包络近似"
                               "（与尤加利同一路径），口径与程序化花型一致，不特殊处理")

    roles = image_roles(model)
    images = model.get("images", [])
    encoded_images = []
    texture_reports = []
    for index, image in enumerate(images):
        role = primary_role(roles.get(index, {"other"}))
        raw_image = image_bytes_of(model, binary, image)
        encoded = encode_texture(raw_image, role)
        encoded_images.append(encoded)
        texture_reports.append({
            "image_index": index,
            "role": role,
            "source_mime": encoded["source_mime"],
            "source_size": encoded["source_size"],
            "source_bytes": encoded["source_bytes"],
            "output_mime": encoded["mime"],
            "output_size": encoded["size"],
            "output_bytes": encoded["bytes"],
            "encoding": encoded["encoding"],
            "resized": encoded["resized"],
            "alpha_present": encoded["has_alpha"],
            "alpha_kept": encoded["alpha_kept"],
            "alpha_fraction_below_250": encoded["alpha_fraction_below_250"],
            "kept_original_bytes": encoded["kept_original_bytes"],
        })

    materials = []
    for material in model.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {}) or {}
        materials.append({
            "name": material.get("name"),
            "baseColorTexture": "baseColorTexture" in pbr,
            "metallicRoughnessTexture": "metallicRoughnessTexture" in pbr,
            "normalTexture": "normalTexture" in material,
            "metallicFactor": pbr.get("metallicFactor", 1),
            "roughnessFactor": pbr.get("roughnessFactor", 1),
            "doubleSided": material.get("doubleSided", False),
            "alphaMode": material.get("alphaMode", "OPAQUE"),
        })

    new_model, new_binary, rebuild_info = rebuild_glb_bytes(model, binary, encoded_images)
    pipeline_extras = {
        "pipeline": "flower_glb_pipeline.py",
        "version": PIPELINE_VERSION,
        "prepared_at": now_local(),
        "source_sha256": raw_sha,
        "family": family,
        "kind": kind,
        "target_height_m": target_height,
        "scale": round(scale, 6),
        "note": "几何 bufferView 字节未改动；仅图片重编码 + bufferView 重排（4 字节对齐）",
    }
    new_model.setdefault("extras", {})
    if isinstance(new_model["extras"], dict):
        new_model["extras"]["lux_pipeline"] = pipeline_extras

    glb_bytes = write_glb(new_model, new_binary)
    out_glb.write_bytes(glb_bytes)
    processed_sha = sha256_bytes(glb_bytes)

    validation = validate_glb_bytes(glb_bytes, triangles, len(vertices))
    validation["json_parse_ok"] = True
    validation["glb_total_bytes"] = len(glb_bytes)

    report = {
        "asset_id": asset_id,
        "family": family,
        "kind": kind,
        "prepared_at": now_local(),
        "pipeline_version": PIPELINE_VERSION,
        "parameters": {
            "family": family,
            "kind": kind,
            "target_height_m": target_height,
            "grip_lift_m": grip_lift,
            "rotationY_deg": rotation_y,
        },
        "raw_file": rel(raw),
        "processed_file": rel(out_glb),
        "generation": load_generation_info(family, run_id),
        "raw": {
            "bytes": len(raw_bytes),
            "sha256": raw_sha,
            "triangle_count": triangles,
            "vertex_count": len(vertices),
            "bbox_min": [round(v, 6) for v in bbox_min],
            "bbox_max": [round(v, 6) for v in bbox_max],
            "size": [round(bbox_max[i] - bbox_min[i], 6) for i in range(3)],
            "height_m": round(height, 6),
            "node_count": len(model.get("nodes", [])),
            "mesh_count": len(model.get("meshes", [])),
            "material_count": len(materials),
            "image_count": len(images),
            "image_mime": sorted({im.get("mimeType") for im in images if im.get("mimeType")}),
            "materials": materials,
            "mesh_uses": mesh_uses,
            "extensions_required": model.get("extensionsRequired", []),
            "bin_bytes": len(binary),
        },
        "processed": {
            "bytes": len(glb_bytes),
            "sha256": processed_sha,
            "triangle_count": validation["triangle_count"],
            "vertex_count": validation["vertex_count"],
            "bin_bytes": validation["bin_bytes"],
            "json_bytes": validation["json_bytes"],
        },
        "compression": {
            "raw_bytes": len(raw_bytes),
            "processed_bytes": len(glb_bytes),
            "saved_bytes": len(raw_bytes) - len(glb_bytes),
            "ratio": round(len(glb_bytes) / len(raw_bytes), 4),
            "target_max_bytes": TARGET_MAX_BYTES,
            "within_target": len(glb_bytes) <= TARGET_MAX_BYTES,
        },
        "normalization": {
            "target_height_m": target_height,
            "grip_lift_m": grip_lift,
            "rotationY_deg": rotation_y,
            "scale": round(scale, 6),
            "gripAt": round(grip_at, 6),
            "headOffsetY": round(head_offset, 6),
            "derivation": "scale = targetHeight / rawHeight; gripAt = rawBBoxMin.y*scale + gripLift; "
                          "headOffsetY = headCenter.y*scale - gripAt",
        },
        "head": {
            "band_fraction": 0.25,
            "band_vertex_count": head_band_count,
            "center_raw": [round(v, 6) for v in head_center_raw],
            "center_scaled": [round(head_center_raw[i] * scale, 6) for i in range(3)],
            "headCenterY_m": round(head_center_raw[1] * scale, 6),
            "headOffsetY_m": round(head_offset, 6),
        },
        "head_radius": head_radius,
        "head_radius_manifest": round(min(0.2, max(0.03, head_radius["radius_m"])) if head_radius else 0.09, 5),
        "textures": texture_reports,
        "rebuild": {
            "buffer_view_count": len(new_model["bufferViews"]),
            "bin_bytes": rebuild_info["bin_bytes"],
            "layout": rebuild_info["layout"],
            "alignment": "4-byte",
        },
        "validation": validation,
        "elapsed_seconds": round(time.time() - started, 2),
    }
    out_measure.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    log(f"[prepare] {asset_id}: {len(raw_bytes)/1e6:.2f} MB → {len(glb_bytes)/1e6:.2f} MB "
        f"({report['compression']['ratio']*100:.1f}%)，三角面 {triangles}，"
        f"scale={scale:.4f} gripAt={grip_at:.4f} headOffsetY={head_offset:.4f}，"
        f"headRadius={report['head_radius_manifest']}")
    if not validation["triangle_count_match"]:
        raise ValueError(f"{asset_id}: 产物三角面 {validation['triangle_count']} != 原始 {triangles}")
    if not validation["glb_valid"]:
        raise ValueError(f"{asset_id}: 产物校验失败 {validation['problems']}")
    return report


def cmd_prepare(args) -> int:
    report = measure_and_prepare(
        raw=pathlib.Path(args.raw),
        family=args.family,
        kind=args.kind,
        target_height=args.target_height,
        grip_lift=args.grip_lift,
        rotation_y=args.rotation_y,
        out_dir=pathlib.Path(args.out_dir),
        force=args.force,
        run_id=args.run_id,
    )
    if args.json:
        print(json.dumps({k: report[k] for k in ("asset_id", "compression", "normalization", "head_radius", "generation")},
                         ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------------------
# species-plan 读取
# ---------------------------------------------------------------------------


def parse_builtin_ts() -> list[dict]:
    """从 app/src/data/builtin.ts 读回花型与配色，作为「与 app 完全一致」的真源。"""
    if not BUILTIN_TS.exists():
        return []
    text = BUILTIN_TS.read_text(encoding="utf-8")
    species = []
    block = re.search(
        r"export const V07_SPECIES[^=]*=\s*\[(.*?)\n\](?:\s*as const[^;]*)?;",
        text,
        re.S,
    )
    if block:
        pattern = re.compile(
            r"\{\s*family:\s*'([^']+)',\s*key:\s*'([^']+)',\s*name:\s*'([^']+)',\s*kind:\s*'([^']+)',"
            r".*?colors:\s*\[(.*?)\]\s*\}",
            re.S,
        )
        for match in pattern.finditer(block.group(1)):
            family, _key, name, kind, colors_raw = match.groups()
            colors = re.findall(r"\['([^']*)',\s*'(#[0-9a-fA-F]{3,8})'\]", colors_raw)
            if colors:
                species.append({"family": family, "name": name, "kind": kind,
                                "colors": [[c, v] for c, v in colors]})
    ext = re.search(r"export function extensionEntries\(\)[^{]*\{(.*?)\n\}", text, re.S)
    if ext:
        for match in re.finditer(
            r"entry\('([^']+)','([^']+)','([^']+)','([^']+)','(#[0-9a-fA-F]{3,8})','([^']+)','([^']+)'\)",
            ext.group(1),
        ):
            asset_id, family, display_name, variant, color, procedural, kind = match.groups()
            family_name, _, variant_name = display_name.partition(" · ")
            target = next((s for s in species if s["family"] == family), None)
            if target is None:
                target = {"family": family, "name": family_name, "kind": kind, "colors": [], "ids": []}
                species.append(target)
            target.setdefault("ids", []).append(asset_id)
            # 扩展条目的 colors 也要补进去，否则 species_variant_entries 展不开这些 id
            target.setdefault("colors", []).append([variant_name or variant, color])
            # 记录显式 id 与展示名，manifest 生成时优先用它们
            target.setdefault("explicit", []).append({
                "assetId": asset_id, "displayName": display_name,
                "variantName": variant_name or variant, "color": color,
            })
    return species


def _normalize_plan_assets(item: dict) -> list[dict]:
    """species-plan.json 的 `assets` 数组 → [{assetId, displayName, variantName, color}]。

    兼容三种写法：{"id","displayName","color"}、{"assetId","name","hex"}、[名字, "#hex"]。
    """
    assets_raw = item.get("assets")
    assets: list[dict] = []
    if not isinstance(assets_raw, list):
        return assets
    for index, asset in enumerate(assets_raw):
        if isinstance(asset, dict):
            asset_id = asset.get("id") or asset.get("assetId") or asset.get("asset_id")
            display = asset.get("displayName") or asset.get("display_name") or asset.get("name")
            color = asset.get("color") or asset.get("hex")
            if not asset_id or not color:
                continue
            variant = asset.get("variantName") or asset.get("variant_name")
            if not variant:
                _, _, variant = (display or "").partition(" · ")
            assets.append({
                "assetId": str(asset_id),
                "displayName": str(display or asset_id),
                "variantName": str(variant or f"配色 {index + 1}"),
                "color": str(color),
            })
        elif isinstance(asset, (list, tuple)) and len(asset) >= 2:
            assets.append({
                "assetId": f"{item.get('family', 'family')}-{index + 1}",
                "displayName": f"{item.get('name', item.get('family', ''))} · {asset[0]}",
                "variantName": str(asset[0]),
                "color": str(asset[1]),
            })
    return assets


def load_plan() -> tuple[list[dict], str]:
    """返回 (species 列表, 来源说明)。优先 species-plan.json，缺失时回退 builtin.ts。"""
    if PLAN_FILE.exists():
        raw = json.loads(PLAN_FILE.read_text(encoding="utf-8"))
        items = raw
        if isinstance(raw, dict):
            for key in ("species", "families", "items", "entries", "flowers"):
                if isinstance(raw.get(key), list):
                    items = raw[key]
                    break
        if isinstance(items, list) and items:
            species = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                family = item.get("family") or item.get("key") or item.get("id")
                if not family:
                    continue
                assets = _normalize_plan_assets(item)
                colors = assets and [[a["variantName"], a["color"]] for a in assets] or []
                if not colors:
                    colors_raw = item.get("colors") or item.get("variants") or item.get("palette") or []
                    for color_item in colors_raw:
                        if isinstance(color_item, dict):
                            colors.append([
                                color_item.get("variantName") or color_item.get("name") or "标准色",
                                color_item.get("color") or color_item.get("hex") or "#cccccc",
                            ])
                        elif isinstance(color_item, (list, tuple)) and len(color_item) >= 2:
                            colors.append([str(color_item[0]), str(color_item[1])])
                entry = {
                    "family": family,
                    "name": item.get("name") or item.get("displayName") or family,
                    "kind": item.get("kind") or "main",
                    "assets": assets,
                    "colors": colors,
                    "targetHeightM": item.get("targetHeightM") or item.get("target_height_m"),
                    "baseVariantIndex": item.get("baseVariantIndex", item.get("base_variant_index", 0)),
                    "recolor": item.get("recolor"),
                    "runId": item.get("runId") or item.get("run_id"),
                    "faceCount": item.get("faceCount") or item.get("face_count"),
                    "prompt": item.get("prompt") or item.get("promptZh") or item.get("prompt_zh"),
                    "promptFile": item.get("promptFile") or item.get("prompt_file"),
                    "rawFile": item.get("rawFile") or item.get("raw_file") or item.get("glb"),
                    "assetIds": [a["assetId"] for a in assets] or item.get("assetIds") or item.get("asset_ids"),
                    "taskId": item.get("taskId") or item.get("task_id"),
                }
                if entry["colors"]:
                    species.append(entry)
            if species:
                return species, f"assets/local/species-plan.json（{len(species)} 种）"
    builtin = parse_builtin_ts()
    if builtin:
        return builtin, f"app/src/data/builtin.ts 解析（{len(builtin)} 种；species-plan.json 缺失）"
    return list(FALLBACK_SPECIES), f"脚本内置兜底表（{len(FALLBACK_SPECIES)} 种）"


def species_variant_entries(species: list[dict]) -> list[dict]:
    """把 species 展开成 44 条配色条目（assetId/displayName/color/kind/family）。"""
    entries = []
    for item in species:
        if item.get("assets"):
            rows = item["assets"]
        else:
            explicit = {entry["assetId"]: entry for entry in item.get("explicit", [])}
            ids = item.get("ids") or item.get("assetIds")
            rows = []
            for index, (variant_name, color) in enumerate(item["colors"]):
                asset_id = ids[index] if ids and index < len(ids) else None
                if not asset_id:
                    known = [entry for entry in explicit.values() if entry["color"].lower() == color.lower()]
                    if known:
                        asset_id = known[0]["assetId"]
                if not asset_id:
                    asset_id = f"{item['family']}-{index + 1}"
                display_name = (explicit.get(asset_id, {}).get("displayName")
                                or f"{item['name']} · {variant_name}")
                rows.append({"assetId": asset_id, "displayName": display_name,
                             "variantName": variant_name, "color": color})
        for index, row in enumerate(rows):
            entries.append({
                "assetId": row["assetId"],
                "family": item["family"],
                "familyName": item["name"],
                "kind": item["kind"],
                "variantName": row["variantName"],
                "displayName": row["displayName"],
                "color": row["color"],
                "index": index,
                "species": item,
            })
    return entries


def verify_plan_against_builtin(species: list[dict]) -> list[dict]:
    """把 species-plan 的 id/配色与 app/src/data/builtin.ts 逐条对照，返回差异列表。"""
    builtin = parse_builtin_ts()
    if not builtin:
        return [{"note": "builtin.ts 解析失败，跳过对照"}]
    builtin_ids = {row["assetId"]: row for row in species_variant_entries(builtin)}
    plan_ids = {row["assetId"]: row for row in species_variant_entries(species)}
    differences = []
    for asset_id in sorted(set(builtin_ids) - set(plan_ids)):
        differences.append({"assetId": asset_id, "issue": "builtin.ts 有、species-plan 缺失"})
    for asset_id in sorted(set(plan_ids) - set(builtin_ids)):
        differences.append({"assetId": asset_id, "issue": "species-plan 多出（builtin.ts 没有）"})
    for asset_id in sorted(set(plan_ids) & set(builtin_ids)):
        plan_row, builtin_row = plan_ids[asset_id], builtin_ids[asset_id]
        if plan_row["color"].lower() != builtin_row["color"].lower():
            differences.append({"assetId": asset_id, "issue": "颜色不一致",
                                "plan": plan_row["color"], "builtin": builtin_row["color"]})
        if plan_row["displayName"] != builtin_row["displayName"]:
            differences.append({"assetId": asset_id, "issue": "displayName 不一致",
                                "plan": plan_row["displayName"], "builtin": builtin_row["displayName"]})
    return differences


def find_raw_for_family(family: str, families: list[str], raw_dir: pathlib.Path = RAW_DIR) -> tuple[pathlib.Path | None, list[str]]:
    """按 `20261107-<family>-<序号>.glb` 精确匹配 raw 文件。

    注意不能只用 `startswith(f"{family}-")`：`20261107-spray-chrysanthemum-1.glb`
    也满足 `spray-`，会把小菊的文件当成多头玫瑰（实测踩过）。要求 family 之后
    紧跟数字序号，才算这个花型的产物。
    """
    if not raw_dir.exists():
        return None, []
    candidates = []
    for path in sorted(raw_dir.glob("*.glb")):
        stem = re.sub(r"^\d{8}-", "", path.stem)
        if not stem.startswith(f"{family}-"):
            continue
        remainder = stem[len(family) + 1:]
        if not remainder[:1].isdigit():
            continue
        candidates.append(path)
    if not candidates:
        return None, []
    candidates.sort(key=lambda p: (p.stat().st_mtime, p.name))
    return candidates[-1], [rel(p) for p in candidates]


def cmd_prepare_all(args) -> int:
    species, plan_source = load_plan()
    log(f"[prepare-all] plan 来源：{plan_source}，共 {len(species)} 种")
    out_dir = pathlib.Path(args.out_dir)
    ok, failed, missing = [], [], []
    for item in species:
        family = item["family"]
        kind = item["kind"]
        run_id = item.get("runId")
        target_height = item.get("targetHeightM") or DEFAULT_TARGET_HEIGHT.get(kind, 0.45)
        raw_path = None
        if item.get("rawFile"):
            candidate = PROJECT_ROOT / item["rawFile"]
            if candidate.exists():
                raw_path = candidate
        if raw_path is None:
            raw_path, all_candidates = find_raw_for_family(family, [s["family"] for s in species])
            if raw_path is not None and len(all_candidates) > 1:
                log(f"[prepare-all] {family}: 找到 {len(all_candidates)} 个候选，取最新 {raw_path.name}")
        if raw_path is None:
            # 缺 raw 时区分「任务还没建」和「任务建了但 GLB 还没下载到」，方便 Lead 判断 27/27 进度
            generation = load_generation_info(family, run_id)
            if generation.get("task_id") is not None:
                status = "task-created-raw-missing"
                detail = f"任务已创建（taskId={generation['task_id']}，run_dir={generation.get('run_dir')}）但 raw GLB 还没下载到"
            else:
                status = "task-not-created"
                detail = "runs/ 下没有该花型的任务记录（未生成或未到）"
            missing.append({
                "family": family,
                "kind": kind,
                "runId": run_id,
                "status": status,
                "taskId": generation.get("task_id"),
                "run_dir": generation.get("run_dir"),
                "detail": detail,
            })
            log(f"[prepare-all] 缺 raw {family}：{detail}")
            continue
        try:
            report = measure_and_prepare(raw_path, family, kind, float(target_height),
                                         args.grip_lift, args.rotation_y, out_dir,
                                         force=args.force, run_id=run_id)
            ok.append({"family": family, "raw": rel(raw_path), "glb": report["processed_file"],
                       "bytes": report["processed"]["bytes"], "ratio": report["compression"]["ratio"],
                       "raw_bytes": report["raw"]["bytes"], "triangles": report["raw"]["triangle_count"],
                       "target_height_m": report["normalization"]["target_height_m"],
                       "taskId": report.get("generation", {}).get("task_id"),
                       "credits_consumed": report.get("generation", {}).get("credits_consumed")})
        except Exception as error:  # noqa: BLE001 - 逐个家族失败要记录，不能整批中断
            failed.append({"family": family, "raw": rel(raw_path), "error": str(error)})
            log(f"[prepare-all] {family} 失败：{error}")
    summary = {
        "at": now_local(),
        "plan_source": plan_source,
        "planned": len(species),
        "prepared": len(ok),
        "complete": len(ok) == len(species),
        "missing_count": len(missing),
        "missing_task_created": sum(1 for item in missing if item["status"] == "task-created-raw-missing"),
        "missing_task_not_created": sum(1 for item in missing if item["status"] == "task-not-created"),
        "missing": missing,
        "failed": failed,
        "ok": ok,
        "totals": {
            "raw_bytes": sum(item["raw_bytes"] for item in ok),
            "processed_bytes": sum(item["bytes"] for item in ok),
            "triangle_count": sum(item["triangles"] for item in ok),
        },
        "out_dir": rel(out_dir),
    }
    summary_path = out_dir / "prepare-all.summary.json"
    out_dir.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"[prepare-all] 进度 {len(ok)}/{len(species)} 已压缩"
        f"（缺 raw {len(missing)}：已建任务 {summary['missing_task_created']} / 未建任务 {summary['missing_task_not_created']}），"
        f"失败 {len(failed)}；汇总 {rel(summary_path)}")
    if missing:
        log("[prepare-all] 缺 raw 明细："
            + "、".join(f"{item['family']}({item['status']})" for item in missing))
    if args.strict and (missing or failed):
        log("[prepare-all] --strict：还没到齐，返回非 0")
        return 1
    return 0


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------


def load_catalog() -> dict:
    if CATALOG.exists():
        return json.loads(CATALOG.read_text(encoding="utf-8"))
    return {"schema_version": 1, "updated_at": None, "assets": []}


def read_measure_files(processed_dir: pathlib.Path) -> dict:
    measures = {}
    for path in sorted(processed_dir.glob("lux-*.measure.json")):
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            log(f"[manifest] 跳过损坏的 measure：{path.name}")
            continue
        measures[report["family"]] = report
    return measures


def existing_manifest_entries() -> list[dict]:
    if not MANIFEST_PATH.exists():
        return []
    try:
        data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return [e for e in data.get("assets", []) if isinstance(e, dict) and e.get("glb")]


def build_manifest_entries(species: list[dict], measures: dict, old_entries: list[dict]) -> tuple[list[dict], list[dict], dict]:
    """返回 (manifest 条目, catalog 新增条目, per-family recolor 记录)。"""
    variant_rows = species_variant_entries(species)
    by_family: dict[str, list[dict]] = {}
    for row in variant_rows:
        by_family.setdefault(row["family"], []).append(row)

    family_order = [item["family"] for item in species]
    kind_order = {"main": 0, "filler": 1, "greenery": 2}
    # 花材架按 kind 分组更自然：主花 → 配花 → 绿叶，组内按 species-plan 顺序
    ordered_families = sorted(family_order, key=lambda f: (kind_order.get(next(
        (s["kind"] for s in species if s["family"] == f), "main"), 9), family_order.index(f)))

    keep_old = []
    old_by_family = {}
    for entry in old_entries:
        family = (entry.get("fallback") or {}).get("procedural") or ""
        old_by_family.setdefault(family, []).append(entry)

    new_entries: list[dict] = []
    catalog_entries: list[dict] = []
    recolor_log = {}
    missing = []

    for family in ordered_families:
        item = next(s for s in species if s["family"] == family)
        measure = measures.get(family)
        rows = by_family.get(family, [])
        if not rows:
            continue
        if measure is None:
            missing.append(family)
            continue
        norm = measure["normalization"]
        head_radius = measure["head_radius_manifest"]
        base_index = int(item.get("baseVariantIndex") or 0)
        species_mode = item.get("recolor")
        base_row = rows[base_index] if 0 <= base_index < len(rows) else rows[0]
        window = hue_window(base_row["color"], item["kind"], family=family)
        mode = species_mode if species_mode in ("petals", "foliage") else window["mode"]
        recolor_log[family] = {
            "mode": mode,
            "baseAssetId": base_row["assetId"],
            "baseColor": base_row["color"],
            "hue": window["hue"],
            "half_width": window["half_width"],
            "note": window["note"],
            "profile": window["profile"],
        }

        for row in rows:
            is_base = row["assetId"] == base_row["assetId"]
            entry = {
                "id": row["assetId"],
                "kind": row["kind"],
                "displayName": row["displayName"],
                "glb": f"lux-{family}.glb",
                "thumb": f"thumbs/{row['assetId']}.png",
                "transform": {
                    "scale": norm["scale"],
                    "rotationY": norm["rotationY_deg"],
                    "gripAt": norm["gripAt"],
                    "headOffsetY": norm["headOffsetY"],
                },
                "fallback": {"procedural": family, "color": row["color"]},
                "size": {
                    "uniformScale": 1,
                    "headWidth": 1,
                    "headHeight": 1,
                    "leafSpread": 1,
                    "headRadius": head_radius,
                },
            }
            if not is_base:
                entry["recolor"] = {"mode": mode, "hue": window["hue"]}
            new_entries.append(entry)

        catalog_entries.append({
            "id": f"lux-{family}",
            "kind": item["kind"],
            "displayName": item["name"],
            "fallback": {"procedural": family, "color": base_row["color"]},
            "transform": {
                "scale": norm["scale"],
                "rotationY": norm["rotationY_deg"],
                "gripAt": norm["gripAt"],
                "headOffsetY": norm["headOffsetY"],
            },
            "files": {
                "raw": measure["raw_file"],
                "processed": measure["processed_file"],
                "bytes": measure["raw"]["bytes"],
                "sha256": measure["raw"]["sha256"],
                "processed_bytes": measure["processed"]["bytes"],
                "processed_sha256": measure["processed"]["sha256"],
            },
            "measurement": {
                "raw_size_m": measure["raw"]["size"],
                "raw_height_m": measure["raw"]["height_m"],
                "raw_bbox_min": measure["raw"]["bbox_min"],
                "raw_bbox_max": measure["raw"]["bbox_max"],
                "triangle_count": measure["raw"]["triangle_count"],
                "vertex_count": measure["raw"]["vertex_count"],
                "material_count": measure["raw"]["material_count"],
                "image_count": measure["raw"]["image_count"],
                "extensions_required": measure["raw"].get("extensions_required", []),
                "target_height_m": measure["parameters"]["target_height_m"],
                "head_radius_m": measure.get("head_radius_manifest"),
                "head_center_y_m": measure["head"]["headCenterY_m"],
                "measure_report": measure["processed_file"].replace(".glb", ".measure.json"),
                "compression": measure["compression"],
            },
            "variants": [
                {
                    "assetId": row["assetId"],
                    "displayName": row["displayName"],
                    "color": row["color"],
                    "isBase": row["assetId"] == base_row["assetId"],
                    "recolor": None if row["assetId"] == base_row["assetId"]
                    else {"mode": mode, "hue": window["hue"]},
                }
                for row in rows
            ],
            "source": {
                "tool": "Aholo Lux3D",
                "endpoint": "https://api.aholo3d.cn/lux3d/v1/generate/text-to-3d/task/create",
                "api_version": "G1",
                "style": "photorealistic",
                "face_count_requested": item.get("faceCount"),
                "output_format": ["glb"],
                "prompt": item.get("prompt"),
                "prompt_file": item.get("promptFile") or f"assets/local/prompts/{family}.txt",
                "run_dir": item.get("runId") or None,
                "task_id": item.get("taskId"),
                "pipeline": f"scripts/flower_glb_pipeline.py prepare（{PIPELINE_VERSION}）",
            },
            "generation": build_generation_block(item),
        })

    # 旧 9 条原样保留（内容不改，只补 thumb 字段；glb 仍指向原文件）
    used_families = set(by_family.keys())
    ordered_old = []
    for family in [f for f in ("rose", "tulip", "eucalyptus") if f in old_by_family]:
        ordered_old.extend(old_by_family[family])
    for entry in ordered_old:
        copied = json.loads(json.dumps(entry))
        copied.setdefault("thumb", f"thumbs/{copied['id']}.png")
        keep_old.append(copied)

    all_entries = keep_old + new_entries
    return all_entries, catalog_entries, {
        "recolor": recolor_log,
        "missing_measures": missing,
        "species_plan": species,
        "variant_count": len(variant_rows),
        "kept_old": len(keep_old),
    }


def build_generation_block(item: dict) -> dict:
    """从 runs/<runId>/ 读真实耗时/积分；缺就写 null 并在 note 里说明，不编造。"""
    info = load_generation_info(item["family"], item.get("runId"))
    block = {
        "task_id": info.get("task_id"),
        "requested_at": info.get("requested_at"),
        "finished_at": info.get("finished_at"),
        "final_status": info.get("final_status"),
        "duration_seconds": info.get("duration_seconds"),
        "credits_consumed": info.get("credits_consumed"),
        "credits_known": info.get("credits_known"),
        "run_dir": info.get("run_dir"),
        "note": info.get("note") or "原始 GLB 由 Lead 批量生成；本管线只做压缩/测量/登记，不创建生成任务",
    }
    if block["credits_consumed"] is None:
        block["credits_note"] = "batch 尚未用 task/list 回填积分；如实写 null，不估算"
    return block


def cmd_stage(args) -> int:
    """只把 processed/lux-*.glb 复制到 public/assets 并写一份**临时** manifest（QA 用）。

    正式 app/public/assets/manifest.json 由 `manifest` 子命令在全部产物到齐后一次性重写；
    QA 阶段先落到 public 让 dev server 能取到 lux-*.glb，临时清单写到 processed 目录下，
    不覆盖工作台正在用的清单。
    """
    species, plan_source = load_plan()
    processed_dir = pathlib.Path(args.processed_dir)
    measures = read_measure_files(processed_dir)
    if not measures:
        raise SystemExit(f"[stage] {rel(processed_dir)} 下没有 lux-*.measure.json，先跑 prepare-all")
    old_entries = existing_manifest_entries()
    entries, catalog_entries, meta = build_manifest_entries(species, measures, old_entries)

    APP_PUBLIC_ASSETS.mkdir(parents=True, exist_ok=True)
    copied = []
    for family in sorted(measures):
        source = processed_dir / f"lux-{family}.glb"
        if not source.exists():
            continue
        target = APP_PUBLIC_ASSETS / f"lux-{family}.glb"
        shutil.copyfile(source, target)
        copied.append({"family": family, "bytes": target.stat().st_size})
    temp_manifest = pathlib.Path(args.out)
    temp_manifest.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "assetsVersion": args.version or f"2026-11-07.stage-{time.strftime('%H%M%S')}",
        "generated_at": now_local(),
        "generator": f"scripts/flower_glb_pipeline.py stage（{PIPELINE_VERSION}，临时 QA 清单）",
        "assets": entries,
    }
    temp_manifest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    log(json.dumps({
        "staged_glb": len(copied),
        "manifest_entries": len(entries),
        "new_entries": len(entries) - meta["kept_old"],
        "missing_measures": len(meta["missing_measures"]),
        "temp_manifest": rel(temp_manifest),
        "note": "未改动 app/public/assets/manifest.json 与 catalog.json",
    }, ensure_ascii=False, indent=2))
    return 0


def cmd_manifest(args) -> int:
    species, plan_source = load_plan()
    log(f"[manifest] plan 来源：{plan_source}")

    processed_dir = pathlib.Path(args.processed_dir)
    measures = read_measure_files(processed_dir)
    if not measures:
        log(f"[manifest] 警告：{rel(processed_dir)} 下没有 lux-*.measure.json，先跑 prepare/prepare-all")

    old_entries = existing_manifest_entries()
    entries, catalog_entries, meta = build_manifest_entries(species, measures, old_entries)
    if not entries:
        raise SystemExit("[manifest] 没有可写的条目：既没有旧 9 条也没有新 measure")

    # 1) 复制 processed/lux-*.glb → app/public/assets/lux-*.glb
    APP_PUBLIC_ASSETS.mkdir(parents=True, exist_ok=True)
    wanted = {f"lux-{family}.glb" for family in measures}
    copied = []
    for family in sorted(measures):
        source = processed_dir / f"lux-{family}.glb"
        if not source.exists():
            log(f"[manifest] 警告：{rel(source)} 不存在，跳过复制")
            continue
        target = APP_PUBLIC_ASSETS / f"lux-{family}.glb"
        shutil.copyfile(source, target)
        copied.append({"family": family, "file": rel(target), "bytes": target.stat().st_size})
    for stale in APP_PUBLIC_ASSETS.glob("lux-*.glb"):
        if stale.name not in wanted:
            stale.unlink()
            log(f"[manifest] 删除过期产物 {rel(stale)}")

    # 2) 写 manifest.json
    version = args.version or time.strftime("2026-11-07.lux3d-%H%M%S")
    manifest = {
        "schema_version": 1,
        "assetsVersion": version,
        "generated_at": now_local(),
        "generator": f"scripts/flower_glb_pipeline.py manifest（{PIPELINE_VERSION}）",
        "assets": entries,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    # 3) 更新 catalog.json（保留旧 3 条 + 新增 27 条 species 级）
    catalog = load_catalog()
    # 旧 3 条（rose/tulip/eucalyptus）保持原样不重建；重建的 lux-* species 条目整体替换
    catalog["assets"] = [a for a in catalog.get("assets", [])
                         if not str(a.get("id", "")).startswith("lux-")]
    catalog["assets"].extend(catalog_entries)
    catalog["assetsVersion"] = version
    catalog["updated_at"] = now_local()
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")

    # 4) 把 recolor 窗口写回每个 measure.json（低饱和基色的提示记在证据里）
    for family, info in meta["recolor"].items():
        measure_path = processed_dir / f"lux-{family}.measure.json"
        if not measure_path.exists():
            continue
        measure = json.loads(measure_path.read_text(encoding="utf-8"))
        measure["recolor"] = {
            "mode": info["mode"],
            "base_asset_id": info["baseAssetId"],
            "base_color": info["baseColor"],
            "hue": info["hue"],
            "half_width": info["half_width"],
            "note": info["note"],
            "base_color_profile": info["profile"],
            "low_saturation_base": bool(info["profile"]["low_saturation"]),
        }
        measure_path.write_text(json.dumps(measure, ensure_ascii=False, indent=2), encoding="utf-8")

    report = {
        "at": now_local(),
        "assetsVersion": version,
        "manifest": rel(MANIFEST_PATH),
        "entries_total": len(entries),
        "entries_kept_old": meta["kept_old"],
        "entries_new": len(entries) - meta["kept_old"],
        "species": len(catalog_entries),
        "variant_rows": meta["variant_count"],
        "copied": copied,
        "missing_measures": meta["missing_measures"],
        "plan_source": plan_source,
        "plan_builtin_differences": verify_plan_against_builtin(species),
        "low_saturation_bases": [
            {"family": family, "baseColor": info["baseColor"], "hue": info["hue"]}
            for family, info in meta["recolor"].items() if info["profile"]["low_saturation"]
        ],
        "recolor": meta["recolor"],
        "iteration_notes": PIPELINE_ITERATION_NOTES,
    }
    report_path = processed_dir / "lux3d-manifest.report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    if report["plan_builtin_differences"]:
        log(f"[manifest] 警告：species-plan 与 builtin.ts 有 {len(report['plan_builtin_differences'])} 处不一致，"
            f"见 {rel(report_path)}")
    log(json.dumps({
        "manifest": report["manifest"],
        "assetsVersion": version,
        "entries_total": report["entries_total"],
        "entries_kept_old": report["entries_kept_old"],
        "entries_new": report["entries_new"],
        "copied": len(copied),
        "recolor_variants": sum(1 for e in entries if "recolor" in e and isinstance(e["recolor"], dict)),
        "low_saturation_bases": len(report["low_saturation_bases"]),
        "plan_builtin_differences": len(report["plan_builtin_differences"]),
        "report": rel(report_path),
    }, ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------------------
# QA / 缩略图编排（Python 负责起 dev server + 调 node 脚本）
# ---------------------------------------------------------------------------


def server_reachable(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status < 500
    except (urllib.error.URLError, OSError):
        return False


class DevServer:
    def __init__(self, url: str, port: int, start: bool):
        self.url = url
        self.port = port
        self.start = start
        self.process = None

    def __enter__(self):
        if server_reachable(self.url):
            log(f"[dev] 复用已在运行的 dev server：{self.url}")
            return self
        if not self.start:
            raise SystemExit(
                f"[dev] {self.url} 没有在跑。先手动执行：\n"
                f"    cd app; npm run dev -- --port {self.port} --strictPort\n"
                f"或者加 --start-server 让本脚本自己起（结束后会关掉）。"
            )
        npm = shutil.which("npm.cmd") or shutil.which("npm") or "npm"
        log(f"[dev] 启动 {npm} run dev -- --port {self.port} --strictPort（cwd={rel(APP_DIR)}）")
        self.process = subprocess.Popen(
            [npm, "run", "dev", "--", "--port", str(self.port), "--strictPort"],
            cwd=str(APP_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        deadline = time.time() + 90
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise SystemExit(f"[dev] dev server 退出，exit={self.process.returncode}（端口被占用？）")
            if server_reachable(self.url):
                log(f"[dev] dev server 就绪：{self.url}")
                return self
            time.sleep(1)
        raise SystemExit(f"[dev] 等待 {self.url} 超时")
    def __exit__(self, exc_type, exc, tb):
        if self.process and self.process.poll() is None:
            log("[dev] 关闭本脚本启动的 dev server")
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(self.process.pid)],
                           capture_output=True, check=False)
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
        return False


def run_node_qa(mode: str, url: str, extra: list[str] | None = None) -> int:
    node = shutil.which("node") or "node"
    command = [node, str(QA_SCRIPT), "--mode", mode, "--url", url]
    if extra:
        command.extend(extra)
    log(f"[qa] {node} scripts/qa-models.mjs --mode {mode} --url {url}")
    return subprocess.run(command, cwd=str(APP_DIR)).returncode


def qa_manifest_args(args) -> list[str]:
    """把 --manifest / --families 透传给 node 脚本（manifest 用绝对路径，脚本按 app/ 解析）。"""
    extra: list[str] = []
    if getattr(args, "manifest", None):
        extra.extend(["--manifest", str(pathlib.Path(args.manifest).resolve())])
    if getattr(args, "families", None):
        extra.extend(["--families", args.families])
    return extra


def cmd_thumbs(args) -> int:
    with DevServer(args.url, args.port, args.start_server):
        return run_node_qa("thumbs", args.url, qa_manifest_args(args))


def cmd_qa(args) -> int:
    with DevServer(args.url, args.port, args.start_server):
        return run_node_qa("qa", args.url, qa_manifest_args(args))


def cmd_compare(args) -> int:
    """raw vs processed 正视图并排：验收贴图压缩色偏。"""
    processed_dir = pathlib.Path(args.processed_dir)
    measures = read_measure_files(processed_dir)
    if args.family:
        families = [f for f in args.family if f in measures]
    else:
        families = sorted(measures)
    if not families:
        log("[compare] 没有可比较的 measure")
        return 1
    temp_dir = APP_PUBLIC_ASSETS / "_pipeline-test"
    temp_dir.mkdir(parents=True, exist_ok=True)
    pairs = []
    try:
        for family in families:
            measure = measures[family]
            raw_path = PROJECT_ROOT / measure["raw_file"]
            processed_path = PROJECT_ROOT / measure["processed_file"]
            if not raw_path.exists() or not processed_path.exists():
                continue
            raw_target = temp_dir / f"raw-{family}.glb"
            processed_target = temp_dir / f"processed-{family}.glb"
            shutil.copyfile(raw_path, raw_target)
            shutil.copyfile(processed_path, processed_target)
            norm = measure["normalization"]
            size = {"uniformScale": 1, "headWidth": 1, "headHeight": 1, "leafSpread": 1,
                    "headRadius": measure.get("head_radius_manifest", 0.09)}
            base = {
                "family": family,
                "kind": measure["kind"],
                "transform": {
                    "scale": norm["scale"],
                    "rotationY": norm["rotationY_deg"],
                    "gripAt": norm["gripAt"],
                    "headOffsetY": norm["headOffsetY"],
                },
                "size": size,
                "color": "#e8a0b4",
            }
            pairs.append({
                "family": family,
                "left": {"label": f"raw {measure['raw']['bytes']/1e6:.2f} MB", **base,
                         "glb": f"_pipeline-test/raw-{family}.glb", "assetId": f"raw-{family}"},
                "right": {"label": f"processed {measure['processed']['bytes']/1e6:.2f} MB", **base,
                          "glb": f"_pipeline-test/processed-{family}.glb", "assetId": f"processed-{family}"},
            })
        pairs_path = VERIFY_DIR / "compare-pairs.json"
        VERIFY_DIR.mkdir(parents=True, exist_ok=True)
        pairs_path.write_text(json.dumps({"pairs": pairs}, ensure_ascii=False, indent=2), encoding="utf-8")
        with DevServer(args.url, args.port, args.start_server):
            code = run_node_qa("compare", args.url, ["--pairs", str(pairs_path)])
        return code
    finally:
        if not args.keep_temp:
            for path in temp_dir.glob("*.glb"):
                path.unlink()
            try:
                temp_dir.rmdir()
            except OSError:
                pass


def cmd_report(args) -> int:
    processed_dir = pathlib.Path(args.processed_dir)
    measures = read_measure_files(processed_dir)
    rows = []
    total = 0
    total_raw = 0
    total_triangles = 0
    credits_known = 0.0
    credits_rows = []
    for family, measure in sorted(measures.items()):
        size = measure["processed"]["bytes"]
        generation = measure.get("generation") or {}
        credits = generation.get("credits_consumed")
        if isinstance(credits, (int, float)):
            credits_known += float(credits)
        else:
            credits_rows.append(family)
        total += size
        total_raw += measure["raw"]["bytes"]
        total_triangles += measure["raw"]["triangle_count"]
        rows.append({
            "family": family,
            "kind": measure["kind"],
            "raw_bytes": measure["raw"]["bytes"],
            "processed_bytes": size,
            "ratio": measure["compression"]["ratio"],
            "triangles": measure["raw"]["triangle_count"],
            "vertices": measure["raw"]["vertex_count"],
            "scale": measure["normalization"]["scale"],
            "target_height_m": measure["normalization"]["target_height_m"],
            "head_radius_m": measure.get("head_radius_manifest"),
            "task_id": generation.get("task_id"),
            "credits_consumed": credits,
            "duration_seconds": generation.get("duration_seconds"),
            "within_target": size <= SINGLE_TARGET_BYTES,
            "validation_ok": measure["validation"]["glb_valid"],
        })
    old_glbs = []
    for name in ("rose-pink.glb", "tulip-pink.glb", "eucalyptus-green.glb"):
        path = APP_PUBLIC_ASSETS / name
        if path.exists():
            old_glbs.append({"file": name, "bytes": path.stat().st_size})
    total_with_old = total + sum(item["bytes"] for item in old_glbs)
    over_target = [row["family"] for row in rows if not row["within_target"]]
    summary = {
        "at": now_local(),
        "count_new_glb": len(rows),
        "total_raw_bytes": total_raw,
        "total_raw_mb": round(total_raw / 1024 / 1024, 2),
        "total_new_bytes": total,
        "total_new_mb": round(total / 1024 / 1024, 2),
        "overall_ratio": round(total / total_raw, 4) if total_raw else None,
        "total_triangles": total_triangles,
        "credits": {
            "known_sum": credits_known,
            "known_count": len(rows) - len(credits_rows),
            "unknown_count": len(credits_rows),
            "unknown_families": credits_rows,
            "note": "credits_consumed 来自 assets/local/runs/<run>/generation.json；batch 回填前为 null，如实统计，不估算",
        },
        "old_glbs": old_glbs,
        "total_with_old_bytes": total_with_old,
        "total_with_old_mb": round(total_with_old / 1024 / 1024, 2),
        "budget": {
            "single_target_bytes": SINGLE_TARGET_BYTES,
            "new_total_target_bytes": TOTAL_TARGET_BYTES,
            "with_old_threshold_bytes": TOTAL_DISCUSS_THRESHOLD_BYTES,
            "over_single_target": over_target,
            "new_total_within_target": total <= TOTAL_TARGET_BYTES,
            "with_old_within_threshold": total_with_old <= TOTAL_DISCUSS_THRESHOLD_BYTES,
            "note": "Lead 2026-11-07 修订口径：单件 ≤2.6MB、27 件新资产合计 ≤50MB、超过 55MB 讨论；"
                    "旧 3 个 GLB（rose/tulip/eucalyptus，合计 "
                    f"{sum(item['bytes'] for item in old_glbs)/1024/1024:.2f}MB）是既有高模、保持不动，"
                    "不计入 27 件新预算，但『含旧总量』仍如实报告",
        },
        "rows": rows,
        "spike_families": sorted(SPIKE_FAMILIES),
        "iteration_notes": PIPELINE_ITERATION_NOTES,
    }
    if args.out:
        output = pathlib.Path(args.out)
        if not output.is_absolute():
            output = PROJECT_ROOT / output
    else:
        output = processed_dir / "lux3d-report.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    header = "| family | kind | raw MB | processed MB | ratio | tris | target m | taskId | credits | within 2.6MB |"
    lines = [header, "|---|---|---|---|---|---|---|---|---|---|"]
    for row in rows:
        credits = row["credits_consumed"]
        lines.append(
            f"| {row['family']} | {row['kind']} | {row['raw_bytes']/1e6:.2f} | "
            f"{row['processed_bytes']/1e6:.2f} | {row['ratio']*100:.1f}% | {row['triangles']} | "
            f"{row['target_height_m']:.2f} | {row['task_id'] or '-'} | "
            f"{credits if credits is not None else 'null'} | "
            f"{'yes' if row['within_target'] else 'NO'} |"
        )
    print("\n".join(lines))
    print(f"\n新增 {len(rows)} 个 GLB：raw {summary['total_raw_mb']} MB → processed {summary['total_new_mb']} MB"
          f"（整体压缩到 {summary['overall_ratio']*100:.1f}%），总三角面 {total_triangles}")
    print(f"单件预算：目标 ≤{SINGLE_TARGET_BYTES/1024/1024:.1f} MB，超目标 {len(over_target)} 件"
          f"{'：' + '、'.join(over_target) if over_target else '（无）'}")
    print(f"27 件新资产合计目标 ≤{TOTAL_TARGET_BYTES/1024/1024:.0f} MB → "
          f"{'达标' if summary['budget']['new_total_within_target'] else '超出'}；"
          f"含旧 3 个既有高模（{sum(item['bytes'] for item in old_glbs)/1024/1024:.2f} MB）合计 "
          f"{summary['total_with_old_mb']} MB，讨论阈值 ≤{TOTAL_DISCUSS_THRESHOLD_BYTES/1024/1024:.0f} MB → "
          f"{'在阈值内' if summary['budget']['with_old_within_threshold'] else '需讨论'}")
    print(f"积分：已知 {summary['credits']['known_count']} 件合计 {summary['credits']['known_sum']}，"
          f"未知 {summary['credits']['unknown_count']} 件（batch 回填前属正常）")
    print(f"[report] 写入 {rel(output)}")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lux3D 花材资产管线（GLB 压缩/测量/manifest/QA）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("prepare", help="单个 raw GLB → processed/lux-<family>.glb + measure.json")
    p.add_argument("--raw", required=True)
    p.add_argument("--family", required=True)
    p.add_argument("--kind", required=True, choices=["main", "filler", "greenery"])
    p.add_argument("--target-height", type=float, default=0.45, help="归一化后的整枝高度（米）")
    p.add_argument("--grip-lift", type=float, default=0.02, help="握点相对茎底的抬升（米）")
    p.add_argument("--rotation-y", type=float, default=0.0)
    p.add_argument("--out-dir", default=str(PROCESSED_DIR))
    p.add_argument("--run-id", help="生成记录目录名（默认按 family 在 assets/local/runs/ 里自动找）")
    p.add_argument("--force", action="store_true", help="忽略幂等短路，强制重编码")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_prepare)

    p = sub.add_parser("prepare-all", help="按 species-plan 批量 prepare（缺 raw 的跳过并记录）")
    p.add_argument("--out-dir", default=str(PROCESSED_DIR))
    p.add_argument("--grip-lift", type=float, default=0.02)
    p.add_argument("--rotation-y", type=float, default=0.0)
    p.add_argument("--force", action="store_true")
    p.add_argument("--strict", action="store_true", help="有缺失/失败时返回非 0")
    p.set_defaults(func=cmd_prepare_all)

    p = sub.add_parser("stage", help="复制 lux-*.glb 到 public/assets 并写临时 QA manifest（不动正式清单）")
    p.add_argument("--processed-dir", default=str(PROCESSED_DIR))
    p.add_argument("--out", default=str(PROCESSED_DIR / "qa-manifest.json"))
    p.add_argument("--version")
    p.set_defaults(func=cmd_stage)

    p = sub.add_parser("manifest", help="生成 manifest.json（53 条）并更新 catalog.json")
    p.add_argument("--processed-dir", default=str(PROCESSED_DIR))
    p.add_argument("--version", help="固定 assetsVersion（默认 2026-11-07.lux3d-<HHMMSS>）")
    p.set_defaults(func=cmd_manifest)

    p = sub.add_parser("thumbs", help="生成全部条目的静态缩略图（160×190 透明 PNG）")
    p.add_argument("--url", default="http://127.0.0.1:5190/")
    p.add_argument("--port", type=int, default=5190)
    p.add_argument("--start-server", action="store_true")
    p.add_argument("--manifest", help="默认 app/public/assets/manifest.json；QA 阶段可指向临时清单")
    p.add_argument("--families", help="只处理指定花型（逗号分隔）")
    p.set_defaults(func=cmd_thumbs)

    p = sub.add_parser("qa", help="4 视角接触表 + 配色变体对比")
    p.add_argument("--url", default="http://127.0.0.1:5190/")
    p.add_argument("--port", type=int, default=5190)
    p.add_argument("--start-server", action="store_true")
    p.add_argument("--manifest", help="默认 app/public/assets/manifest.json；QA 阶段可指向临时清单")
    p.add_argument("--families", help="只处理指定花型（逗号分隔）")
    p.set_defaults(func=cmd_qa)

    p = sub.add_parser("compare", help="raw vs processed 正视图并排（验收贴图色偏）")
    p.add_argument("--processed-dir", default=str(PROCESSED_DIR))
    p.add_argument("--family", action="append")
    p.add_argument("--url", default="http://127.0.0.1:5190/")
    p.add_argument("--port", type=int, default=5190)
    p.add_argument("--start-server", action="store_true")
    p.add_argument("--keep-temp", action="store_true")
    p.set_defaults(func=cmd_compare)

    p = sub.add_parser("report", help="汇总尺寸/面数/压缩比表格")
    p.add_argument("--processed-dir", default=str(PROCESSED_DIR))
    p.add_argument("--out")
    p.set_defaults(func=cmd_report)
    return parser


def main() -> int:
    # Windows 控制台默认 GBK，中文日志会被上游按 UTF-8 解码成乱码；统一改 UTF-8。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
