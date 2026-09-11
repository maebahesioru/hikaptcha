"""はみ出している表の原因セルを特定する"""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_context(viewport={"width": 1440, "height": 900}, locale="ja-JP").new_page()
    pg.goto("http://localhost:3107/docs", wait_until="networkidle")
    info = pg.evaluate(
        r"""() => {
      const t = [...document.querySelectorAll('main table')][2];
      if (!t) return null;
      const cs = getComputedStyle(t);
      const cells = [...t.querySelectorAll('th,td')].map(c => {
        const r = c.getBoundingClientRect();
        const ccs = getComputedStyle(c);
        // 最小内容幅を測る(nowrap相当の幅)
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
        probe.textContent = c.textContent;
        document.body.appendChild(probe);
        const nowrap = Math.round(probe.getBoundingClientRect().width);
        probe.remove();
        return { tag: c.tagName, text: c.textContent.slice(0, 26), w: Math.round(r.width),
                 minContent: nowrap, ws: ccs.whiteSpace, wb: ccs.wordBreak, ov: ccs.overflowWrap };
      });
      return { tableDisplay: cs.display, tableW: Math.round(t.getBoundingClientRect().width),
               scrollW: t.scrollWidth, clientW: t.clientWidth, cells: cells.slice(0, 12) };
    }"""
    )
    print("table display:", info["tableDisplay"], f"幅{info['tableW']} scrollW{info['scrollW']} clientW{info['clientW']}")
    print()
    for c in info["cells"]:
        print(f"  {c['tag']:3s} w={c['w']:4d} minContent={c['minContent']:5d} ws={c['ws']:8s} wb={c['wb']:12s} ov={c['ov']:10s} | {c['text']}")
    b.close()
