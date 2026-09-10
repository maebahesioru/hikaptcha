// 「タグのサイト全体での使用回数(usages)」と「バッチ内の出現枚数」の関係を実測する。
// 目的: 出題形式ごとに必要なタグの信頼度しきい値を決める。
//   pick / or / notpick は「タグの誤りが即不正解になる」厳しい形式なので、
//   使用回数の多い(=付与が安定している)タグだけを使いたい。
const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "Mozilla/5.0" };
const BATCHES = Number(process.argv[2] || 8);

const hk = async (p) => {
  const r = await fetch(BASE + "/api" + p, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

const hist = new Map(); // 出現枚数 -> usagesの配列
for (let i = 0; i < BATCHES; i++) {
  const offset = Math.floor(Math.random() * 29500);
  const q = encodeURIComponent("safety:safe type:image");
  const d = await hk(`/posts?query=${q}&limit=20&offset=${offset}&fields=id,tags`);
  const rows = (d?.results || []).filter((p) => p && p.tags);
  if (!rows.length) continue;
  const byTag = new Map();
  for (const p of rows) {
    for (const t of p.tags) {
      const name = (t.names && t.names[0]) || "";
      if (!name) continue;
      if (!byTag.has(name)) byTag.set(name, { n: 0, usages: t.usages || 0 });
      byTag.get(name).n++;
    }
  }
  for (const [name, v] of byTag) {
    if (!hist.has(v.n)) hist.set(v.n, []);
    hist.get(v.n).push({ name, usages: v.usages });
  }
  await new Promise((s) => setTimeout(s, 300));
}

for (const n of [...hist.keys()].sort((a, b) => a - b)) {
  const arr = hist.get(n);
  const us = arr.map((x) => x.usages).sort((a, b) => a - b);
  const q = (f) => us[Math.min(us.length - 1, Math.floor(us.length * f))];
  console.log(
    `出現${n}枚: ${arr.length}タグ / usages 最小${us[0]} 25%${q(0.25)} 中央${q(0.5)} 75%${q(0.75)} 最大${us[us.length - 1]}`
  );
}
// 出現1〜3枚(=pick/or/notpickで使う帯)のタグをusages順に出す
const few = [];
for (const n of [1, 2, 3]) for (const x of hist.get(n) || []) few.push({ n, ...x });
few.sort((a, b) => b.usages - a.usages);
console.log("\n出現1〜3枚のタグ(usages上位20):");
for (const x of few.slice(0, 20)) console.log(`  ${x.usages} ${x.name} (出現${x.n})`);
console.log("\n出現1〜3枚のタグ(usages下位10):");
for (const x of few.slice(-10)) console.log(`  ${x.usages} ${x.name} (出現${x.n})`);
