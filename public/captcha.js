// ヒカマニCAPTCHA ウィジェット
// 使い方(埋め込み先サイト):
//   <div id="captcha"></div>
//   <script src="https://CAPTCHAサーバー/captcha.js"></script>
//   <script>
//     HikamaniCaptcha.render(document.getElementById("captcha"), {
//       apiBase: "https://CAPTCHAサーバー",   // 別オリジンに埋め込む時は必須
//       onSolved: function (token) { ... },   // 解決トークンを受け取る
//     });
//   </script>
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
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
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

    function draw() {
      box.textContent = "";
      box.appendChild(el("p", "hkc-title", "🤖 ロボットでないことを確認(ヒカマニCAPTCHA)"));

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
        // hikabooruは外部Refererのホットリンクを403で弾く → Refererを送らない
        img.referrerPolicy = "no-referrer";
        img.src = t.url;
        img.alt = "";
        img.loading = "lazy";
        img.draggable = false;
        btn.appendChild(img);
        btn.appendChild(el("span", "hkc-check", "✓"));
        btn.addEventListener("click", function () {
          if (busy) return;
          if (sel.has(t.id)) sel.delete(t.id);
          else sel.add(t.id);
          btn.classList.toggle("sel", sel.has(t.id));
          btn.setAttribute("aria-pressed", sel.has(t.id) ? "true" : "false");
          // 選択が1枚以上になったら確認ボタンを有効化(選択解除で無効化)
          const okBtn = box.querySelector(".hkc-btn.ok");
          if (okBtn) okBtn.disabled = sel.size === 0;
        });
        grid.appendChild(btn);
      });
      box.appendChild(grid);

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
      draw();
      fetch(apiBase + "/api/challenge", { cache: "no-store" })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          if (!j || !j.tiles || !j.tiles.length) {
            msg(j && j.error ? j.error : "問題を取得できませんでした", true);
            return;
          }
          ch = j;
          draw();
        })
        .catch(function () { msg("通信エラーが起きました。再試行してください", true); });
    }

    function submit() {
      if (!ch || sel.size === 0 || busy) return;
      busy = true;
      draw();
      msg("確認中...", false);
      fetch(apiBase + "/api/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ch.id, selected: Array.from(sel) }),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          busy = false;
          if (j && j.ok && j.token) {
            sel = new Set();
            ch = { prompt: null, tiles: [] };
            draw();
            msg("ロボット確認OK!", false);
            onSolved(j.token);
            return;
          }
          sel = new Set();
          if (j && j.expired) {
            load(); // 期限切れ/試行回数超過は新しい問題へ
            msg(j.error || "新しい問題を出します", true);
            return;
          }
          draw();
          msg(j && j.error ? j.error : "不正解です。選び直してください", true);
        })
        .catch(function () {
          busy = false;
          draw();
          msg("通信エラーが起きました。もう一度お試しください", true);
        });
    }

    load();
  }

  window.HikamaniCaptcha = { render: render };
})();
