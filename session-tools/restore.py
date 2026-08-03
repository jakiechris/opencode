#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 JSON 文件还原 opencode session(调用 opencode serve API)。

用法:
    python3 restore.py <session_id> <文件.json>

参数:
    session_id   顶级 session id,如 ses_xxx(与文件内顶级 session 校验)
    file         JSON 文件全路径(backup.py 的输出)

环境变量:
    OPENCODE_SERVER_URL    serve 地址,默认 http://localhost:4096
    OPENCODE_SERVER_TOKEN  Bearer token,serve 需要鉴权时设置

说明:
    文件是 backup.py 的输出 {"sessions": [{info, messages}, ...]}。
    按顺序(父 session 在前)逐个调用 POST /session/import 还原。
    还原后 session 归属当前 serve 实例的项目(与 CLI import 行为一致)。
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

BASE_URL = os.environ.get("OPENCODE_SERVER_URL", "http://localhost:4096").rstrip("/")
TOKEN = os.environ.get("OPENCODE_SERVER_TOKEN", "")


def http(path: str, body: dict) -> object:
    """POST 请求 serve API,返回解析后的 JSON。"""
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8")) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} POST {url}\n{e.read().decode('utf-8', 'replace')}")
    except urllib.error.URLError as e:
        sys.exit(f"请求失败 POST {url}\n{e.reason}")


def main() -> None:
    p = argparse.ArgumentParser(description="从 JSON 还原 opencode session")
    p.add_argument("session_id", help="顶级 session id,如 ses_xxx(用于校验)")
    p.add_argument("file", help="JSON 文件全路径(backup.py 的输出)")
    args = p.parse_args()

    with open(args.file, "r", encoding="utf-8") as f:
        data = json.load(f)

    sessions = data.get("sessions")
    if sessions is None:
        sessions = [data] if isinstance(data, dict) and "info" in data else None
    if not sessions:
        sys.exit(f"文件里没有可还原的 session: {args.file}")

    top = sessions[0]["info"]["id"]
    if top != args.session_id:
        print(f"警告: 文件顶级 session 是 {top}, 传入的是 {args.session_id}", file=sys.stderr)

    for i, entry in enumerate(sessions, 1):
        info = entry["info"]
        messages = entry.get("messages", [])
        print(f"[{i}/{len(sessions)}] 还原 {info['id']} ({len(messages)} 条消息)")
        http("/session/import", {"info": info, "messages": messages})
    print(f"完成,共还原 {len(sessions)} 个 session")


if __name__ == "__main__":
    main()
