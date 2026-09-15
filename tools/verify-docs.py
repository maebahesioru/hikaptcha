""" /docs の描画を実測する(README.mdと一致しているか・崩れていないか)

README.md を唯一の情報源にして毎回レンダリングする設計なので、
「READMEの内容が全部出ているか」と「Markdownが崩れていないか」を見る。
"""
import re
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3107"
DOCS = BASE + "/docs"
SHOT = "C:/Users/maeba/Desktop/hikamani-captcha/.docs-shots"

OUT = []


def log(label, ok, extra=""):
    OUT.append((label, ok, extra))
    print(("OK   " if ok else "FAIL "), label, extra, flush=True)


def get(url):
    req = urllib.request.Request(url, headers={"user-agent": "verify-docs/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, r.read().decode("utf-8", "replace")


# ---------- 1) 配信されているか ----------
st, html = get(DOCS)
log("/docs が200で返る", st == 200, f"HTTP{st} {len(html)}bytes")

readme = open("C:/Users/maeba/Desktop/hikamani-captcha/README.md", encoding="utf-8").read()

# ---------- 2) READMEの主要な見出しが出ているか ----------
h2 = re.findall(r"^## (.+)$", readme, re.M)
missing = [h for h in h2 if h.strip() not in html]
log("READMEの見出し(h2)が全部出ている", not missing, f"欠け={missing[:4]}" if missing else f"{len(h2)}個すべて")

# ---------- 3) 最新の追記が反映されているか(直近の変更を狙い撃ち) ----------
for probe, label in [
    ("0で無制限", "レート制限が既定オフの記述"),
    ("IP_QUOTA", "env表の IP_QUOTA"),
    ("HARD_MIN_SOLVE_MS", "回答が速すぎますの修正"),
    ("サイトキー", "複数サイトで足りないもの"),
    ("18 PASS / 0 FAIL", "埋め込み検証の結果"),
    ("20 PASS / 0 FAIL", "多層認証テストの結果"),
]:
    log(f"最新の記述: {label}", probe in html, f"'{probe}'" + ("" if probe in html else " が見つからない"))

# ---------- 4) Markdownの崩れ(表・コード・リンク) ----------
log("表がテーブルに変換されている", html.count("<table") >= 5, f"<table> {html.count('<table')}個")
log("コードがコードブロックに変換されている", html.count("<pre") >= 5, f"<pre> {html.count('<pre')}個")
log("生のMarkdown記号が残っていない(|で始まる行や```)", not re.search(r"^\s*[|`]{2,}", html, re.M), "OK")
log("見出しがh1/h2/h3になっている", html.count("<h1") >= 1 and html.count("<h2") >= 5, f"h1={html.count('<h1')} h2={html.count('<h2')}")
bad_link = re.findall(r'<a[^>]+href="(?!https?:|/|#)[^"]*\.md"', html)
log("READMEへの相対リンクが壊れていない", not bad_link, str(bad_link[:3]))

# ---------- 5) ブラウザでの見た目・コンソールエラー ----------
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_context(viewport={"width": 1280, "height": 900}, locale="ja-JP", device_scale_factor=2).new_page()
    errs = []
    pg.on("console", lambda m: errs.append(m.text[:150]) if m.type == "error" else None)
    pg.goto(DOCS, wait_until="networkidle")
    title = pg.title()
    log("ページタイトルがある", bool(title), title[:50])

    # 目次(ナビ)があるか、リンクが機能するか
    nav = pg.evaluate("() => [...document.querySelectorAll('a[href^=\"#\"]')].length")
    log("見出しへのリンク(目次)がある", nav >= 5, f"{nav}個")

    # 横スクロールが出ていないか(テーブル崩れの検出)
    overflow = pg.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    log("横スクロールが出ていない", overflow <= 2, f"はみ出し {overflow}px")

    pg.screenshot(path=f"{SHOT}/docs-top.png")
    pg.evaluate("() => window.scrollTo(0, document.body.scrollHeight * 0.35)")
    pg.wait_for_timeout(400)
    pg.screenshot(path=f"{SHOT}/docs-mid.png")
    print(f"   スクショ: {SHOT}/docs-top.png / docs-mid.png")

    log("コンソールエラーなし", not errs, str(errs[:3]))
    b.close()

fails = [x for x in OUT if not x[1]]
print(f"\n=== 合計: {len(OUT) - len(fails)} PASS / {len(fails)} FAIL ===")
for label, _, extra in fails:
    print("  FAIL:", label, extra)
sys.exit(1 if fails else 0)
