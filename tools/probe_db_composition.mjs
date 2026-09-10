// hikabooruの「画像の構成」を実測する(なぜ見た目が似通うのかの根本原因)
//  調べること:
//   1. アスペクト比の分布(goodAspect が 1.0〜2.2 に絞っている影響)
//   2. 16:9のYouTubeサムネイルがどのくらいの割合を占めるか
//   3. source(元ネタ)の多様性 = 同じチャンネルの大量投稿に支配されていないか
const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "Mozilla/5.0" };
const Q = encodeURIComponent("safety:safe type:image");
const N = Number(process.argv[2] || 60); // 1枚ずつN箇所から取ってDB全体を推定する

const posts = [];
for (let i = 0; i < N; i++) {
  const offset = Math.floor(Math.random() * 29500);
  try {
    const r = await fetch(`${BASE}/api/posts?query=${Q}&limit=1&offset=${offset}&fields=id,canvasWidth,canvasHeight,tags,source`, { headers: UA });
    const d = await r.json();
    const p = d?.results?.[0];
    if (p) posts.push(p);
  } catch {}
  await new Promise((s) => setTimeout(s, 120));
}
console.log(`サンプル ${posts.length}枚(ランダム1枚抽出を繰り返し)\n`);

// --- 1) アスペクト比 ---
const bucket = new Map();
for (const p of posts) {
  const w = Number(p.canvasWidth) || 0, h = Number(p.canvasHeight) || 0;
  if (!w || !h) { bucket.set("不明", (bucket.get("不明") || 0) + 1); continue; }
  const r = w / h;
  const key = r < 0.9 ? "縦長(<0.9)" : r < 1.15 ? "正方形(0.9-1.15)" : r < 1.45 ? "4:3(1.15-1.45)" : r < 1.62 ? "3:2(1.45-1.62)" : r < 1.85 ? "16:9(1.62-1.85)" : "超横長(>1.85)";
  bucket.set(key, (bucket.get(key) || 0) + 1);
}
console.log("=== アスペクト比の分布 ===");
for (const [k, v] of [...bucket.entries()].sort((a, b) => b[1] - a[1])) {
  const pass = /4:3|3:2|16:9|正方形/.test(k);
  console.log(`  ${k}: ${v}枚 (${(v / posts.length * 100).toFixed(0)}%)${pass ? "  ← goodAspect通過" : "  ← 除外される"}`);
}

// --- 2) サムネイル/スクショ系タグの割合 ---
const THUMB = ["サムネイル", "youtube", "日本語のテキスト", "字幕", "実況", "you tuber", "youtuber", "プレイ", "ゲーム", "画面"];
let thumbHit = 0;
for (const p of posts) {
  const names = (p.tags || []).map((x) => ((x.names && x.names[0]) || "").toLowerCase());
  if (names.some((n) => THUMB.includes(n))) thumbHit++;
}
console.log(`\n=== サムネイル/画面系タグが付く割合: ${thumbHit}/${posts.length} (${(thumbHit / posts.length * 100).toFixed(0)}%) ===`);

// --- 3) source(元ネタ)の多様性 ---
const bySrc = new Map();
for (const p of posts) {
  const s = (p.source || "(なし)").replace(/^https?:\/\//, "").split("/")[0];
  bySrc.set(s, (bySrc.get(s) || 0) + 1);
}
const sorted = [...bySrc.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n=== source(ドメイン)の種類: ${bySrc.size}種 / ${posts.length}枚 ===`);
for (const [s, n] of sorted.slice(0, 8)) console.log(`  ${n}枚: ${s}`);
console.log(`\n※ 特定ドメインが上位を占めるほど「同じ元ネタの塊」が多い = ランダムに引いても似通いやすい`);
