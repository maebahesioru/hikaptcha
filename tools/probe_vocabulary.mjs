// お題タグの「語彙の広さ」を実測する。
//   同じタグばかり出ると「同じような問題」に見えるので、実際に何種のタグが出るのか測る。
// 使い方: node tools/probe_vocabulary.mjs [サーバー] [件数]
const BASE = process.argv[2] || "http://localhost:3107";
const N = Number(process.argv[3] || 120);
const cnt = new Map();
const modes = {};
let ok = 0;
let fails = 0;
for (let i = 0; i < N * 2 && ok < N; i++) {
  const r = await fetch(BASE + "/api/challenge");
  if (r.status !== 200) { fails++; await new Promise((s) => setTimeout(s, 300)); continue; }
  const j = await r.json();
  ok++;
  const m = (j.ask && j.ask.mode) || j.mode || "?";
  modes[m] = (modes[m] || 0) + 1;
  for (const t of j.tags || (j.ask && j.ask.tags) || []) cnt.set(t, (cnt.get(t) || 0) + 1);
  await new Promise((s) => setTimeout(s, 80));
}
const total = [...cnt.values()].reduce((a, b) => a + b, 0);
const once = [...cnt.values()].filter((c) => c === 1).length;
const multi = [...cnt.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
console.log(`出題${ok}件 ${JSON.stringify(modes)}${fails ? ` (失敗${fails})` : ""}`);
console.log(`延べ${total}回 / 異なり${cnt.size}種 / 再出率 ${(100 * (1 - cnt.size / total)).toFixed(1)}%`);
console.log(`1回だけ出たタグ: ${once}種 (${((once / cnt.size) * 100).toFixed(0)}%) / 2回以上: ${multi.length}種`);
console.log(`再出の多い順: ${multi.slice(0, 15).map(([t, c]) => `${t}×${c}`).join("  ") || "(なし)"}`);
if (process.argv.includes("--list")) {
  const all = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => (c > 1 ? `${t}×${c}` : t));
  console.log(`\n出たタグ全部(${all.length}種):\n  ${all.join("  ")}`);
}
