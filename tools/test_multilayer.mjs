// 多層認証の検証スイート
//  A) ウィジェットのPoWソルバー(実コードを抽出してWebCryptoで実行)が動くか
//  B) 攻撃シナリオ別の拒否(本番 :3107)
//  C) 全層通過の正常フロー(デバッグコピー :3108 で正解を取得して実施)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PROD = "http://localhost:3107";
const DEBUG = "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

// ---------- ウィジェットのPoWソルバーを実ファイルから抽出して評価 ----------
function loadWidgetPow() {
  const src = readFileSync("C:/Users/maeba/Desktop/hikamani-captcha/public/captcha.js", "utf8");
  const start = src.indexOf("function leadingZeroBits");
  const end = src.indexOf("function render(");
  if (start < 0 || end < 0) throw new Error("ウィジェットのPoW関数が見つからない");
  const code = src.slice(start, end);
  // 注: new Function の body は自分たちのリポジトリ内のウィジェット実コード(ローカルファイル)のみ。
  // 外部入力・ユーザー入力は一切混入しないので注入の余地はない(テスト目的で実コードを走らせるための評価)。
  const factory = new Function("crypto", "performance", code + "\nreturn { solvePow, leadingZeroBits };");
  return factory(globalThis.crypto, globalThis.performance);
}

function serverPowNonce(challenge, bits) {
  // サーバー実装と同じロジック(Node高速版)での期待値確認用
  for (let n = 0; n < 50_000_000; n++) {
    const h = createHash("sha256").update(challenge + ":" + n).digest();
    let z = 0;
    for (const b of h) { if (b === 0) { z += 8; continue; } z += Math.clz32(b) - 24; break; }
    if (z >= bits) return String(n);
  }
  return null;
}

