#!/usr/bin/env python
"""Lux3D 花器/包装容器资产管线：raw GLB 贴图压缩 + GLB 重写 + manifest + 入库复制。

与 `scripts/flower_glb_pipeline.py` 的关系：
- 花材管线负责花材的「测量 + 归一化参数 + 花头半径」；本脚本只做容器需要的部分，
  直接 importlib 复用它的 GLB 读写 / 贴图压缩 / 重建 / 校验函数，**不修改**那个文件。
- 容器不需要离线几何归一化：运行时加载器按包围盒缩放/居中/落地，manifest 里只给
  targetHeightM 与实测 bbox。

产物：
    assets/local/processed-vessels/<id>.glb                 压缩后的 GLB
    assets/local/processed-vessels/<id>.measure.json        单件测量/压缩证据
    assets/local/processed-vessels/vessels-manifest.json    本地清单（含 taskId/credits/prompt 哈希）
    app/public/assets/vessels/<id>.glb                      入库副本
    app/public/assets/vessels/manifest.json                 入库清单（含 assetsVersion）

用法（PowerShell）：
    python scripts/vessel_glb_pipeline.py prepare-all
    python scripts/vessel_glb_pipeline.py prepare-all --only wicker-basket,gift-box
    python scripts/vessel_glb_pipeline.py report
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import shutil
import struct
import time

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS_LOCAL = PROJECT_ROOT / "assets" / "local"
RAW_DIR = ASSETS_LOCAL / "raw"
PLAN_FILE = ASSETS_LOCAL / "vessel-plan.json"
PROCESSED_DIR = ASSETS_LOCAL / "processed-vessels"
MANIFEST_LOCAL = PROCESSED_DIR / "vessels-manifest.json"
APP_VESSELS_DIR = PROJECT_ROOT / "app" / "public" / "assets" / "vessels"
APP_MANIFEST = APP_VESSELS_DIR / "manifest.json"

PIPELINE_VERSION = "1.1"
# 单个容器 GLB 目标上限（task-5 口径）。
TARGET_MAX_BYTES = round(2.5 * 1024 * 1024)
ASSETS_VERSION_DATE = "2026-11-07"


def now_local() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def rel(path: pathlib.Path) -> str:
    try:
        return str(path.resolve().relative_to(PROJECT_ROOT)).replace("\\", "/")
    except ValueError:
        return str(path)


def load_flower_pipeline():
    """从文件加载花材管线模块（复用其 GLB 读写 / 贴图压缩 / 重建 / 校验实现）。"""
    path = PROJECT_ROOT / "scripts" / "flower_glb_pipeline.py"
    spec = importlib.util.spec_from_file_location("flower_glb_pipeline", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"无法加载花材管线：{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path: pathlib.Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: pathlib.Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# 生成记录（taskId / 积分 / 起止时间），全部从真实落盘证据回读，取不到就写 null
# ---------------------------------------------------------------------------


def find_run_dir(run_id: str) -> pathlib.Path | None:
    candidate = ASSETS_LOCAL / "runs" / run_id
    return candidate if candidate.is_dir() else None


def batch_rows() -> dict[str, dict]:
    """把 assets/local/runs/batch-*/summary.json 的 rows 按 family 汇总（后出现的覆盖先出现的）。"""
    rows: dict[str, dict] = {}
    runs_dir = ASSETS_LOCAL / "runs"
    if not runs_dir.exists():
        return rows
    for summary_path in sorted(runs_dir.glob("batch-*/summary.json")):
        summary = read_json(summary_path, {}) or {}
        for row in summary.get("rows", []):
            family = row.get("family")
            if isinstance(family, str):
                rows[family] = {**row, "summary_file": rel(summary_path), "batch_id": summary.get("batch_id")}
    return rows


def generation_of(spec: dict, batch: dict[str, dict]) -> dict:
    family = spec["family"]
    run_dir = find_run_dir(spec.get("runId", ""))
    task = read_json(run_dir / "task.json", {}) if run_dir else {}
    gen = read_json(run_dir / "generation.json", {}) if run_dir else {}
    result = read_json(run_dir / "task_result.json", {}) if run_dir else {}
    downloads = read_json(run_dir / "downloads.json", {}) if run_dir else {}
    row = batch.get(family, {})

    task_id = task.get("taskId") or row.get("taskId")
    credits = gen.get("credits_consumed")
    credits_source = "runs/<run>/generation.json" if isinstance(credits, int) else None
    if not isinstance(credits, int) and isinstance(row.get("consumedCredits"), int):
        credits = row["consumedCredits"]
        credits_source = f"{row.get('summary_file')}（rows[].consumedCredits）"
    requested = gen.get("requested_at") or row.get("created_at")
    finished = gen.get("finished_at") or row.get("downloaded_at")
    duration = result.get("elapsed_s")
    return {
        "run_dir": rel(run_dir) if run_dir else None,
        "task_id": task_id,
        "credits_consumed": credits if isinstance(credits, int) else None,
        "credits_source": credits_source if isinstance(credits, int) else None,
        "requested_at": requested,
        "finished_at": finished or (downloads.get("downloaded_at") if downloads else None),
        "task_elapsed_seconds": duration,
        "final_status": gen.get("final_status") or (row.get("status") if row else None),
        "glb": row.get("glb") or (downloads.get("files") or [{}])[0].get("path") if downloads else row.get("glb"),
        "error": row.get("error"),
        "batch_id": row.get("batch_id"),
    }


def find_raw(run_id: str) -> pathlib.Path | None:
    """raw 文件名是 <runId>-<idx>.glb；family 之后必须紧跟数字序号，避免前缀误匹配。"""
    pattern = re.compile(r"^" + re.escape(run_id) + r"-(\d+)\.glb$")
    matches = [p for p in RAW_DIR.glob(f"{run_id}-*.glb") if pattern.match(p.name)] if RAW_DIR.exists() else []
    if not matches:
        return None
    return sorted(matches, key=lambda p: int(pattern.match(p.name).group(1)))[0]


# ---------------------------------------------------------------------------
# 索引无损压缩（Lux3D 输出统一用 uint32 索引；顶点数 < 65536 时 uint16 足够）
# ---------------------------------------------------------------------------


def compact_uint16_indices(model: dict, binary: bytes, fg) -> tuple[dict, dict, dict]:
    """把所有「独占 bufferView 的 uint32 索引」无损改成 uint16。

    只做三件可验证的事：componentType 5125 → 5123、按原索引顺序重打包、
    accessor byteOffset 归零。三角形/顶点/UV 完全不变（validate 会重新解码核对）。
    不满足条件（索引超 65535、bufferView 共用、有 byteStride）就原样跳过并记账。
    """
    new_model = json.loads(json.dumps(model))
    index_accessors: set[int] = set()
    for mesh in new_model.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            if "indices" in primitive:
                index_accessors.add(primitive["indices"])
    users: dict[int, list[int]] = {}
    for i, acc in enumerate(new_model.get("accessors", [])):
        bv = acc.get("bufferView")
        if isinstance(bv, int):
            users.setdefault(bv, []).append(i)

    replacements: dict[int, bytes] = {}
    items = []
    saved = 0
    for ai in sorted(index_accessors):
        acc = new_model["accessors"][ai]
        record = {"accessor": ai}
        if acc.get("componentType") != 5125 or "sparse" in acc or acc.get("bufferView") is None:
            record.update({"action": "skip", "reason": "不是无 sparse 的 uint32 索引"})
            items.append(record)
            continue
        bv_index = acc["bufferView"]
        bv = new_model["bufferViews"][bv_index]
        if users.get(bv_index) != [ai]:
            record.update({"action": "skip", "reason": f"bufferView {bv_index} 被多个 accessor 共用"})
            items.append(record)
            continue
        if bv.get("byteStride"):
            record.update({"action": "skip", "reason": "bufferView 带 byteStride"})
            items.append(record)
            continue
        flat = [value[0] for value in fg.decode_accessor(new_model, binary, ai)]
        if not flat:
            record.update({"action": "skip", "reason": "索引为空"})
            items.append(record)
            continue
        max_index = max(flat)
        if max_index > 65535:
            record.update({"action": "skip", "reason": f"最大索引 {max_index} 超过 uint16 上限"})
            items.append(record)
            continue
        payload = struct.pack("<" + "H" * len(flat), *flat)
        if len(payload) >= bv["byteLength"]:
            record.update({"action": "skip", "reason": "uint16 不会更小"})
            items.append(record)
            continue
        replacements[bv_index] = payload
        acc["componentType"] = 5123
        acc["byteOffset"] = 0
        saved += bv["byteLength"] - len(payload)
        record.update({
            "action": "uint16",
            "bufferView": bv_index,
            "indices": len(flat),
            "vertex_count": max_index + 1,
            "old_bytes": bv["byteLength"],
            "new_bytes": len(payload),
        })
        items.append(record)
    return new_model, replacements, {"indices": items, "saved_bytes": saved}


def rebuild_glb_with_replacements(model: dict, binary: bytes, encoded_images: list[dict], replacements: dict[int, bytes]):
    """adopted from flower_glb_pipeline.rebuild_glb_bytes：多一个 bufferView 字节替换表。

    图片 bufferView 换成重编码字节；索引 bufferView 用 replacements 里的 uint16 字节；
    其它 bufferView 原字节不动。全部重新 4 字节对齐排布并重映射引用。
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
    fg_module._remap_buffer_view_refs(other, remap, image_bvs, "model")
    new_model.update(other)

    new_bvs: list[dict] = []
    payloads: list[bytes] = []
    layout: list[dict] = []
    for old_index in kept_old:
        old_bv = model["bufferViews"][old_index]
        replacement = replacements.get(old_index)
        if replacement is None:
            offset = old_bv.get("byteOffset", 0)
            length = old_bv["byteLength"]
            payload = binary[offset:offset + length]
            if len(payload) != length:
                raise ValueError(f"bufferView {old_index} 越界")
            kind = "geometry" if old_bv.get("target") else "data"
        else:
            payload = replacement
            kind = "geometry-index-uint16"
        bv = {k: v for k, v in old_bv.items() if k not in ("byteOffset", "byteLength", "buffer")}
        bv["buffer"] = 0
        new_bvs.append(bv)
        payloads.append(payload)
        layout.append({"kind": kind, "old_index": old_index, "bytes": len(payload)})

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
# prepare：贴图压缩 + GLB 重写
# ---------------------------------------------------------------------------


