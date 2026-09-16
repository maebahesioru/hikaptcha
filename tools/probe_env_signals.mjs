// 環境シグナル(webdriver等)の判定を実測する
// 使い方: node tools/probe_env_signals.mjs [base]
const BASE = process.argv[2] || "http://localhost:3108";
const { scryptSync } = await import("node:crypto");

const j = async (u, o) => {
  const r = await fetch(BASE + u, o);
  return { s: r.status, b: await r.json().catch(() => ({})) };
};
const zeros = (b) => {
  let z = 0;
  for (const x of b) {
    if (x === 0) { z += 8; continue; }
    let n = 0, v = x;
    while ((v & 0x80) === 0) { n++; v = (v << 1) & 0xff; }
    return z + n;
  }
  return z;
};

async function solve(signals, label) {
  const c = (await j("/api/challenge")).b;
  // 画像を実際に取得する(サーバーは配信の有無を記録している)
  const n = await fetch(c.tiles[0].url);
  await Promise.all(c.tiles.map((t) => fetch(t.url).then((r) => r.arrayBuffer())));
  void n;
  const sel = c.tiles.filter((t) => t.target).map((t) => t.id);
  let nonce = "0";
  for (let i = 0; i < 1e6; i++) {
    const dk = scryptSync(c.pow.challenge + ":" + i, Buffer.from(c.pow.salt, "hex"), 32,
      { N: c.pow.N, r: c.pow.r, p: c.pow.p, maxmem: 2 ** 28 });
    if (zeros(dk) >= c.pow.bits) { nonce = String(i); break; }
  }
  await new Promise((s) => setTimeout(s, 1700));
  const r = await j("/api/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: c.id, selected: sel, ticket: c.ticket, nonce, elapsedMs: 1900,
      signals: { ...signals, powMs: 200 } }),
  });
  console.log(`  ${label.padEnd(30)} → HTTP ${r.s} / ${r.b.error || ("ok:" + r.b.ok)}${r.b.risk !== undefined ? " / risk=" + r.b.risk : ""}`);
}

console.log(`BASE = ${BASE}`);
console.log("=== 環境シグナルの判定(画像取得済み) ===");
await solve({ interactionSeen: true, pointerMoves: 30, clicks: 2 }, "環境情報なし(=中立/API利用)");
await solve({ interactionSeen: true, pointerMoves: 30, clicks: 2, noChrome: true }, "ブラウザAPIなし(+1)");
await solve({ interactionSeen: true, pointerMoves: 30, clicks: 2, webdriver: true }, "webdriver=true(+2)");
await solve({ interactionSeen: true, pointerMoves: 30, clicks: 2, gpu: "Google SwiftShader" }, "ソフトウェア描画(+2)");
await solve({ interactionSeen: true, pointerMoves: 30, clicks: 2, webdriver: true, gpu: "Google SwiftShader" }, "両方(自動化ブラウザ相当)");
