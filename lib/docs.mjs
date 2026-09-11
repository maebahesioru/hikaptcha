// /docs ページの生成。README.md を唯一の情報源にして毎回レンダリングする。
// (手書きHTMLを別に持つと必ずREADMEと食い違うので、片方を直せば両方直る形にしている)
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderMarkdown } from "./md.mjs";

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0c0c0e; color: #e4e4e7;
         font-family: "Segoe UI", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif; }
  a { color: #7dd3fc; }
  .top { position: sticky; top: 0; z-index: 5; background: rgba(12,12,14,.92);
         border-bottom: 1px solid #27272a; backdrop-filter: blur(8px); }
  .top .inner { max-width: 1200px; margin: 0 auto; padding: 10px 20px;
                display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .top a { font-size: 13px; text-decoration: none; }
  .top .title { font-weight: 700; font-size: 14px; color: #e4e4e7; }
  .top .sp { flex: 1; }
  .top .demo { background: #0369a1; color: #fff; padding: 6px 12px; border-radius: 8px; }
  .top .demo:hover { background: #0284c7; }

  .layout { max-width: 1200px; margin: 0 auto; padding: 24px 20px 80px;
            display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 36px; }
  @media (max-width: 940px) { .layout { grid-template-columns: 1fr; gap: 0; } nav.toc { display: none; } }

  /* 狭い画面では目次を折りたたみで上に出す(サイドバーを消すだけだと迷子になる) */
  details.toc-m { display: none; margin: 0 0 16px; background: #131316;
                  border: 1px solid #2e2e33; border-radius: 10px; padding: 10px 12px; }
  @media (max-width: 940px) { details.toc-m { display: block; } }
  details.toc-m summary { cursor: pointer; font-size: 13px; color: #a1a1aa; }
  details.toc-m ol { margin: 8px 0 0; padding-left: 18px; font-size: 13px; line-height: 1.7; }
  details.toc-m a { color: #a1a1aa; text-decoration: none; }
  details.toc-m a:hover { color: #7dd3fc; }

  nav.toc { position: sticky; top: 68px; align-self: start; max-height: calc(100vh - 90px);
            overflow: auto; font-size: 13px; padding-right: 14px; border-right: 1px solid #1f1f23; }
  nav.toc .lbl { font-size: 11px; color: #6b6b76; letter-spacing: .08em; margin: 0 0 10px; }
  nav.toc ol { list-style: none; margin: 0; padding: 0; }
  nav.toc li { margin: 0; line-height: 1.6; }
  /* 親(h2)と子(h3)の差をはっきりさせる: 親は明るく太字、子は字を小さくして左に罫線 */
  nav.toc li.l2 { margin: 0 0 10px; }
  nav.toc li.l2 > a { color: #d4d4d8; font-weight: 600; }
  nav.toc li.l3 { margin: 0 0 8px 10px; padding-left: 10px; border-left: 1px solid #2e2e33; font-size: 12.5px; }
  nav.toc li.l3 > a { color: #8f8f9a; }
  nav.toc a { text-decoration: none; display: block; }
  nav.toc a:hover { color: #7dd3fc; }

  main { min-width: 0; }
  main h1 { font-size: 26px; margin: 0 0 6px; }
  /* 上のバーが固定なので、アンカー移動で見出しが隠れないように余白を確保する */
  main h1, main h2, main h3, main h4 { scroll-margin-top: 72px; }
  main h2 { font-size: 19px; margin: 34px 0 10px; padding-top: 10px; border-top: 1px solid #27272a; }
  main h3 { font-size: 16px; margin: 24px 0 8px; }
  main h4 { font-size: 14px; margin: 18px 0 6px; color: #a1a1aa; }
  main p { font-size: 14px; line-height: 1.85; margin: 10px 0; }
  main ul, main ol { font-size: 14px; line-height: 1.85; padding-left: 22px; }
  main li { margin: 4px 0; }
  main strong { color: #fff; }
  main code { background: #27272a; padding: 1px 5px; border-radius: 4px;
              font-size: 12.5px; word-break: break-all; }
  pre.code { background: #16161a; border: 1px solid #34343a; border-radius: 10px;
             padding: 12px 14px; overflow: auto; margin: 12px 0; position: relative; }
  pre.code code { background: none; padding: 0; font-size: 12.5px; line-height: 1.7;
                  color: #d4d4d8; white-space: pre; word-break: normal; }
  pre.code[data-lang]::before { content: attr(data-lang); position: absolute; top: 6px; right: 10px;
                                font-size: 10px; color: #52525b; letter-spacing: .05em; }
  table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 13px; display: block; overflow-x: auto; }
  th, td { border: 1px solid #2e2e33; padding: 8px 11px; text-align: left; vertical-align: top;
           line-height: 1.7; overflow-wrap: anywhere;
           /* 日本語は既定だとどの文字でも折り返すため「メモリハー/ドPoW」のように語中で切れる。
              auto-phrase はフレーズ単位で折り返すので、対応ブラウザではこれが防げる
              (未対応ブラウザは従来どおりの折り返しにフォールバックする)。 */
           word-break: auto-phrase;
           line-break: strict; }
  th { background: #18181b; color: #a1a1aa; font-weight: 600; white-space: nowrap; }
  /* 1列目は短いラベル(「1. 画像認証」等)なので折り返さない。
     折り返すとカタカナ語が語中で切れて読みにくくなる(実測で指摘)。 */
  td:first-child { white-space: nowrap; }
  @media (max-width: 640px) { td:first-child { white-space: normal; } }
  tr:nth-child(even) td { background: #101013; }
  blockquote { margin: 12px 0; padding: 8px 14px; border-left: 3px solid #3f3f46;
               background: #131316; color: #a1a1aa; font-size: 13.5px; }
  hr { border: 0; border-top: 1px solid #27272a; margin: 28px 0; }
  .hint { font-size: 12px; color: #71717a; }
`;

/** READMEを読んでdocページのHTMLを返す(mtimeでキャッシュ) */
export function renderDocsPage(rootDir) {
  const file = path.join(rootDir, "README.md");
  const mtime = statSync(file).mtimeMs;
  if (cache && cache.mtime === mtime) return cache.html;

  const md = readFileSync(file, "utf8");
  const { html, toc } = renderMarkdown(md);
  const tocHtml = toc
    .map((t) => `<li class="l${t.level}"><a href="#${t.id}">${t.text}</a></li>`)
    .join("");

  const html2 = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>ヒカマニCAPTCHA ドキュメント</title>
<style>${STYLE}</style>
</head>
<body>
<div class="top"><div class="inner">
  <span class="title">🤖 ヒカマニCAPTCHA</span>
  <a href="#top">ドキュメント</a>
  <span class="sp"></span>
  <a class="demo" href="/">動作デモ</a>
</div></div>

<div class="layout" id="top">
  <nav class="toc"><p class="lbl">目次</p><ol>${tocHtml}</ol></nav>
  <main>
    <details class="toc-m"><summary>目次(${toc.length}項目)</summary><ol>${tocHtml}</ol></details>
${html}
  </main>
</div>
</body>
</html>`;

  cache = { mtime, html: html2 };
  return html2;
}

let cache = null;
