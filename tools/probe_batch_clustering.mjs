// 「同じバッチの画像が似通う」原因を実測する
//  仮説: 取得が `limit=60&offset=N` の「連続した60件」なので、booruの投稿順(=ID順=アップロード順)で
//        同じ投稿者・同じ元ネタの塊(例: 同じチャンネルのサムネイル連投)を丸ごと引いてしまう。
//  検証: 連続取得 vs 複数offsetから小分けに取得 を比べる
const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "Mozilla/5.0" };
const Q = encodeURIComponent("safety:safe type:image");
const FIELDS = "id,canvasWidth,canvasHeight,thumbnailUrl,tags,source,user";

const fetchPosts = async (limit, offset) => {
  const r = await fetch(`${BASE}/api/posts?query=${Q}&limit=${limit}&offset=${offset}&fields=${FIELDS}`, { headers: UA });
  if (!r.ok) return [];
  const d = await r.json();
  return d?.results || [];
};

const tagNames = (p) => (p.tags || []).map((x) => (x.names && x.names[0]) || "").filter(Boolean);
const jac = (a, b) => {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(1, new Set([...A, ...B]).size);
};
// 60枚のペア類似度の平均(高いほど「似通っている」)
const meanPairSim = (posts) => {
  const sets = posts.map((p) => tagNames(p));
  let s = 0, n = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) { s += jac(sets[i], sets[j]); n++; }
  }
  return n ? s / n : 0;
};
const idStats = (posts) => {
  const ids = posts.map((p) => p.id).sort((a, b) => a - b);
  const span = ids.length ? ids[ids.length - 1] - ids[0] : 0;
  return { min: ids[0], max: ids[ids.length - 1], span, perId: ids.length ? (span / ids.length).toFixed(1) : 0 };
};
// 元ネタ(source)の重複度: 同じsourceを持つ画像が多いほど「同じ塊」を引いている
const sourceTop = (posts) => {
  const m = new Map();
  for (const p of posts) {
    const s = p.source || "(なし)";
    m.set(s, (m.get(s) || 0) + 1);
  }
  const arr = [...m.entries()].sort((a, b) => b[1] - a[1]);
  return { distinct: m.size, top: arr.slice(0, 3).map(([s, n]) => `${n}枚:${s.slice(0, 28)}`) };
};

console.log("=== A) 連続した60件を1回で取る(現状の方式) ===");
for (let k = 0; k < 3; k++) {
  const posts = await fetchPosts(60, Math.floor(Math.random() * 29500));
  if (!posts.length) continue;
  const st = idStats(posts), sc = sourceTop(posts);
  // 隣り合う画像同士の類似度(連続性の直接指標)
  let adj = 0;
  for (let i = 1; i < posts.length; i++) adj += jac(tagNames(posts[i - 1]), tagNames(posts[i]));
  console.log(
    `  平均ペア類似 ${meanPairSim(posts).toFixed(3)} / 隣接類似 ${(adj / (posts.length - 1)).toFixed(3)}` +
    ` / ID ${st.min}〜${st.max} (間隔 平均${st.perId}) / source種類 ${sc.distinct} → ${sc.top.join(" | ")}`
  );
  await new Promise((s) => setTimeout(s, 300));
}

console.log("\n=== B) 10個のoffsetから6件ずつ小分けで取る(改善案) ===");
for (let k = 0; k < 3; k++) {
  let posts = [];
  for (let i = 0; i < 10; i++) {
    posts = posts.concat(await fetchPosts(6, Math.floor(Math.random() * 29500)));
    await new Promise((s) => setTimeout(s, 120));
  }
  if (!posts.length) continue;
  const st = idStats(posts), sc = sourceTop(posts);
  let adj = 0;
  for (let i = 1; i < posts.length; i++) adj += jac(tagNames(posts[i - 1]), tagNames(posts[i]));
  console.log(
    `  平均ペア類似 ${meanPairSim(posts).toFixed(3)} / 隣接類似 ${(adj / (posts.length - 1)).toFixed(3)}` +
    ` / ID ${st.min}〜${st.max} (間隔 平均${st.perId}) / source種類 ${sc.distinct} → ${sc.top.join(" | ")}`
  );
}
console.log("\n※ 平均ペア類似が高い = バッチ内でタグが似ている = 見た目も似通っている");
