"""本文の行長と箇条書きの折り返し(ぶら下げ)を実測する"""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_context(viewport={"width": 1440, "height": 900}, locale="ja-JP").new_page()
    pg.goto("http://localhost:3107/docs", wait_until="networkidle")
    r = pg.evaluate(
        r"""() => {
      const main = document.querySelector('main');
      const fs = (el) => parseFloat(getComputedStyle(el).fontSize);
      const ps = [...main.querySelectorAll('p')].filter(e => e.textContent.trim().length > 40);
      const widths = ps.map(e => ({ w: Math.round(e.getBoundingClientRect().width), chars: Math.round(e.getBoundingClientRect().width / fs(e)) }));
      const maxChars = Math.max(...widths.map(x => x.chars));
      const over = widths.filter(x => x.chars > 48).length;

      // 箇条書きの折り返し: 2行目以降の先頭x座標が1行目のテキスト開始位置と揃うか
      const li = [...main.querySelectorAll('ol > li, ul > li')].find(e => e.getBoundingClientRect().height > fs(e) * 2.2);
      let hang = null;
      if (li) {
        const rects = [...li.getClientRects()];
        const lh = parseFloat(getComputedStyle(li).lineHeight);
        const lines = Math.round(li.getBoundingClientRect().height / lh);
        hang = { lines, firstLeft: Math.round(rects[0].left), rects: rects.length, textIndent: getComputedStyle(li).textIndent, listPos: getComputedStyle(li.parentElement).listStylePosition };
      }
      return { pCount: ps.length, maxChars, over, sample: widths.slice(0, 4), hang };
    }"""
    )
    print("段落:", r["pCount"], "個 / 1行の最大文字数:", r["maxChars"], "/ 48字超え:", r["over"], "件")
    print("  例:", r["sample"])
    print("折り返す箇条書き:", r["hang"])
    b.close()
