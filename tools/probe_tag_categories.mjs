// hikabooruのタグに付く category の分布を実測する
//  ねらい: 「人間が付けた信頼できるタグ(キャラ/版権/作家など)」と
//          「AIが一括付与したタグ」を構造的に区別できるかを見る。
//          (手選定のリストを作るのではなく、APIが返すメタデータで判定したい)
const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "Mozilla/5.0" };
const Q = encodeURIComponent("safety:safe type:image");
const N = Number(process.argv[2] || 20);

const byCat = new Map(); // category -> {tags: 件数, images: Set, example: tag}
const perImageCats = new Map(); // category -> 出現画像数
const orderStats = []; // 「タグ配列の何番目か」ごとの usages(=並び順の意味を探る)

for (let i = 0; i < N; i++) {
  const offset = Math.floor(Math.random() * 29500);
  try {
    const r = await fetch(`${BASE}/api/posts?query=${Q}&limit=20&offset=${offset}&fields=id,tags`, { headers: UA });
    if (!r.ok) continue;
    const d = await r.json();
    for (const p of d?.results || []) {
      const cats = new Set();
      (p.tags || []).forEach((t, idx) => {
        const cat = t.category || "(なし)";
        const name = (t.names && t.names[0]) || "";
        if (!name) return;
        const cur = byCat.get(cat) || { tags: 0, images: 0, example: name, maxUsages: 0 };
        cur.tags++;
        cur.images++;
        if ((t.usages || 0) > cur.maxUsages) { cur.maxUsages = t.usages || 0; cur.example = name; }
        byCat.set(cat, cur);
        cats.add(cat);
        if (idx < 8) orderStats.push({ idx, usages: t.usages || 0 });
      });
      for (const c of cats) perImageCats.set(c, (perImageCats.get(c) || 0) + 1);
    }
  } catch {}
  if (i % 5 === 0) console.log(`...${i}/${N}`);
  await new Promise((s) => setTimeout(s, 200));
}

console.log("\n=== カテゴリ別(タグ出現数 / 画像出現数 / 例 / 最大usages) ===");
for (const [cat, v] of [...byCat.entries()].sort((a, b) => b[1].tags - a[1].tags)) {
  console.log(`  ${cat.padEnd(12)} タグ${String(v.tags).padStart(6)}回 / 画像${String(v.images).padStart(6)}枚 / 例「${v.example}」(usages ${v.maxUsages})`);
}

console.log("\n=== タグ配列の位置ごとの平均usages(並び順に意味があるか) ===");
const byIdx = new Map();
for (const o of orderStats) {
  const cur = byIdx.get(o.idx) || { sum: 0, n: 0 };
  cur.sum += o.usages;
  cur.n++;
  byIdx.set(o.idx, cur);
}
for (const idx of [...byIdx.keys()].sort((a, b) => a - b)) {
  const v = byIdx.get(idx);
  console.log(`  ${idx}番目: 平均usages ${Math.round(v.sum / v.n)} (n=${v.n})`);
}
