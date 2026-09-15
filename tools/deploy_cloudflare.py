# -*- coding: utf-8 -*-
"""hikaptcha.hikamers.app を Cloudflare トンネル + DNS に登録する。

既存の cf_ingress_all.py / cf_add_dns.py と同じ方法(Global API Key)を使う。
認証情報はそのファイルから読むのでこのスクリプトには書かない。

使い方:
  python tools/deploy_cloudflare.py check   # 現状確認だけ
  python tools/deploy_cloudflare.py add     # ingressとDNSを追加
"""
import json
import re
import sys
import urllib.error
import urllib.request

HOST = "hikaptcha.hikamers.app"
SRC = "C:/Users/maeba/Downloads/cf_ingress_all.py"


def load_creds():
    s = open(SRC, encoding="utf-8", errors="replace").read()
    token = re.search(r"TOKEN\s*=\s*['\"]([^'\"]+)['\"]", s).group(1)
    email = re.search(r"EMAIL\s*=\s*['\"]([^'\"]+)['\"]", s).group(1)
    acct = re.search(r"ACCT\s*=\s*['\"]([^'\"]+)['\"]", s).group(1)
    tid = re.search(r"tid\s*=\s*['\"]([^'\"]+)['\"]", s).group(1)
    return {"X-Auth-Email": email, "X-Auth-Key": token,
            "Content-Type": "application/json"}, acct, tid


HDRS, ACCT, TID = load_creds()
API = "https://api.cloudflare.com/client/v4"


def req(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, headers=HDRS, method=method)
    try:
        res = urllib.request.urlopen(r, timeout=30)
        return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]


def get_tunnel_ingress():
    st, d = req("GET", f"{API}/accounts/{ACCT}/cfd_tunnel/{TID}/configurations")
    if st != 200:
        print("  tunnel設定取得失敗:", st, d)
        return None, None
    conf = (d.get("result") or {}).get("config") or {}
    return conf.get("ingress") or [], conf


def get_dns(name):
    st, d = req("GET", f"{API}/zones/{ZONE}/dns_records?name={name}")
    if st != 200:
        print("  DNS取得失敗:", st, d)
        return None
    return d.get("result") or []


ZONE = None


def find_zone():
    """hikamers.app のゾーンIDを名前から引く(スクリプトに直書きしないため)"""
    st, d = req("GET", f"{API}/zones?name=hikamers.app")
    if st == 200 and d.get("result"):
        return d["result"][0]["id"]
    return None


def main():
    global ZONE
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    ZONE = find_zone()
    print(f"ゾーンID: {'取得OK' if ZONE else '取得失敗'}")

    ingress, conf = get_tunnel_ingress()
    if ingress is None:
        return
    hosts = [r.get("hostname") for r in ingress if r.get("hostname")]
    print(f"トンネル: {TID[:8]}… / 登録ホスト {len(hosts)}件")
    print(f"  hikaptcha は ingress に: {'あり' if HOST in hosts else '**なし**'}")
    print(f"  catch-all: {[r for r in ingress if not r.get('hostname')]}")

    recs = get_dns(HOST)
    print(f"DNSレコード: {len(recs)}件")
    for r in recs:
        print(f"  type={r['type']} content={r['content'][:52]} proxied={r.get('proxied')}")

    if mode != "add":
        return

    changed = False
    # 1) DNS: ワイルドカード(*.hikamers.app → トンネル)があれば個別レコードは不要
    st, d = req("GET", f"{API}/zones/{ZONE}/dns_records?name=*.hikamers.app")
    wild = [r for r in (d.get("result") or []) if r["type"] == "CNAME" and "cfargotunnel" in str(r["content"])]
    if wild:
        print("  DNS: ワイルドカード(*.hikamers.app → トンネル)があるので個別レコード不要")
    elif not recs:
        body = {"type": "CNAME", "name": HOST, "content": f"{TID}.cfargotunnel.com", "proxied": True, "ttl": 1}
        st, d2 = req("POST", f"{API}/zones/{ZONE}/dns_records", body)
        print(f"  DNS作成: {st} {'OK' if st == 200 else d2}")
        changed = True

    # 2) ingress: catch-all の直前に挿入
    if HOST not in hosts:
        new_ing = [r for r in ingress if r.get("hostname")]
        new_ing.append({"hostname": HOST, "service": "http://localhost:80"})
        new_ing.append({"service": "http_status:404"})
        st, d = req("PUT", f"{API}/accounts/{ACCT}/cfd_tunnel/{TID}/configurations",
                    {"config": {"ingress": new_ing}})
        print(f"  ingress更新: {st} {'OK / 登録ホスト ' + str(len(new_ing) - 1) + '件' if st == 200 else str(d)[:200]}")
        changed = True
    else:
        print("  ingress: 既に登録済み(変更なし)")

    print("完了" if changed else "変更なし")


if __name__ == "__main__":
    main()
