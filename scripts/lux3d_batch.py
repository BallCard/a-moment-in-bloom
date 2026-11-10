#!/usr/bin/env python
"""Aholo Lux3D 文生 3D 批量任务工具（仅标准库）。

用途：把 `assets/local/species-plan.json` 里的 27 种花材逐个提交给 Lux3D，
轮询、下载 GLB，并把每个任务的全过程证据落到 `assets/local/runs/<runId>/`。

安全约束（沿用项目规则）：
- 创建请求**永不自动重发**：网络异常/超时只记录并停下来，等人工核对
  `task/list` 后再决定；避免重复扣积分。
- 每个任务的意图（prompt 与参数）在创建前先写盘（intent.json），创建成功
  立刻写 task.json；轮询写 polls.jsonl；结果写 task_result.json；下载写
  downloads.json 与 generation.json。
- 并发上限自适应：先按 --max-concurrent 提交；如果服务端返回
  GENERATION_CONCURRENCY_LIMIT_EXCEEDED，就降到「当前在跑任务数」再试，
  不把这次尝试记成失败（该请求没有创建任务）。
- 积分不足（400 / 11003 / insufficient credits）时停止整批，不继续提交。

用法：
    python scripts/lux3d_batch.py --plan assets/local/species-plan.json
    python scripts/lux3d_batch.py --plan ... --only peony,lily
    python scripts/lux3d_batch.py --plan ... --status            # 只看进度
    python scripts/lux3d_batch.py --plan ... --reconcile         # 用 task/list 校准状态

API Key 读取顺序：--key-file → 环境变量 AHOLO_API_KEY → %USERPROFILE%\\.aholo\\api-key.txt。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import time
import urllib.error
import urllib.request

API_BASE = "https://api.aholo3d.cn"
CREATE_PATH = "/lux3d/v1/generate/text-to-3d/task/create"
GET_PATH = "/lux3d/v1/generate/task/get"
LIST_PATH = "/lux3d/v1/generate/task/list"

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNS_DIR = PROJECT_ROOT / "assets" / "local" / "runs"
RAW_DIR = PROJECT_ROOT / "assets" / "local" / "raw"
PROMPT_DIR = PROJECT_ROOT / "assets" / "local" / "prompts"

STATUS_NAMES = {0: "init", 1: "running", 3: "succeeded", 4: "failed", 6: "cancelled"}
TERMINAL = {3, 4, 6}

# 批次的本地状态：每 species 一条，脚本据此续跑，绝不会因为重启重复创建任务。
STATE_NAME = "batch-state.json"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


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
    with OPENER.open(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
        return resp.status, body


# 本机是 TUN 透明代理，直连即可出网；显式绕过环境变量里的 HTTP(S)_PROXY，
# 避免慢速/挂起的代理连接把批量下载卡死（实测代理偶发不返回数据）。
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_get_bytes(url: str, timeout: int = 180) -> bytes:
    with OPENER.open(url, timeout=timeout) as resp:
        return resp.read()


def write_json(path: pathlib.Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def read_json(path: pathlib.Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Batch:
    def __init__(self, args):
        self.args = args
        self.plan_path = pathlib.Path(args.plan)
        self.plan = read_json(self.plan_path)
        if not self.plan or not self.plan.get("species"):
            raise SystemExit(f"计划文件没有 species：{self.plan_path}")
        self.species = {s["family"]: s for s in self.plan["species"]}
        if args.only:
            wanted = {s.strip() for s in args.only.split(",") if s.strip()}
            missing = wanted - set(self.species)
            if missing:
                raise SystemExit(f"--only 里有计划中不存在的 family：{sorted(missing)}")
            self.order = [f for f in self.species if f in wanted]
        else:
            self.order = list(self.species)
        self.batch_dir = RUNS_DIR / args.batch_id
        self.batch_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.batch_dir / STATE_NAME
        self.state = read_json(self.state_path, {"batch_id": args.batch_id, "created_at": now_iso(), "items": {}, "log": []})
        self.key = resolve_key(args)
        self.max_concurrent = max(1, args.max_concurrent)
        self.stop_reason: str | None = None
        # 并发已满时的退避截止时间，避免每 3 秒撞一次 create 接口。
        self.busy_until = 0.0

    # ---------------- 状态 ----------------
    def item(self, family: str) -> dict:
        items = self.state["items"]
        if family not in items:
            items[family] = {"family": family, "status": "pending"}
        return items[family]

    def save(self) -> None:
        self.state["updated_at"] = now_iso()
        write_json(self.state_path, self.state)

    def note(self, msg: str) -> None:
        log(msg)
        self.state["log"].append({"at": now_iso(), "msg": msg})
        self.save()

    def run_dir(self, family: str) -> pathlib.Path:
        d = RUNS_DIR / self.species[family]["runId"]
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ---------------- 创建 ----------------
    def create(self, family: str) -> str:
        spec = self.species[family]
        item = self.item(family)
        d = self.run_dir(family)
        prompt = spec["prompt"].strip()
        payload = {
            "prompt": prompt,
            "style": "photorealistic",
            "version": "G1",
            "faceCount": int(spec.get("faceCount", 30000)),
            "outputFormat": ["glb"],
            "aiPredictSize": True,
        }
        PROMPT_DIR.mkdir(parents=True, exist_ok=True)
        prompt_file = PROMPT_DIR / f"{spec['runId']}.txt"
        prompt_file.write_text(prompt + "\n", encoding="utf-8")
        write_json(d / "intent.json", {
            "run_id": spec["runId"],
            "family": family,
            "created_at": now_iso(),
            "endpoint": API_BASE + CREATE_PATH,
            "payload": payload,
            "prompt_file": str(prompt_file.resolve().relative_to(PROJECT_ROOT)),
            "note": "create 超时/异常时禁止自动重发；先 task/list 核对是否已创建。",
        })
        item["status"] = "creating"
        self.save()
        try:
            status, body = request_json("POST", CREATE_PATH, self.key, payload)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            write_json(d / "create_response.json", {"http_status": exc.code, "body": raw, "at": now_iso()})
            item["status"] = "create_http_error"
            item["error"] = f"HTTP {exc.code}: {raw[:500]}"
            self.save()
            if "insufficient" in raw.lower() or "11003" in raw:
                self.stop_reason = f"积分不足（{family}）：{raw[:300]}"
            else:
                self.stop_reason = f"创建失败（{family}）：HTTP {exc.code} {raw[:200]}"
            return "error"
        except Exception as exc:  # 网络超时等：绝不重发
            write_json(d / "create_response.json", {"error": str(exc), "timeout_or_network": True, "at": now_iso()})
            item["status"] = "create_unknown"
            item["error"] = str(exc)
            self.save()
            self.stop_reason = f"创建请求异常，未自动重发（{family}）：{exc}；请先 task/list 核对"
            return "error"

        record = {"http_status": status, "received_at": now_iso(), "body": body}
        write_json(d / "create_response.json", record)
        try:
            parsed = json.loads(body)
        except Exception as exc:
            item["status"] = "create_unknown"
            item["error"] = f"响应解析失败：{exc} body={body[:300]}"
            self.save()
            self.stop_reason = f"创建响应无法解析（{family}）"
            return "error"

        code = str(parsed.get("c"))
        if code == "0":
            task_id = parsed.get("d")
            item.update({"status": "created", "taskId": task_id, "created_at": now_iso(),
                         "faceCount": payload["faceCount"]})
            write_json(d / "task.json", {"taskId": task_id, "run_id": spec["runId"], "family": family})
            self.save()
            self.note(f"创建成功 {family} taskId={task_id}")
            return "ok"
        message = parsed.get("m") or ""
        if "GENERATION_CONCURRENCY_LIMIT_EXCEEDED" in code or "并发" in message:
            item["status"] = "pending"
            self.save()
            log(f"并发已达上限，{family} 退避 {self.args.busy_backoff}s 后重试")
            return "busy"
        item["status"] = "create_error"
        item["error"] = f"c={code} m={message}"
        self.save()
        if "insufficient" in (code + message).lower() or "11003" in code or "积分" in message:
            self.stop_reason = f"积分不足：{code} {message}"
        else:
            self.stop_reason = f"创建失败（{family}）：c={code} m={message}"
        return "error"

    # ---------------- 轮询与下载 ----------------
    def poll(self, family: str) -> str:
        item = self.item(family)
        task_id = item.get("taskId")
        if task_id is None:
            return "no_task"
        d = self.run_dir(family)
        stamp = now_iso()
        try:
            status, body = request_json("GET", f"{GET_PATH}?taskid={task_id}", self.key, timeout=45)
            parsed = json.loads(body)
        except Exception as exc:
            with (d / "polls.jsonl").open("a", encoding="utf-8") as fp:
                fp.write(json.dumps({"at": stamp, "error": str(exc)}, ensure_ascii=False) + "\n")
            return "running"
        data = parsed.get("d") or {}
        st = data.get("status")
        with (d / "polls.jsonl").open("a", encoding="utf-8") as fp:
            fp.write(json.dumps({"at": stamp, "http": status, "c": parsed.get("c"),
                                 "status": st, "status_name": STATUS_NAMES.get(st, f"unknown({st})")},
                                ensure_ascii=False) + "\n")
        if st not in TERMINAL:
            item["status"] = "running"
            item["last_status"] = st
            self.save()
            return "running"
        write_json(d / "task_result.json", {"at": stamp, "response": parsed})
        if st == 3:
            item["status"] = "succeeded"
            item["succeeded_at"] = now_iso()
            self.save()
            self.note(f"生成成功 {family} taskId={task_id}")
            return self.download(family)
        item["status"] = "failed" if st == 4 else "cancelled"
        item["error"] = f"task status {st} {STATUS_NAMES.get(st)}"
        self.save()
        self.note(f"任务未成功 {family} status={st}")
        return "failed"

    def download(self, family: str) -> str:
        spec = self.species[family]
        item = self.item(family)
        d = self.run_dir(family)
        result = read_json(d / "task_result.json") or {}
        data = (result.get("response") or {}).get("d") or {}
        outputs = data.get("outputs") or []
        saved, skipped = [], []
        for idx, out in enumerate(outputs):
            content = (out or {}).get("content")
            if not content or content == "NOT_REQUESTED" or not str(content).startswith("http"):
                skipped.append({"index": idx, "reason": "no url"})
                continue
            lower = str(content).lower()
            if ".glb" not in lower:
                skipped.append({"index": idx, "reason": "非 GLB，批量只用 glb", "url_tail": lower[-40:]})
                continue
            target = RAW_DIR / f"{spec['runId']}-{idx}.glb"
            RAW_DIR.mkdir(parents=True, exist_ok=True)
            try:
                blob = http_get_bytes(content)
            except Exception as exc:
                skipped.append({"index": idx, "error": f"下载失败：{exc}"})
                log(f"下载失败 {spec['runId']} idx={idx}：{exc}")
                continue
            target.write_bytes(blob)
            saved.append({"index": idx, "path": str(target.relative_to(PROJECT_ROOT)),
                          "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest()})
            log(f"下载 {target.name} {len(blob)} bytes")
        write_json(d / "downloads.json", {"downloaded_at": now_iso(), "files": saved, "skipped": skipped})
        if not saved:
            item["status"] = "download_failed"
            item["error"] = "任务成功但没有可下载的 GLB"
            self.save()
            return "download_failed"
        item["glb"] = saved[0]["path"]
        item["glb_bytes"] = saved[0]["bytes"]
        item["status"] = "downloaded"
        item["downloaded_at"] = now_iso()
        write_json(d / "generation.json", {
            "requested_at": item.get("created_at"),
            "finished_at": item.get("succeeded_at") or item.get("downloaded_at"),
            "final_status": "succeeded",
            "credits_consumed": None,
            "note": "credits 由本脚本在批次末尾用 task/list 回填；结果 URL 有效期 2 小时，已即时下载",
        })
        self.save()
        self.note(f"已下载 {family} → {item['glb']}")
        return "downloaded"

    def fill_credits(self) -> None:
        """批次结束后用 task/list 回填每个任务的真实 consumedCredits。"""
        try:
            status, body = request_json("GET", f"{LIST_PATH}?page=1&pagesize=100", self.key)
            items = (json.loads(body).get("d") or {}).get("items") or []
        except Exception as exc:
            log(f"回填积分失败：{exc}")
            return
        by_id = {int(it["taskId"]): it for it in items if it.get("taskId") is not None}
        for family, item in self.state["items"].items():
            tid = item.get("taskId")
            if tid is None or int(tid) not in by_id:
                continue
            rec = by_id[int(tid)]
            item["consumedCredits"] = rec.get("consumedCredits")
            item["task_created_ms"] = rec.get("created")
            item["task_last_modified_ms"] = rec.get("lastModified")
            d = self.run_dir(family)
            gen = read_json(d / "generation.json", {})
            if gen:
                gen["credits_consumed"] = rec.get("consumedCredits")
                gen["api_task_created_ms"] = rec.get("created")
                gen["api_task_last_modified_ms"] = rec.get("lastModified")
                write_json(d / "generation.json", gen)
        self.save()

    # ---------------- 主循环 ----------------
    def run(self) -> int:
        started = time.time()
        last_create_try = 0.0
        round_no = 0
        while True:
            round_no += 1
            # 任务已成功但上次下载中断：先补下载（最多 3 次），再继续提交新任务。
            for f in list(self.order):
                it = self.item(f)
                if it["status"] in ("succeeded", "download_failed") and it.get("taskId") is not None:
                    it["download_attempts"] = it.get("download_attempts", 0) + 1
                    self.save()
                    if it["download_attempts"] <= 3:
                        self.download(f)
            pending = [f for f in self.order if self.item(f)["status"] == "pending"]
            active = [f for f in self.order if self.item(f)["status"] in ("created", "running")]
            unfinished = [f for f in self.order if self.item(f)["status"] in
                          ("pending", "created", "running", "create_http_error", "create_unknown", "create_error", "failed", "cancelled", "download_failed")]

            # 完成态：succeeded/downloaded 之外的都算没跑完
            done = [f for f in self.order if self.item(f)["status"] == "downloaded"]
            if len(done) == len(self.order):
                break
            if self.stop_reason:
                break
            if not pending and not active:
                # 没有可继续的：剩下的都是失败态（不自动重试）
                break

            # 提交：只在有 pending、并发没满、距离上次提交 ≥ 3s 时尝试
            if (pending and len(active) < self.max_concurrent
                    and time.time() - last_create_try > 3 and time.time() >= self.busy_until):
                family = pending[0]
                last_create_try = time.time()
                outcome = self.create(family)
                if outcome == "busy":
                    self.max_concurrent = max(1, len(active))
                    self.busy_until = time.time() + self.args.busy_backoff
                    log(f"并发上限降到 {self.max_concurrent}")
                elif outcome == "error":
                    break
                continue

            # 轮询在跑的任务
            progressed = False
            for family in list(active):
                before = self.item(family)["status"]
                self.poll(family)
                if self.item(family)["status"] != before:
                    progressed = True
            if round_no % 10 == 0:
                snapshot = {f: self.item(f)["status"] for f in self.order}
                log(f"进度：{json.dumps(snapshot, ensure_ascii=False)}")
            if not progressed and time.time() - started > self.args.max_seconds:
                self.stop_reason = f"超过批次时长 {self.args.max_seconds}s，停止"
                break
            time.sleep(self.args.poll_interval)

        self.fill_credits()
        self.save()
        self.summary()
        return 0 if all(self.item(f)["status"] in ("succeeded", "downloaded") for f in self.order) else 2

    def summary(self) -> None:
        rows = []
        total_credits = 0
        for family in self.order:
            item = self.item(family)
            rows.append({k: item.get(k) for k in
                         ("family", "status", "taskId", "glb", "glb_bytes", "consumedCredits", "error", "created_at", "downloaded_at")})
            if isinstance(item.get("consumedCredits"), int):
                total_credits += item["consumedCredits"]
        try:
            plan_label = str(self.plan_path.resolve().relative_to(PROJECT_ROOT))
        except Exception:
            plan_label = str(self.plan_path)
        summary = {
            "batch_id": self.args.batch_id,
            "plan": plan_label,
            "finished_at": now_iso(),
            "stop_reason": self.stop_reason,
            "species_total": len(self.order),
            "done": sum(1 for r in rows if r["status"] in ("succeeded", "downloaded")),
            "failed": [r for r in rows if r["status"] not in ("succeeded", "downloaded", "pending")],
            "credits_consumed_known": total_credits,
            "rows": rows,
        }
        write_json(self.batch_dir / "summary.json", summary)
        log(f"批次结束：{summary['done']}/{summary['species_total']}，已知消耗 {total_credits} 积分，停止原因：{self.stop_reason or '无'}")
        print(json.dumps([{ "family": r["family"], "status": r["status"], "credits": r["consumedCredits"]} for r in rows], ensure_ascii=False))


def cmd_status(args) -> int:
    state = read_json(RUNS_DIR / args.batch_id / STATE_NAME)
    if not state:
        print("还没有批次状态文件")
        return 1
    for family, item in state["items"].items():
        print(f"{family:24s} {item.get('status'):16s} task={item.get('taskId')} credits={item.get('consumedCredits')} {item.get('error') or ''}")
    return 0


def cmd_reconcile(args) -> int:
    """人工核对：用 task/list 把服务端真实任务状态写回本地（不改创建记录）。"""
    batch = Batch(args)
    batch.fill_credits()
    print("已用 task/list 回填任务信息（若本地没有 taskId，需要人工从 intent/时间窗口判断）。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Aholo Lux3D 文生 3D 批量任务工具")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("run", "status", "reconcile"):
        p = sub.add_parser(name)
        p.add_argument("--plan", default="assets/local/species-plan.json")
        p.add_argument("--batch-id", default="batch-20261107")
        p.add_argument("--key-file")
        p.add_argument("--only", default="")
        if name == "run":
            p.add_argument("--max-concurrent", type=int, default=3)
            p.add_argument("--poll-interval", type=int, default=10)
            p.add_argument("--busy-backoff", type=int, default=60, help="并发已满时的退避秒数")
            p.add_argument("--max-seconds", type=int, default=4 * 3600)
    args = parser.parse_args()
    if args.cmd == "status":
        return cmd_status(args)
    if args.cmd == "reconcile":
        return cmd_reconcile(args)
    return Batch(args).run()


if __name__ == "__main__":
    raise SystemExit(main())
