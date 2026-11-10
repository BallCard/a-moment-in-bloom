#!/usr/bin/env python
"""花材 GLB 的测量、归一化参数计算、资产清单登记与工作台同步（仅标准库）。

为什么没有 Blender：本机未安装 Blender（见 experiments/local/env-check.md）。本工具的定位是
「可复现的整理脚本」——它不解码贴图、不做雕刻级修改，而是：

1. `measure` 解析 GLB 容器、节点层级变换与 POSITION 顶点，得到真实世界包围盒、三角面数、
   花头顶部区域质心，据此计算工作台需要的归一化参数；
2. `register` 把测量结果、生成来源、哈希写进 `assets/local/catalog.json`（唯一真源）；
3. `sync` 把 catalog 里登记的 GLB 复制到 `app/public/assets/` 并生成 `manifest.json`
   （app 侧契约见 app/README.md 的「资产接入契约」）。

归一化参数的语义（与 app 的实现一致）：
- `scale`        : 应用在模型根节点上的均匀缩放，把模型统一到目标高度（米）。
- `rotationY`    : 角度制，统一模型朝向。
- `gripAt`       : 缩放后模型局部空间中握点的 Y 高度（米）。app 加载时做 position.y = -gripAt。
- `headOffsetY`  : 缩放后握点到花头中心的 Y 距离（米），用于选中环与拖动锚点。

原件（raw）与整理结果（processed）都保留；当前处理不需要改二进制，processed 为原件副本，
归一化只体现在 catalog/manifest 的元数据里，并在此记录，避免"看起来加工过其实没加工"。

用法：
    python scripts/bouquet_assets.py measure  --raw assets/local/raw/20261105-tulip-pink-1.glb --id tulip-pink --target-height 0.55
    python scripts/bouquet_assets.py register --measure-report assets/local/processed/tulip-pink.measure.json --id tulip-pink
    python scripts/bouquet_assets.py sync
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil
import struct
import sys
import time

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS_LOCAL = PROJECT_ROOT / "assets" / "local"
RAW_DIR = ASSETS_LOCAL / "raw"
PROCESSED_DIR = ASSETS_LOCAL / "processed"
CATALOG = ASSETS_LOCAL / "catalog.json"
APP_PUBLIC_ASSETS = PROJECT_ROOT / "app" / "public" / "assets"

COMPONENT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
TYPE_SIZE = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


# ---------------------------------------------------------------- GLB 解析


def read_glb(path: pathlib.Path):
    data = path.read_bytes()
    if len(data) < 12:
        raise ValueError("GLB 文件头不完整")
    magic, version, total = struct.unpack("<4sII", data[:12])
    if magic != b"glTF" or version != 2:
        raise ValueError("只支持 GLB 2 文件")
    if total != len(data):
        raise ValueError("GLB 声明长度与实际文件长度不一致")
    pos, model, binary = 12, None, b""
    while pos < len(data):
        length, kind = struct.unpack("<I4s", data[pos:pos + 8])
        pos += 8
        chunk = data[pos:pos + length]
        pos += length
        if kind == b"JSON":
            model = json.loads(chunk.decode("utf-8"))
        elif kind == b"BIN\x00":
            binary = chunk
    if not isinstance(model, dict) or model.get("asset", {}).get("version") != "2.0":
        raise ValueError("缺少 glTF 2.0 JSON 元数据")
    return model, binary


def node_matrix(node: dict):
    if "matrix" in node:
        m = node["matrix"]  # column-major
        return [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]]
    tx, ty, tz = node.get("translation", [0, 0, 0])
    qx, qy, qz, qw = node.get("rotation", [0, 0, 0, 1])
    sx, sy, sz = node.get("scale", [1, 1, 1])
    # 四元数 → 旋转矩阵
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


IDENTITY = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


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
    comps = TYPE_SIZE[acc["type"]]
    stride = bv.get("byteStride") or size * comps
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    count = acc["count"]
    out = []
    for i in range(count):
        off = base + i * stride
        vals = struct.unpack_from("<" + fmt * comps, binary, off)
        out.append(vals)
    return out


def collect_vertices(model: dict, binary: bytes):
    """返回 [(x,y,z,世界变换后的点)]，并统计三角面数。"""
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
                    w = transform_point(world, p)
                    vertices.append(w)
                if "indices" in primitive:
                    idx = decode_accessor(model, binary, primitive["indices"])
                    triangles += len(idx) // 3
                else:
                    triangles += len(pts) // 3
                mesh_uses.append({"node": node_index, "mesh": node["mesh"], "vertices": len(pts),
                                  "material": primitive.get("material")})
        for child in node.get("children", []):
            walk(child, world)

    for r in roots:
        walk(r, IDENTITY)
    return vertices, triangles, mesh_uses


# ---------------------------------------------------------------- 测量


def measure(raw: pathlib.Path, asset_id: str, target_height: float, grip_lift: float, rotation_y: float):
    model, binary = read_glb(raw)
    vertices, triangles, mesh_uses = collect_vertices(model, binary)
    if not vertices:
        raise ValueError("模型没有可解码的顶点")
    xs = [v[0] for v in vertices]
    ys = [v[1] for v in vertices]
    zs = [v[2] for v in vertices]
    bbox_min = [min(xs), min(ys), min(zs)]
    bbox_max = [max(xs), max(ys), max(zs)]
    height = bbox_max[1] - bbox_min[1]
    if height <= 1e-9:
        raise ValueError("模型 Y 轴高度为 0，可能不是 Y-up 或只有平面")
    scale = target_height / height

    # 花头区域：顶部 25% 高度带内顶点质心（近似花头中心）
    band = bbox_max[1] - 0.25 * height
    head_pts = [v for v in vertices if v[1] >= band]
    head_center = [
        sum(p[0] for p in head_pts) / len(head_pts),
        sum(p[1] for p in head_pts) / len(head_pts),
        sum(p[2] for p in head_pts) / len(head_pts),
    ] if head_pts else [0.0, bbox_max[1], 0.0]

    grip_at = bbox_min[1] * scale + grip_lift
    head_offset = head_center[1] * scale - grip_at

    images = model.get("images", [])
    materials = []
    for material in model.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
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

    digest = hashlib.sha256(raw.read_bytes()).hexdigest()
    raw = raw.resolve()
    report = {
        "asset_id": asset_id,
        "raw_file": str(raw.relative_to(PROJECT_ROOT)),
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "bytes": raw.stat().st_size,
        "sha256": digest,
        "raw_bbox_min": [round(v, 6) for v in bbox_min],
        "raw_bbox_max": [round(v, 6) for v in bbox_max],
        "raw_size": [round(bbox_max[i] - bbox_min[i], 6) for i in range(3)],
        "vertex_count": len(vertices),
        "triangle_count": triangles,
        "mesh_uses": mesh_uses,
        "node_count": len(model.get("nodes", [])),
        "mesh_count": len(model.get("meshes", [])),
        "material_count": len(materials),
        "image_count": len(images),
        "image_mime": sorted({im.get("mimeType") for im in images if im.get("mimeType")}),
        "materials": materials,
        "extensions_required": model.get("extensionsRequired", []),
        "head_band_vertex_count": len(head_pts),
        "head_center_raw": [round(v, 6) for v in head_center],
        "normalization": {
            "target_height_m": target_height,
            "grip_lift_m": grip_lift,
            "rotationY_deg": rotation_y,
            "scale": round(scale, 5),
            "gripAt": round(grip_at, 5),
            "headOffsetY": round(head_offset, 5),
            "derivation": "scale = target_height / raw_height; gripAt = raw_bbox_min_y*scale + grip_lift; "
                          "headOffsetY = head_center_y*scale - gripAt",
        },
        "processed_file": str((PROCESSED_DIR / f"{asset_id}.glb").relative_to(PROJECT_ROOT)),
        "processing_note": "当前整理不改二进制：尺度/握点/朝向作为元数据写入 manifest，由 app 在导入边界统一应用。"
                           "processed 文件是原件字节副本，sha256 与 raw 相同。",
    }
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(raw, PROCESSED_DIR / f"{asset_id}.glb")
    report_path = PROCESSED_DIR / f"{asset_id}.measure.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("asset_id", "bytes", "triangle_count", "vertex_count",
                                             "raw_size", "raw_bbox_min", "raw_bbox_max",
                                             "material_count", "image_count", "normalization")},
                     ensure_ascii=False, indent=2))
    print(f"[measure] 写入 {report_path.relative_to(PROJECT_ROOT)}，复制 processed/{asset_id}.glb")
    return report


# ---------------------------------------------------------------- 登记与同步


def load_catalog() -> dict:
    if CATALOG.exists():
        return json.loads(CATALOG.read_text(encoding="utf-8"))
    return {"schema_version": 1, "updated_at": None, "assets": []}


def save_catalog(catalog: dict) -> None:
    catalog["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[catalog] {CATALOG.relative_to(PROJECT_ROOT)}（{len(catalog['assets'])} 条）")


def cmd_register(args) -> int:
    report = json.loads(pathlib.Path(args.measure_report).read_text(encoding="utf-8"))
    catalog = load_catalog()
    existing = next((a for a in catalog["assets"] if a["id"] == args.id), None)
    entry = existing or {"id": args.id}
    norm = report["normalization"]
    entry.update({
        "kind": args.kind,
        "displayName": args.display_name,
        "fallback": {"procedural": args.fallback, "color": args.color},
        "transform": {
            "scale": norm["scale"],
            "rotationY": norm["rotationY_deg"],
            "gripAt": norm["gripAt"],
            "headOffsetY": norm["headOffsetY"],
        },
        "files": {
            "raw": report["raw_file"],
            "processed": report["processed_file"],
            "bytes": report["bytes"],
            "sha256": report["sha256"],
        },
        "measurement": {
            "raw_size_m": report["raw_size"],
            "raw_bbox_min": report["raw_bbox_min"],
            "raw_bbox_max": report["raw_bbox_max"],
            "triangle_count": report["triangle_count"],
            "vertex_count": report["vertex_count"],
            "material_count": report["material_count"],
            "image_count": report["image_count"],
            "extensions_required": report["extensions_required"],
            "measure_report": str(pathlib.Path(args.measure_report).resolve().relative_to(PROJECT_ROOT)),
        },
    })
    if args.source_json:
        entry["source"] = json.loads(pathlib.Path(args.source_json).read_text(encoding="utf-8"))
    if args.generation_json:
        entry["generation"] = json.loads(pathlib.Path(args.generation_json).read_text(encoding="utf-8"))
    if not existing:
        catalog["assets"].append(entry)
    catalog["assetsVersion"] = time.strftime("%Y-%m-%d.%H%M%S")
    save_catalog(catalog)
    return 0


def cmd_sync(args) -> int:
    catalog = load_catalog()
    APP_PUBLIC_ASSETS.mkdir(parents=True, exist_ok=True)
    manifest_assets = []
    copied = []
    for entry in catalog["assets"]:
        src = PROJECT_ROOT / entry["files"]["processed"]
        if not src.exists():
            print(f"[sync] 跳过 {entry['id']}：找不到 {entry['files']['processed']}")
            continue
        target = APP_PUBLIC_ASSETS / f"{entry['id']}.glb"
        shutil.copyfile(src, target)
        copied.append({"id": entry["id"], "bytes": target.stat().st_size})
        manifest_assets.append({
            "id": entry["id"],
            "kind": entry["kind"],
            "displayName": entry["displayName"],
            "glb": f"{entry['id']}.glb",
            "transform": entry["transform"],
            "fallback": entry["fallback"],
        })
    manifest = {
        "schema_version": 1,
        "assetsVersion": catalog.get("assetsVersion") or "unversioned",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "assets": manifest_assets,
    }
    (APP_PUBLIC_ASSETS / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"copied": copied, "manifest": str((APP_PUBLIC_ASSETS / 'manifest.json').relative_to(PROJECT_ROOT))},
                     ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="花材 GLB 测量 / 登记 / 同步")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("measure")
    p.add_argument("--raw", required=True)
    p.add_argument("--id", required=True, help="资产 id，如 tulip-pink")
    p.add_argument("--target-height", type=float, default=0.55, help="归一化后的整枝高度（米）")
    p.add_argument("--grip-lift", type=float, default=0.02, help="握点相对茎底的抬升（米）")
    p.add_argument("--rotation-y", type=float, default=0.0, help="统一朝向的角度")
    p.set_defaults(func=lambda a: (measure(pathlib.Path(a.raw), a.id, a.target_height, a.grip_lift, a.rotation_y), 0)[1])

    p = sub.add_parser("register")
    p.add_argument("--measure-report", required=True)
    p.add_argument("--id", required=True)
    p.add_argument("--kind", default="main", choices=["main", "filler", "greenery"])
    p.add_argument("--display-name", required=True)
    p.add_argument("--fallback", default="tulip", choices=["tulip", "rose", "eucalyptus"])
    p.add_argument("--color", default="#e8a0b4")
    p.add_argument("--source-json", help="生成来源 JSON（taskId、prompt、参数）")
    p.add_argument("--generation-json", help="耗时与积分记录 JSON")
    p.set_defaults(func=cmd_register)

    p = sub.add_parser("sync")
    p.set_defaults(func=cmd_sync)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
