# hikabooruの全タグを辞書(UniDic)で品詞判定し、
# 「動詞的・形容詞的・地名/人名」のタグを機械的に洗い出して拒否リストを作る。
# 方式は変えない(ランダムバッチ+除外フィルタ)ままで、除外の根拠を辞書で強化する。
#
#  除外する品詞:
#   - 形状詞(形状詞可能・形容動詞語幹相当): 必要 / シュール / コミカル など状態語
#   - サ変可能な普通名詞(動詞として使える名詞): キャンセル / 退出 / 変換 / 料理 など動作
#   - 固有名詞のうち 地名・人名: 東京 / 田中 など(画像から判別できない)
#  ※ 固有名詞の一般(キャラクター名)は視覚的に有効なので残す
import json
import time
import urllib.parse
import urllib.request
import fugashi

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
API = "https://hikabooru.hikamers.app/api"
OUT = "C:/Users/maeba/Desktop/hikamani-captcha/tag_reject.json"

# 辞書が「人名」と判定しても視覚的に判別できる語は除外しない。
# 実測で誤除外が判明したもの(キャラクター名・物体・生物)を列挙する。
NOT_PERSON = {
    # キャラクター名(見た目で判別できる)
    "マリオ", "ルイージ", "ベジータ", "ピカチュウ", "マスオ", "アリス", "ヨッシー",
    "クッパ", "ピーチ", "リンク", "ゼルダ", "ソニック", "カービィ", "ドラえもん",
    # 人名と誤判定される物体・生物・概念(視覚的に有効)
    "ヨーヨー", "蝶々", "猫娘", "悪魔", "クッキー", "クッキ", "スプライト", "バレンタイン",
    "ブレーザー", "ブレイザー", "ガーランド", "フェリス", "コス", "チャン",
}

tag = fugashi.Tagger()


def classify(word):
    """1形態素なら品詞で判定。複合語は対象外(辞書の語単位で判定できないため)"""
    # 視覚的に判別できる語は品詞に関係なく除外しない(誤除外の防止)
    if word in NOT_PERSON:
        return None
    try:
        ts = [x for x in tag(word) if x.surface.strip()]
    except Exception:
        return None
    if len(ts) != 1:
        return None
    f = ts[0].feature
    pos1 = f.pos1
    pos2 = getattr(f, "pos2", "")
    pos3 = getattr(f, "pos3", "")
    if pos1 == "形状詞":
        return "形状詞"
    if pos1 == "名詞":
        if pos2 == "普通名詞" and pos3 == "サ変可能":
            return "サ変可能"
        if pos2 == "固有名詞":
            # 地名・人名は除外。一般(キャラクター名等)は残す
            if pos3 in ("地名", "人名"):
                return f"固有名詞/{pos3}"
    return None


def main():
    # 全タグ(usages>=10)を取得
    tags = []
    offset = 0
    while True:
        q = urllib.parse.quote("usages:10..")
        url = f"{API}/tags?query={q}&limit=100&offset={offset}&fields=names,usages"
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
            if n and len(n) <= 12:
                tags.append(n)
        offset += 100
        if offset >= (d.get("total") or 0):
            break
        time.sleep(0.12)
        if offset > 12000:
            break

    print(f"取得タグ数: {len(tags)}")
    rejects = {}
    for t in tags:
        why = classify(t)
        if why:
            rejects[t] = why
    print(f"品詞で除外: {len(rejects)}件")

    # 内訳
    from collections import Counter
    print("内訳:", dict(Counter(rejects.values())))

    # 除外例
    for k, v in list(rejects.items())[:15]:
        print(f"  除外例 {k} ({v})")

    # 除外してはいけない語が混ざっていないか(視覚的に有効な語)
    keep = ["テレビ", "カメラ", "バッグ", "カービー", "ピカチュウ", "マリオ", "ヤカン", "スプーン"]
    for k in keep:
        if k in rejects:
            print(f"  ⚠️ 誤除外の恐れ: {k} ({rejects[k]})")

    json.dump(rejects, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print("saved:", OUT)


main()
