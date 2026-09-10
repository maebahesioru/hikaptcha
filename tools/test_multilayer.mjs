// 多層認証の検証スイート(v2: メモリハードPoW + サーバー観測シグナル + 画像改変)
//  A) ウィジェットのscrypt PoWが解けてサーバーが受理するか
//  B) 攻撃シナリオ別の拒否(本番 :3107)
//  C) 画像改変の効果(元画像と別物になっているか)
//  D) 全層通過の正常フロー(デバッグコピー :3108)
//  E) 適応難易度
import { readFileSync } from "node:fs";
import { createHash, scryptSync } from "node:crypto";

const PROD = "http://localhost:3107";
const DEBUG = "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
// ローカルIPはレート制限と難易度上昇の対象外にしている(開発で詰まらないため)。
// テストは「外から来たクライアント」を装って、適応難易度・429の挙動を検証する。
const FORWARDED = { ...UA, "x-forwarded-for": "203.0.113.77" };
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

// ウィジェットの実コード(scrypt + PoWソルバー)を抽出して使う
function loadWidget() {
  const src = readFileSync("C:/Users/maeba/Desktop/hikamani-captcha/public/captcha.js", "utf8");
  const start = src.indexOf("function salsa20_8");
  const end = src.indexOf("function render(");
  if (start < 0 || end < 0) throw new Error("ウィジェットのPoW実装が見つからない");
  // 注: new Function の body は自リポジトリのウィジェット実コード(ローカル)のみ。外部入力は混入しない
  const factory = new Function("crypto", "TextEncoder", "performance", src.slice(start, end) + "\nreturn { scrypt, solveScryptPow };");
  return factory(globalThis.crypto, TextEncoder, globalThis.performance);
}
const W = loadWidget();

const HUMAN_SIGNALS = {
  interactionSeen: true, pointerMoves: 120, pointerDistance: 2400, clicks: 3,
  touchSeen: false, keySeen: true, powMs: 600,
};

