// プールの実数を測る: 種別ごとの総数と、フィルタ条件を変えたときの「使える枚数」
// 使い方: node tools/probe_pool_size.mjs [抜き取り数=360]
const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "hikamani-captcha/1.0" };
const N = Number(process.argv[2] || 360);

const SCREENSHOT_TAGS = new Set([
  "日本語のテキスト", "対話箱", "文字の壁", "プロフィール", "凍結済みアカウント",
  "スクリーンショット", "偽のスクリーンショット", "スクショ", "スクリーンキャプチャ",
  "ツイート", "twitter", "x", "タイムライン", "リツイート", "トレンド", "通知",
  "テロップ", "チャットログ", "メニュー", "チャンネル", "検索結果", "投稿画面",
  "アップロード", "アプリ", "ブラウザ", "ウェブサイト", "サイト", "ウィンドウ",
  "ui", "エクセル", "ワード", "字幕", "文字", "ロゴ", "タイトル", "見出し",
]);
const MAX_TAGS_PER_IMAGE = 120;

const api = async (p) => {
  const r = await fetch(BASE + p, { headers: UA });
  if (!r.ok) throw new Error(p + " " + r.status);
  return r.json();
};
const aspect = (p) => {
  const w = Number(p.canvasWidth) || 0, h = Number(p.canvasHeight) || 0;
  return w && h ? w / h : 0;
};

(async () => {
  const type = process.argv[3] || "image";
  const q = encodeURIComponent(`safety:safe type:${type}`);
  const head = await api(`/api/posts?query=${q}&limit=1&fields=id`);
  const total = head.total || 0;

  const c = { seen: 0, base: 0, noShot: 0, wide: 0, both: 0, hasThumb: 0 };
  while (c.seen < N) {
    const off = Math.floor(Math.random() * Math.max(1, total - 60));
    const d = await api(`/api/posts?query=${q}&limit=60&offset=${off}&fields=id,canvasWidth,canvasHeight,thumbnailUrl,tags`);
    for (const p of d.results || []) {
      const seenN = c.seen;
      c.seen++;
      if (!p.thumbnailUrl) continue;
      const r = aspect(p);
      const a = r >= 1.0 && r <= 2.2;
      const aWide = r >= 0.7 && r <= 2.8;
      const names = (p.tags || []).map((t) => ((t.names && t.names[0]) || "").toLowerCase());
      const shot = names.some((n) => SCREENSHOT_TAGS.has(n));
      const few = names.length <= MAX_TAGS_PER_IMAGE;
      if (a && !shot && few) c.base++;
      if (a && few) c.noShot++;
      if (aWide && !shot && few) c.wide++;
      if (aWide && few) c.both++;
      if (c.seen >= N) break;
      void seenN;
    }
  }
  const pct = (x) => ((x / c.seen) * 100).toFixed(0);
  const est = (x) => Math.round((total * x) / c.seen).toLocaleString();
  console.log(`type:${type} 総数 ${total.toLocaleString()} 枚 (${c.seen}枚を抜き取り)`);
  console.log(`  1. 現行(アスペクト1.0-2.2 + スクショ除外 + タグ数)  ${pct(c.base).padStart(3)}% → 約 ${est(c.base).padStart(7)} 枚`);
  console.log(`  2. スクショ除外をやめる                            ${pct(c.noShot).padStart(3)}% → 約 ${est(c.noShot).padStart(7)} 枚`);
  console.log(`  3. アスペクトを0.7-2.8に拡大                        ${pct(c.wide).padStart(3)}% → 約 ${est(c.wide).padStart(7)} 枚`);
  console.log(`  4. 両方やめる                                      ${pct(c.both).padStart(3)}% → 約 ${est(c.both).padStart(7)} 枚`);
})().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
