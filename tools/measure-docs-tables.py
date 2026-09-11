"""どの表がはみ出しているか・狭い画面での挙動を実測する"""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    for vw in (1440, 1280, 1024, 940, 700):
        pg = b.new_context(viewport={"width": vw, "height": 900}, locale="ja-JP").new_page()
        pg.goto("http://localhost:3107/docs", wait_until="networkidle")
        rows = pg.evaluate(
            r"""() => [...document.querySelectorAll('main table')].map((t, i) => {
          const head = (t.querySelector('th')?.innerText || '').slice(0, 18);
          return { i, head, need: t.scrollWidth - t.clientWidth, cols: t.querySelectorAll('thead th').length };
        }).filter(x => x.need > 2)"""
        )
        print(f"viewport {vw}px: はみ出し {len(rows)}件", rows[:3])
        pg.close()
    b.close()
