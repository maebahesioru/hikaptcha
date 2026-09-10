# server.mjs の出題生成ブロックを「ランダム+辞書検証済みタグ」版に置換する
import io

P = "C:/Users/maeba/Desktop/hikamani-captcha/server.mjs"
src = open(P, encoding="utf-8").read().split("\n")

NEW = '''// ---------- 出題生成(ランダム画像 + 辞書検証済みタグ) ----------
// 方針:
//  - 画像は毎回ランダムなバッチ(出題のバラエティを担保)
//  - お題タグは、そのバッチに付いているタグのうち allowed_tags.json に載っているものだけ
//    allowed_tags.json = hikabooruの全タグ(10,806件)を
//      「JMdict(日本語辞書)の常用名詞」+「UniDicで 名詞/普通名詞/一般 と判定」
//    で検証して残った“画像を見て判別できる一般名詞”だけの集合(辞書から自動生成・手選定ではない)
//    → 造語(ポヴ/バウティー)・動作性名詞(変換/送信)・形状詞(安全/透明)・
//      固有名詞・抽象語・構図/UI語を原理的に排除できる
//  - 直近で使ったタグは避けて単調さを防ぐ

const ALLOWED =
  (() => {
    try {
      const arr = JSON.parse(readFileSync(path.join(__dirname, "allowed_tags.json"), "utf8"));
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  })();
if (ALLOWED.size < 50) {
  console.error("allowed_tags.json が読めません。先に tools/build_allowlist.py を実行してください");
  process.exit(1);
}

// 直近で出題したタグ(同じタグが続かないようにする)
const RECENT_TAGS = [];
const RECENT_MAX = 60;
function markUsed(tag) {
  RECENT_TAGS.push(tag);
  while (RECENT_TAGS.length > RECENT_MAX) RECENT_TAGS.shift();
}

// タイルは正方形なので、極端な縦長/横長(9:16未満・16:9超)は
// 表示したときに小さく/切れて判別不能になる → 出題から除外
function goodAspect(p) {
  const w = Number(p.canvasWidth) || 0;
  const h = Number(p.canvasHeight) || 0;
  if (!w || !h) return false;
  const r = w / h;
  return r >= 0.56 && r <= 1.78; // 9:16(0.5625)〜16:9(1.7778) の範囲
}

// ランダムなoffset位置からsafe画像を1バッチ引く(タグ名も返す)
async function fetchRandomImageBatch(limit) {
  const offset = Math.floor(Math.random() * 29500);
  const q = encodeURIComponent("safety:safe type:image");
  const d = await hkFetch(`/posts?query=${q}&limit=${limit}&offset=${offset}&fields=id,canvasWidth,canvasHeight,thumbnailUrl,tags`);
  return (d?.results || [])
    .filter((p) => p && p.id && p.thumbnailUrl && goodAspect(p))
    .map((p) => ({
      id: p.id,
      url: absUrl(p.thumbnailUrl),
      tags: new Set((p.tags || []).map((t) => (t.names && t.names[0]) || "").filter(Boolean)),
    }));
}

async function makeChallenge() {
  for (let i = 0; i < 30; i++) {
    const batch = await fetchRandomImageBatch(24);
    if (batch.length < GRID_SIZE) continue;

    // バッチ内タグの登場回数(辞書検証済みタグのみ)
    const counts = new Map();
    for (const p of batch) {
      for (const t of p.tags) {
        if (!ALLOWED.has(t)) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }

    // 2〜3枚に付くタグがお題候補(正解が絞られていて、かつ多すぎない)
    let candidates = [];
    for (const [tag, n] of counts) {
      if (n >= 2 && n <= 3) candidates.push({ tag, n });
    }
    if (!candidates.length) continue;

    // 直近使ったタグは避ける(候補が全部最近なら仕方なく使う)
    const fresh = candidates.filter((c) => !RECENT_TAGS.includes(c.tag));
    if (fresh.length) candidates = fresh;

    // 重み付きランダム選択(出現数が多い方をやや優先)
    const roulette = [];
    for (const c of candidates) for (let k = 0; k < c.n; k++) roulette.push(c.tag);
    const tag = roulette[Math.floor(Math.random() * roulette.length)];
    const tagCount = counts.get(tag) || 2;

    // 正解=お題タグが付く画像(2〜3枚) / ダミー=同じバッチ内でお題タグが付かない画像
    const targets = batch.filter((p) => p.tags.has(tag)).slice(0, tagCount);
    const rest = batch.filter((p) => !p.tags.has(tag));
    if (rest.length < GRID_SIZE - targets.length) continue;
    const distractors = shuffle(rest).slice(0, GRID_SIZE - targets.length);

    const tiles = shuffle([
      ...targets.map((p) => ({
        id: randomBytes(6).toString("hex"),
        postId: p.id,
        url: p.url,
        target: true,
      })),
      ...distractors.map((p) => ({
        id: randomBytes(6).toString("hex"),
        postId: p.id,
        url: p.url,
        target: false,
      })),
    ]);

    markUsed(tag);
    return {
      id: randomBytes(8).toString("hex"),
      prompt: tag,
      createdAt: Date.now(),
      tiles,
      attempts: 0,
    };
  }
  return null;
}'''

# 76行目(1-index)から makeChallenge 終端までを置換
start = 75  # 0-index
# makeChallenge の終端を探す("// ---------- トークン/掃除 ----------" の直前)
end = None
for i, line in enumerate(src):
    if line.startswith("// ---------- トークン/掃除"):
        end = i
        break
assert end is not None, "end marker not found"
assert src[start].startswith("// ---------- 出題生成"), src[start]

out = src[:start] + NEW.split("\n") + [""] + src[end:]
open(P, "w", encoding="utf-8", newline="\n").write("\n".join(out))
print("replaced lines", start + 1, "..", end, "-> new length", len(NEW.split("\n")))
