// 依存ゼロの最小Markdown→HTML変換。
//
// なぜ自前か: このプロジェクトは依存ゼロ(dependencies なし)方針で、
// README.md を doc ページとして配信したい。README が唯一の情報源になるので
// ドキュメントが腐らない(手書きHTMLだと必ずズレる)。
//
// 対応する記法は README で実際に使っているものだけ:
//   見出し(#〜####) / フェンスコード``` / 表 / 箇条書き(-,1.) / 引用(>) / 区切り(---)
//   インライン: **強調** / *斜体* / `コード` / [リンク](url)
//
// ⚠️ テキストは必ずHTMLエスケープしてから組み立てる。
//    READMEには <div id="captcha"> のようなタグがコードブロック内に出てくるので、
//    エスケープしないとページが壊れる(実行される余地も作らない)。

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 見出しからアンカーIDを作る(日本語はそのまま、記号は落とす) */
export function slugify(text) {
  return String(text)
    .replace(/`/g, "")
    .replace(/[「」【】（）()［］\[\]!?"'’“”:：;；,，.。/／\\|*#<>＝=+＋]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "section";
}

/** インライン記法(コード→強調→リンクの順に、コードの中身を保護しながら) */
function inline(s) {
  let t = esc(s);
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener">${txt}</a>`);
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return t;
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
const isFence = (l) => /^\s*```/.test(l);
const isHeading = (l) => /^#{1,6}\s+/.test(l);
const isHr = (l) => /^\s*(---|\*\*\*|___)\s*$/.test(l);
const isUl = (l) => /^\s*[-*]\s+/.test(l);
const isOl = (l) => /^\s*\d+\.\s+/.test(l);
const isQuote = (l) => /^\s*>\s?/.test(l);

/**
 * MarkdownをHTMLに変換する。
 * @returns {{ html: string, toc: {level:number, text:string, id:string}[] }}
 */
export function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  const toc = [];
  const usedIds = new Map();
  let i = 0;

  const uniqueId = (base) => {
    const n = usedIds.get(base) || 0;
    usedIds.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };

  // 表を <table> に
  const renderTable = (rows) => {
    const cells = (row) =>
      row
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.replace(/\\\|/g, "|").trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);

    // 記号を除いた「見た目の文字数」。折り返し可否の判定に使う。
    const plainLen = (s) =>
      s.replace(/\*\*/g, "").replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim().length;

    // 1列目は「1. 画像認証」のような短いラベルであることが多く、折り返すと
    // カタカナ語が語中で切れて読みにくい。ただし長い文章が入る表もあるため、
    // 一律 nowrap にすると表が横にはみ出す(実測: 1440pxでも193pxはみ出した)。
    // → 短いセルだけ nowrap にする。
    const NW_MAX = 14;
    const td = (c, idx) => {
      const cls = idx === 0 && plainLen(c) <= NW_MAX ? ' class="nw"' : "";
      return `<td${cls}>${inline(c)}</td>`;
    };

    let html = "<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead>";
    if (body.length) {
      html += "<tbody>" + body.map((r) => "<tr>" + r.map(td).join("") + "</tr>").join("") + "</tbody>";
    }
    return html + "</table>";
  };

  while (i < lines.length) {
    const line = lines[i];

    // フェンスコード
    if (isFence(line)) {
      const lang = line.trim().replace(/^```/, "").trim();
      const buf = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) buf.push(lines[i++]);
      i++; // 閉じフェンスを飛ばす
      out.push(
        `<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(buf.join("\n"))}</code></pre>`
      );
      continue;
    }

    // 表(次の行が区切り行のときだけ表として扱う)
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(lines[i++]);
      out.push(renderTable(rows));
      continue;
    }

    // 見出し
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const id = uniqueId(slugify(text));
      if (level >= 2 && level <= 3) toc.push({ level, text: text.replace(/`/g, ""), id });
      out.push(`<h${level} id="${esc(id)}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    if (isHr(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // 引用(連続する > をまとめる)
    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }

    // 箇条書き
    if (isUl(line)) {
      const items = [];
      while (i < lines.length && isUl(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      out.push("<ul>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ul>");
      continue;
    }

    // 番号付きリスト
    if (isOl(line)) {
      const items = [];
      while (i < lines.length && isOl(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      out.push("<ol>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ol>");
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 段落(連続する通常行をまとめる)
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isFence(lines[i]) &&
      !isHeading(lines[i]) &&
      !isHr(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i]) &&
      !isQuote(lines[i]) &&
      !isTableRow(lines[i])
    ) {
      para.push(lines[i++]);
    }
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
  }

  return { html: out.join("\n"), toc };
}
