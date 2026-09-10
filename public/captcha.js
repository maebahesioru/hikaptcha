// ヒカマニCAPTCHA ウィジェット(多層認証版)
// 使い方(埋め込み先サイト):
//   <div id="captcha"></div>
//   <script src="https://CAPTCHAサーバー/captcha.js"></script>
//   <script>
//     HikamaniCaptcha.render(document.getElementById("captcha"), {
//       apiBase: "https://CAPTCHAサーバー",
//       onSolved: function (token, ticket) { ... },
//     });
//   </script>
// サーバー側は /api/consume に { token, ticket } を送って消費する。
//
// 層: 画像認証 / メモリハードPoW(scrypt) / ハニーポット / チケット束縛 / 挙動シグナル
//     + サーバー側で「画像が実際に配信されたか」「実測経過時間」を検証する
// 外部CDN不使用・自鯖配信のためSRI対象外。
(function () {
  "use strict";

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .hkc {
      font-family: inherit;
      color: #e4e4e7;
      background: #18181b;
      border: 1px solid #3f3f46;
      border-radius: 12px;
      padding: 14px;
      width: 100%;
      max-width: 720px;
      user-select: none;
    }
    .hkc-title { margin: 0 0 6px; font-size: 12px; font-weight: 700; color: #a1a1aa; }
    .hkc-prompt { margin: 0 0 10px; font-size: 15px; line-height: 1.5; color: #d4d4d8; }
    .hkc-prompt b { color: #7dd3fc; }
    .hkc-prompt .all { color: #fcd34d; }
    .hkc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .hkc-tile {
      position: relative;
      padding: 0;
      /* 境界を明確にする(ぼかし背景と前景が混ざって見えるのを防ぐ) */
      border: 2px solid #52525b;
      border-radius: 8px;
      overflow: hidden;
      background: #000;
      cursor: pointer;
      /* 配信画像をクロップせず contain で見せるので、タイルは 3:2 */
      aspect-ratio: 3 / 2;
      display: block;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .6);
      transition: border-color .12s, opacity .12s;
    }
    /* 背景: 同じ画像を拡大+ぼかして敷き、余白を黒帯ではなく自然に見せる。
       暗めにして前景(はっきりした画像)との境目を作る */
    .hkc-tile .hkc-bg {
      position: absolute;
      inset: 0;
      width: 100%; height: 100%;
      object-fit: cover;
      filter: blur(14px) brightness(0.38) saturate(1.1);
      transform: scale(1.2);
      display: block;
    }
    /* 前景: 画像全体を切らずに表示(これが本物のタイル) */
    .hkc-tile .hkc-fg {
      position: relative;
      width: 100%; height: 100%;
      object-fit: contain;
      display: block;
    }
    .hkc-tile:hover { border-color: #71717a; }
    .hkc-tile.sel { border-color: #7dd3fc; outline: 2px solid rgba(125, 211, 252, .6); outline-offset: -1px; }
    .hkc-tile.sel img { opacity: .82; }
    .hkc-check {
      position: absolute; top: 4px; right: 4px;
      width: 18px; height: 18px; border-radius: 9999px;
      background: #0ea5e9; color: #fff;
      font-size: 11px; font-weight: 700; line-height: 18px; text-align: center;
      display: none;
    }
    .hkc-tile.sel .hkc-check { display: block; }
    .hkc-bar { margin-top: 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .hkc-btn {
      font: inherit; font-size: 12px; font-weight: 700;
      border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer;
    }
    .hkc-btn.ok { background: #0369a1; color: #fff; }
    .hkc-btn.ok:hover { background: #0284c7; }
    .hkc-btn.ghost { background: transparent; color: #a1a1aa; border: 1px solid #3f3f46; }
    .hkc-btn.ghost:hover { color: #e4e4e7; }
    .hkc-btn:disabled { opacity: .45; cursor: not-allowed; }
    .hkc-msg { font-size: 12px; margin: 8px 0 0; line-height: 1.5; }
    .hkc-msg.warn { color: #f87171; }
    .hkc-msg.ok { color: #34d399; font-weight: 700; }
    .hkc-loading { padding: 26px 0; text-align: center; font-size: 12px; color: #71717a; }
    .hkc-hp {
      position: absolute !important;
      left: -9999px !important;
      width: 1px; height: 1px;
      opacity: 0; pointer-events: none;
    }
    .hkc-layers { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; font-size: 10px; }
    .hkc-layer { border: 1px solid #3f3f46; border-radius: 9999px; padding: 2px 8px; color: #71717a; }
    .hkc-layer.on { border-color: #22c55e; color: #86efac; }
    .hkc-layer.work { border-color: #eab308; color: #fde047; }
    .hkc-layer.off { border-color: #7f1d1d; color: #fca5a5; }
    .hkc-progress { height: 3px; background: #27272a; border-radius: 2px; overflow: hidden; margin-top: 8px; }
    .hkc-progress i { display: block; height: 100%; width: 0%; background: #eab308; transition: width .2s; }
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ===== メモリハードPoW (scrypt / RFC 7914) =====
  // WebCryptoはscrypt非対応なので純JSで実装する。
  // SHA256のPoWと違いメモリ帯域律速なので、GPU/ASICの優位が数桁縮む。
  function salsa20_8(B) {
    const x = new Int32Array(16);
    for (let i = 0; i < 16; i++) x[i] = B[i];
    const rot = (v, n) => ((v << n) | (v >>> (32 - n))) | 0;
    for (let i = 0; i < 8; i += 2) {
      x[4] ^= rot(x[0] + x[12] | 0, 7); x[8] ^= rot(x[4] + x[0] | 0, 9);
      x[12] ^= rot(x[8] + x[4] | 0, 13); x[0] ^= rot(x[12] + x[8] | 0, 18);
      x[9] ^= rot(x[5] + x[1] | 0, 7); x[13] ^= rot(x[9] + x[5] | 0, 9);
      x[1] ^= rot(x[13] + x[9] | 0, 13); x[5] ^= rot(x[1] + x[13] | 0, 18);
      x[14] ^= rot(x[10] + x[6] | 0, 7); x[2] ^= rot(x[14] + x[10] | 0, 9);
      x[6] ^= rot(x[2] + x[14] | 0, 13); x[10] ^= rot(x[6] + x[2] | 0, 18);
      x[3] ^= rot(x[15] + x[11] | 0, 7); x[7] ^= rot(x[3] + x[15] | 0, 9);
      x[11] ^= rot(x[7] + x[3] | 0, 13); x[15] ^= rot(x[11] + x[7] | 0, 18);
      x[1] ^= rot(x[0] + x[3] | 0, 7); x[2] ^= rot(x[1] + x[0] | 0, 9);
      x[3] ^= rot(x[2] + x[1] | 0, 13); x[0] ^= rot(x[3] + x[2] | 0, 18);
      x[6] ^= rot(x[5] + x[4] | 0, 7); x[7] ^= rot(x[6] + x[5] | 0, 9);
      x[4] ^= rot(x[7] + x[6] | 0, 13); x[5] ^= rot(x[4] + x[7] | 0, 18);
      x[11] ^= rot(x[10] + x[9] | 0, 7); x[8] ^= rot(x[11] + x[10] | 0, 9);
      x[9] ^= rot(x[8] + x[11] | 0, 13); x[10] ^= rot(x[9] + x[8] | 0, 18);
      x[12] ^= rot(x[15] + x[14] | 0, 7); x[13] ^= rot(x[12] + x[15] | 0, 9);
      x[14] ^= rot(x[13] + x[12] | 0, 13); x[15] ^= rot(x[14] + x[13] | 0, 18);
    }
    for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
  }
  function blockMix(B, Y, r) {
    const X = new Int32Array(16);
    X.set(B.subarray((2 * r - 1) * 16, (2 * r - 1) * 16 + 16));
    for (let i = 0; i < 2 * r; i++) {
      for (let k = 0; k < 16; k++) X[k] ^= B[i * 16 + k];
      salsa20_8(X);
      Y.set(X, i * 16);
    }
    for (let i = 0; i < r; i++) B.set(Y.subarray(i * 2 * 16, i * 2 * 16 + 16), i * 16);
    for (let i = 0; i < r; i++) B.set(Y.subarray((i * 2 + 1) * 16, (i * 2 + 1) * 16 + 16), (i + r) * 16);
  }
  // PBKDF2-HMAC-SHA256(p, s, c=1, dkLen) — scryptの前段
  async function pbkdf2Sha256(pw, salt, dkLen) {
    const key = await crypto.subtle.importKey("raw", pw, { name: "PBKDF2" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 1, hash: "SHA-256" }, key, dkLen * 8
    );
    return new Uint8Array(bits);
  }
  // scrypt(password, salt, N, r, p, dkLen) → Uint8Array
  // RFC 7914: B = PBKDF2(pw,salt,1,p*M) → ROMix(B) → DK = PBKDF2(pw,B,1,dkLen)
  async function scrypt(pw, salt, N, r, p, dkLen) {
    const M = 128 * r;
    const raw = await pbkdf2Sha256(pw, salt, M * p); // 前段PBKDF2
    const B = new Int32Array(M * p / 4);
    const rawView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < B.length; i++) B[i] = rawView.getInt32(i * 4, true); // little-endian
    const V = new Int32Array((N * M) / 4);
    const Y = new Int32Array(M / 4);
    for (let i = 0; i < p; i++) {
      const off = (i * M) / 4;
      const view = B.subarray(off, off + M / 4);
      for (let j = 0; j < N; j++) { V.set(view, (j * M) / 4); blockMix(view, Y, r); }
      for (let j = 0; j < N; j++) {
        // Integerify: 最後のブロック先頭32bitを「符号なし」として読む。
        // JSの % は負値を返すので >>> 0 で符号なし化しないと index が壊れる
        const idx = ((view[(2 * r - 1) * 16] >>> 0) % N) * (M / 4);
        for (let k = 0; k < M / 4; k++) view[k] ^= V[idx + k];
        blockMix(view, Y, r);
      }
    }
    // 後段PBKDF2(scryptの仕様上必須。抜けるとサーバーの検証と一致しない)
    const bBytes = new Uint8Array(B.buffer, B.byteOffset, B.byteLength);
    return await pbkdf2Sha256(pw, bBytes, dkLen);
  }

  async function solveScryptPow(chal, saltHex, bits, N, r, p, onProgress) {
    const enc = new TextEncoder();
    const salt = new Uint8Array(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const target = bits;
    const t0 = performance.now();
    for (let nonce = 0; ; nonce++) {
      const dk = await scrypt(enc.encode(chal + ":" + nonce), salt, N, r, p, 32);
      let zeros = 0;
      for (let i = 0; i < dk.length; i++) {
        const b = dk[i];
        if (b === 0) { zeros += 8; continue; }
        let x = b, n = 0;
        while ((x & 0x80) === 0) { n++; x = (x << 1) & 0xff; }
        zeros += n;
        break;
      }
      if (zeros >= target) return { nonce: String(nonce), ms: Math.round(performance.now() - t0) };
      if (onProgress && nonce % 2 === 0) {
        onProgress(nonce, performance.now() - t0);
        await new Promise((res) => setTimeout(res, 0)); // UIに制御を返す
      }
    }
  }

  function render(mount, opts) {
    const apiBase = (opts && opts.apiBase) || "";
    const onSolved = (opts && typeof opts.onSolved === "function") ? opts.onSolved : function () {};

    const root = mount.attachShadow ? mount.attachShadow({ mode: "open" }) : mount;
    const style = el("style");
    style.textContent = STYLE;
    root.appendChild(style);
    const box = el("div", "hkc");
    root.appendChild(box);

    let ch = null;
    let sel = new Set();
    let busy = false;
    let challengeAt = 0;
    let waitTimer = null; // レート制限の待機カウントダウン用

    // 挙動シグナル(補助。サーバー側は画像配信の有無と実測時間を主軸に見る)
    const sig = { interactionSeen: false, pointerMoves: 0, pointerDistance: 0, clicks: 0, touchSeen: false, keySeen: false, powMs: 0 };
    let lastX = null, lastY = null;
    function onMove(e) {
      sig.interactionSeen = true;
      sig.pointerMoves++;
      if (e.pointerType === "touch") sig.touchSeen = true;
      if (lastX !== null) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        sig.pointerDistance += Math.sqrt(dx * dx + dy * dy);
      }
      lastX = e.clientX; lastY = e.clientY;
    }
    function onKey() { sig.interactionSeen = true; sig.keySeen = true; }
    function onDown(e) {
      sig.interactionSeen = true;
      if (e.pointerType === "touch") sig.touchSeen = true;
      const path = e.composedPath ? e.composedPath() : [];
      for (const n of path) if (n && n.classList && n.classList.contains("hkc-hp")) sig.touchedHidden = true;
    }
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("keydown", onKey, { passive: true });

    let layerStatus = { img: "", pow: "", beh: "", hp: "" };
    let progress = 0;

    function layers() {
      const wrap = el("div", "hkc-layers");
      const items = [
        ["画像認証", layerStatus.img],
        ["計算認証", layerStatus.pow],
        ["挙動判定", layerStatus.beh],
        ["ハニーポット", layerStatus.hp],
      ];
      for (const [label, st] of items) {
        const cls = st === "on" ? "hkc-layer on" : st === "work" ? "hkc-layer work" : st === "off" ? "hkc-layer off" : "hkc-layer";
        const mark = st === "on" ? "✓ " : st === "work" ? "… " : st === "off" ? "✕ " : "";
        wrap.appendChild(el("span", cls, mark + label));
      }
      return wrap;
    }

    function draw() {
      box.textContent = "";
      box.appendChild(el("p", "hkc-title", "🤖 ロボットでないことを確認(ヒカマニCAPTCHA)"));
      if (ch && (ch.ask || ch.prompt) && !busy) {
        const text = (ch.ask && ch.ask.text) || ch.prompt;
        const p = el("p", "hkc-prompt");
        p.appendChild(document.createTextNode("下の画像の中から"));
        // 「◯◯」=お題のタグ(青) / 「全部」「◯枚だけ」=強調(黄) に色を付ける
        const re = /「[^」]*」|全部|\d+枚だけ/g;
        let last = 0, m;
        while ((m = re.exec(text))) {
          if (m.index > last) p.appendChild(document.createTextNode(text.slice(last, m.index)));
          const t = m[0];
          const b = el("b", t === "全部" || /\d+枚だけ/.test(t) ? "all" : "");
          b.textContent = t;
          p.appendChild(b);
          last = m.index + t.length;
        }
        if (last < text.length) p.appendChild(document.createTextNode(text.slice(last)));
        box.appendChild(p);
      }
      if (!ch) {
        box.appendChild(el("div", "hkc-loading", busy ? "確認中..." : "問題を準備中..."));
        return;
      }
      const grid = el("div", "hkc-grid");
      ch.tiles.forEach(function (t) {
        const btn = el("button", "hkc-tile");
        btn.type = "button";
        btn.setAttribute("aria-pressed", sel.has(t.id) ? "true" : "false");
        // 背景(ぼかし)と前景(全体表示)の2枚でタイルを作る。
        // クロップしないので被写体が端で切れず、余白はぼかしで自然に埋まる。
        const bg = document.createElement("img");
        bg.className = "hkc-bg";
        bg.referrerPolicy = "no-referrer";
        bg.src = t.url;
        bg.alt = "";
        bg.draggable = false;
        bg.setAttribute("aria-hidden", "true");
        btn.appendChild(bg);
        const img = document.createElement("img");
        img.className = "hkc-fg";
        img.referrerPolicy = "no-referrer";
        img.src = t.url;
        img.alt = "";
        img.draggable = false;
        btn.appendChild(img);
        btn.appendChild(el("span", "hkc-check", "✓"));
        btn.addEventListener("click", function () {
          if (busy) return;
          sig.interactionSeen = true; sig.clicks++;
          const limit = (ch && ch.ask && ch.ask.maxSelect) || 0;
          if (limit === 1) {
            // 「1枚だけ選べ」の問題はラジオのように選択が移る
            sel.clear();
            sel.add(t.id);
            grid.querySelectorAll(".hkc-tile").forEach(function (b) {
              const on = b === btn;
              b.classList.toggle("sel", on);
              b.setAttribute("aria-pressed", on ? "true" : "false");
            });
          } else {
            // 「◯枚だけ選べ」を超える選択は無視する(選び直すには外してから押す)
            if (!sel.has(t.id) && limit > 0 && sel.size >= limit) return;
            if (sel.has(t.id)) sel.delete(t.id); else sel.add(t.id);
            btn.classList.toggle("sel", sel.has(t.id));
            btn.setAttribute("aria-pressed", sel.has(t.id) ? "true" : "false");
          }
          const okBtn = box.querySelector(".hkc-btn.ok");
          if (okBtn) okBtn.disabled = sel.size === 0;
        });
        grid.appendChild(btn);
      });
      box.appendChild(grid);

      const hp = document.createElement("input");
      hp.type = "text";
      hp.name = (ch && ch.honeypot) || "website";
      hp.className = "hkc-hp";
      hp.tabIndex = -1;
      hp.autocomplete = "off";
      hp.setAttribute("aria-hidden", "true");
      box.appendChild(hp);

      const bar = el("div", "hkc-bar");
      const ok = el("button", "hkc-btn ok", "確認する");
      ok.type = "button";
      ok.disabled = sel.size === 0;
      ok.addEventListener("click", submit);
      const again = el("button", "hkc-btn ghost", "別の問題にする");
      again.type = "button";
      again.addEventListener("click", load);
      bar.appendChild(ok);
      bar.appendChild(again);
      box.appendChild(bar);

      if (busy && progress > 0 && progress < 100) {
        const pr = el("div", "hkc-progress");
        const i = el("i");
        i.style.width = progress + "%";
        pr.appendChild(i);
        box.appendChild(pr);
      }
      box.appendChild(layers());
    }

    function msg(text, warn) {
      const old = box.querySelector(".hkc-msg");
      if (old) old.remove();
      box.appendChild(el("p", "hkc-msg " + (warn ? "warn" : "ok"), text));
    }

    function load() {
      ch = null; sel = new Set(); progress = 0;
      layerStatus = { img: "", pow: "", beh: "", hp: "" };
      draw();
      fetch(apiBase + "/api/challenge", { cache: "no-store" })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            return { status: r.status, j: j || {} };
          });
        })
        .then(function (res) {
          var j = res.j;
          // レート制限は「待てば必ず再開できる」ので、待ち時間を出して自動で再取得する。
          // エラー文字列を出して終わりにすると、ユーザーは何秒待てばいいか分からず詰む。
          if (res.status === 429) {
            var wait = Number(j.retryAfterSec || 0) || 5;
            waitCountdown(wait);
            return;
          }
          if (!j || !j.tiles || !j.tiles.length) {
            msg(j && j.error ? j.error : "問題を取得できませんでした", true);
            return;
          }
          ch = j;
          challengeAt = Date.now();
          draw();
        })
        .catch(function () { msg("通信エラーが起きました。再試行してください", true); });
    }

    // 待ち時間を1秒刻みで表示し、0になったら自動で取り直す
    function waitCountdown(sec) {
      if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
      var left = Math.max(1, Math.floor(sec));
      var render = function () {
        box.textContent = "";
        box.appendChild(el("p", "hkc-title", "🤖 ロボットでないことを確認(ヒカマニCAPTCHA)"));
        var p = el("p", "hkc-prompt");
        var b = el("b", "all");
        b.textContent = "あと" + left + "秒";
        p.appendChild(document.createTextNode("アクセスが集中しています。"));
        p.appendChild(b);
        p.appendChild(document.createTextNode("で自動的に再開します"));
        box.appendChild(p);
        box.appendChild(el("div", "hkc-loading", "待機中..."));
      };
      render();
      waitTimer = setInterval(function () {
        left -= 1;
        if (left <= 0) {
          clearInterval(waitTimer); waitTimer = null;
          load();
          return;
        }
        render();
      }, 1000);
    }

    async function submit() {
      if (!ch || sel.size === 0 || busy) return;
      busy = true;
      progress = 0;
      draw();
      const hpInput = box.querySelector(".hkc-hp");

      try {
        // 層: メモリハードPoW(scrypt) — GPUでも割に合わない計算コスト
        layerStatus.pow = "work";
        msg("計算認証を実行中...", false);
        draw();
        let nonce = "0";
        if (ch.pow && ch.pow.challenge) {
          const res = await solveScryptPow(
            ch.pow.challenge, ch.pow.salt, ch.pow.bits, ch.pow.N, ch.pow.r, ch.pow.p,
            function (n, ms) {
              progress = Math.min(95, Math.round((ms / 3000) * 100));
              msg("計算認証を実行中... (" + Math.round(ms) + "ms)", false);
              draw();
            }
          );
          nonce = res.nonce;
          sig.powMs = res.ms;
          progress = 100;
          layerStatus.pow = "on";
          msg("計算認証OK(" + res.ms + "ms)。画像認証を確認中...", false);
        } else {
          layerStatus.pow = "on";
        }
        layerStatus.hp = (hpInput && hpInput.value) ? "off" : "on";
        draw();

        const payload = {
          id: ch.id,
          selected: Array.from(sel),
          ticket: ch.ticket,
          nonce: nonce,
          elapsedMs: Date.now() - challengeAt,
          signals: sig,
        };
        if (hpInput) payload[(ch.honeypot) || "website"] = hpInput.value;

        const r = await fetch(apiBase + "/api/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const j = await r.json().catch(function () { return {}; });
        busy = false;
        progress = 0;

        if (j && j.ok && j.token) {
          layerStatus.img = "on";
          layerStatus.beh = typeof j.risk === "number" && j.risk > 0 ? "work" : "on";
          sel = new Set();
          ch = { prompt: null, tiles: [] };
          draw();
          msg("ロボット確認OK!", false);
          onSolved(j.token, payload.ticket);
          return;
        }
        if (j && j.powRequired) {
          layerStatus.pow = "off";
          draw();
          msg(j.error || "計算認証に失敗しました", true);
          return;
        }
        sel = new Set();
        if (j && j.expired) {
          load();
          msg(j.error || "新しい問題を出します", true);
          return;
        }
        layerStatus.img = "off";
        draw();
        msg(j && j.error ? j.error : "不正解です。選び直してください", true);
      } catch (e) {
        busy = false;
        progress = 0;
        draw();
        msg("通信エラーが起きました。もう一度お試しください", true);
      }
    }

    window.addEventListener("pagehide", function () {
      if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    });

    load();
  }

  window.HikamaniCaptcha = { render: render };
})();
