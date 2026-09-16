// 回転タスクのE2Eテスト: 正しい角度で通るか / 間違った角度で弾かれるか
// 使い方: node tools/test_rotate_mode.mjs [base=http://localhost:3108]
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
async function challenge() {
  const c = (await j("/api/challenge")).b;
  await Promise.all(c.tiles.map((t) => fetch(t.url).then((r) => r.arrayBuffer())));
  let nonce = "0";
  for (let i = 0; i < 1e6; i++) {
    const dk = scryptSync(c.pow.challenge + ":" + i, Buffer.from(c.pow.salt, "hex"), 32,
      { N: c.pow.N, r: c.pow.r, p: c.pow.p, maxmem: 2 ** 28 });
    if (zeros(dk) >= c.pow.bits) { nonce = String(i); break; }
  }
  await new Promise((s) => setTimeout(s, 1700));
  const tile = c.tiles.find((t) => t.target) || c.tiles[0];
  return { c, nonce, tile, applied: Number(tile.rot) || 0 };
}
const verify = (c, nonce, tile, rotate) => j("/api/verify", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: c.id, selected: [tile.id], ticket: c.ticket, nonce, rotate,
    elapsedMs: 1900, signals: { interactionSeen: true, pointerMoves: 25, clicks: 3 } }),
});

console.log(`BASE = ${BASE}`);
const a = await challenge();
console.log(`お題: ${a.c.ask ? a.c.ask.text : "(なし)"} / mode=${a.c.mode} / 適用角度=${a.applied}度 / step=${a.c.ask ? a.c.ask.step : "-"}`);
const wrong = (a.applied + 90) % 360;
const rw = await verify(a.c, a.nonce, a.tile, wrong);
console.log(`  間違った向き(${wrong}度)を申告 → HTTP ${rw.s} / ${rw.b.error || "ok:" + rw.b.ok}`);

const b = await challenge();
const correct = (360 - b.applied) % 360;
const rc = await verify(b.c, b.nonce, b.tile, correct);
console.log(`  正しい向き(${correct}度)を申告 → HTTP ${rc.s} / ${rc.b.error || "ok:" + rc.b.ok}${rc.b.token ? " / token発行" : ""}`);
console.log(rc.b.ok && rw.s === 400 ? "\n=> 回転タスクは期待どおり動作(正解は通り、不正解は弾かれる)" : "\n=> 想定外の結果");
