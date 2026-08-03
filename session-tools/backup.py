#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""备份 opencode session 到 JSON 文件(调用 opencode serve API)。

用法:
    python3 backup.py <session_id> [<输出.json>]

参数:
    session_id   顶级 session id,如 ses_xxx
    output       输出 JSON 文件全路径(可选,默认 ./<session_id>.json)

环境变量:
    OPENCODE_SERVER_URL        serve 地址,默认 http://localhost:4096
    OPENCODE_SERVER_TOKEN      Bearer token,serve 需要鉴权时设置
    OPENCODE_SERVER_DIRECTORY  directory 查询参数,多项目 serve 路由需要时设置

说明:
    备份的是"顶级 session + 其全部子 session"(递归,父 session 在前)。
    输出 JSON 结构:{"sessions": [{info, messages}, ...]},
    其中 messages 为 [{info, parts}, ...](与 export / GET 输出同构)。
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

BASE_URL = os.environ.get("OPENCODE_SERVER_URL", "http://localhost:4096").rstrip("/")
TOKEN = os.environ.get("OPENCODE_SERVER_TOKEN", "")
DIRECTORY = os.environ.get("OPENCODE_SERVER_DIRECTORY", "")


def http(path: str) -> tuple:
    """请求 serve API,返回 (response, 解析后的 JSON)。"""
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url)
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return resp, (json.loads(raw.decode("utf-8")) if raw else None)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} GET {url}\n{e.read().decode('utf-8', 'replace')}")
    except urllib.error.URLError as e:
        sys.exit(f"请求失败 GET {url}\n{e.reason}")


def q(**params) -> str:
    """把可选查询参数拼成 ?a=b&c=d,空值跳过。"""
    pairs = [f"{k}={v}" for k, v in params.items() if v]
    return ("?" + "&".join(pairs)) if pairs else ""


def get_messages(session_id: str) -> list:
    """分页拉取某 session 的全部消息+parts(X-Next-Cursor 翻页)。"""
    messages = []
    before = None
    while True:
        params = {"limit": 100, "before": before, "directory": DIRECTORY}
        path = f"/session/{session_id}/messages{q(**params)}"
        resp, page = http(path)
        messages.extend(page or [])
        before = resp.headers.get("X-Next-Cursor")
        if not before:
            break
    return messages


def collect(session_id: str, seen: set, out: list) -> None:
    """递归收集 session 及其子 session(父 session 在前)。"""
    if session_id in seen:
        return
    seen.add(session_id)
    _, info = http(f"/session/{session_id}{q(directory=DIRECTORY)}")
    out.append({"info": info, "messages": get_messages(session_id)})
    _, children = http(f"/session/{session_id}/children{q(directory=DIRECTORY)}")
    for child in children or []:
        collect(child["id"], seen, out)


def main() -> None:
    p = argparse.ArgumentParser(description="备份 opencode session(含子 session)到 JSON")
    p.add_argument("session_id", help="顶级 session id,如 ses_xxx")
    p.add_argument("output", nargs="?", default=None, help="输出 JSON 文件全路径(默认 <session_id>.json)")
    args = p.parse_args()

    out_path = args.output or f"{args.session_id}.json"
    sessions = []
    collect(args.session_id, set(), sessions)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"sessions": sessions}, f, ensure_ascii=False, indent=2)
    print(f"已备份 {len(sessions)} 个 session -> {out_path}")


if __name__ == "__main__":
    main()
