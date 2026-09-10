# JMdict「常用名詞」vs「全名詞」で許可セットのサイズと品質を比較
import json, re
import fugashi

ROOT = "C:/Users/maeba/Desktop/hikamani-captcha"
COMMON = set(json.load(open(f"{ROOT}/tools/common_nouns.json", encoding="utf-8")))
ALLN = set(json.load(open(f"{ROOT}/tools/all_nouns.json", encoding="utf-8")))
_bl = json.load(open(f"{ROOT}/tools/tag_blacklist.json", encoding="utf-8"))
BLACK = set(_bl["abstract"]) | set(_bl["too_broad"]) | set(_bl["meta"])

tag = fugashi.Tagger()
NUM = re.compile(r"[0-9０-９]")
HIRA = re.compile(r"[\u3040-\u309f]")
HIRA_TAIL = re.compile(r"[\u3040-\u309f]$")
KATAKAN_KANJI = re.compile(r"[\u30a1-\u30f6\u3400-\u9fff]")
JUNK_START = re.compile(r"^[、。，「」（）()・\s\-_/\\@]")
BRACKET = re.compile(r"[()（）「」『』《》〈〉【】….]")

def pos_ok(w):
    ts = [x for x in tag(w) if x.surface.strip()]
    if not ts: return False
    if len(ts) > 1: return True
    f = ts[0].feature
    if f.pos1 != "名詞": return False
    if f.pos2 == "固有名詞": return False
    return f.pos2 == "普通名詞" and f.pos3 == "一般"

def ok(w, vocab):
    if not w or len(w) < 2 or len(w) > 8: return False
    if NUM.search(w) or BRACKET.search(w) or JUNK_START.search(w): return False
    if " " in w or "\u3000" in w: return False
    if HIRA_TAIL.search(w): return False
    if not KATAKAN_KANJI.search(w): return False
    if len(HIRA.findall(w)) >= 3: return False
    if w.count("の") >= 1: return False
    if w in BLACK: return False
    if w not in vocab: return False
    return pos_ok(w)

# 候補: hikabooruのタグ一覧(usages>=10)を前回取得済みという前提で、タグ名だけ再取得はせず
# 代わりに「辞書側の候補」で検証: 各辞書の語のうちPOSを通るものの数
for name, vocab in (("common", COMMON), ("all", ALLN)):
    n = 0
    samples = []
    for w in vocab:
        if ok(w, vocab):
            n += 1
            if len(samples) < 0:
                samples.append(w)
    print(f"{name}: POS通過語数 = {n}")

# hikabooruタグ側での比較(前回の許可リストと、all版)
tags = json.load(open(f"{ROOT}/allowed_tags.json", encoding="utf-8"))
print("common版で許可されたタグ数:", len(tags))
extra = []
# all版で追加されるタグを確認するため、タグ一覧を再取得せず既知の一部で確認
for w in ["カウチ", "ヘッドギア", "サングラス", "椅子", "ドア", "テレビ", "カメラ", "バウティー", "ポヴ", "グッキ", "変換", "安全"]:
    print(f"  {w}: common={ok(w, COMMON)} all={ok(w, ALLN)}")