async function post(base, path, body) {
  const r = await fetch(base + path, {
    method: "POST", headers: { ...UA, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

const HUMAN_SIGNALS = { interactionSeen: true, pointerMoves: 120, pointerDistance: 2400, clicks: 3, touchSeen: false, keySeen: true, powMs: 800 };

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} ${detail ? "→ " + detail : ""}`); }
}

async function main() {
  // ---------- A) ウィジェットPoWソルバー ----------
  console.log("=== A) ウィジェットのPoWソルバー(実コード) ===");
  const wp = loadWidgetPow();
  const chA = await (await fetch(PROD + "/api/challenge", { headers: UA })).json();
  console.log(`  お題「${chA.prompt}」難易度=${chA.pow.bits}bits`);
  const t0 = Date.now();
  const solved = await wp.solvePow(chA.pow.challenge, chA.pow.bits, null);
  const elapsed = Date.now() - t0;
  console.log(`  ブラウザ実コードでの解: nonce=${solved.nonce} (${elapsed}ms, 自己申告${solved.ms}ms)`);
  const expectNonce = serverPowNonce(chA.pow.challenge, chA.pow.bits);
  // 複数解があり得るので、解の妥当性は「難易度を満たす」ことで判定
  const h = createHash("sha256").update(chA.pow.challenge + ":" + solved.nonce).digest();
  let z = 0; for (const b of h) { if (b === 0) { z += 8; continue; } z += Math.clz32(b) - 24; break; }
  check("PoW解が難易度を満たす", z >= chA.pow.bits, `zeros=${z} < bits=${chA.pow.bits}`);
  check("PoW解がサーバーの受理条件と一致", solved.nonce === expectNonce || z >= chA.pow.bits);
  check("PoWが人間に許容できる時間(3秒以内)", elapsed < 3000, `${elapsed}ms`);

  // ---------- B) 攻撃シナリオ(本番 :3107) ----------
  console.log("\n=== B) 拒否されるべき攻撃(本番) ===");

  // B1: PoW無しで正解だけ送る(以前のタグボット相当)
  const ch1 = await (await fetch(PROD + "/api/challenge", { headers: UA })).json();
  const r1 = await post(PROD, "/api/verify", {
    id: ch1.id, selected: [ch1.tiles[0].id], ticket: ch1.ticket, nonce: "0",
    elapsedMs: 5000, signals: HUMAN_SIGNALS,
  });
  check("PoW未完了は拒否", !r1.body?.ok && (r1.body?.powRequired || /計算認証/.test(r1.body?.error || "")), JSON.stringify(r1.body));

  // B2: ハニーポット記入 → 即ボット判定
  const ch2 = await (await fetch(PROD + "/api/challenge", { headers: UA })).json();
  const r2 = await post(PROD, "/api/verify", {
    id: ch2.id, selected: [ch2.tiles[0].id], ticket: ch2.ticket, nonce: "0",
    elapsedMs: 5000, signals: HUMAN_SIGNALS, website: "http://spam.example/",
  });
  check("ハニーポット記入は拒否", !r2.body?.ok && /自動入力/.test(r2.body?.error || ""), JSON.stringify(r2.body));

  // B3: チケット無し
  const ch3 = await (await fetch(PROD + "/api/challenge", { headers: UA })).json();
  const r3 = await post(PROD, "/api/verify", {
    id: ch3.id, selected: [ch3.tiles[0].id], nonce: "0", elapsedMs: 5000, signals: HUMAN_SIGNALS,
  });
  check("チケット無しは拒否", !r3.body?.ok && r3.status === 410, JSON.stringify(r3.body));

  // B4: 偽チケット
  const r3b = await post(PROD, "/api/verify", {
    id: ch3.id, selected: [ch3.tiles[0].id], ticket: "f".repeat(32), nonce: "0",
    elapsedMs: 5000, signals: HUMAN_SIGNALS,
  });
  check("偽チケットは拒否", !r3b.body?.ok, JSON.stringify(r3b.body));

  // B5: PoWは解いたが操作シグナルが一切無い(スクリプトからの直接POST)
  const ch5 = await (await fetch(PROD + "/api/challenge", { headers: UA })).json();
  const n5 = await wp.solvePow(ch5.pow.challenge, ch5.pow.bits, null);
  const r5 = await post(PROD, "/api/verify", {
    id: ch5.id, selected: [ch5.tiles[0].id], ticket: ch5.ticket, nonce: n5.nonce,
    elapsedMs: 3000, signals: {}, // 操作ゼロ
  });
  check("操作シグナル無しは拒否", !r5.body?.ok && /機械的な操作/.test(r5.body?.error || ""), JSON.stringify(r5.body));

  // B6: PoWは解いたが速すぎる(画像を読む時間が無い)
  const ch6 = await (await fetch(PROD + "/api/challenge", { headers: UA })).json();
  const n6 = await wp.solvePow(ch6.pow.challenge, ch6.pow.bits, null);
  const r6 = await post(PROD, "/api/verify", {
    id: ch6.id, selected: [ch6.tiles[0].id], ticket: ch6.ticket, nonce: n6.nonce,
    elapsedMs: 100, signals: { ...HUMAN_SIGNALS, powMs: 0 },
  });
  check("速すぎる回答は拒否", !r6.body?.ok && /速すぎる/.test(r6.body?.error || ""), JSON.stringify(r6.body));

  // B6b: タッチ操作の人間は誤検知されない(画像の答えだけが理由で弾かれること)
  const ch6b = await (await fetch(PROD + "/api/challenge", { headers: UA })).json();
  const n6b = await wp.solvePow(ch6b.pow.challenge, ch6b.pow.bits, null);
  const r6b = await post(PROD, "/api/verify", {
    id: ch6b.id, selected: [ch6b.tiles[0].id], ticket: ch6b.ticket, nonce: n6b.nonce,
    elapsedMs: 4000,
    signals: { interactionSeen: true, pointerMoves: 1, pointerDistance: 10, clicks: 2, touchSeen: true, powMs: 800 },
  });
  check("タッチ操作の人間を誤検知しない", !/機械的な操作/.test(r6b.body?.error || ""), JSON.stringify(r6b.body));

  // B7: 古い形式(URLからタグを引くボット) — URLに投稿IDが無いこと
  const raw = await (await fetch(PROD + "/api/challenge", { headers: UA })).text();
  check("画像URLに投稿ID/ドメインが漏れない", !/\d{4,}_[A-Za-z0-9_\-]+\.\w+/.test(raw) && !raw.includes("hikabooru"));

  // ---------- C) 全層通過(デバッグコピー :3108) ----------
  console.log("\n=== C) 正常フロー(全層通過) ===");
  const chC = await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json();
  const correct = (chC.tiles || []).filter((t) => t.target).map((t) => t.id);
  if (!correct.length) { console.log("  デバッグコピー(:3108)が起動していません"); }
  else {
    const nC = await wp.solvePow(chC.pow.challenge, chC.pow.bits, null);
    await sleep(1400); // 人間らしい所要時間
    const rC = await post(DEBUG, "/api/verify", {
      id: chC.id, selected: correct, ticket: chC.ticket, nonce: nC.nonce,
      elapsedMs: 1500, signals: HUMAN_SIGNALS, website: "",
    });
    check("全層通過でトークン発行", !!(rC.body?.ok && rC.body?.token), JSON.stringify(rC.body));
    if (rC.body?.token) {
      const con = await post(DEBUG, "/api/consume", { token: rC.body.token, ticket: chC.ticket });
      check("正しいチケットで消費成功", con.body?.ok === true, JSON.stringify(con.body));

      // チケット横流し(別チケットで消費)は拒否されるか
      const chC2 = await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json();
      const nC2 = await wp.solvePow(chC2.pow.challenge, chC2.pow.bits, null);
      await sleep(1400);
      const rC2 = await post(DEBUG, "/api/verify", {
        id: chC2.id, selected: (chC2.tiles || []).filter((t) => t.target).map((t) => t.id),
        ticket: chC2.ticket, nonce: nC2.nonce, elapsedMs: 1500, signals: HUMAN_SIGNALS, website: "",
      });
      if (rC2.body?.token) {
        const steal = await post(DEBUG, "/api/consume", { token: rC2.body.token, ticket: chC.ticket });
        check("別チケットでの消費は拒否(横流し対策)", steal.body?.ok === false, JSON.stringify(steal.body));
      }
    }
  }

  console.log(`\n=== 合計: ${pass} PASS / ${fail} FAIL ===`);

  // ---------- D) 適応難易度(突破実績でPoWが重くなるか) ----------
  console.log("\n=== D) 適応難易度 ===");
  const before = (await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json()).pow.bits;
  console.log(`  現在の難易度: ${before}bits(突破実績 ${'?'}回)`);
  // デバッグコピーで5回突破して難易度が上がるか
  for (let i = 0; i < 5; i++) {
    const c = await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json();
    const n = await wp.solvePow(c.pow.challenge, c.pow.bits, null);
    await sleep(1300);
    const r = await post(DEBUG, "/api/verify", {
      id: c.id, selected: (c.tiles || []).filter((t) => t.target).map((t) => t.id),
      ticket: c.ticket, nonce: n.nonce, elapsedMs: 1600, signals: HUMAN_SIGNALS, website: "",
    });
    if (!r.body?.ok) { console.log(`  ${i + 1}回目の突破に失敗: ${JSON.stringify(r.body).slice(0, 80)}`); break; }
  }
  const after = (await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json()).pow.bits;
  console.log(`  5回突破後の難易度: ${after}bits`);
  check("突破実績でPoW難易度が上がる", after > before, `${before} -> ${after}`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
