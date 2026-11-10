#!/usr/bin/env python
"""Aholo Lux3D 文生 3D 任务的创建、轮询与下载工具（仅标准库）。

真实调用会消耗账号积分，因此：
- 创建任务前先把意图写入 `intent.json`，创建成功后记录 `create_response.json`；
- 创建请求超时不会自动重发（`create` 命令不做重试），只能人工判断后重新执行；
- 轮询写入 `polls.jsonl`（含时间戳与状态），下载结果记录到 `run.json`。

用法：
    python scripts/lux3d_generate.py run    --run-id 20261105-tulip-pink --prompt-file assets/local/prompts/tulip.txt
    python scripts/lux3d_generate.py create --run-id ... --prompt-file ...
    python scripts/lux3d_generate.py poll   --run-id ...
    python scripts/lux3d_generate.py download --run-id ...

API Key 读取顺序：--key-file → 环境变量 AHOLO_API_KEY → %USERPROFILE%\\.aholo\\api-key.txt。
不要把密钥写进仓库或提交到 Git。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

API_BASE = "https://api.aholo3d.cn"
CREATE_PATH = "/lux3d/v1/generate/text-to-3d/task/create"
GET_PATH = "/lux3d/v1/generate/task/get"

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNS_DIR = PROJECT_ROOT / "assets" / "local" / "runs"
RAW_DIR = PROJECT_ROOT / "assets" / "local" / "raw"

STATUS_NAMES = {0: "init", 1: "running", 3: "succeeded", 4: "failed", 6: "cancelled"}


def resolve_key(args) -> str:
    if args.key_file:
        return pathlib.Path(args.key_file).read_text(encoding="utf-8").strip()
    env_key = os.environ.get("AHOLO_API_KEY", "").strip()
    if env_key:
        return env_key
    default = pathlib.Path(os.path.expanduser("~")) / ".aholo" / "api-key.txt"
    if default.exists():
        return default.read_text(encoding="utf-8").strip()
    raise SystemExit("未找到 API Key：请用 --key-file、AHOLO_API_KEY 或 ~/.aholo/api-key.txt 提供。")


def request_json(method: str, path: str, key: str, payload: dict | None = None, timeout: int = 60):
    url = API_BASE + path
    data = None
    headers = {"Authorization": key, "Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
        return resp.status, body


def run_dir(run_id: str) -> pathlib.Path:
    d = RUNS_DIR / run_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_json(path: pathlib.Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def cmd_create(args) -> int:
    d = run_dir(args.run_id)
    prompt = pathlib.Path(args.prompt_file).read_text(encoding="utf-8").strip()
    payload = {
        "prompt": prompt,
        "style": args.style,
        "version": args.version,
        "faceCount": args.face_count,
        "outputFormat": args.formats,
        "aiPredictSize": args.ai_predict_size,
    }
    intent = {
        "run_id": args.run_id,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "endpoint": API_BASE + CREATE_PATH,
        "payload": payload,
        "prompt_file": str(pathlib.Path(args.prompt_file).resolve()),
        "note": "若 create 超时或返回未知结果，先执行 poll/list 确认是否已创建，禁止盲目重发。",
    }
    write_json(d / "intent.json", intent)
    print(f"[intent] {d / 'intent.json'}")
    try:
        status, body = request_json("POST", CREATE_PATH, resolve_key(args), payload)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        write_json(d / "create_response.json", {"http_status": exc.code, "body": body})
        print(f"[create] HTTP {exc.code}: {body}")
        return 2
    except Exception as exc:  # 网络超时等：不重试
        write_json(d / "create_response.json", {"error": str(exc), "timeout_or_network": True})
        print(f"[create] 网络异常，未自动重发：{exc}")
        return 3
    record = {"http_status": status, "received_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "body": body}
    write_json(d / "create_response.json", record)
    print(f"[create] HTTP {status}: {body}")
    try:
        parsed = json.loads(body)
        if parsed.get("c") != "0":
            print(f"[create] 业务失败 c={parsed.get('c')} m={parsed.get('m')}，未得到 taskId")
            return 4
        write_json(d / "task.json", {"taskId": parsed["d"], "run_id": args.run_id})
        print(f"[create] taskId={parsed['d']}")
    except Exception as exc:
        print(f"[create] 响应解析失败：{exc}")
        return 5
    return 0


def cmd_poll(args) -> int:
    d = run_dir(args.run_id)
    task = json.loads((d / "task.json").read_text(encoding="utf-8"))
    task_id = task["taskId"]
    key = resolve_key(args)
    started = time.time()
    last_status = None
    with (d / "polls.jsonl").open("a", encoding="utf-8") as log:
        while True:
            elapsed = time.time() - started
            stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            try:
                status, body = request_json("GET", f"{GET_PATH}?taskid={task_id}", key)
                parsed = json.loads(body)
                data = parsed.get("d") or {}
                st = data.get("status")
                name = STATUS_NAMES.get(st, f"unknown({st})")
                entry = {"at": stamp, "elapsed_s": round(elapsed, 1), "http": status, "c": parsed.get("c"), "status": st, "status_name": name}
                log.write(json.dumps(entry, ensure_ascii=False) + "\n")
                log.flush()
                print(f"[poll] +{elapsed:6.1f}s status={name}")
                if st != last_status:
                    last_status = st
                if st in (3, 4, 6):
                    write_json(d / "task_result.json", {"at": stamp, "elapsed_s": round(elapsed, 1), "response": parsed})
                    print(f"[poll] 终态 {name}，已写 task_result.json（总耗时 {elapsed:.1f}s）")
                    return 0 if st == 3 else 6
            except Exception as exc:
                entry = {"at": stamp, "elapsed_s": round(elapsed, 1), "error": str(exc)}
                log.write(json.dumps(entry, ensure_ascii=False) + "\n")
                log.flush()
                print(f"[poll] +{elapsed:6.1f}s 查询异常（继续限频重试）：{exc}")
            if elapsed > args.timeout:
                print(f"[poll] 超过 {args.timeout}s 未到终态，停止轮询；稍后可再执行 poll。")
                return 7
            time.sleep(args.interval)


def cmd_download(args) -> int:
    d = run_dir(args.run_id)
    result = json.loads((d / "task_result.json").read_text(encoding="utf-8"))
    data = result["response"].get("d") or {}
    outputs = data.get("outputs") or []
    if not outputs:
        print("[download] 结果里没有 outputs")
        return 2
    saved = []
    for idx, out in enumerate(outputs):
        content = (out or {}).get("content")
        if not content or content == "NOT_REQUESTED" or not str(content).startswith("http"):
            continue
        lower = content.lower()
        ext = ".glb" if ".glb" in lower else ".zip" if ".zip" in lower else ".ply" if ".ply" in lower else ".bin"
        target = RAW_DIR / f"{args.run_id}-{idx}{ext}"
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(content, timeout=180) as resp:
            blob = resp.read()
        target.write_bytes(blob)
        saved.append({
            "index": idx,
            "url_expires": "官方说明结果 URL 有效期 2 小时，需及时下载",
            "path": str(target.relative_to(PROJECT_ROOT)),
            "bytes": len(blob),
            "sha256": hashlib.sha256(blob).hexdigest(),
        })
        print(f"[download] {target} ({len(blob)} bytes)")
    write_json(d / "downloads.json", {"downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "files": saved})
    return 0 if saved else 3


def cmd_show(args) -> int:
    d = run_dir(args.run_id)
    for name in ("intent.json", "create_response.json", "task.json", "polls.jsonl", "task_result.json", "downloads.json"):
        p = d / name
        if p.exists():
            print(f"--- {name} ---")
            text = p.read_text(encoding="utf-8")
            print(text if len(text) < 4000 else text[:4000] + "…")
    return 0


def cmd_run(args) -> int:
    rc = cmd_create(args)
    if rc != 0:
        return rc
    rc = cmd_poll(args)
    if rc != 0:
        return rc
    return cmd_download(args)


def main() -> int:
    parser = argparse.ArgumentParser(description="Aholo Lux3D 文生 3D 任务工具")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def add_common(p):
        p.add_argument("--run-id", required=True, help="本次运行的目录名，如 20261105-tulip-pink")
        p.add_argument("--key-file", help="API Key 文件路径；默认 ~/.aholo/api-key.txt 或 AHOLO_API_KEY")

    for name, fn in (("create", cmd_create), ("poll", cmd_poll), ("download", cmd_download), ("show", cmd_show), ("run", cmd_run)):
        p = sub.add_parser(name)
        add_common(p)
        if name in ("create", "run"):
            p.add_argument("--prompt-file", required=True)
            p.add_argument("--style", default="photorealistic")
            p.add_argument("--version", default="G1", choices=["G1", "G1-Turbo"])
            p.add_argument("--face-count", type=int, default=60000)
            p.add_argument("--formats", nargs="+", default=["glb"])
            p.add_argument("--ai-predict-size", action="store_true", default=True)
        if name in ("poll", "run"):
            p.add_argument("--interval", type=int, default=15, help="轮询间隔秒")
            p.add_argument("--timeout", type=int, default=900, help="最长等待秒")

    args = parser.parse_args()
    return {"create": cmd_create, "poll": cmd_poll, "download": cmd_download, "show": cmd_show, "run": cmd_run}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
