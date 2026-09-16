"""公開ドキュメントとデモの見た目を確認(スクショ)"""
from playwright.sync_api import sync_playwright
OUT = "C:/Users/maeba/Desktop/hikamani-captcha/.docs-shots"
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 1000}, device_scale_factor=1.4)
    # ドキュメント
    pg.goto("https://hikaptcha.hikamers.app/docs", wait_until="load")
    pg.wait_for_timeout(1200)
    pg.screenshot(path=OUT + "/deployed-docs.png")
    titles = pg.eval_on_selector_all("h2", "els => els.map(e => e.textContent.trim())")
    print("docs の h2:", titles)
    over = pg.evaluate("() => [...document.querySelectorAll('*')].filter(e => e.scrollWidth > e.clientWidth + 2 && e.clientWidth > 0).length")
    print("横スクロール要素:", over)
    # デモ
    pg.goto("https://hikaptcha.hikamers.app/", wait_until="load")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=OUT + "/deployed.png")
    print("デモ撮影OK")
    b.close()
