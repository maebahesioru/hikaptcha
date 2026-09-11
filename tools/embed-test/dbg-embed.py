"""verifyが通らない原因を特定する(ネットワーク応答とウィジェットの表示を全部出す)"""
import json
import time

from playwright.sync_api import sync_playwright

SITE = "http://localhost:3200"
CAPTCHA = "http://localhost:3108"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1000, "height": 900}, locale="ja-JP")
    pg = ctx.new_page()

    events = []
    pg.on("console", lambda m: events.append(("console:" + m.type, m.text[:200])))
    pg.on("pageerror", lambda e: events.append(("pageerror", str(e)[:200])))
    pg.on("requestfailed", lambda r: events.append(("reqfail", f"{r.url[:90]} {r.failure}")))
    pg.on("response", lambda r: events.append(("resp", f"{r.status} {r.request.method} {r.url[:100]}")))

    captured = {}
    pg.on(
        "response",
        lambda r: captured.update({"body": r.json()})
        if r.url.endswith("/api/challenge") and r.status == 200
        else None,
    )

    pg.goto(SITE, wait_until="networkidle")
    pg.wait_for_function(
        "() => { const h=document.getElementById('captcha');"
        " return h && h.shadowRoot && h.shadowRoot.querySelectorAll('.hkc-tile').length===9; }",
        timeout=30000,
    )

    tiles = captured["body"]["tiles"]
    idx = [i for i, t in enumerate(tiles) if t.get("target")]
    print("正解:", idx, "モード:", captured["body"]["mode"], "minMs:", captured["body"].get("minMs"))

    pg.evaluate(
        r"""(idx) => {
      const sr = document.getElementById('captcha').shadowRoot;
      [...sr.querySelectorAll('.hkc-tile')].forEach((t,i) => { if (idx.includes(i)) t.click(); });
    }""",
        idx,
    )
    events.clear()
    pg.evaluate("() => document.getElementById('captcha').shadowRoot.querySelector('.hkc-btn.ok').click()")

    # 15秒間、状態と通信を観察する
    for i in range(15):
        time.sleep(1)
        st = pg.evaluate(
            r"""() => {
          const sr = document.getElementById('captcha').shadowRoot;
          const box = sr.querySelector('.hkc-prompt');
          const note = sr.querySelector('.hkc-msg') || sr.querySelector('.hkc-status') || sr.querySelector('.hkc-loading');
          const tk = document.getElementById('token').textContent;
          return { text: (box ? box.textContent : '').slice(0, 80), note: (note ? note.textContent : '').slice(0, 120), token: tk.slice(0, 16), hasToken: tk.length > 10 };
        }"""
        )
        if st["hasToken"]:
            print(f"t={i+1}s トークン発行!", st)
            break
        if i % 3 == 2 or "エラー" in st["note"] or "不正解" in st["note"]:
            print(f"t={i+1}s {st}")

    print("\n--- 通信 ---")
    for k, v in events[-25:]:
        print(f"  [{k}] {v}")
    b.close()
