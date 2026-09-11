"""docページの「使い方・API」部分を実際に描画して撮る(見た目の確認用)

verify-docs.py は構造と崩れを見るが、ここでは新しく足したマニュアル部分だけを
目で確認できるようにスクリーンショットを切る。
"""
import sys

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3107"
SHOT = "C:/Users/maeba/Desktop/hikamani-captcha/.docs-shots"

TARGETS = [
    ("usage", "使い方(クイックスタート)"),      # 埋め込みコード
    ("flow", "認証フロー"),                       # シーケンス図
    ("api", "APIリファレンス"),                   # フィールド表
    ("errors", "エラー一覧(実際に返るメッセージ)"),  # エラー表
]

import urllib.request


def slug(text: str) -> str:
    """見出しのidは lib/md.mjs の作り方に合わせる(記号を落として小文字化)"""
    out = []
    for ch in text:
        if ch in "()（）・,、。:/／ 「」()%":
            continue
        out.append(ch)
    return "".join(out).lower()


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=1.5)
    pg.goto(BASE + "/docs", wait_until="load")
    pg.wait_for_timeout(400)

    # 目印として各見出しのidを実測
    ids = pg.eval_on_selector_all("h1,h2,h3", "els => els.map(e => [e.tagName, e.id, e.textContent])")
    print("=== ページ上の見出し(id付き) ===")
    for tag, hid, text in ids[:22]:
        print(f"  {tag} #{hid}  {text[:44]}")

    ok = 0
    for name, label in TARGETS:
        el = pg.query_selector(f"xpath=//h2[contains(., '{label[:6]}')]") or \
             pg.query_selector(f"xpath=//*[contains(text(), '{label[:8]}')]")
        if not el:
            print(f"  スキップ: {label}")
            continue
        path = f"{SHOT}/api-{name}.png"
        el.scroll_into_view_if_needed()
        pg.wait_for_timeout(250)
        # 見出しから下 1100px を切る
        box = el.bounding_box()
        pg.screenshot(path=path, clip={"x": 0, "y": box["y"] - 10, "width": 1280, "height": 1100})
        print(f"  撮影: {path}  ({label})")
        ok += 1

    # 横スクロールが出ている要素を検出(コードブロック含む)
    over = pg.evaluate("""() => {
      const bad = [];
      for (const el of document.querySelectorAll('*')) {
        if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
          bad.push({tag: el.tagName, cls: (el.className||'').toString().slice(0,30),
                    scroll: el.scrollWidth, client: el.clientWidth});
        }
      }
      return bad.slice(0, 8);
    }""")
    print(f"\n=== 横スクロールしている要素: {len(over)}個 ===")
    for o in over:
        print(f"  {o['tag']}.{o['cls']}  {o['scroll']}px > {o['client']}px")

    b.close()
    print(f"\n撮影 {ok}/{len(TARGETS)}")
