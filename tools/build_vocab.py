# JMdict(EDICT)から「常用名詞」語彙セットを作る
#  - pos に名詞(n)を含む
#  - 優先度タグ(news1/ichi1/spec1/gai1/spec2/news2/ichi2/gai2)を持つ = 一般によく使われる語
# 出力: common_nouns.json (見出し形の配列)
import gzip
import json
import re
import xml.etree.ElementTree as ET
# 注: SRC は edrdg.org 公式のJMdict(ローカル保存・信頼済み)のみを読む。
# 信頼できないXMLを扱う場合は defusedxml を使うこと。

SRC = "C:/Users/maeba/AppData/Local/Temp/JMdict_e.xml"
OUT = "C:/Users/maeba/Desktop/hikamani-captcha/tools/common_nouns.json"
OUT_ALL = "C:/Users/maeba/Desktop/hikamani-captcha/tools/all_nouns.json"

PRI = {"news1", "ichi1", "spec1", "gai1", "spec2", "news2", "ichi2", "gai2"}
# 名詞として採用するPOS(名詞一般・固有名詞は除外しないが接尾/接頭は除外)
NOUN_POS = {"n", "n-adv", "n-t", "n-suf", "n-pref", "num"}

tree = ET.parse(SRC)
root = tree.getroot()
common = set()
alln = set()
for entry in root.findall("entry"):
    forms = []
    for k in entry.findall("k_ele"):
        keb = k.find("keb")
        if keb is not None and keb.text:
            forms.append(keb.text)
    for r in entry.findall("r_ele"):
        reb = r.find("reb")
        if reb is not None and reb.text:
            forms.append(reb.text)
    pris = set()
    for k in entry.findall("k_ele"):
        for p in k.findall("ke_pri"):
            pris.add((p.text or "").strip())
    for r in entry.findall("r_ele"):
        for p in r.findall("re_pri"):
            pris.add((p.text or "").strip())
    poss = set()
    for s in entry.findall("sense"):
        for p in s.findall("pos"):
            poss.add((p.text or "").strip())
    # JMdict_e.xml はPOSが英語展開形(例: "noun (common) (futsuumeishi)")
    # 一般名詞のみ採用(接尾/接頭/固有名詞/形容動詞語幹などは除外)
    is_noun = False
    for p in poss:
        if "noun (common)" in p or p == "noun" or p == "n":
            is_noun = True
    if not is_noun:
        continue
    for f in forms:
        if len(f) >= 2 and len(f) <= 10:
            alln.add(f)
            if pris & PRI:
                common.add(f)

print("common nouns:", len(common))
print("all nouns:", len(alln))
json.dump(sorted(common), open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
json.dump(sorted(alln), open(OUT_ALL, "w", encoding="utf-8"), ensure_ascii=False, indent=0)

# 実際に出たタグで検証
good = ["テレビ", "カウチ", "ヘルメット", "マスク", "リボン", "包丁", "カメラ", "テーブル",
        "サングラス", "モンキー", "お刺身", "茶髪", "電気", "半袖"]
bad = ["バウティー", "ポヴ", "グッキ", "ハプロリネ", "グリン", "ドン", "変容", "健康指数",
       "参考画像", "デフォルメ", "誕生の瞬間", "ウォーターマーク", "カバー", "アニメ化",
       "国境", "周囲保護", "ビンテージ", "レア", "ノーマル", "ゼロ・ピクチャー",
       "ユーチューバー", "セルフィー", "紫の瞳", "広い瞳", "黒い目", "写真", "カップ",
       "シャドウ", "スマートフォン", "黒いジャケット", "黄色いシャツ", "フーディー",
       "悪魔の角", "動物の耳", "オレンジ色の髪", "デュエルモンスター", "ヒカキン"]
print("\n--- good ---")
for t in good:
    print(f"  {t}: common={t in common} all={t in alln}")
print("\n--- bad ---")
for t in bad:
    print(f"  {t}: common={t in common} all={t in alln}")