def prepare_one(fg, spec: dict, generation: dict, force: bool = False) -> dict:
    family = spec["family"]
    asset_id = family
    run_id = spec["runId"]
    target_height = float(spec["targetHeightM"])
    prompt = spec["prompt"].strip()
    prompt_sha = sha256_bytes(prompt.encode("utf-8"))

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    out_glb = PROCESSED_DIR / f"{asset_id}.glb"
    out_measure = PROCESSED_DIR / f"{asset_id}.measure.json"

    raw = find_raw(run_id)
    if raw is None:
        return {
            "id": asset_id,
            "status": "missing_raw",
            "error": f"assets/local/raw/ 下没有 {run_id}-<n>.glb（生成/下载未完成）",
            "generation": generation,
            "prompt_sha256": prompt_sha,
            "targetHeightM": target_height,
        }

    raw_bytes = raw.read_bytes()
    raw_sha = sha256_bytes(raw_bytes)

    if not force and out_glb.exists() and out_measure.exists():
        try:
            previous = json.loads(out_measure.read_text(encoding="utf-8"))
            same = (
                previous.get("pipeline_version") == PIPELINE_VERSION
                and previous.get("raw", {}).get("sha256") == raw_sha
                and previous.get("parameters", {}).get("prompt_sha256") == prompt_sha
                and abs(float(previous.get("parameters", {}).get("targetHeightM", -1)) - target_height) < 1e-9
                and previous.get("processed", {}).get("sha256") == sha256_bytes(out_glb.read_bytes())
            )
            if same:
                print(f"[prepare] {asset_id} 已是最新（raw sha 与 prompt 一致），跳过重编码")
                previous["generation"] = generation
                previous["status"] = "ok"
                write_json(out_measure, previous)
                return previous
        except (json.JSONDecodeError, OSError, ValueError):
            pass

    started = time.time()
    model, binary = fg.read_glb(raw)
    vertices, triangles, mesh_uses = fg.collect_vertices(model, binary)
    if not vertices:
        raise ValueError(f"{raw.name}: 模型没有可解码的顶点")

    xs = [v[0] for v in vertices]
    ys = [v[1] for v in vertices]
    zs = [v[2] for v in vertices]
    bbox_min = [min(xs), min(ys), min(zs)]
    bbox_max = [max(xs), max(ys), max(zs)]
    size = [bbox_max[i] - bbox_min[i] for i in range(3)]
    if size[1] <= 1e-9:
        raise ValueError(f"{raw.name}: Y 轴高度为 0，可能不是 Y-up 模型")

    roles = fg.image_roles(model)
    images = model.get("images", [])
    encoded_images = []
    texture_reports = []
    for index, image in enumerate(images):
        role = fg.primary_role(roles.get(index, {"other"}))
        raw_image = fg.image_bytes_of(model, binary, image)
        encoded = fg.encode_texture(raw_image, role)
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

    with_alpha = [t for t in texture_reports if t["alpha_kept"]]
    # Lux3D 统一输出 uint32 索引；顶点数 < 65536 时用 uint16 无损减半（不碰顶点/UV/法线）。
    compact_model, index_replacements, index_compaction = compact_uint16_indices(model, binary, fg)
    new_model, new_binary, rebuild_info = rebuild_glb_with_replacements(
        compact_model, binary, encoded_images, index_replacements)
    new_model.setdefault("extras", {})
    if isinstance(new_model["extras"], dict):
        new_model["extras"]["lux_pipeline"] = {
            "pipeline": "vessel_glb_pipeline.py",
            "version": PIPELINE_VERSION,
            "prepared_at": now_local(),
            "source_sha256": raw_sha,
            "asset_id": asset_id,
            "target_height_m": target_height,
            "note": "几何顶点/法线/UV bufferView 字节未改动；图片重编码、索引 uint32→uint16 无损重打包、bufferView 重排（4 字节对齐）",
        }
    glb_bytes = fg.write_glb(new_model, new_binary)
    out_glb.write_bytes(glb_bytes)

    validation = fg.validate_glb_bytes(glb_bytes, triangles, len(vertices))
    validation["glb_total_bytes"] = len(glb_bytes)

    # 索引一致性核对：逐 primitive 解码 raw 与产物的索引数组，必须逐项完全相同。
    index_checks = []
    parsed_model, parsed_binary = fg.read_glb(out_glb)
    for mi, mesh in enumerate(model.get("meshes", [])):
        for pi, primitive in enumerate(mesh.get("primitives", [])):
            if "indices" not in primitive:
                continue
            raw_indices = [value[0] for value in fg.decode_accessor(model, binary, primitive["indices"])]
            new_primitive = parsed_model["meshes"][mi]["primitives"][pi]
            new_indices = [value[0] for value in fg.decode_accessor(parsed_model, parsed_binary, new_primitive["indices"])]
            index_checks.append({
                "mesh": mi,
                "primitive": pi,
                "indices": len(raw_indices),
                "identical": raw_indices == new_indices,
                "component_type_raw": model["accessors"][primitive["indices"]]["componentType"],
                "component_type_processed": parsed_model["accessors"][new_primitive["indices"]]["componentType"],
            })
    validation["index_identical"] = all(item["identical"] for item in index_checks)
    validation["index_checks"] = index_checks

    report = {
        "id": asset_id,
        "status": "ok",
        "name": spec.get("name"),
        "prepared_at": now_local(),
        "pipeline_version": PIPELINE_VERSION,
        "plan_file": rel(PLAN_FILE),
        "parameters": {
            "targetHeightM": target_height,
            "faceCount_requested": spec.get("faceCount"),
            "prompt_sha256": prompt_sha,
        },
        "raw_file": rel(raw),
        "processed_file": rel(out_glb),
        "generation": generation,
        "raw": {
            "bytes": len(raw_bytes),
            "sha256": raw_sha,
            "triangle_count": triangles,
            "vertex_count": len(vertices),
            "bbox_min": [round(v, 6) for v in bbox_min],
            "bbox_max": [round(v, 6) for v in bbox_max],
            "size": [round(v, 6) for v in size],
            "height_m": round(size[1], 6),
            "node_count": len(model.get("nodes", [])),
            "mesh_count": len(model.get("meshes", [])),
            "material_count": len(model.get("materials", [])),
            "image_count": len(images),
            "image_mime": sorted({im.get("mimeType") for im in images if im.get("mimeType")}),
            "mesh_uses": mesh_uses,
            "extensions_required": model.get("extensionsRequired", []),
            "bin_bytes": len(binary),
        },
        "processed": {
            "bytes": len(glb_bytes),
            "sha256": sha256_bytes(glb_bytes),
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
        "textures": texture_reports,
        "alpha_textures": [t["role"] for t in with_alpha],
        "index_compaction": index_compaction,
        "rebuild": {
            "buffer_view_count": len(new_model["bufferViews"]),
            "bin_bytes": rebuild_info["bin_bytes"],
            "layout": rebuild_info["layout"],
            "alignment": "4-byte",
        },
        "validation": validation,
        "elapsed_seconds": round(time.time() - started, 2),
    }
    write_json(out_measure, report)
    print(f"[prepare] {asset_id}: {len(raw_bytes)/1e6:.2f} MB → {len(glb_bytes)/1e6:.2f} MB "
          f"({report['compression']['ratio']*100:.1f}%)，三角面 {validation['triangle_count']}，"
          f"bbox {[round(v,3) for v in size]}，taskId={generation.get('task_id')}，"
          f"credits={generation.get('credits_consumed')}")
    if not validation["triangle_count_match"]:
        raise ValueError(f"{asset_id}: 产物三角面 {validation['triangle_count']} != 原始 {triangles}")
    if not validation["glb_valid"]:
        raise ValueError(f"{asset_id}: 产物校验失败 {validation['problems']}")
    if not validation["index_identical"]:
        raise ValueError(f"{asset_id}: 索引无损压缩后索引数组与原始不一致：{validation['index_checks']}")
    return report


# ---------------------------------------------------------------------------
# manifest + 入库复制
# ---------------------------------------------------------------------------


def build_manifest(plan: dict, reports: list[dict]) -> dict:
    entries = []
    for spec, report in zip(plan["species"], reports):
        generation = report.get("generation") or {}
        entry = {
            "id": spec["family"],
            "name": spec.get("name"),
            "kind": "vessel",
            "file": f"{spec['family']}.glb",
            "url": f"assets/vessels/{spec['family']}.glb",
            "targetHeightM": float(spec["targetHeightM"]),
            "triangles": (report.get("processed") or {}).get("triangle_count"),
            "vertices": (report.get("processed") or {}).get("vertex_count"),
            "bytes": (report.get("processed") or {}).get("bytes"),
            "rawBytes": (report.get("raw") or {}).get("bytes"),
            "bbox": {
                "min": (report.get("raw") or {}).get("bbox_min"),
                "max": (report.get("raw") or {}).get("bbox_max"),
                "size": (report.get("raw") or {}).get("size"),
            },
            "taskId": generation.get("task_id"),
            "runId": spec.get("runId"),
            "credits": generation.get("credits_consumed"),
            "creditsSource": generation.get("credits_source"),
            "requestedAt": generation.get("requested_at"),
            "finishedAt": generation.get("finished_at"),
            "taskElapsedSeconds": generation.get("task_elapsed_seconds"),
            "promptSha256": (report.get("parameters") or {}).get("prompt_sha256"),
            "sha256": (report.get("processed") or {}).get("sha256"),
            "indexCompaction": {
                "savedBytes": (report.get("index_compaction") or {}).get("saved_bytes"),
                "actions": [
                    {"action": item.get("action"), "componentType": (item.get("action") == "uint16") and 5123 or None}
                    for item in (report.get("index_compaction") or {}).get("indices", [])
                ],
            },
            "validation": {
                "glbValid": (report.get("validation") or {}).get("glb_valid"),
                "triangleCountMatch": (report.get("validation") or {}).get("triangle_count_match"),
                "indexIdentical": (report.get("validation") or {}).get("index_identical"),
            },
            "withinTarget": (report.get("compression") or {}).get("within_target"),
        }
        if report.get("status") != "ok":
            entry["status"] = report.get("status")
            entry["error"] = report.get("error")
        entries.append(entry)

    total_credits = sum(e["credits"] for e in entries if isinstance(e.get("credits"), int))
    total_bytes = sum(e["bytes"] for e in entries if isinstance(e.get("bytes"), int))
    ok_count = sum(1 for e in entries if e.get("triangles"))
    return {
        "assetsVersion": f"{ASSETS_VERSION_DATE}.vessels-{time.strftime('%H%M%S')}",
        "generatedAt": now_local(),
        "pipeline": {"name": "vessel_glb_pipeline.py", "version": PIPELINE_VERSION,
                     "textureCompression": "baseColor 1024 q82 / normal 1024 q90 / metallicRoughness 512 q75；有 alpha 则保留 PNG"},
        "plan": rel(PLAN_FILE),
        "source": "Aholo Lux3D text-to-3D（G1 / photorealistic / faceCount 30000）",
        "count": len(entries),
        "ok": ok_count,
        "creditsTotal": total_credits,
        "bytesTotal": total_bytes,
        "targetMaxBytes": TARGET_MAX_BYTES,
        "assets": entries,
    }


def copy_to_app(reports: list[dict]) -> list[str]:
    APP_VESSELS_DIR.mkdir(parents=True, exist_ok=True)
    copied = []
    for report in reports:
        if report.get("status") != "ok":
            continue
        src = PROCESSED_DIR / f"{report['id']}.glb"
        dst = APP_VESSELS_DIR / f"{report['id']}.glb"
        shutil.copy2(src, dst)
        copied.append(rel(dst))
    return copied


def cmd_prepare_all(args) -> int:
    if fg_module.Image is None:
        raise SystemExit("缺少 Pillow：请先安装 Pillow（系统 python 已带）")
    plan = read_json(PLAN_FILE, {})
    if not plan or not plan.get("species"):
        raise SystemExit(f"计划文件没有 species：{PLAN_FILE}")
    wanted = {s.strip() for s in args.only.split(",") if s.strip()} if args.only else None
    specs = [s for s in plan["species"] if wanted is None or s["family"] in wanted]
    if wanted:
        missing = wanted - {s["family"] for s in specs}
        if missing:
            raise SystemExit(f"--only 里有计划中不存在的 id：{sorted(missing)}")

    batch = batch_rows()
    reports = []
    for spec in specs:
        generation = generation_of(spec, batch)
        try:
            report = prepare_one(fg_module, spec, generation, force=args.force)
        except Exception as exc:  # 单件失败不掩盖，继续其余，最终如实写进 manifest
            report = {
                "id": spec["family"],
                "status": "error",
                "error": f"{type(exc).__name__}: {exc}",
                "generation": generation,
                "parameters": {"targetHeightM": float(spec["targetHeightM"]), "prompt_sha256": sha256_bytes(spec["prompt"].strip().encode("utf-8"))},
            }
            print(f"[prepare] {spec['family']} 失败：{report['error']}")
        reports.append(report)

    # --only 时把没参与本次跑动的既有证据合并回来，保证 manifest 始终覆盖全计划
    if wanted is not None:
        merged: list[dict] = []
        for spec in plan["species"]:
            if spec["family"] in wanted:
                merged.append(reports[[s["family"] for s in specs].index(spec["family"])])
            else:
                previous = read_json(PROCESSED_DIR / f"{spec['family']}.measure.json", None)
                merged.append(previous or {"id": spec["family"], "status": "missing",
                                           "error": "本次 --only 未运行，也没有旧证据",
                                           "parameters": {"targetHeightM": float(spec["targetHeightM"]),
                                                          "prompt_sha256": sha256_bytes(spec["prompt"].strip().encode("utf-8"))}})
        reports = merged

    manifest = build_manifest(plan, reports)
    write_json(MANIFEST_LOCAL, manifest)
    copied = copy_to_app(reports)
    write_json(APP_MANIFEST, manifest)
    print(f"[manifest] {manifest['ok']}/{manifest['count']} 件就位，已知积分 {manifest['creditsTotal']}，"
          f"合计 {manifest['bytesTotal']/1e6:.2f} MB")
    print(f"[manifest] 本地 {rel(MANIFEST_LOCAL)}；入库 {rel(APP_MANIFEST)}；复制 {len(copied)} 个 GLB")
    for entry in manifest["assets"]:
        flag = "OK" if entry.get("triangles") else "MISSING"
        print(f"  {entry['id']:16s} {flag:8s} task={entry.get('taskId')} credits={entry.get('credits')} "
              f"{entry.get('bytes')} bytes tris={entry.get('triangles')}")
    return 0 if manifest["ok"] == manifest["count"] else 2


def cmd_report(args) -> int:
    manifest = read_json(MANIFEST_LOCAL, None)
    if not manifest:
        print("还没有 vessels-manifest.json，先跑 prepare-all")
        return 1
    print(f"assetsVersion={manifest['assetsVersion']}  {manifest['ok']}/{manifest['count']}  "
          f"credits={manifest['creditsTotal']}  bytes={manifest['bytesTotal']}")
    for e in manifest["assets"]:
        print(f"{e['id']:16s} tris={str(e.get('triangles')):>7s} bytes={str(e.get('bytes')):>9s} "
              f"target={e.get('targetHeightM')} task={e.get('taskId')} credits={e.get('credits')}")
    return 0


fg_module = None


def main() -> int:
    global fg_module
    parser = argparse.ArgumentParser(description="Lux3D 花器资产管线（贴图压缩 + GLB 重写 + manifest）")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_prepare = sub.add_parser("prepare-all")
    p_prepare.add_argument("--only", default="")
    p_prepare.add_argument("--force", action="store_true")
    sub.add_parser("report")
    args = parser.parse_args()
    fg_module = load_flower_pipeline()
    if args.cmd == "prepare-all":
        return cmd_prepare_all(args)
    return cmd_report(args)


if __name__ == "__main__":
    raise SystemExit(main())