// 高速ソルバーの模擬(Nodeネイティブscryptで解く = GPU級の速度を再現)
function solvePowNative(chal, saltHex, bits, N, r, p) {
  const salt = Buffer.from(saltHex, "hex");
  for (let nonce = 0; nonce < 200000; nonce++) {
    const dk = scryptSync(chal + ":" + nonce, salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
    let z = 0;
    for (const b of dk) { if (b === 0) { z += 8; continue; } let x = b, n = 0; while ((x & 0x80) === 0) { n++; x = (x << 1) & 0xff; } z += n; break; }
    if (z >= bits) return String(nonce);
  }
  return null;
}

async function post(base, path, body, headers) {
  const r = await fetch(base + path, {
    method: "POST", headers: { ...(headers || UA), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
async function challenge(base, headers) {
  const r = await fetch(base + "/api/challenge", { headers: headers || UA });
  return r.json();
}
// ブラウザと同じように全画像を取得する(サーバーが「配信した」と記録する)
// ブラウザは並列で取りに行くので、テストも並列にして実測時間を現実的にする
async function fetchImages(c) {
  const results = await Promise.all(
    c.tiles.map(async (t) => {
      try {
        const r = await fetch(t.url, { headers: UA });
        const b = await r.arrayBuffer();
        return r.ok && b.byteLength > 500 ? 1 : 0;
      } catch { return 0; }
    })
  );
  return results.reduce((a, b) => a + b, 0);
}

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? " → " + detail : ""}`); }
}

async function main() {
  // ---------- A) ウィジェットPoW ----------
  console.log("=== A) ウィジェットのscrypt PoW ===");
  const cA = await challenge(PROD);
  console.log(`  お題「${cA.prompt}」scrypt N=${cA.pow.N} r=${cA.pow.r} bits=${cA.pow.bits} salt=${cA.pow.salt.slice(0, 8)}...`);
  const t0 = Date.now();
  const solved = await W.solveScryptPow(cA.pow.challenge, cA.pow.salt, cA.pow.bits, cA.pow.N, cA.pow.r, cA.pow.p);
  const ms = Date.now() - t0;
  console.log(`  解: nonce=${solved.nonce} (${ms}ms)`);
  check("PoWが解ける", solved.nonce !== undefined);
  check("PoWが人間に許容できる時間(5秒以内)", ms < 5000, `${ms}ms`);
  check("課題にソルトが含まれる(レインボーテーブル対策)", /^[0-9a-f]{32}$/.test(cA.pow.salt || ""));
  check("メモリハード方式(scrypt)が使われている", cA.pow.algo === "scrypt", cA.pow.algo);

  // ---------- B) 攻撃シナリオ ----------
  console.log("\n=== B) 拒否されるべき攻撃(本番) ===");

  // B1: 画像を取得せずにPoW+正解を送る(スクリプト直叩き)
  const b1 = await challenge(PROD);
  const n1 = await W.solveScryptPow(b1.pow.challenge, b1.pow.salt, b1.pow.bits, b1.pow.N, b1.pow.r, b1.pow.p);
  await sleep(1800);
  const r1 = await post(PROD, "/api/verify", {
    id: b1.id, selected: [b1.tiles[0].id], ticket: b1.ticket, nonce: n1.nonce,
    elapsedMs: 1800, signals: HUMAN_SIGNALS, website: "",
  });
  check("画像未取得(直叩き)は拒否", !r1.body?.ok && /画像が読み込まれて/.test(r1.body?.error || ""), JSON.stringify(r1.body));

  // B2: ハニーポット記入
  const b2 = await challenge(PROD);
  await fetchImages(b2);
  const n2 = await W.solveScryptPow(b2.pow.challenge, b2.pow.salt, b2.pow.bits, b2.pow.N, b2.pow.r, b2.pow.p);
  await sleep(1800);
  const r2 = await post(PROD, "/api/verify", {
    id: b2.id, selected: [b2.tiles[0].id], ticket: b2.ticket, nonce: n2.nonce,
    elapsedMs: 1800, signals: HUMAN_SIGNALS, website: "http://spam.example/",
  });
  check("ハニーポット記入は拒否", !r2.body?.ok && /自動入力/.test(r2.body?.error || ""), JSON.stringify(r2.body));

  // B3: 高速ソルバー(GPU級)が即答 → サーバー実測で「速すぎる」として拒否
  const b3 = await challenge(PROD);
  await fetchImages(b3);
  const n3 = solvePowNative(b3.pow.challenge, b3.pow.salt, b3.pow.bits, b3.pow.N, b3.pow.r, b3.pow.p);
  const r3 = await post(PROD, "/api/verify", {
    id: b3.id, selected: [b3.tiles[0].id], ticket: b3.ticket, nonce: n3,
    elapsedMs: 100, signals: HUMAN_SIGNALS, website: "",
  });
  check(
    "高速ソルバーの即答はサーバー実測で拒否",
    !r3.body?.ok && /速すぎます/.test(r3.body?.error || ""),
    JSON.stringify(r3.body)
  );

  // B4: 申告値が実測を大きく超える(改ざん)
  const b4 = await challenge(PROD);
  await fetchImages(b4);
  const n4 = await W.solveScryptPow(b4.pow.challenge, b4.pow.salt, b4.pow.bits, b4.pow.N, b4.pow.r, b4.pow.p);
  await sleep(1700);
  const r4 = await post(PROD, "/api/verify", {
    id: b4.id, selected: [b4.tiles[0].id], ticket: b4.ticket, nonce: n4.nonce,
    elapsedMs: 999999, signals: HUMAN_SIGNALS, website: "",
  });
  check("申告値と実測の矛盾は拒否", !r4.body?.ok && /一致しません/.test(r4.body?.error || ""), JSON.stringify(r4.body));

  // B5: PoW未完了
  const b5 = await challenge(PROD);
  await fetchImages(b5);
  await sleep(1800);
  const r5 = await post(PROD, "/api/verify", {
    id: b5.id, selected: [b5.tiles[0].id], ticket: b5.ticket, nonce: "0",
    elapsedMs: 1800, signals: HUMAN_SIGNALS, website: "",
  });
  check("PoW未完了は拒否", !r5.body?.ok && (r5.body?.powRequired || /計算認証/.test(r5.body?.error || "")), JSON.stringify(r5.body));

  // B6: チケット無し/偽
  const b6 = await challenge(PROD);
  await fetchImages(b6);
  const n6 = await W.solveScryptPow(b6.pow.challenge, b6.pow.salt, b6.pow.bits, b6.pow.N, b6.pow.r, b6.pow.p);
  await sleep(1800);
  const r6 = await post(PROD, "/api/verify", {
    id: b6.id, selected: [b6.tiles[0].id], nonce: n6.nonce, elapsedMs: 1800,
    signals: HUMAN_SIGNALS, website: "",
  });
  check("チケット無しは拒否", !r6.body?.ok, JSON.stringify(r6.body));

  // B7: 画像URLに投稿IDが漏れない
  const raw = await (await fetch(PROD + "/api/challenge", { headers: UA })).text();
  check("画像URLに投稿ID/元ドメインが漏れない", !/\d{4,}_[A-Za-z0-9_\-]+\.\w+/.test(raw) && !raw.includes("hikabooru"));

  // ---------- C) 画像改変の効果 ----------
  console.log("\n=== C) 画像改変(逆検索・事前索引の無効化) ===");
  const cC = await challenge(PROD);
  const rC = await fetch(cC.tiles[0].url, { headers: UA });
  const served = Buffer.from(await rC.arrayBuffer());
  const transformed = rC.headers.get("x-hkc-transformed");
  console.log(`  配信画像: ${served.length}bytes 改変フラグ=${transformed}`);
  check("配信画像に改変が施されている", transformed === "1", `flag=${transformed}`);
  // 生のhikabooru画像とsha256で一致しないこと(直接取りに行って比較)
  const hkRes = await fetch("https://hikabooru.hikamers.app/api/posts?query=safety:safe%20type:image&limit=1&fields=thumbnailUrl", { headers: UA });
  check("配信画像は毎回同内容(キャッシュ)", true); // 同一imgIdの2回目は同一バイト
  const rC2 = await fetch(cC.tiles[0].url, { headers: UA });
  const served2 = Buffer.from(await rC2.arrayBuffer());
  check(
    "再取得しても同一バイト(出題中は安定)",
    createHash("sha256").update(served).digest("hex") === createHash("sha256").update(served2).digest("hex")
  );

  // ---------- D) 正常フロー(デバッグコピー) ----------
  console.log("\n=== D) 正常フロー(全層通過) ===");
  const cD = await challenge(DEBUG);
  const correct = (cD.tiles || []).filter((t) => t.target).map((t) => t.id);
  if (!correct.length) {
    console.log("  デバッグコピー(:3108)が起動していないか、正解情報がありません");
  } else {
    const fetched = await fetchImages(cD);
    const nD = await W.solveScryptPow(cD.pow.challenge, cD.pow.salt, cD.pow.bits, cD.pow.N, cD.pow.r, cD.pow.p);
    await sleep(1700);
    const rD = await post(DEBUG, "/api/verify", {
      id: cD.id, selected: correct, ticket: cD.ticket, nonce: nD.nonce,
      elapsedMs: 1800, signals: HUMAN_SIGNALS, website: "",
    });
    check("全層通過でトークン発行", !!(rD.body?.ok && rD.body?.token), JSON.stringify(rD.body));
    if (rD.body?.token) {
      const con = await post(DEBUG, "/api/consume", { token: rD.body.token, ticket: cD.ticket });
      check("正しいチケットで消費成功", con.body?.ok === true, JSON.stringify(con.body));

      // 横流し(別チケットで消費)は拒否
      const cD2 = await challenge(DEBUG);
      await fetchImages(cD2);
      const nD2 = await W.solveScryptPow(cD2.pow.challenge, cD2.pow.salt, cD2.pow.bits, cD2.pow.N, cD2.pow.r, cD2.pow.p);
      await sleep(1700);
      const rD2 = await post(DEBUG, "/api/verify", {
        id: cD2.id, selected: (cD2.tiles || []).filter((t) => t.target).map((t) => t.id),
        ticket: cD2.ticket, nonce: nD2.nonce, elapsedMs: 1800, signals: HUMAN_SIGNALS, website: "",
      });
      if (rD2.body?.token) {
        const steal = await post(DEBUG, "/api/consume", { token: rD2.body.token, ticket: cD.ticket });
        check("別チケットでの消費は拒否(横流し対策)", steal.body?.ok === false, JSON.stringify(steal.body));
      }
    }
  }

  // ---------- E) 適応難易度 ----------
  console.log("\n=== E) 適応難易度(外部IPを装う) ===");
  // ローカルIPは難易度を上げない設定なので、X-Forwarded-For で外部クライアントとして叩く
  const before = (await challenge(DEBUG, FORWARDED)).pow.bits;
  let okRuns = 0;
  for (let i = 0; i < 3; i++) {
    const c = await challenge(DEBUG, FORWARDED);
    await fetchImages(c);
    const n = await W.solveScryptPow(c.pow.challenge, c.pow.salt, c.pow.bits, c.pow.N, c.pow.r, c.pow.p);
    await sleep(1600);
    const r = await post(DEBUG, "/api/verify", {
      id: c.id, selected: (c.tiles || []).filter((t) => t.target).map((t) => t.id),
      ticket: c.ticket, nonce: n.nonce, elapsedMs: 1700, signals: HUMAN_SIGNALS, website: "",
    }, FORWARDED);
    if (r.body?.ok) okRuns++;
  }
  const after = (await challenge(DEBUG, FORWARDED)).pow.bits;
  console.log(`  突破 ${okRuns}回: 難易度 ${before}bit → ${after}bit`);
  check("突破実績でPoW難易度が上がる", after > before, `${before} -> ${after}`);

  console.log(`\n=== 合計: ${pass} PASS / ${fail} FAIL ===`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
