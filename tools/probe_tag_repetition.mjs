// お題タグの「再出」と「似たタグの重複」を実測する。
//
// 使い方: node tools/probe_tag_repetition.mjs [サーバー] [件数]
//
// 見るもの:
//   1. 同じタグが何回出たか(再出率・上位)
//   2. 出たタグ同士が「似ている」組(文字列の包含 or 3文字以上の連続一致)
//   3. 似たタグが別々の出題として何回出たか
const BASE = process.argv[2] || "http://localhost:3107";
const N = Number(process.argv[3] || 40);

// server.mjs の relatedTag と同じ判定(2文字だと誤検出するので3文字以上)
function relatedTag(a, b) {
  if (!a || !b || a === b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const n = a.length < b.length ? a.length : b.length;
  for (let len = n; len >= 3; len--) {
    for (let i = 0; i + len <= a.length; i++) {
      if (b.includes(a.slice(i, i + len))) return true;
    }
  }
  return false;
}

(async () => {
  const used = [];
  const modes = {};
  let fail = 0;
  for (let i = 0; i < N; i++) {
    try {
      const r = await fetch(BASE + "/api/challenge");
      if (r.status !== 200) { fail++; continue; }
      const j = await r.json();
      const tags = j.tags || (j.ask && j.ask.tags) || [];
      const mode = (j.ask && j.ask.mode) || j.mode || "?";
      modes[mode] = (modes[mode] || 0) + 1;
      used.push({ i, tags, mode, text: (j.ask && j.ask.text) || j.prompt });
    } catch { fail++; }
    await new Promise((s) => setTimeout(s, 120));
  }
  console.log(`出題 ${used.length}件 (失敗${fail}) / モード ${JSON.stringify(modes)}`);

  // 1) タグ単体の出現回数
  const cnt = new Map();
  for (const u of used) for (const t of u.tags) cnt.set(t, (cnt.get(t) || 0) + 1);
  const uniq = cnt.size;
  const total = [...cnt.values()].reduce((a, b) => a + b, 0);
  console.log(`\n== タグの再出 ==`);
  console.log(`  延べ${total}回 / 異なり${uniq}種 / 再出率 ${((1 - uniq / total) * 100).toFixed(0)}%`);
  const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`  上位: ${top.map(([t, c]) => `${t}×${c}`).join("  ")}`);

  // 2) 似ているタグの組
  const uniqTags = [...cnt.keys()];
  const pairs = [];
  for (let i = 0; i < uniqTags.length; i++) {
    for (let j = i + 1; j < uniqTags.length; j++) {
      if (relatedTag(uniqTags[i], uniqTags[j])) pairs.push([uniqTags[i], uniqTags[j]]);
    }
  }
  console.log(`\n== 似ているタグの組 ==`);
  console.log(`  ${pairs.length}組 / 異なりタグ${uniq}種`);
  for (const [a, b] of pairs.slice(0, 12)) console.log(`    「${a}」 と 「${b}」 (${cnt.get(a)}回 / ${cnt.get(b)}回)`);

  // 3) 直前の出題と同じ/似たタグが続いた回数
  let backToBack = 0, relatedBack = 0;
  for (let i = 1; i < used.length; i++) {
    const prev = used[i - 1].tags, cur = used[i].tags;
    const same = cur.some((t) => prev.includes(t));
    const rel = cur.some((t) => prev.some((p) => relatedTag(t, p)));
    if (same) backToBack++;
    if (rel) relatedBack++;
  }
  console.log(`\n== 連続した出題 ==`);
  console.log(`  直前とまったく同じタグ: ${backToBack}/${used.length - 1}件`);
  console.log(`  直前と似たタグ        : ${relatedBack}/${used.length - 1}件`);
  console.log(`\n  出題の並び:`);
  for (const u of used.slice(0, 20)) console.log(`    [${u.mode}] ${(u.text || "").slice(0, 40)}`);
})().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
