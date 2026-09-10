# UniDicの品詞情報で「動作性名詞/形状詞」を落とせるか検証
import fugashi, json

t = fugashi.Tagger()

def tags_of(s):
    return list(t.parse(s))

def pos_of(tag):
    """1トークンで構成され、かつ一般名詞ならOK"""
    ts = tags_of(tag)
    if len(ts) != 1:
        return None  # 複数形態素=造語/複合語
    f = ts[0].feature
    # unidic: pos1=名詞 pos2=普通名詞 pos3=一般/サ変可能/形状詞可能/助数詞可能 etc
    return (f.pos1, getattr(f, "pos2", None), getattr(f, "pos3", None))

test = ["テレビ","カメラ","椅子","ドア","ジーンズ","サングラス","楽器","笑顔","変換","変更",
        "編集","送信","印刷","開発","安全","透明","最新","不健康","バウティー","ポヴ",
        "グッキ","容器","容器","デブ","ハゲ","アンドロイド","カップ","コイン","ギター",
        "ピアノ","テーブル","腕時計","自転車","自動車","信号機","歯ブラシ","洗濯機","水筒",
        "包帯","軍服","白衣","眼鏡","口紅","帽子","靴下","長袖","半袖","果物","太陽"]

for w in test:
    print(f"{w}: {pos_of(w)}")
