// 「9枚のうち何枚が同じ元ネタ(同じ投稿者/同じ塊)か」を実測する。
//  ユーザーの「全部の画像がなんとなく似通ってる」の直接指標。
//  デバッグコピー(:3108)が必要。postId の広がりと src の重複を数える。
const URL_ = process.argv[2] || "http://localhost:3108";
const N = Number(process.argv[3] || 12);
const UA = { "user-agent": "Mozilla/5.0" };

const rows = [];
for (let k = 0; k < N; k++) {
  let c = null;
  for (let t = 0; t < 4 && !c; t++) {
    try { const r = await fetch(`${URL_}/api/challenge`, { headers: UA }); if (r.ok) c = await r.json(); } catch {}
    if (!c) await new Promise((s) => setTimeout(s, 600));
  }
  if (!c || !c.tiles?.[0]?.src === undefined) { console.log("srcが取得できません(デバッグコピーを再生成)"); break; }
  const tiles = c.tiles;
  const ids = tiles.map((t) => t.postId).filter(Boolean).sort((a, b) => a - b);
  const span = ids.length ? ids[ids.length - 1] - ids[0] : 0;
  const perId = ids.length ? span / ids.length : 0;
  // src(アカウント)ごとの枚数
  const bySrc = new Map();
  for (const t of tiles) bySrc.set(t.src || "(なし)", (bySrc.get(t.src || "(なし)") || 0) + 1);
  const maxSame = Math.max(...bySrc.values());
  const distinctSrc = bySrc.size;
  const dupTags = tiles.map((t) => (t.tags || []).length);
  rows.push({ mode: c.mode, maxSame, distinctSrc, perId, span });
  console.log(
    `[${c.mode}] 同じ元ネタ最大 ${maxSame}枚 / 元ネタ種類 ${distinctSrc}種 / 投稿ID間隔 平均${perId.toFixed(0)} (幅${span}) / ${c.prompt.slice(0, 30)}`
  );
  await new Promise((s) => setTimeout(s, 250));
}
if (rows.length) {
  const avg = (k) => (rows.reduce((a, b) => a + b[k], 0) / rows.length).toFixed(1);
  console.log(`\n=== 平均: 同じ元ネタ最大 ${avg("maxSame")}枚 / 元ネタ種類 ${avg("distinctSrc")}種 / ID間隔 ${avg("perId")} ===`);
  console.log("※「同じ元ネタ最大」が小さいほど、9枚がバラバラの出所 = 似通って見えない");
}
