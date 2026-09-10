# hikabooruの全タグ(usages>=10, 約10,800件)を辞書+POSで検証し、
# 「画像を見て判別できる一般名詞」だけの許可セットを作る。
#  1. 構造フィルタ(数字/記号/文断片/メタ語/長さ)
#  2. JMdict 常用名詞に載っている(造語・謎タグを排除)
#  3. UniDic で単独トークンの場合は「名詞/普通名詞/一般」のみ許可
#     → サ変可能(変換/編集/送信)や形状詞可能(安全/透明/最新)を排除
#     → 固有名詞(人名/地名/年号)も排除
#  4. 手動ブラックリスト(幅広すぎ/抽象/成人向け)
import json, re, time, urllib.parse, urllib.request
import fugashi

BASE = "https://hikabooru.hikamers.app/api"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
ROOT = "C:/Users/maeba/Desktop/hikamani-captcha"

VOCAB = set(json.load(open(f"{ROOT}/tools/common_nouns.json", encoding="utf-8")))
_bl = json.load(open(f"{ROOT}/tools/tag_blacklist.json", encoding="utf-8"))
BLACK = set(_bl["abstract"]) | set(_bl["too_broad"]) | set(_bl["meta"])

NUM = re.compile(r"[0-9０-９]")
HIRA = re.compile(r"[\u3040-\u309f]")
HIRA_TAIL = re.compile(r"[\u3040-\u309f]$")
KATAKAN_KANJI = re.compile(r"[\u30a1-\u30f6\u3400-\u9fff]")
JUNK_START = re.compile(r"^[、。，「」（）()・\s\-_/\\@]")
BRACKET = re.compile(r"[()（）「」『』《》〈〉【】….]")
META = re.compile(r"上半身|クロースアップ|全身|ポートレート|スクリーンショット|テキスト|ロゴ|アイコン|記号|字幕|構図|画質|サイズ|タグ|ユーザー|チャンネル|シリーズ|投稿|動画|画像|写真")

tag = fugashi.Tagger()

def pos_ok(w):
    ts = [x for x in tag(w) if x.surface.strip()]
    if len(ts) == 0:
        return False
    if len(ts) > 1:
        return True  # 複合語(腕時計/歯ブラシ等)は JMdict 側で担保
    f = ts[0].feature
    if f.pos1 != "名詞":
        return False
    if f.pos2 == "固有名詞":
        return False
    if f.pos2 == "普通名詞" and f.pos3 == "一般":
        return True
    return False

def ok(w):
    if not w or len(w) < 2 or len(w) > 8:
        return False
    if NUM.search(w) or BRACKET.search(w) or JUNK_START.search(w):
        return False
    if " " in w or "\u3000" in w:
        return False
    if HIRA_TAIL.search(w):
        return False
    if not KATAKAN_KANJI.search(w):
        return False
    if len(HIRA.findall(w)) >= 3:
        return False
    if w.count("の") >= 1:
        return False
    if w in BLACK or META.search(w):
        return False
    if w not in VOCAB:
        return False
    if not pos_ok(w):
        return False
    return True

# 全タグ取得(usages>=10)
alltags = []
offset = 0
while True:
    q = urllib.parse.quote("usages:10..")
    url = f"{BASE}/tags?query={q}&limit=100&offset={offset}&fields=names,usages"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
            d = json.load(r)
    except Exception as e:
        print("fetch err", offset, e)
        time.sleep(1)
        continue
    rs = d.get("results") or []
    if not rs:
        break
    for x in rs:
        n = (x.get("names") or [""])[0]
        if n:
            alltags.append((n, x.get("usages") or 0))
    offset += 100
    total = d.get("total") or 0
    if offset >= total:
        break
    time.sleep(0.15)
    if offset > 12000:
        break

print("取得タグ数:", len(alltags))
allowed = sorted({n for n, u in alltags if ok(n)})
print("許可タグ数:", len(allowed))
json.dump(allowed, open(f"{ROOT}/allowed_tags.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)

# 除外例を確認
rejected = [(n, u) for n, u in alltags if not ok(n)]
print("\n--- 除外例(無作為20件) ---")
import random
random.seed(1)
for n, u in random.sample(rejected, min(20, len(rejected))):
    why = []
    if n not in VOCAB: why.append("辞書外")
    if not pos_ok(n): why.append("POS")
    if n in BLACK: why.append("手動除外")
    print(f"  {n} ({u}) ... {','.join(why) or '構造'}")
print("\n--- 許可例(無作為40件) ---")
for n in random.sample(allowed, min(40, len(allowed))):
    print(f"  {n}")
