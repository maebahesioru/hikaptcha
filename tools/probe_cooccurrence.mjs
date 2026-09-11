// 仮説: 「タグTが付いた画像群に共通して現れるタグ(共起タグ)」を使えば、
//       Tが付いていない画像に「Tが写っているか」を推定できるのではないか。
//
// これが効くと、次の2つが同時に直せる:
//   誤付与: Tが付いているのに共起タグがほとんど無い画像 → Tが写っていない可能性 → 正解から外す
//   誤漏れ: Tが付いていないのに共起タグが多い画像 → Tが写っている可能性 → ダミーに使わない
//
// 方式(ランダムバッチ+除外フィルタ)は変えずに、「除外の判断材料」を1つ増やすだけ。
//
// 使い方: node tools/probe_cooccurrence.mjs タグ名 [共起とみなす割合=0.4]
import { argv } from "node:process";

const BASE = "https://hikabooru.hikamers.app";
const TAG = argv[2] || "カーディガン";
const MIN_FREQ = Number(argv[3] || 0.4);

const UA = { "user-agent": "HikamaniCaptchaProbe/1.0 (research)" };
const enc = encodeURIComponent;

async function api(path) {
  const r = await fetch(BASE + path, { headers: UA });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

function tagNames(post) {
  return (post.tags || []).map((t) => t.names[0]);
}
function tagUsages(post) {
  const m = new Map();
  for (const t of post.tags || []) m.set(t.names[0], t.usages);
  return m;
}

(async () => {
  console.log(`== ${TAG} の共起タグを調べる ==`);

  // 1) そのタグが付いている画像を集める
  const set = await api(`/api/posts?query=${enc(TAG)}&limit=100&fields=id,tags`);
  const tPosts = set.results || [];
  console.log(`  T付き画像: ${tPosts.length}枚 (全${set.total}枚)`);

  // 2) 共起タグ = T付き画像のうち MIN_FREQ 以上の割合で現れるタグ
  const freq = new Map();
  const usagesOf = new Map();
  for (const p of tPosts) {
    for (const [name, u] of tagUsages(p)) {
      freq.set(name, (freq.get(name) || 0) + 1);
      usagesOf.set(name, u);
    }
  }
  const companions = [...freq.entries()]
    .filter(([name, n]) => name !== TAG && n / tPosts.length >= MIN_FREQ)
    .map(([name, n]) => ({ name, ratio: n / tPosts.length, usages: usagesOf.get(name) || 0 }))
    .sort((a, b) => b.ratio - a.ratio);
  console.log(`  共起タグ: ${companions.length}個 (${Math.round(MIN_FREQ * 100)}%以上の画像に出現)`);
  for (const c of companions.slice(0, 14)) {
    console.log(`    ${(c.ratio * 100).toFixed(0).padStart(3)}%  usages=${String(c.usages).padStart(6)}  ${c.name}`);
  }
  const compSet = new Set(companions.map((c) => c.name));
  // 汎用タグ(usagesが大きい)は「そのタグらしさ」を表さないので重みを下げる。
  // idf = log(N / usages)。Nはサイト全体のおおよその枚数。
  const N_SITE = 56000;
  const idf = new Map(companions.map((c) => [c.name, Math.max(0, Math.log(N_SITE / Math.max(1, c.usages)))]));
  const idfSum = [...idf.values()].reduce((a, b) => a + b, 0);
  const covW = (p) => {
    if (!idfSum) return 0;
    const names = new Set(tagNames(p));
    let s = 0;
    for (const c of compSet) if (names.has(c)) s += idf.get(c);
    return s / idfSum;
  };

  // 3) Tが付いていない画像(ランダムな位置から)を集めて、共起タグがどれだけ当たるか測る
  const total = set.total;
  const pool = await api(`/api/posts?query=${enc("-" + TAG + " type:image")}&limit=60&offset=${Math.floor(Math.random() * Math.max(1, total - 200))}&fields=id,tags`);
  const poolPosts = (pool.results || []).filter((p) => !tagNames(p).includes(TAG));
  console.log(`\n  Tなし画像: ${poolPosts.length}枚を無作為抽出で確認`);

  const cov = (p) => {
    let hit = 0;
    const names = new Set(tagNames(p));
    for (const c of compSet) if (names.has(c)) hit++;
    return compSet.size ? hit / compSet.size : 0;
  };
  const withT = tPosts.slice(0, 60).map((p) => ({ ...p, c: cov(p), w: covW(p) }));
  const withoutT = poolPosts.map((p) => ({ ...p, c: cov(p), w: covW(p) }));

  const avg = (a) => a.reduce((s, x) => s + x.c, 0) / Math.max(1, a.length);
  const pct = (a, q) => {
    const s = a.map((x) => x.c).sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0;
  };
  for (const key of ["c", "w"]) {
    const label = key === "c" ? "生のカバレッジ" : "IDF重み付き(珍しい共起タグ重視)";
    const a = withT.map((x) => ({ c: x[key] }));
    const b = withoutT.map((x) => ({ c: x[key] }));
    console.log(`\n== ${label} ==`);
    console.log(`  T付き  : 平均 ${(avg(a) * 100).toFixed(1)}%  中央 ${(pct(a, 0.5) * 100).toFixed(1)}%  最小 ${(pct(a, 0) * 100).toFixed(1)}%`);
    console.log(`  Tなし  : 平均 ${(avg(b) * 100).toFixed(1)}%  中央 ${(pct(b, 0.5) * 100).toFixed(1)}%  最大 ${(pct(b, 1) * 100).toFixed(1)}%`);
  }

  // 4) 誤漏れの候補 = Tなしなのに共起タグが多い画像(ここが視覚で要検証)
  const suspects = [...withoutT].sort((a, b) => b.w - a.w).slice(0, 8);
  console.log(`\n== 誤漏れ候補(Tなし・カバレッジ上位) ==`);
  for (const s of suspects) {
    const names = tagNames(s).filter((n) => compSet.has(n));
    console.log(`  id=${s.id} 生${(s.c * 100).toFixed(0)}% / IDF${(s.w * 100).toFixed(0)}% 一致タグ: ${names.slice(0, 6).join(" / ")}`);
    console.log(`     https://hikabooru.hikamers.app/posts/${s.id}`);
  }

  // 5) 誤付与の候補 = T付きなのにカバレッジが低い画像
  const bad = [...withT].sort((a, b) => a.w - b.w).slice(0, 5);
  console.log(`\n== 誤付与候補(T付き・カバレッジ下位) ==`);
  for (const s of bad) {
    console.log(`  id=${s.id} カバレッジ${(s.c * 100).toFixed(0)}%  https://hikabooru.hikamers.app/posts/${s.id}`);
  }
})().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
