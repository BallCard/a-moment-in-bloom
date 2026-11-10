#!/usr/bin/env python3
"""用 ModelScope API-Inference 的 ACE-Step 生成「花间一刻」背景音乐，并做循环/响度处理。

背景（V16 音乐轮）：用户明确授权「音乐直接调 api 做」。本脚本是当时**真实调用**的
可复现记录，不是 mock：

- 接口：`POST https://api-inference.modelscope.cn/v1/audios/generations`（异步模式，
  请求头 `X-ModelScope-Async-Mode: true`），任务查询 `GET /v1/tasks/{task_id}`
  （请求头 `X-ModelScope-Task-Type: audio_generation`）。
  官方文档：https://www.modelscope.cn/docs/model-service/API-Inference/intro （音频推理一节）
- 模型：`ACE-Step/acestep-v15-xl-sft`（ACE-Step 1.5 XL SFT，4B DiT，text2audio，
  模型卡 license: mit；模型页 https://modelscope.cn/models/ACE-Step/acestep-v15-xl-sft）
- 计费：API-Inference 是魔搭面向注册用户提供的**免费**推理服务（官方使用限制文档
  https://www.modelscope.cn/docs/model-service/API-Inference/limits 说明免费、按魔粒档位
  做额度管理）。本脚本不读取账户余额，费用结论见 docs/v16-music-api-record.md。

密钥只从本机 `~/.modelscope/api-key.txt` 或环境变量 `MODELSCOPE_API_KEY` 读取，
不写进仓库、不打印。

子命令：
  generate  提交任务并轮询到 SUCCEED / FAILED，下载原始音频
  fetch     只下载已有任务产物
  process   裁剪尾部静音 → 交叉淡化循环 → 两遍 loudnorm → 192k mp3
  all       generate + process 一条龙

用法示例（真实使用过）：
  python scripts/make_music_api.py all \
    --prompt "温暖安静的原声音乐……无人声，适合花艺工作台长时间循环播放" \
    --duration 45 --raw app/.verify/v16-music/api/ambient-calm-1-raw.mp3 \
    --out app/public/assets/audio/ambient-calm-1.mp3 \
    --record app/.verify/v16-music/api/ambient-calm-1-record.json
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

BASE_URL = "https://api-inference.modelscope.cn"
AUDIO_ENDPOINT = f"{BASE_URL}/v1/audios/generations"
TASK_ENDPOINT = f"{BASE_URL}/v1/tasks/"
DEFAULT_MODEL = "ACE-Step/acestep-v15-xl-sft"
MODEL_LICENSE = "mit"
MODEL_URL = "https://modelscope.cn/models/ACE-Step/acestep-v15-xl-sft"
DOC_URL = "https://www.modelscope.cn/docs/model-service/API-Inference/intro"
LIMITS_URL = "https://www.modelscope.cn/docs/model-service/API-Inference/limits"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_key() -> str:
    key = os.environ.get("MODELSCOPE_API_KEY", "").strip()
    if key:
        return key
    path = Path.home() / ".modelscope" / "api-key.txt"
    if not path.is_file():
        sys.exit(f"缺少 ModelScope 访问令牌：{path} 不存在，且未设置 MODELSCOPE_API_KEY")
    key = path.read_text(encoding="utf-8").strip()
    if not key:
        sys.exit(f"令牌文件为空：{path}")
    return key


def http_json(url: str, key: str, *, method: str = "GET", payload: dict | None = None,
              extra_headers: dict | None = None, timeout: int = 90) -> tuple[int, dict, dict]:
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(body) if body else {}
            except json.JSONDecodeError:
                parsed = {"_raw": body}
            return response.status, dict(response.headers), parsed
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            parsed = {"_raw": body}
        return error.code, dict(error.headers or {}), parsed


def download(url: str, out_path: Path, timeout: int = 180) -> dict:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with urllib.request.urlopen(url, timeout=timeout) as response:
        payload = response.read()
    out_path.write_bytes(payload)
    return {
        "url": url,
        "file": str(out_path),
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "seconds": round(time.time() - started, 2),
        "http_status": 200,
    }


def submit(prompt: str, duration: int, model: str, key: str) -> dict:
    payload = {"model": model, "prompt": prompt, "duration": duration}
    status, headers, body = http_json(
        AUDIO_ENDPOINT, key, method="POST", payload=payload,
        extra_headers={"X-ModelScope-Async-Mode": "true"},
    )
    record = {
        "at": now_iso(),
        "endpoint": AUDIO_ENDPOINT,
        "model": model,
        "request": payload,
        "http_status": status,
        "response": body,
        "response_headers": {
            pair: headers.get(pair)
            for pair in ("HTTP/1.1", "Date", "Content-Type", "Content-Length")
            if headers.get(pair)
        },
    }
    if status != 200 or body.get("status") == "FAILED" or not body.get("task_id"):
        raise RuntimeError(f"提交失败 HTTP {status}: {body}")
    return record


def poll(task_id: str, key: str, interval: float = 4.0, timeout: float = 600.0) -> dict:
    started = time.time()
    deadline = started + timeout
    history = []
    while True:
        status, _headers, body = http_json(
            TASK_ENDPOINT + task_id, key,
            extra_headers={"X-ModelScope-Task-Type": "audio_generation"},
        )
        task_status = body.get("task_status") or body.get("status")
        history.append({
            "at": now_iso(),
            "elapsed_s": round(time.time() - started, 2),
            "http_status": status,
            "task_status": task_status,
        })
        if task_status in ("SUCCEED", "FAILED"):
            return {
                "task_id": task_id,
                "task_status": task_status,
                "elapsed_s": round(time.time() - started, 2),
                "final": body,
                "history": history,
            }
        if time.time() > deadline:
            raise RuntimeError(f"轮询超时（{timeout:.0f}s），最后状态 {task_status}: {body}")
        time.sleep(interval)


def ffprobe(path: Path) -> dict:
    completed = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration,bit_rate,format_name",
         "-show_entries", "stream=codec_name,sample_rate,channels",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(completed.stdout)


def detect_trailing_silence(path: Path, threshold_db: float = -40.0, min_silence: float = 0.4) -> float | None:
    completed = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-af", f"silencedetect=noise={threshold_db}dB:d={min_silence}", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    starts = [float(m.group(1)) for m in re.finditer(r"silence_start: ([0-9.]+)", completed.stderr)]
    ends = [float(m.group(1)) for m in re.finditer(r"silence_end: ([0-9.]+)", completed.stderr)]
    info = ffprobe(path)
    duration = float(info["format"]["duration"])
    if not starts:
        return None
    if ends and ends[-1] >= duration - 0.05:
        return starts[-1]
    return None


def measure_loudness(path: Path) -> dict:
    completed = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    match = re.search(r"\{\s*\"input_i\".*?\}", completed.stderr, re.S)
    if not match:
        raise RuntimeError("loudnorm 测量失败：\n" + completed.stderr[-2000:])
    return json.loads(match.group(0))


def process_audio(raw: Path, out_path: Path, crossfade: float, lufs: float,
                  true_peak: float, bitrate: str, title: str, task_meta: dict) -> dict:
    if not raw.is_file():
        raise SystemExit(f"找不到输入文件：{raw}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    raw_info = ffprobe(raw)
    raw_duration = float(raw_info["format"]["duration"])
    trailing_silence = detect_trailing_silence(raw)
    trimmed_end = trailing_silence if trailing_silence is not None else raw_duration
    # 至少保留 30 秒可循环素材：交叉淡化后长度 = trimmed_end - crossfade
    fade = min(crossfade, max(1.0, trimmed_end - 31.0))
    loop_duration = trimmed_end - fade
    if loop_duration < 30.0 or loop_duration > 61.0:
        raise SystemExit(f"处理后长度 {loop_duration:.2f}s 不在 30–60s 内，请调整参数")

    tmp_fade = out_path.with_suffix(".loop.wav")
    # tail 必须恰好取 fade 秒：acrossfade 输出长度 = len(tail) + len(head) - fade，
    # 若 tail 带上整段尾部，输出会多出 (len(tail) - fade) 秒。
    tail_start = trimmed_end - fade
    filter_graph = (
        f"[0:a]atrim=end={fade:.3f},asetpts=PTS-STARTPTS[head];"
        f"[0:a]atrim=start={tail_start:.3f}:end={trimmed_end:.3f},asetpts=PTS-STARTPTS[tail];"
        f"[tail][head]acrossfade=d={fade:.3f}:c1=tri:c2=tri[blend];"
        f"[0:a]atrim=start={fade:.3f}:end={tail_start:.3f},asetpts=PTS-STARTPTS[mid];"
        f"[blend][mid]concat=n=2:v=0:a=1[out]"
    )
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw),
         "-filter_complex", filter_graph, "-map", "[out]",
         "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(tmp_fade)],
        check=True,
    )

    measured = measure_loudness(tmp_fade)
    loudnorm = (
        f"loudnorm=I={lufs}:TP={true_peak}:LRA=11"
        f":measured_I={measured['input_i']}"
        f":measured_LRA={measured['input_lra']}"
        f":measured_TP={measured['input_tp']}"
        f":measured_thresh={measured['input_thresh']}"
        f":offset={measured.get('target_offset', '0')}:linear=true"
    )
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(tmp_fade),
         "-af", loudnorm, "-ar", "48000", "-ac", "2", "-c:a", "libmp3lame", "-b:a", bitrate,
         "-metadata", f"title={title}",
         "-metadata", "artist=ACE-Step (ModelScope API-Inference)",
         "-metadata", f"comment=Generated by {task_meta.get('model', DEFAULT_MODEL)}; "
                      f"model license {MODEL_LICENSE}; task {task_meta.get('task_id', '?')}; "
                      f"free ModelScope API-Inference; loop edited with ffmpeg",
         str(out_path)],
        check=True,
    )
    out_info = ffprobe(out_path)
    out_duration = float(out_info["format"]["duration"])
    tmp_fade.unlink(missing_ok=True)
    md = hashlib.sha256(out_path.read_bytes()).hexdigest()
    return {
        "source": str(raw),
        "output": str(out_path),
        "source_duration_s": raw_duration,
        "trailing_silence_s": round(trailing_silence, 3) if trailing_silence else 0.0,
        "crossfade_s": fade,
        "loop_duration_s": round(loop_duration, 3),
        "output_duration_s": round(out_duration, 3),
        "loudnorm": {
            "target_i": lufs,
            "target_tp": true_peak,
            "measured_input_i": float(measured["input_i"]),
            "measured_input_tp": float(measured["input_tp"]),
        },
        "bitrate": bitrate,
        "codec": out_info["streams"][0]["codec_name"],
        "sample_rate": int(out_info["streams"][0]["sample_rate"]),
        "channels": int(out_info["streams"][0]["channels"]),
        "bytes": out_path.stat().st_size,
        "sha256": md,
        "loop_note": (
            "首尾交叉淡化构成可循环文件：输出开头是原曲尾部淡出与原曲开头的混合，"
            "循环点两侧数值连续；未做人工试听验收。"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="ACE-Step 背景音乐生成（ModelScope API-Inference）")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate", help="提交并下载原始音频")
    gen.add_argument("--prompt", required=True)
    gen.add_argument("--duration", type=int, default=45, choices=range(30, 61),
                     metavar="30-60")
    gen.add_argument("--model", default=DEFAULT_MODEL)
    gen.add_argument("--raw", required=True, help="原始音频输出路径")
    gen.add_argument("--record", required=True, help="记录 JSON 路径")

    fetch = sub.add_parser("fetch", help="下载已有任务产物")
    fetch.add_argument("--url", required=True)
    fetch.add_argument("--raw", required=True)

    proc = sub.add_parser("process", help="循环与响度处理")
    proc.add_argument("--in", dest="inp", required=True)
    proc.add_argument("--out", required=True)
    proc.add_argument("--crossfade", type=float, default=3.0)
    proc.add_argument("--lufs", type=float, default=-16.0)
    proc.add_argument("--true-peak", type=float, default=-2.0)
    proc.add_argument("--bitrate", default="192k")
    proc.add_argument("--title", default="花间一刻 · 背景音乐")
    proc.add_argument("--task-id", default=None, help="把生成任务 id 写进音频 comment 便于溯源")
    proc.add_argument("--record", required=True)

    full = sub.add_parser("all", help="生成并处理")
    full.add_argument("--prompt", required=True)
    full.add_argument("--duration", type=int, default=45)
    full.add_argument("--model", default=DEFAULT_MODEL)
    full.add_argument("--raw", required=True)
    full.add_argument("--out", required=True)
    full.add_argument("--record", required=True)
    full.add_argument("--crossfade", type=float, default=3.0)
    full.add_argument("--lufs", type=float, default=-16.0)
    full.add_argument("--true-peak", type=float, default=-2.0)
    full.add_argument("--bitrate", default="192k")
    full.add_argument("--title", default="花间一刻 · 背景音乐")

    args = parser.parse_args()
    key = read_key()

    if args.command == "fetch":
        info = download(args.url, Path(args.raw))
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0

    if args.command == "process":
        record = {
            "processed_at": now_iso(),
            "model": DEFAULT_MODEL,
            "model_license": MODEL_LICENSE,
            "task_id": args.task_id,
            "source": {"url": None, "task_id": args.task_id},
        }
        result = process_audio(Path(args.inp), Path(args.out), args.crossfade, args.lufs,
                               args.true_peak, args.bitrate, args.title, record)
        record.update({"command": "process", "result": result})
        out_record = Path(args.record)
        out_record.parent.mkdir(parents=True, exist_ok=True)
        out_record.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    submitted = submit(args.prompt, args.duration, args.model, key)
    task = poll(submitted["response"]["task_id"], key)
    if task["task_status"] != "SUCCEED":
        raise SystemExit(f"生成失败：{json.dumps(task['final'], ensure_ascii=False)}")
    audio_url = task["final"]["outputs"]["url"]
    download_info = download(audio_url, Path(args.raw))
    record = {
        "generated_at": now_iso(),
        "provider": "ModelScope API-Inference",
        "endpoint": AUDIO_ENDPOINT,
        "model": args.model,
        "model_license": MODEL_LICENSE,
        "model_url": MODEL_URL,
        "docs_url": DOC_URL,
        "limits_url": LIMITS_URL,
        "pricing_note": "API-Inference 为平台免费推理服务，按魔粒档位做额度管理；未从响应读到扣费字段。",
        "prompt": args.prompt,
        "duration_requested_s": args.duration,
        "submit": submitted,
        "task": task,
        "download": download_info,
    }
    if args.command == "all":
        result = process_audio(Path(args.raw), Path(args.out), args.crossfade, args.lufs,
                               args.true_peak, args.bitrate, args.title, task)
        record["process"] = result

    out_record = Path(args.record)
    out_record.parent.mkdir(parents=True, exist_ok=True)
    out_record.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
