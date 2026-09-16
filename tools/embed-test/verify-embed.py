"""「他サイトに埋め込んで認証に使えるか」を実測する。

構成(すべて別オリジン):
  :3200 = 埋め込み先の模擬サイト(このリポジトリの tools/embed-test)
  :3108 = CAPTCHA本体(デバッグコピー。正解タイルが分かるので自動で解ける)

確かめること:
  1) 別オリジンから captcha.js を読んでウィジェットが描画されるか
  2) /api/challenge を cross-origin fetch できるか(CORS/preflight)
  3) 画像を cross-origin で読み込めるか
  4) 解いて onSolved(token, ticket) が呼ばれるか
  5) 埋め込み先のサーバー役が /api/consume でトークンを消費できるか
  6) 同じトークンの二度使いが拒否されるか(ワンタイム)
  7) コンソールエラーが出ていないか
"""
import json
import sys
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

SITE = "http://localhost:3200"
CAPTCHA = "http://localhost:3108"
SHOT = "C:/Users/maeba/Desktop/hikamani-captcha/tools/embed-test/shots"

OUT = []


def log(label, ok, extra=""):
    OUT.append((label, ok, extra))
    print(("OK   " if ok else "FAIL "), label, extra, flush=True)


def consume(token, ticket):
    """埋め込み先のサーバーがやる処理(BFF)。ブラウザを経由せずサーバー間で叩く"""
    body = json.dumps({"token": token, "ticket": ticket}).encode()
    req = urllib.request.Request(
        CAPTCHA + "/api/consume", data=body,
        headers={"content-type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw[:120]


with sync_playwright() as p:
    # 本番は実行環境のシグナル(webdriver / ソフトウェア描画 / ブラウザAPIの有無)で
    # 自動化ブラウザを弾く。検証ではフローだけを見たいので、実ブラウザ相当の値を注入する。
    b = p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
    ctx = b.new_context(viewport={"width": 1000, "height": 900}, locale="ja-JP", device_scale_factor=2)
    ctx.add_init_script("""
      // ヘッドレス特有の値を実ブラウザ相当に上書き(検証用。本番の検出はそのまま動く)
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      if (!window.chrome) window.chrome = { runtime: {} };
      const patch = (proto) => {
        if (!proto) return;
        const orig = proto.getParameter;
        proto.getParameter = function (p) {
          const dbg = this.getExtension && this.getExtension('WEBGL_debug_renderer_info');
          if (dbg && p === dbg.UNMASKED_RENDERER_WEBGL) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Ti Direct3D11 vs_5_0 ps_5_0)';
          return orig.apply(this, arguments);
        };
      };
      patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
      patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
    """)
    pg = ctx.new_page()

    console_errors, req_failed = [], []
    pg.on("console", lambda m: console_errors.append(m.text[:160]) if m.type == "error" else None)
    pg.on("requestfailed", lambda r: req_failed.append(f"{r.url[:90]} {r.failure}"))

    # /api/challenge の応答を横取りして「正解タイル」を取る(デバッグコピーだけが返す)
    captured = {}

    def on_response(resp):
        if resp.url.endswith("/api/challenge") and resp.status == 200:
            try:
                j = resp.json()
                captured["body"] = j
                # 新しいchallengeが来たことをテスト側から検知できるようにする
                try:
                    pg.evaluate("(id) => { window.__capId = id; }", j.get("id"))
                except Exception:
                    pass
            except Exception:
                pass

    pg.on("response", on_response)

    pg.goto(SITE, wait_until="networkidle")
    log("別オリジンのページが開く", pg.title() != "", f"title={pg.title()[:40]}")

    # ウィジェットが描画されるまで待つ(シャドウDOM内)
    pg.wait_for_function(
        "() => { const h=document.getElementById('captcha');"
        " return h && h.shadowRoot && h.shadowRoot.querySelectorAll('.hkc-tile').length === 9; }",
        timeout=30000,
    )
    n_tiles = pg.evaluate(
        "() => document.getElementById('captcha').shadowRoot.querySelectorAll('.hkc-tile').length"
    )
    log("別オリジンでウィジェットが描画される", n_tiles == 9, f"タイル{n_tiles}枚")

    # 画像が実際に描画されたか(cross-origin の /api/img)
    img_ok = pg.evaluate(
        r"""() => {
      const sr = document.getElementById('captcha').shadowRoot;
      const imgs = [...sr.querySelectorAll('.hkc-tile img')];
      return { n: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
               src: imgs[0] ? imgs[0].getAttribute('src') : null };
    }"""
    )
    log("画像を cross-origin で読み込める", img_ok["loaded"] == 18, str(img_ok))
    log("画像URLがCAPTCHA本体を指している", bool(img_ok["src"]) and img_ok["src"].startswith(CAPTCHA),
        (img_ok["src"] or "")[:60])

    # 正解タイルを取る(横取りした応答から)
    body = captured.get("body") or {}
    tiles = body.get("tiles") or []
    correct_idx = [i for i, t in enumerate(tiles) if t.get("target")]
    log("cross-origin で /api/challenge を取得できた(CORS)", bool(tiles), f"モード={body.get('mode')} 正解{len(correct_idx)}枚")
    log("お題が届いている", bool(body.get("prompt")), str(body.get("prompt"))[:60])

    if not correct_idx:
        print("!! 正解が取れないため以降はスキップ")
    else:
        # 正解タイルをクリック(シャドウDOM内の .hkc-tile は応答と同じ順)
        pg.evaluate(
            r"""(idx) => {
          const sr = document.getElementById('captcha').shadowRoot;
          const tiles = [...sr.querySelectorAll('.hkc-tile')];
          for (const i of idx) tiles[i].click();
        }""",
            correct_idx,
        )
        sel = pg.evaluate(
            "() => document.getElementById('captcha').shadowRoot.querySelectorAll('.hkc-tile.sel').length"
        )
        log("正解タイルを選択できる", sel == len(correct_idx), f"{sel}/{len(correct_idx)}")

        # 確認する(PoWを解いて /api/verify に POST する)。
        # 成功(トークン)か、失敗表示(不正解/エラー)のどちらかで待ちを抜ける。
        verify_bodies = []
        pg.on(
            "response",
            lambda r: verify_bodies.append((r.status, (r.json() if r.status != 204 else None)))
            if r.url.endswith("/api/verify")
            else None,
        )
        pg.evaluate("() => document.getElementById('captcha').shadowRoot.querySelector('.hkc-btn.ok').click()")
        try:
            pg.wait_for_function(
                "() => {"
                "  const c=document.getElementById('token');"
                "  if (c && c.textContent && c.textContent.length > 10) return true;"
                "  const sr=document.getElementById('captcha').shadowRoot;"
                "  const t=sr?sr.textContent:'';"
                "  return /不正解|エラー|やり直|できません|多すぎ|失敗/.test(t);"
                "}",
                timeout=60000,
            )
        except Exception as e:
            print("   wait失敗:", str(e)[:100])
        why = pg.evaluate(
            r"""() => {
          const sr = document.getElementById('captcha').shadowRoot;
          return sr ? sr.textContent.replace(/\s+/g, ' ').slice(0, 200) : '(shadowなし)';
        }"""
        )
        print("   画面の状態:", why)
        print("   /api/verify の応答:", verify_bodies[-1] if verify_bodies else "(なし)")
        tok = pg.evaluate("() => document.getElementById('token').textContent")
        tic = pg.evaluate("() => document.getElementById('ticket').textContent")
        state = pg.evaluate("() => document.getElementById('state').textContent")
        log("別オリジンで解いてトークンを受け取れる", bool(tok) and len(tok) > 10, f"token={tok[:14]}… ({len(tok)}字)")
        log("チケットも受け取れる", bool(tic) and len(tic) > 5, f"ticket={tic[:10]}…")
        # トークン受領の時点では「未検証」であること(クライアントだけで認証済みにしない)
        log("トークン受領だけでは認証済みにしない", "未検証" in state, f"state={state}")
        log("埋め込み先の登録ボタンが有効化される", pg.evaluate("() => !document.getElementById('signup').disabled"), "有効")

        # --- ラウンドA: 埋め込み先の「サーバー」が消費する(BFFパターン) ---
        # ここで初めて認証が成立する。UIがサーバー検証に追従しているかも見る。
        pg.evaluate("() => document.getElementById('signup').click()")
        pg.wait_for_function(
            "() => /認証済み|認証失敗/.test(document.getElementById('state').textContent)",
            timeout=25000,
        )
        state2 = pg.evaluate("() => document.getElementById('state').textContent")
        log("別オリジンのブラウザ経由でconsumeして認証済みになる", "サーバー検証済み" in state2, f"state={state2}")

        # --- ラウンドB: サーバー間のconsume(実際のBFF)と、使い回しの拒否 ---
        # 新しい問題を解いて、2つ目のトークンを取る
        pg.evaluate("() => { const sr=document.getElementById('captcha').shadowRoot;"
                    " const b=[...sr.querySelectorAll('.hkc-btn')].find(x=>/別の問題|やり直/.test(x.textContent)); if(b) b.click(); }")
        pg.wait_for_function(
            "() => { const h=document.getElementById('captcha');"
            " return h && h.shadowRoot && h.shadowRoot.querySelectorAll('.hkc-tile').length===9; }",
            timeout=30000,
        )
        # 2回目は「1つ目とは別のchallenge」が届くまで待つ(固定待ちだと取りこぼす)
        first_id = body.get("id")
        try:
            pg.wait_for_function(
                "(fid) => window.__capId && window.__capId !== fid",
                arg=first_id,
                timeout=30000,
            )
        except Exception as e:
            print("   2つ目のchallenge待ちでタイムアウト:", str(e)[:80])
        pg.wait_for_function(
            "() => { const h=document.getElementById('captcha');"
            " return h && h.shadowRoot && h.shadowRoot.querySelectorAll('.hkc-tile').length===9; }",
            timeout=30000,
        )
        body2nd = captured.get("body") or {}
        idx2 = [i for i, t in enumerate(body2nd.get("tiles") or []) if t.get("target")]
        print(f"   2つ目: モード={body2nd.get('mode')} 正解{len(idx2)}枚")
        pg.evaluate(
            r"""(idx) => {
          const sr = document.getElementById('captcha').shadowRoot;
          [...sr.querySelectorAll('.hkc-tile')].forEach((t,i) => { if (idx.includes(i)) t.click(); });
        }""",
            idx2,
        )
        pg.evaluate("() => document.getElementById('captcha').shadowRoot.querySelector('.hkc-btn.ok').click()")
        pg.wait_for_function(
            "() => { const t=document.getElementById('token').textContent; return t && t.length > 10 && t !== "
            + repr(tok) + "; }",
            timeout=60000,
        )
        tok2 = pg.evaluate("() => document.getElementById('token').textContent")
        tic2 = pg.evaluate("() => document.getElementById('ticket').textContent")
        log("2つ目のトークンも取れる", tok2 != tok and len(tok2) > 10, f"token2={tok2[:12]}…")

        st, body2 = consume(tok2, tic2)
        log("サーバー間で /api/consume できる(実際のBFF)", st == 200 and body2.get("ok") is True, f"HTTP{st} {body2}")

        st2, body2b = consume(tok2, tic2)
        log("同じトークンの二度使いは拒否される", not (st2 == 200 and body2b.get("ok") is True), f"HTTP{st2} {body2b}")

        st3, body3 = consume(tok2, "")
        log("チケット無しの消費は拒否される", not (st3 == 200 and body3.get("ok") is True), f"HTTP{st3} {body3}")

    pg.screenshot(path=f"{SHOT}/embed-site.png", full_page=True)
    print(f"   スクショ: {SHOT}/embed-site.png")

    log("コンソールエラーなし", not console_errors, str(console_errors[:3]))
    log("リクエスト失敗なし", not req_failed, str(req_failed[:3]))
    b.close()

fails = [x for x in OUT if not x[1]]
print(f"\n=== 合計: {len(OUT) - len(fails)} PASS / {len(fails)} FAIL ===")
for label, _, extra in fails:
    print("  FAIL:", label, extra)
with open("C:/Users/maeba/Desktop/hikamani-captcha/tools/embed-test/last-verify.txt", "w", encoding="utf-8") as f:
    for label, ok, extra in OUT:
        f.write(f"{'OK  ' if ok else 'FAIL'} {label} {extra}\n")
    f.write(f"\n{len(OUT) - len(fails)} PASS / {len(fails)} FAIL\n")
sys.exit(1 if fails else 0)
