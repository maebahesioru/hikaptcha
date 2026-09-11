// APIの「実際の応答」を全部記録する。ドキュメントに載せる例はここで取った実物だけにする。
//
//   使い方: node tools/api_walkthrough.mjs [http://localhost:3107]
//
// やること:
//   1. GET  /api/challenge        出題を取る
//   2. GET  /api/img/<id>         9枚を実際に取得(サーバーは取得を記録している)
//   3. PoWを解く(サーバーと同じ scrypt)
//   4. POST /api/verify           回答 → トークン
//   5. POST /api/consume          消費(1回目=成功 / 2回目=失敗)
//   6. 失敗系を実際に踏む(未取得・お手本を無視・ハニーポット・不正解)
//   7. GET  /api/health
import { scryptSync } from "node:crypto";

const BASE = process.argv[2] || "http://localhost:3107";
const J = (o) => JSON.stringify(o);

function leadingZeroBits(buf) {
  let z = 0;
  for (const b of buf) {
    if (b === 0) { z += 8; continue; }
    let x = b, n = 0;
    while ((x & 0x80) === 0) { n++; x = (x << 1) & 0xff; }
    return z + n;
  }
  return z;
}

function solvePow(pow) {
  const t0 = Date.now();
  for (let nonce = 0; nonce < 5_000_000; nonce++) {
    const dk = scryptSync(pow.challenge + ":" + nonce, Buffer.from(pow.salt, "hex"), 32,
      { N: pow.N, r: pow.r, p: pow.p, maxmem: 256 * 1024 * 1024 });
    if (leadingZeroBits(dk) >= pow.bits) return { nonce: String(nonce), ms: Date.now() - t0 };
  }
  throw new Error("PoWが解けない");
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: J(body),
  });
  let data; try { data = await r.json(); } catch { data = { _raw: "<json以外>" }; }
  return { status: r.status, data };
}
async function get(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, data: await r.json() };
}

const log = (label, v) => console.log(`\n### ${label}\n${typeof v === "string" ? v : J(v, null, 1)}`);

(async () => {
  console.log(`BASE = ${BASE}`);

  // ---- 1. 出題 ----
  const ch = (await get("/api/challenge")).data;
  log("1. GET /api/challenge", {
    id: ch.id, mode: ch.mode, ask: ch.ask, tags: ch.tags, prompt: ch.prompt,
    tiles: ch.tiles.slice(0, 2).map((t) => ({ id: t.id, url: t.url })) ,
    tile数: ch.tiles.length,
    ticket: ch.ticket.slice(0, 12) + "…",
    pow: { ...ch.pow, challenge: ch.pow.challenge.slice(0, 12) + "…", salt: ch.pow.salt.slice(0, 12) + "…" },
    honeypot: ch.honeypot, minMs: ch.minMs,
  });

  // ---- 2. 画像を実際に取る ----
  let imgStatus = [];
  for (const t of ch.tiles) {
    const r = await fetch(ch.tiles[0].url.startsWith("http") ? t.url : BASE + t.url.replace(/^https?:\/\/[^/]+/, ""));
    imgStatus.push(r.status);
  }
  log("2. GET /api/img/<id> ×9", { status: [...new Set(imgStatus)], 取得枚数: imgStatus.filter((s) => s === 200).length });

  // 正解の位置(本番は返らないので、デバッグコピー以外では「全選択」で試す)
  const hasTarget = ch.tiles.some((t) => t.target !== undefined);
  const selected = hasTarget
    ? ch.tiles.filter((t) => t.target).map((t) => t.id)
    : ch.tiles.map((t) => t.id);

  // ---- 3. PoW ----
  const pow = solvePow(ch.pow);
  log("3. PoWを解く", { nonce: pow.nonce, 所要ms: pow.ms });

  // ---- 4. 回答 ----
  const wait = Math.max(ch.minMs, 1600) - pow.ms;
  if (wait > 0) await new Promise((s) => setTimeout(s, wait));
  const started = Date.now();
  const v = await post("/api/verify", {
    id: ch.id,
    selected,
    ticket: ch.ticket,
    nonce: pow.nonce,
    elapsedMs: Date.now() - started + pow.ms + 100,
    signals: { interactionSeen: true, pointerMoves: 24, clicks: selected.length, touchSeen: false, keySeen: false, powMs: pow.ms },
  });
  log("4. POST /api/verify", v);

  if (v.status !== 200 || !v.data.token) {
    console.log("\n(ここで失敗したので以降はスキップ)");
    return;
  }

  // ---- 5. 消費 ----
  log("5a. POST /api/consume(1回目)", await post("/api/consume", { token: v.data.token, ticket: ch.ticket }));
  log("5b. POST /api/consume(2回目=同じトークン)", await post("/api/consume", { token: v.data.token, ticket: ch.ticket }));

  // ---- 6. 失敗系 ----
  // 6a. 存在しないID
  log("6a. 存在しない出題ID", await post("/api/verify", {
    id: "0000000000000000", selected: [], ticket: ch.ticket, nonce: pow.nonce, elapsedMs: 3000,
    signals: { interactionSeen: true, pointerMoves: 10, clicks: 1 },
  }));

  // 6b. ハニーポット(人間には見えない入力欄)を埋める
  {
    const c2 = (await get("/api/challenge")).data;
    const p2 = solvePow(c2.pow);
    await new Promise((s) => setTimeout(s, Math.max(c2.minMs, 1600) - p2.ms > 0 ? Math.max(c2.minMs, 1600) - p2.ms : 0));
    log("6b. ハニーポットを埋めて回答", await post("/api/verify", {
      id: c2.id, selected: c2.tiles.map((t) => t.id), ticket: c2.ticket, nonce: p2.nonce,
      elapsedMs: 3000, website: "http://spam.example",
      signals: { interactionSeen: true, pointerMoves: 12, clicks: 3, powMs: p2.ms },
    }));
  }

  // 6c. 画像を取らずに回答(取得の層)
  {
    const c3 = (await get("/api/challenge")).data;
    const p3 = solvePow(c3.pow);
    await new Promise((s) => setTimeout(s, 1700));
    log("6c. 画像を1枚も取らずに回答", await post("/api/verify", {
      id: c3.id, selected: c3.tiles.map((t) => t.id), ticket: c3.ticket, nonce: p3.nonce,
      elapsedMs: 3000, signals: { interactionSeen: true, pointerMoves: 12, clicks: 3, powMs: p3.ms },
    }));
  }

  // 6d. チケット無しで消費(横流し)
  log("6d. チケット無しで消費", await post("/api/consume", { token: "deadbeef".repeat(6) }));

  // ---- 7. health ----
  const h = (await get("/api/health")).data;
  log("7. GET /api/health", { ok: h.ok, statsのキー: Object.keys(h.stats) });
})().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
