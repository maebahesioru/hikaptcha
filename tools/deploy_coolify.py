# -*- coding: utf-8 -*-
"""Coolifyのアプリを再デプロイする(進行を待って結果を表示)

使い方: python tools/deploy_coolify.py [app-uuid]
認証情報: ~/.coolify_token か環境変数 COOLIFY_TOKEN / COOLIFY_URL
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

APP = sys.argv[1] if len(sys.argv) > 1 else "xfcjrdeuiay92l6fzedjaws2"
BASE = os.environ.get("COOLIFY_URL", "https://coolify.hikamers.app").rstrip("/")
TOKEN = os.environ.get("COOLIFY_TOKEN", "")


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={
                                     "Authorization": f"Bearer {TOKEN}",
                                     "Content-Type": "application/json",
                                     # CloudflareがPythonのUAを1010で弾くためブラウザ相当を名乗る
                                     "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                                   "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                                     "Accept": "application/json",
                                 })
    try:
        r = urllib.request.urlopen(req, timeout=60)
        txt = r.read().decode()
        return r.status, (json.loads(txt) if txt.strip().startswith(("{", "[")) else txt)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def main():
    if not TOKEN:
        print("COOLIFY_TOKEN が未設定")
        return 1
    st, d = api("POST", f"/api/v1/deploy?uuid={APP}")
    if st != 200 and st != 201:
        print("デプロイ開始に失敗:", st, d)
        return 1
    du = d["deployments"][0]["deployment_uuid"]
    print(f"デプロイ開始: {du}")
    for i in range(40):
        time.sleep(15)
        st2, d2 = api("GET", f"/api/v1/deployments/{du}")
        status = d2.get("status") if isinstance(d2, dict) else "?"
        print(f"  [{(i + 1) * 15}s] {status}")
        if status in ("finished", "failed", "cancelled"):
            if status != "finished":
                print("ログ末尾:", (d2.get("logs") or "")[-600:])
            return 0 if status == "finished" else 1
    print("タイムアウト")
    return 1


if __name__ == "__main__":
    sys.exit(main())
