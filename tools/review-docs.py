"""現在の /docs を見た目ごと確認する(デスクトップ/モバイル + 目次・本文の状態)"""
import json

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3107/docs"
OUT = "C:/Users/maeba/Desktop/hikamani-captcha/tools/docs-review"

import os
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    for name, vp, dsr in [("desktop", {"width": 1440, "height": 1000}, 1), ("mobile", {"width": 390, "height": 844}, 2)]:
        ctx = b.new_context(viewport=vp, locale="ja-JP", device_scale_factor=dsr)
        pg = ctx.new_page()
        errs = []
        pg.on("console", lambda m: errs.append(m.text[:120]) if m.type == "error" else None)
        pg.goto(BASE, wait_until="networkidle")
        pg.wait_for_timeout(800)

        info = pg.evaluate(
            r"""() => {
          const main = document.querySelector('main') || document.body;
          const p = main.querySelector('p');
          const cs = p ? getComputedStyle(p) : null;
          // 横スクロールが出ていないか(表のはみ出し検出)
          const de = document.documentElement;
          const overflow = de.scrollWidth - de.clientWidth;
          const tables = [...main.querySelectorAll('table')].map((t) => ({
            w: Math.round(t.getBoundingClientRect().width),
            rows: t.querySelectorAll('tr').length,
            over: Math.round(t.getBoundingClientRect().right - de.clientWidth),
          }));
          const links = [...main.querySelectorAll('a[href^="#"]')].length;
          return {
            h2: main.querySelectorAll('h2').length,
            h3: main.querySelectorAll('h3').length,
            tables: tables.length,
            worstTableOverflow: Math.max(0, ...tables.map((t) => t.over)),
            pageOverflow: overflow,
            tocLinks: document.querySelectorAll('nav a').length,
            bodyFontSize: cs ? cs.fontSize : null,
            bodyLineHeight: cs ? cs.lineHeight : null,
            bodyMaxWidth: cs ? cs.maxWidth : null,
            text: (p ? p.textContent : '').slice(0, 60),
          };
        }"""
        )
        pg.screenshot(path=f"{OUT}/docs-{name}.png", full_page=False)
        # 目次と本文の一部が入るように、少しスクロールした画も撮る
        pg.evaluate("() => window.scrollTo(0, 900)")
        pg.wait_for_timeout(400)
        pg.screenshot(path=f"{OUT}/docs-{name}-mid.png", full_page=False)
        print(f"[{name}] {json.dumps(info, ensure_ascii=False)}")
        print(f"        console errors: {errs[:2]}")
        ctx.close()
    b.close()
print("撮影完了:", OUT)
