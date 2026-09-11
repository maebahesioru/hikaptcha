// E(適応難易度)の突破が0回になる原因を特定する: 新品サーバーで応答本文を全部出す
import { readFileSync } from "node:fs";
import { createHash, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";

const PORT = 3111;
const BASE = `http://localhost:${PORT}`;
const UA = { "user-agent": "Mozilla/5.0" };
const FORWARDED = { ...UA, "x-forwarded-for": "203.0.113.99" };
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

// ウィジェットのPoW実装を流用
// 注: new Function に渡すのは自前リポジトリの captcha.js から切り出した文字列のみ。
//     外部入力は一切混ざらない(既存の test_multilayer.mjs と同じ読み込み方)。
const src = readFileSync("C:/Users/maeba/Desktop/hikamani-captcha/public/captcha.js", "utf8");
const start = src.indexOf("function salsa20_8");
const end = src.indexOf("function render(");
const mod = { exports: {} };
new Function("module", "exports", src.slice(start, end) + "\nmodule.exports={solveScryptPow};")(mod, mod.exports);
const W = mod.exports;

const srv = spawn("node", ["server.mjs"], {
  cwd: "C:/Users/maeba/AppData/Local/Temp/vtest2", // 正解タイル付きのデバッグコピー
  env: { ...process.env, PORT: String(PORT), IP_QUOTA: "100000" },
  stdio: "inherit",
});
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { up = (await fetch(BASE + "/api/health", { headers: UA })).ok; } catch {}
    if (!up) await sleep(500);
  }
  console.log("起動:", up);

  const ch = async (h) => (await fetch(BASE + "/api/challenge", { headers: h || UA })).json();

  const before = await ch(FORWARDED);
  console.log("before bits:", before.pow.bits, "minMs:", before.minMs);

  const c = await ch(FORWARDED);
  console.log("正解タイル:", (c.tiles || []).filter((t) => t.target).length, "/", c.tiles.length,
              "| モード:", c.mode, "| タイルにtargetがある:", "target" in (c.tiles[0] || {}));
  // 画像を全部取る(サーバーが「配信した」と記録する)
  await Promise.all(c.tiles.map((t) => fetch(t.url, { headers: UA }).then((r) => r.arrayBuffer())));
  const n = await W.solveScryptPow(c.pow.challenge, c.pow.salt, c.pow.bits, c.pow.N, c.pow.r, c.pow.p);
  await sleep(1700);
  const r = await fetch(BASE + "/api/verify", {
    method: "POST",
    headers: { ...FORWARDED, "content-type": "application/json" },
    body: JSON.stringify({
      id: c.id,
      selected: (c.tiles || []).filter((t) => t.target).map((t) => t.id),
      ticket: c.ticket, nonce: n.nonce, elapsedMs: 1800,
      signals: { pointerMoves: 12, pointerDistance: 420, interactions: 3, clicks: 3, keyPresses: 0,
                 touchEvents: 0, scrollEvents: 1, timeToFirstInteraction: 900, hidden: false,
                 webdriver: false, languages: "ja-JP", hardwareConcurrency: 8, deviceMemory: 8,
                 userAgent: "Mozilla/5.0", visibilityChanges: 0, interactionSeen: true },
      website: "",
    }),
  });
  console.log("verify:", r.status, JSON.stringify(await r.json()));
  console.log("after bits:", (await ch(FORWARDED)).pow.bits);
} finally {
  try { srv.kill(); } catch {}
}
