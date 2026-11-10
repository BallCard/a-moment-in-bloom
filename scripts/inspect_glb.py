"""Read a GLB 2 container and report metadata; this is not a renderer or glTF validator."""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path


def inspect(path: Path) -> dict:
    size = path.stat().st_size
    with path.open("rb") as stream:
        header = stream.read(12)
        if len(header) != 12:
            raise ValueError("GLB 文件头不完整")
        magic, version, total = struct.unpack("<4sII", header)
        if magic != b"glTF" or version != 2:
            raise ValueError("只支持 GLB 2 文件")
        if total != size:
            raise ValueError("GLB 声明长度与实际文件长度不一致")
        model = None
        chunks = []
        while stream.tell() < size:
            chunk_header = stream.read(8)
            if len(chunk_header) != 8:
                raise ValueError("GLB 块头不完整")
            length, kind = struct.unpack("<I4s", chunk_header)
            if length % 4 or stream.tell() + length > size:
                raise ValueError("GLB 块长度越界或未按 4 字节对齐")
            if not chunks and kind != b"JSON":
                raise ValueError("首个 GLB 块必须是 JSON")
            if kind == b"JSON":
                if model is not None:
                    raise ValueError("GLB 含重复 JSON 块")
                if length > 64 * 1024 * 1024:
                    raise ValueError("JSON 元数据超过本工具 64 MiB 限制")
                model = json.loads(stream.read(length).decode("utf-8"))
            else:
                stream.seek(length, 1)
            chunks.append({"type": kind.decode("ascii", errors="replace"), "bytes": length})
    if not isinstance(model, dict) or model.get("asset", {}).get("version") != "2.0":
        raise ValueError("缺少 glTF 2.0 JSON 元数据")
    meshes = model.get("meshes", [])
    accessors = model.get("accessors", [])
    geometry = []
    for mi, mesh in enumerate(meshes):
        for pi, primitive in enumerate(mesh.get("primitives", [])):
            attributes = primitive.get("attributes", {})
            position = attributes.get("POSITION")
            if position is not None and (not isinstance(position, int) or not 0 <= position < len(accessors)):
                raise ValueError("POSITION accessor 索引无效")
            acc = accessors[position] if position is not None else {}
            geometry.append({"mesh": mi, "primitive": pi, "attributes": list(attributes),
                             "position_count": acc.get("count"), "mode": primitive.get("mode", 4),
                             "accessor_local_min": acc.get("min"),
                             "accessor_local_max": acc.get("max"), "material": primitive.get("material")})
    materials = []
    for material in model.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        materials.append({"name": material.get("name"),
                          "metallicFactor": pbr.get("metallicFactor", 1),
                          "roughnessFactor": pbr.get("roughnessFactor", 1),
                          "baseColorTexture": "baseColorTexture" in pbr,
                          "metallicRoughnessTexture": "metallicRoughnessTexture" in pbr,
                          "normalTexture": "normalTexture" in material,
                          "extensions": list(material.get("extensions", {}))})
    return {"file": path.name, "bytes": size, "chunks": chunks,
            "mesh_count": len(meshes), "node_count": len(model.get("nodes", [])),
            "animation_count": len(model.get("animations", [])),
            "skin_count": len(model.get("skins", [])), "geometry": geometry,
            "materials": materials, "extensions_required": model.get("extensionsRequired", []),
            "limits": "仅检查封装及部分元数据；边界来自 accessor，未应用节点变换；"
                      "不解码几何/贴图，不证明文件完整有效或视觉正确。"
                      "材质最终值还需结合贴图；不能仅凭 metallicFactor 判断金属。"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.file), ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, struct.error) as error:
        parser.exit(1, f"GLB 检查失败：{error}\n")
