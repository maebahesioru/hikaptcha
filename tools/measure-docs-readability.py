"""ドキュメントページの可読性を実測する(行長・文字サイズ・余白)"""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_context(viewport={"width": 1440, "height": 900}, locale="ja-JP").new_page()
    pg.goto("http://localhost:3107/docs", wait_until="networkidle")

    m = pg.evaluate(
        r"""() => {
      const main = document.querySelector('main');
      const pEl = [...main.querySelectorAll('p')].find(e => e.textContent.length > 60);
      const cs = pEl ? getComputedStyle(pEl) : null;
      const w = pEl ? pEl.getBoundingClientRect().width : main.getBoundingClientRect().width;
      const fs = cs ? parseFloat(cs.fontSize) : 0;
      const lh = cs ? parseFloat(cs.lineHeight) : 0;
      // 日本語の全角文字はほぼ font-size と同じ幅。1行に入る全角文字数の目安。
      const cpl = fs ? Math.round(w / fs) : 0;
      const toc = document.querySelector('nav.toc');
      const tocCS = toc ? getComputedStyle(toc) : null;
      const tocA = toc ? toc.querySelector('li.l3 > a') : null;
      const tocFS = tocA ? parseFloat(getComputedStyle(tocA).fontSize) : 0;
      return {
        mainWidth: Math.round(w), fontSize: fs, lineHeight: lh,
        lineHeightRatio: lh && fs ? +(lh / fs).toFixed(2) : 0,
        charsPerLine: cpl,
        tocWidth: toc ? Math.round(toc.getBoundingClientRect().width) : 0,
        tocFontSize: tocFS,
        tables: document.querySelectorAll('main table').length,
        tablesOverflow: [...document.querySelectorAll('main table')].filter(t => t.scrollWidth > t.clientWidth + 2).length,
        codeBlocks: document.querySelectorAll('pre.code').length,
      };
    }"""
    )
    print("実測:", m)
    print()
    # 判定
    cpl = m["charsPerLine"]
    print(f"1行の全角文字数: 約{cpl}字 (読みやすい目安は 35〜45字)")
    print("判定:", "長すぎる → 本文の最大幅を絞るべき" if cpl > 48 else ("適正" if cpl >= 30 else "狭すぎる"))
    print(f"行間: {m['lineHeightRatio']}倍 (目安 1.6〜1.9)")
    print(f"目次: 幅{m['tocWidth']}px / 文字{m['tocFontSize']}px")
    print(f"表: {m['tables']}個中 {m['tablesOverflow']}個が横スクロール必要")
    b.close()
