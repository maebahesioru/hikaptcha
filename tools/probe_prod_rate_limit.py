# -*- coding: utf-8 -*-
"""本番のレート制限を実測する(並列で一気に叩いて429が出るか)"""
import collections
import concurrent.futures
import urllib.error
import urllib.request

URL = "https://hikaptcha.hikamers.app/api/challenge"
N = 150
PAR = 15


def one(_):
    try:
        r = urllib.request.urlopen(urllib.request.Request(URL, headers={"User-Agent": "limit-test"}), timeout=20)
        return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return -1


codes = collections.Counter()
with concurrent.futures.ThreadPoolExecutor(max_workers=PAR) as ex:
    for st in ex.map(one, range(N)):
        codes[st] += 1

print(f"並列{PAR}で{N}発: {dict(codes)}")
if 429 in codes:
    print("→ 429が出た = レート制限が本番で効いている")
else:
    print("→ 429なし(上限に達していない)")
