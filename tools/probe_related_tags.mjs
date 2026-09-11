// 仮説: 「お題タグと“別物だが関連する”タグがバッチ内に存在すると不公平になる」
//   例: お題が「シャツ」なのに、ダミー側に「Tシャツ」「ワイシャツ」等が付いている画像がある
//       → 人間にはシャツに見えるので選んでしまい不正解。
//   AIタガーは似た概念を別タグで付けるため、これは「誤漏れ」の主要因になりうる。
//
// 測ること: 出題ごとに「ダミー側に、お題タグと文字列が近い(=関連しそうな)タグが何枚あるか」
//   文字列の近さ = 部分文字列(シャツ ⊂ ワイシャツ) / 2文字以上の共通部分
const DEBUG = process.argv[2] || "http://localhost:3108";
const N = Number(process.argv[3] || 20);
const UA = { "user-agent": "Mozilla/5.0" };

const related = (a, b) => {
  if (!a || !b || a === b) return false;
  if (a.includes(b) || b.includes(a)) return true; // シャツ / ワイシャツ
  // 2文字以上の連続した共通部分(カタカナ・漢字のみ対象。助詞や数字の一致は無視)
  const ok = /[\u30a0-\u30ff\u4e00-\u9faf]/;
  for (let len = Math.min(a.length, b.length); len >= 2; len--) {
    for (let i = 0; i + len <= a.length; i++) {
      const sub = a.slice(i, i + len);
      if (!ok.test(sub)) continue;
      if (b.includes(sub)) return true;
    }
  }
  return false;
};

let hit = 0, total = 0;
const examples = [];
for (let k = 0; k < N; k++) {
  let c = null;
  for (let t = 0; t < 4 && !c; t++) {
    try {
      const r = await fetch(DEBUG + "/api/challenge", { headers: UA });
      if (r.ok) {
        const j = await r.json();
        if (j && j.tiles && j.tiles[0].tags) c = j;
      }
    } catch {}
    if (!c) await new Promise((s) => setTimeout(s, 500));
  }
  if (!c) continue;
  const T = (c.tags || [])[0];
  if (!T) continue;
  total++;
  const risk = c.tiles.filter((t) => {
    if (t.target) return false;
    return (t.tags || []).some((x) => x !== T && related(T, x));
  });
  if (risk.length) {
    hit++;
    if (examples.length < 8) {
      const ex = risk[0].tags.filter((x) => x !== T && related(T, x)).slice(0, 3);
      examples.push(`「${T}」 vs ダミーの関連タグ [${ex.join(", ")}] (該当ダミー${risk.length}枚)`);
    }
  }
  await new Promise((s) => setTimeout(s, 200));
}

console.log(`出題 ${total}件中、ダミーに関連タグがある出題: ${hit}件 (${Math.round((hit / Math.max(1, total)) * 100)}%)`);
console.log("\n例:");
for (const e of examples) console.log("  " + e);
