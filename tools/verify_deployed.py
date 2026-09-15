"""デプロイ後の最終確認(スクショ+画像ロード)"""
from playwright.sync_api import sync_playwright
OUT = "C:/Users/maeba/Desktop/hikamani-captcha/.docs-shots/deployed.png"
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1180, "height": 980}, device_scale_factor=1.4)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("https://hikaptcha.hikamers.app/", wait_until="load")
    pg.wait_for_timeout(3000)
    info = pg.evaluate("""() => {
      const sh = [...document.querySelectorAll('*')].map(e => e.shadowRoot).filter(Boolean)[0];
      if (!sh) return {shadow: false};
      const imgs = [...sh.querySelectorAll('img')];
      const texts = [...sh.querySelectorAll('*')].map(e => e.textContent.trim()).filter(t => t && t.length < 80);
      return {shadow: true, images: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
              https: imgs.filter(i => i.src.startsWith('https')).length,
              prompt: texts.find(t => t.includes('選んでください')) || null,
              buttons: [...sh.querySelectorAll('button')].map(b => b.textContent.trim()).slice(0,3)};
    }""")
    print("ページ:", info)
    print("JSエラー:", errs[:3] if errs else "なし")
    pg.screenshot(path=OUT)
    print("スクショ:", OUT)
    b.close()
