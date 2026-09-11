// 決定的な検証: 「共起タグのカバレッジ」は『画像にTが写っているか』を予測するか?
//
// 使い方: node tools/validate_companion_score.mjs タグ名 [枚数=6]
//
// 出すもの(6枚ずつ):
//   A群 = Tが付いていないのに共起カバレッジが高い画像(=「誤漏れ」と判定したい画像)
//   B群 = Tが付いているのに共起カバレッジが低い画像(=「誤付与」と判定したい画像)
// これらを実際に見て、Tが写っているかを vision で判定する。
//   → A群にTが写っていれば「予測が当たっている」= 使える
//   → A群にTが写っていなければ「ただのシリーズ指紋」= 使えない
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://hikabooru.hikamers.app";
const TAG = process.argv[2] || "眼鏡";
const N = Number(process.argv[3] || 6);
const OUT = `C:/Users/maeba/Desktop/hikamani-captcha/tools/comp-${Date.now()}`;
const UA = { "user-agent": "HikamaniCaptchaProbe/1.0 (research)" };
const enc = encodeURIComponent;
const N_SITE = 56000;

const api = async (p) => {
  const r = await fetch(BASE + p, { headers: UA });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};
const names = (p) => (p.tags || []).map((t) => t.names[0]);

mkdirSync(OUT, { recursive: true });

// 1) 共起タグ(それなりの枚数で作る)
const tSet = await api(`/api/posts?query=${enc(TAG)}&limit=200&fields=id,tags,thumbnailUrl`);
const tPosts = tSet.results || [];
const freq = new Map(), usages = new Map();
for (const p of tPosts) {
  for (const t of p.tags || []) {
    freq.set(t.names[0], (freq.get(t.names[0]) || 0) + 1);
    usages.set(t.names[0], t.usages);
  }
}
const comps = [...freq.entries()]
  .filter(([n, c]) => n !== TAG && c / tPosts.length >= 0.3)
  .map(([n, c]) => ({ n, ratio: c / tPosts.length, idf: Math.max(0, Math.log(N_SITE / Math.max(1, usages.get(n) || 1))) }))
  .filter((c) => c.idf > 0.5) // 汎用すぎるタグは捨てる
  .sort((a, b) => b.idf * b.ratio - a.idf * a.ratio);
const compSet = new Map(comps.map((c) => [c.n, c.idf]));
const idfSum = [...compSet.values()].reduce((a, b) => a + b, 0);
const score = (p) => {
  const s = new Set(names(p));
  let sum = 0;
  for (const [n, w] of compSet) if (s.has(n)) sum += w;
  return idfSum ? sum / idfSum : 0;
};
console.log(`共起タグ ${compSet.size}個 (IDF>0.5のみ): ${comps.slice(0, 8).map((c) => `${c.n}(${c.idf.toFixed(1)})`).join(", ")}`);

// 2) Tなし画像をランダムに集めて、スコア上位 = A群
const pool = await api(`/api/posts?query=${enc("-" + TAG + " type:image")}&limit=200&offset=${Math.floor(Math.random() * Math.max(1, tSet.total))}&fields=id,tags,thumbnailUrl`);
const noT = (pool.results || []).filter((p) => !names(p).includes(TAG)).map((p) => ({ ...p, s: score(p) })).sort((a, b) => b.s - a.s);
const A = noT.slice(0, N);

// 3) T付き画像のスコア下位 = B群
const withT = tPosts.map((p) => ({ ...p, s: score(p) })).sort((a, b) => a.s - b.s);
const B = withT.slice(0, N);

console.log(`\nA群(Tなし・スコア上位): ${A.map((p) => p.s.toFixed(2)).join(", ")}`);
console.log(`B群(Tあり・スコア下位): ${B.map((p) => p.s.toFixed(2)).join(", ")}`);
console.log(`(Tなし全体のスコア上位20件の平均 ${(noT.slice(0, 20).reduce((a, b) => a + b.s, 0) / Math.max(1, Math.min(20, noT.length))).toFixed(3)} / T付き全体の平均 ${(withT.reduce((a, b) => a + b.s, 0) / Math.max(1, withT.length)).toFixed(3)})`);

// 4) サムネイルを落として montage を作る
const rows = [];
const truth = [];
for (const [group, list] of [["A", A], ["B", B]]) {
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const raw = p.thumbnailUrl || "";
    const url = raw.startsWith("http") ? raw : BASE + (raw.startsWith("/") ? raw : "/" + raw);
    const file = `${OUT}/${group}${i + 1}.jpg`;
    const r = await fetch(url, { headers: UA });
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(file, buf);
    rows.push(file);
    truth.push({ group, idx: i + 1, id: p.id, score: Number(p.s.toFixed(3)),
                 tags: names(p).slice(0, 12) });
  }
}
writeFileSync(`${OUT}/truth.json`, JSON.stringify(truth, null, 1));

console.log("上段 =", A.map((p) => p.id).join(", "));
console.log("下段 =", B.map((p) => p.id).join(", "));
console.log(`\n各画像のリンク:`);
for (const t of truth) console.log(`  ${t.group}${t.idx} (score ${t.score}) https://hikabooru.hikamers.app/posts/${t.id}`);
console.log(`\nOUT=${OUT}`);
