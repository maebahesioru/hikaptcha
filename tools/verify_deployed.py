"""デプロイされたCAPTCHAをブラウザで開いて確認する"""
from playwright.sync_api import sync_playwright

URL = "https://hikaptcha.hikamers.app/"
OUT = "C:/Users/maeba/Desktop/hikamani-captcha/.docs-shots/deployed.png"

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 1100}, device_scale_factor=1.5)
    errs = []
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL, wait_until="load")
    pg.wait_for_timeout(2500)
    # 影のDOMの中を見る(captcha.jsはShadow DOMで描画する)
    info = pg.evaluate("""() => {
      const host = document.querySelector('div');
      const out = {hosts: document.querySelectorAll('*').length};
      const sh = [...document.querySelectorAll('*')].map(e => e.shadowRoot).filter(Boolean);
      out.shadowRoots = sh.length;
      if (sh.length) {
        const imgs = sh[0].querySelectorAll('img');
        out.images = imgs.length;
        out.loaded = [...imgs].filter(i => i.complete && i.naturalWidth > 0).length;
        const title = sh[0].querySelector('.hkc-title, .title, h3');
        out.prompt = title ? title.textContent.trim().slice(0, 60) : null;
      }
      return out;
    }""")
    print("ページ情報:", info)
    print("コンソールエラー:", errs[:3] if errs else "なし")
    pg.screenshot(path=OUT)
    print("スクショ:", OUT)
    b.close()
