# 辞書フィルタの精度・出題可能性を実測する
import json, random, re, urllib.request, time

VOCAB = set(json.load(open("C:/Users/maeba/Desktop/hikamani-captcha/tools/common_nouns.json", encoding="utf-8")))
ALLN = set(json.load(open("C:/Users/maeba/Desktop/hikamani-captcha/tools/all_nouns.json", encoding="utf-8")))
BASE = "https://hikabooru.hikamers.app/api"
UA = {"User-Agent": "Mozilla/5.0"}

NUM = re.compile(r"[0-9０-９]")
HIRA = re.compile(r"[\u3040-\u309f]")
KATAKAN_KANJI = re.compile(r"[\u30a1-\u30f6\u3400-\u9fff]")
HIRA_TAIL = re.compile(r"[\u3040-\u309f]$")
JUNK_START = re.compile(r"^[、。，「」（）()・\s\-_/\\@]")
BRACKET = re.compile(r"[()（）「」『』《》〈〉【】….]")

_bl = json.load(open("C:/Users/maeba/Desktop/hikamani-captcha/tools/tag_blacklist.json", encoding="utf-8"))
BLACK = set(_bl["abstract"]) | set(_bl["too_broad"]) | set(_bl["meta"])

def good(t):
    if not t or len(t) < 2 or len(t) > 8: return False
    if NUM.search(t): return False
    if HIRA_TAIL.search(t): return False
    if JUNK_START.search(t): return False
    if BRACKET.search(t): return False
    if " " in t or "\u3000" in t: return False
    if t in BLACK: return False
    if not KATAKAN_KANJI.search(t): return False
    if len(HIRA.findall(t)) >= 3: return False
    if t.count("の") >= 1: return False
    return t in VOCAB

def fetch(limit, offset):
    q = urllib.parse.quote("safety:safe type:image")
    url = f"{BASE}/posts?query={q}&limit={limit}&offset={offset}&fields=id,tags"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
            return (json.load(r).get("results") or [])
    except Exception as e:
        return []

import urllib.parse
random.seed()
prompts = []
observed = {}
succ = 0
trials = 60
for i in range(trials):
    off = random.randint(0, 29000)
    rs = fetch(26, off)
    if len(rs) < 9: 
        time.sleep(0.3); continue
    counts = {}
    for p in rs:
        seen = set()
        for x in (p.get("tags") or []):
            n = (x.get("names") or [""])[0]
            if not n or n in seen or not good(n): continue
            seen.add(n)
            counts[n] = counts.get(n, 0) + 1
    cand = [(t, c) for t, c in counts.items() if 2 <= c <= 4]
    if cand:
        succ += 1
        prompts.append(cand)
        for t, c in cand:
            observed[t] = observed.get(t, 0) + 1
    time.sleep(0.3)

print(f"出題可能バッチ: {succ}/{trials}")
print(f"ユニークお題タグ: {len(observed)}")
print("\n--- 出現したお題タグ(全件) ---")
for t, c in sorted(observed.items()):
    print(f"  {t}")
