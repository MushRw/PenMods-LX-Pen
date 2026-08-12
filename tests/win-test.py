#!/usr/bin/env python3
"""Windows 端真机级测试：驱动 penmusic-win.exe 走真实网络 RPC。

验证：五源搜索 / kw 歌词（GBK+inflate）/ 热搜 / 音源脚本 musicUrl。
Usage: python tests/win-test.py
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, "runner", "penmusic-win.exe")
JS_DIR = os.path.join(ROOT, "plugin", "js")
SCRIPT = os.path.join(ROOT, "plugin", "scripts", "example-kw-source.js")

failed = 0


def check(name, ok, extra=""):
    global failed
    if ok:
        print("  ok  " + name)
    else:
        print("  FAIL " + name + ((" :: " + str(extra)) if extra else ""))
        failed += 1


def main():
    if not os.path.exists(EXE):
        print("missing " + EXE + "（先执行 runner 下 gcc 编译）")
        sys.exit(1)

    p = subprocess.Popen(
        [EXE, "--script", SCRIPT, "--js-dir", JS_DIR, "--in", "-", "--out", "-"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    q = queue.Queue()

    def reader():
        for line in p.stdout:
            q.put(line)

    threading.Thread(target=reader, daemon=True).start()
    seq = 0

    def rpc(cmd, timeout=50):
        nonlocal seq
        seq += 1
        cmd["id"] = seq
        p.stdin.write(json.dumps(cmd, ensure_ascii=False) + "\n")
        p.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                line = q.get(timeout=0.5)
            except queue.Empty:
                continue
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("id") == seq:
                return msg
        return None

    try:
        ping = rpc({"cmd": "ping"})
        check("ping", ping is not None and ping.get("ok") and ping.get("data") == "pong", ping)

        for src, kw in [("kw", "晴天"), ("kg", "晴天"), ("mg", "晴天"), ("wy", "晴天"), ("tx", "周杰伦")]:
            res = rpc({"cmd": "search", "platform": src, "keyword": kw, "page": 1})
            ok = res is not None and res.get("ok") and res.get("data", {}).get("list")
            check(src + " search", ok, res)
            if ok:
                first = res["data"]["list"][0]
                print("      first: " + (first.get("name") or "") + " - " + (first.get("singer") or ""))

        kw = rpc({"cmd": "search", "platform": "kw", "keyword": "晴天", "page": 1})
        if kw and kw.get("ok") and kw["data"]["list"]:
            first = kw["data"]["list"][0]
            lr = rpc({"cmd": "lyric", "source": "kw", "info": first})
            ok = lr is not None and lr.get("ok") and "晴天" in (lr["data"].get("lyric") or "")
            check("kw lyric (GBK+inflate)", ok, lr)

        hot = rpc({"cmd": "hotsearch", "platform": "kw"})
        check("kw hotsearch", hot is not None and hot.get("ok") and hot["data"].get("list"), hot)

        script = rpc({"cmd": "script", "source": "kw", "action": "musicUrl",
                      "info": {"type": "128k", "musicInfo": {"songmid": "228908"}}})
        check("script musicUrl", script is not None and script.get("ok") and str(script.get("data", "")).startswith("http"), script)

        rpc({"cmd": "quit"}, timeout=5)
    finally:
        try:
            p.stdin.close()
        except Exception:
            pass
        try:
            p.kill()
        except Exception:
            pass

    print("\n" + ("ALL PASS" if failed == 0 else "%d FAILED" % failed))
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
