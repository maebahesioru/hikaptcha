// /docs(README.md から生成)の検証。
//   1) Markdown変換の単体チェック(表・コード・エスケープ・インライン記法)
//   2) 実際の /docs が 200 で、READMEの主要セクションがHTMLになっているか
//   3) 目次リンクと見出しIDが全部一致しているか(リンク切れ検出)
//   4) README中のHTMLタグがエスケープされているか(コードブロック内の <div> 等)
//
// 使い方: node tools/verify_docs.mjs [baseUrl]
import { readFileSync } from "node:fs";
import { renderMarkdown, slugify } from "../lib/md.mjs";

const BASE = process.argv[2] || "http://localhost:3107";
let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  if (ok) pass++;
  else fail++;
  console.log((ok ? "  ✅ " : "  ❌ ") + label + (extra ? "  " + extra : ""));
};

// ---------- 1) Markdown変換の単体チェック ----------
console.log("=== A) Markdown変換 ===");
const fixture = [
  "# 見出し1",
  "",
  "## 見出し2",
  "",
  "**太字** と *斜体* と `コード` と [リンク](https://example.com/a?b=1&c=2)。",
  "",
  "```bash",
  'echo "<div id=x>&amp;</div>"',
  "```",
  "",
  "| 列A | 列B |",
  "|---|---|",
  "| `x` | **y** |",
  "",
  "- 項目1",
  "- 項目2",
  "",
  "1. 手順1",
  "2. 手順2",
  "",
  "> 引用文",
  "",
  "---",
].join("\n");
const r = renderMarkdown(fixture);
const h = r.html;

check("見出しがh1/h2になる", h.includes("<h1 id=") && h.includes("<h2 id="));
check("太字/斜体/コード/リンクが変換される",
  h.includes("<strong>太字</strong>") && h.includes("<em>斜体</em>") &&
  h.includes("<code>コード</code>") && h.includes('<a href="https://example.com/a?b=1&amp;c=2"'));
check("コードブロックがpre/codeになり、中のHTMLタグがエスケープされる",
  h.includes("<pre class=\"code\" data-lang=\"bash\">") && h.includes("&lt;div id=x&gt;") && !h.includes("<div id=x>"));
check("表がtableになり、セル内のインライン記法も効く",
  h.includes("<table>") && h.includes("<th>列A</th>") && h.includes("<td><code>x</code></td>") && h.includes("<td><strong>y</strong></td>"));
check("箇条書きがul/olになる", h.includes("<ul><li>項目1</li>") && h.includes("<ol><li>手順1</li>"));
check("引用と区切りが変換される", h.includes("<blockquote>引用文</blockquote>") && h.includes("<hr>"));
check("生のMarkdownが残っていない(``` も |---| も無い)",
  !h.includes("```") && !/\|\s*---/.test(h));
check("目次用の見出しを拾っている(h1は除外してh2のみ)", r.toc.length === 1 && r.toc[0].level === 2,
  `toc=${JSON.stringify(r.toc.map((t) => t.level + ":" + t.text))}`);

// 見出しIDが重複しても壊れないこと
const dup = renderMarkdown("## 同じ\n\n## 同じ\n").html;
check("同じ見出しでもIDが重複しない", dup.includes('id="同じ"') && dup.includes('id="同じ-1"'));

// 記号が落ちて日本語が残ること
check("slugifyが日本語を残し記号を落とす", slugify("テスト(注) 「A/B」") === "テスト注-ab");

// 生HTMLを書いても素通ししない(エスケープされる)
const raw = renderMarkdown('<script>alert(1)</script>\n').html;
check("地の文の生タグもエスケープされる", raw.includes("&lt;script&gt;") && !raw.includes("<script>"));

// ---------- 2) 実際の /docs ----------
console.log("\n=== B) /docs の配信内容 ===");
const res = await fetch(BASE + "/docs", { headers: { "user-agent": "verify-docs/1.0" } });
const page = await res.text();
check("/docs が 200 で HTML を返す", res.status === 200 && /text\/html/.test(res.headers.get("content-type") || ""),
  `HTTP${res.status} ${(res.headers.get("content-type") || "").split(";")[0]}`);

const readme = readFileSync("C:/Users/maeba/Desktop/hikamani-captcha/README.md", "utf8");

// READMEの主要セクションがHTMLに載っているか(READMEの ## 見出しを全部確認)
const readmeH2 = [...readme.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
const missing = readmeH2.filter((t) => {
  const id = slugify(t.replace(/`/g, ""));
  return !page.includes(`id="${id}"`);
});
check(`READMEの全セクション(${readmeH2.length}個)がHTMLに入っている`, missing.length === 0, missing.slice(0, 3).join(" / "));

// 主要な中身(API・埋め込み・設定)が実際に載っているか
for (const key of ["/api/challenge", "/api/verify", "/api/consume", "/api/img/", "IP_QUOTA", "MIN_SOLVE_MS", "onSolved"]) {
  check(`本文に ${key} が出る`, page.includes(key));
}

// ---------- 3) 目次と見出しIDの整合 ----------
console.log("\n=== C) 目次リンクの整合 ===");
// ページ内の全アンカー(サイドバー目次・モバイルの折りたたみ目次)をまとめて検証する
const tocHrefs = [...page.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
// アンカーの飛び先は見出しに限らない(#top はレイアウト要素)ので、ページ内の全idを見る
const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const broken = tocHrefs.filter((t) => !ids.has(t));
check("目次リンクが全て存在する見出しを指す", tocHrefs.length > 5 && broken.length === 0,
  `${tocHrefs.length}本 / 切れ ${broken.length}${broken.length ? ": " + broken.slice(0, 3).join(",") : ""}`);
check("モバイル用の折りたたみ目次がある", page.includes('<details class="toc-m">') && page.includes("目次("));
check("固定ヘッダー分のスクロール余白がある", page.includes("scroll-margin-top"));

// ---------- 4) 描画の安全確認 ----------
console.log("\n=== D) 生成HTMLの安全性 ===");
// README内のコードブロックにあるタグが素のHTMLとして出ていないこと
check("README中の <div id=\"captcha\"> がエスケープされている", page.includes("&lt;div id=&quot;captcha&quot;&gt;"));
// 生成ページ自身のscriptは無し(静的な文書)
check("生成ページにscriptタグが無い", !/<script/i.test(page));
check("生成ページにstyleタグが1つだけある", (page.match(/<style/g) || []).length === 1);
check("HTMLが閉じている", page.trim().endsWith("</html>"));

console.log(`\n=== 合計: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
