// 出題の失敗率と失敗理由を測る(回帰チェック用)
// 使い方: node tools/probe_failure_rate.mjs [サーバー] [件数]
const BASE = process.argv[2] || "http://localhost:3107";
const N = Number(process.argv[3] || 40);

const stats = async () => (await (await fetch(BASE + "/api/health")).json()).stats;

const before = await stats();
let ok = 0;
let fail = 0;
const codes = {};
const slow = [];
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  const r = await fetch(BASE + "/api/challenge");
  const ms = Date.now() - t0;
  if (r.status === 200) { ok++; await r.json(); }
  else {
    fail++;
    codes[r.status] = (codes[r.status] || 0) + 1;
    const body = await r.text().catch(() => "");
    if (fail <= 3) console.log(`  失敗例: HTTP ${r.status} ${body.slice(0, 120)} (${ms}ms)`);
  }
  slow.push(ms);
  await new Promise((s) => setTimeout(s, 100));
}
slow.sort((a, b) => a - b);
console.log(`所要: 中央値${slow[Math.floor(slow.length / 2)]}ms / 最大${slow[slow.length - 1]}ms`);
console.log(`失敗の内訳: ${JSON.stringify(codes)}`);
const after = await stats();
const keys = Object.keys(after).filter((k) => k.startsWith("f"));
const delta = {};
for (const k of keys) {
  const d = (after[k] || 0) - (before[k] || 0);
  if (d) delta[k] = d;
}
console.log(`成功 ${ok}/${N} 失敗 ${fail}`);
console.log(`試行 +${after.attempts - before.attempts} / 出題 +${after.challenges - before.challenges}`);
console.log(`失敗理由の増分: ${JSON.stringify(delta)}`);
console.log(`fRecentEmpty +${after.fRecentEmpty - before.fRecentEmpty}`);
