// ヒカマニCAPTCHA ウィジェット(多層認証版)
// 使い方(埋め込み先サイト):
//   <div id="captcha"></div>
//   <script src="https://CAPTCHAサーバー/captcha.js"></script>
//   <script>
//     HikamaniCaptcha.render(document.getElementById("captcha"), {
//       apiBase: "https://CAPTCHAサーバー",   // 別オリジンに埋め込む時は必須
//       onSolved: function (token, ticket) { ... },  // 解決トークン+チケット
//     });
//   </script>
// サーバー側は /api/consume に { token, ticket } を送って消費する。
//
// 層構成: 画像認証 + Proof-of-Work + ハニーポット + 挙動シグナル + チケット束縛
// 外部CDN等は使わない自前スクリプトのためSRI対象外(同一サーバー配信)。
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
      max-width: 520px;
      user-select: none;
    }
    .hkc-title { margin: 0 0 6px; font-size: 12px; font-weight: 700; color: #a1a1aa; }
    .hkc-prompt { margin: 0 0 10px; font-size: 13px; line-height: 1.5; color: #d4d4d8; }
    .hkc-prompt b { color: #7dd3fc; }
    .hkc-prompt .all { color: #fcd34d; }
    .hkc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .hkc-tile {
      position: relative;
      padding: 0;
      border: 1px solid #3f3f46;
      border-radius: 8px;
      overflow: hidden;
      background: #000;
      cursor: pointer;
      aspect-ratio: 1;
      display: block;
      transition: border-color .12s, opacity .12s;
    }
    .hkc-tile img {
      width: 100%; height: 100%;
      /* 全体が見えるように contain(正方形クロップで切らない) */
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
    /* ハニーポット: 人間には見えないがボットの自動入力は引っかかる */
    .hkc-hp {
      position: absolute !important;
      left: -9999px !important;
      width: 1px; height: 1px;
      opacity: 0; pointer-events: none;
    }
    .hkc-layers { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; font-size: 10px; }
    .hkc-layer {
      border: 1px solid #3f3f46; border-radius: 9999px;
      padding: 2px 8px; color: #71717a;
    }
    .hkc-layer.on { border-color: #22c55e; color: #86efac; }
    .hkc-layer.work { border-color: #eab308; color: #fde047; }
    .hkc-layer.off { border-color: #7f1d1d; color: #fca5a5; }
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- Proof-of-Work(sha256の先頭ゼロビット探索) ----
  function leadingZeroBits(buf) {
    let zeros = 0;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b === 0) { zeros += 8; continue; }
      let x = b, n = 0;
      while ((x & 0x80) === 0) { n++; x = (x << 1) & 0xff; }
      zeros += n;
      break;
    }
    return zeros;
  }

  async function solvePow(challenge, bits, onProgress) {
    const enc = new TextEncoder();
    const t0 = performance.now();
    let nonce = 0;
    while (true) {
      const buf = enc.encode(challenge + ":" + nonce);
      const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
      if (leadingZeroBits(h) >= bits) {
        return { nonce: String(nonce), ms: Math.round(performance.now() - t0) };
      }
      nonce++;
      // 512回ごとにUIへ制御を返す(固まらせない)+進捗表示
      if (nonce % 512 === 0) {
        if (onProgress) onProgress(nonce, performance.now() - t0c);
        await new Promise(function (r) { setTimeout(r, 0); });
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

    // ---- 挙動シグナル収集(ポインタ・タッチ・キー・クリック) ----
    // 誤検知を避けるため「操作があったか」を主指標にし、移動量は補助に使う。
    const sig = {
      interactionSeen: false,
      pointerMoves: 0,
      pointerDistance: 0,
      clicks: 0,
      touchSeen: false,
      keySeen: false,
      powMs: 0,
    };
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
      // 隠し要素(ハニーポット)への接触はボットの痕跡
      const p = e.composedPath ? e.composedPath() : [];
      for (const n of p) if (n && n.classList && n.classList.contains("hkc-hp")) sig.touchedHidden = true;
    }
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("keydown", onKey, { passive: true });

    function layers(status) {
      const wrap = el("div", "hkc-layers");
      const items = [
        ["img", "画像認証", status.img],
        ["pow", "計算認証", status.pow],
        ["beh", "挙動判定", status.beh],
        ["hp", "ハニーポット", status.hp],
      ];
      for (const [, label, st] of items) {
        const cls = st === "on" ? "hkc-layer on" : st === "work" ? "hkc-layer work" : st === "off" ? "hkc-layer off" : "hkc-layer";
        const mark = st === "on" ? "✓ " : st === "work" ? "… " : st === "off" ? "✕ " : "";
        wrap.appendChild(el("span", cls, mark + label));
      }
      return wrap;
    }

    let layerStatus = { img: "", pow: "", beh: "", hp: "" };

    function draw() {
      box.textContent = "";
      box.appendChild(el("p", "hkc-title", "🤖 ロボットでないことを確認(ヒカマニCAPTCHA)"));

      // お題タグを出題(画像を見て「◯◯の画像」を全部選ぶ)
      if (ch && ch.prompt && !busy) {
        const p = el("p", "hkc-prompt");
        p.appendChild(document.createTextNode("下の画像の中から「"));
        const b = el("b");
        b.textContent = ch.prompt;
        p.appendChild(b);
        p.appendChild(document.createTextNode("」の画像を"));
        const all = el("b", "all");
        all.textContent = "全部";
        p.appendChild(all);
        p.appendChild(document.createTextNode("選んでください"));
        box.appendChild(p);
      }

      if (!ch) {
        const d = el("div", "hkc-loading", busy ? "確認中..." : "問題を準備中...");
        box.appendChild(d);
        return;
      }

      const grid = el("div", "hkc-grid");
      ch.tiles.forEach(function (t) {
        const btn = el("button", "hkc-tile");
        btn.type = "button";
        btn.setAttribute("aria-pressed", sel.has(t.id) ? "true" : "false");
        const img = document.createElement("img");
        // 画像はプロキシ経由(元URLを隠す)。Refererも送らない
        img.referrerPolicy = "no-referrer";
        img.src = t.url;
        img.alt = "";
        img.loading = "lazy";
        img.draggable = false;
        btn.appendChild(img);
        btn.appendChild(el("span", "hkc-check", "✓"));
        btn.addEventListener("click", function () {
          if (busy) return;
          sig.interactionSeen = true;
          sig.clicks++;
          if (sel.has(t.id)) sel.delete(t.id);
          else sel.add(t.id);
          btn.classList.toggle("sel", sel.has(t.id));
          btn.setAttribute("aria-pressed", sel.has(t.id) ? "true" : "false");
          const okBtn = box.querySelector(".hkc-btn.ok");
          if (okBtn) okBtn.disabled = sel.size === 0;
        });
        grid.appendChild(btn);
      });
      box.appendChild(grid);

      // ハニーポット(人間には見えない・ボットの自動入力だけが引っかかる)
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

      box.appendChild(layers(layerStatus));
    }

    function msg(text, warn) {
      const old = box.querySelector(".hkc-msg");
      if (old) old.remove();
      const m = el("p", "hkc-msg " + (warn ? "warn" : "ok"), text);
      box.appendChild(m);
    }

    function load() {
      ch = null;
      sel = new Set();
      layerStatus = { img: "", pow: "", beh: "", hp: "" };
      draw();
      fetch(apiBase + "/api/challenge", { cache: "no-store" })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
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

    async function submit() {
      if (!ch || sel.size === 0 || busy) return;
      busy = true;
      draw();
      const hpInput = box.querySelector(".hkc-hp");

      try {
        // 層: 計算認証(Proof-of-Work) — 回答前に計算コストを要求
        layerStatus.pow = "work";
        msg("計算認証を実行中...", false);
        draw();
        let nonce = "0";
        if (ch.pow && ch.pow.challenge) {
          const res = await solvePow(ch.pow.challenge, ch.pow.bits, function (n, ms) {
            msg("計算認証を実行中... (" + Math.round(ms) + "ms / " + n + " 回)", false);
          });
          nonce = res.nonce;
          sig.powMs = res.ms; // PoWに要した時間(挙動判定で差し引く)
          layerStatus.pow = "on";
          msg("計算認証OK(" + res.ms + "ms)。画像認証を確認中...", false);
        } else {
          layerStatus.pow = "on";
        }
        // 層: ハニーポット(空であるべき)
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

        if (j && j.ok && j.token) {
          layerStatus.img = "on";
          layerStatus.beh = (typeof j.risk === "number" && j.risk > 0) ? "work" : "on";
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
        draw();
        msg("通信エラーが起きました。もう一度お試しください", true);
      }
    }

    // ページ離脱時にリスナを解放
    window.addEventListener("pagehide", function () {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    });

    load();
  }

  window.HikamaniCaptcha = { render: render };
})();
