"""docページの <pre> が本当に折り返しているかを実測する(JSは単純に保つ)"""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    pg.goto("http://localhost:3107/docs", wait_until="load")
    pg.wait_for_timeout(300)
    rows = pg.eval_on_selector_all(
        "pre",
        """els => els.map(e => {
             const cs = getComputedStyle(e);
             return { ws: cs.whiteSpace, client: e.clientWidth, scroll: e.scrollWidth,
                      text: e.textContent };
           })""",
    )
    print(f"{'white-space':16s} {'client':>7s} {'scroll':>7s} {'はみ出し':>8s} {'最長行':>6s}  先頭")
    bad = []
    for r in rows:
        lines = r["text"].split("\n")
        longest = max((len(l) for l in lines), default=0)
        over = r["scroll"] - r["client"]
        flag = "  <= 折返し!" if over > 1 else ""
        print(f"{r['ws']:16s} {r['client']:7d} {r['scroll']:7d} {over:8d} {longest:6d}  {lines[0][:30]}{flag}")
        if over > 1:
            bad.append((lines[0][:40], longest, r["client"], r["scroll"]))
    print()
    print(f"折り返しているコードブロック: {len(bad)}個")
    for head, longest, c, s in bad:
        print(f"  {head} … 最長{longest}字 / 表示幅{c}px に {s}px")
    b.close()
