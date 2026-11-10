"""Copy the three supplied training files and extract PPTX text without executing content."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import zipfile
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
FILES = ("Readme.txt", "aholo内训ppt.pptx", "Aholo内训720p.mp4")
NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def paragraphs(data: bytes) -> list[str]:
    return [
        "".join(t.text or "" for t in p.findall(".//a:t", NS))
        for p in ET.fromstring(data).findall(".//a:p", NS)
        if p.findall(".//a:t", NS)
    ]


def ingest(source: Path) -> dict:
    source = source.resolve(strict=True)
    # Check every input before starting the copy.
    for name in FILES:
        if not (source / name).is_file():
            raise ValueError(f"缺少输入文件：{name}")
    private = ROOT / "materials/private"
    originals = private / "originals"
    originals.mkdir(parents=True, exist_ok=True)
    manifest = {"processed_at": datetime.now().astimezone().isoformat(), "files": []}
    for name in FILES:
        src, dst = source / name, originals / name
        sha = digest(src)
        if dst.exists():
            if digest(dst) != sha:
                raise ValueError(f"归档中已有不同内容的同名文件，未覆盖：{dst}")
        else:
            shutil.copy2(src, dst)
        if digest(dst) != sha:
            raise ValueError(f"副本校验失败：{name}")
        manifest["files"].append({"source": str(src), "archive": str(dst.relative_to(ROOT)),
                                  "bytes": src.stat().st_size, "sha256": sha})
    slides = []
    with zipfile.ZipFile(originals / FILES[1]) as package:
        names = set(package.namelist())
        ordered = sorted((n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                         key=lambda n: int(re.search(r"slide(\d+)", n)[1]))
        for number, name in enumerate(ordered, 1):
            text = paragraphs(package.read(name))
            notes, links = [], []
            relpath = f"ppt/slides/_rels/slide{number}.xml.rels"
            if relpath in names:
                for rel in ET.fromstring(package.read(relpath)):
                    target = rel.attrib.get("Target", "")
                    if rel.attrib.get("TargetMode") == "External":
                        links.append(target)
                    if rel.attrib.get("Type", "").endswith("/notesSlide"):
                        note_name = "ppt/notesSlides/" + target.rsplit("/", 1)[-1]
                        if note_name in names:
                            notes = paragraphs(package.read(note_name))
            slides.append({"slide": number, "paragraphs": text, "notes": notes,
                           "external_links": links})
    manifest["slides"] = len(slides)
    (private / "training-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (private / "training-slides.json").write_text(
        json.dumps(slides, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# 培训 PPT 逐页文字摘录（仅本地）", "",
             "来源：归档 PPT。以下含讲者备注；不是独立验证结论。图像、动画与嵌入视频未转录。", ""]
    for slide in slides:
        lines.extend([f"## 第 {slide['slide']} 页", "", *slide["paragraphs"], ""])
        if not slide["paragraphs"]:
            lines.extend(["本页无可提取文字，需回看原稿。", ""])
        if slide["notes"]:
            lines.extend(["### 讲者备注（来源原文）", "", *slide["notes"], ""])
        if slide["external_links"]:
            lines.extend(["### 外部链接（未执行）", "",
                          *[f"- {url}" for url in slide["external_links"]], ""])
    (private / "training-slides.md").write_text("\n".join(lines), encoding="utf-8")
    return {"archived_files": len(FILES), "slides": len(slides),
            "verified_sha256": True, "output": str(private)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(ingest(args.source_dir), ensure_ascii=False, indent=2))
    except (OSError, ValueError, zipfile.BadZipFile, ET.ParseError) as error:
        parser.exit(1, f"资料导入失败：{error}\n")
