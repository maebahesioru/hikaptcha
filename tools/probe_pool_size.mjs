// 画像プールの実数を測る: 種別ごとの総数と、CAPTCHAのフィルタを通過する割合
// 使い方: node tools/probe_pool_size.mjs
const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "hikamani-captcha/1.0" };

// サーバーと同じフィルタ(server.mjs の fetchSlice 相当)
const SCREENSHOT_TAGS = new Set([
  "日本語のテキスト", "対話箱", "文字の壁", "プロフィール", "凍結済みアカウント",
  "スクリーンショット", "偽のスクリーンショット", "スクショ", "スクリーンキャプチャ",
  "ツイート", "twitter", "x", "タイムライン", "リツイート", "トレンド", "通知",
  "テロップ", "チャットログ", "メニュー", "チャンネル", "検索結果", "投稿画面",
  "アップロード", "アプリ", "ブラウザ", "ウェブサイト", "サイト", "ウィンドウ",
  "ui", "エクセル", "ワード", "字幕", "文字", "ロゴ", "タイトル", "見出し",
]);
const MAX_TAGS_PER_IMAGE = 120;

async function api(p) {
  const r = await fetch(BASE + p, { headers: UA });
  if (!r.ok) throw new Error(p + " " + r.status);
  return r.json();
}

function goodAspect(p) {
  const w = Number(p.canvasWidth) || 0, h = Number(p.canvasHeight) || 0;
  if (!w || !h) return false;
  const r = w / h;
  return r >= 1.0 && r <= 2.2;
}

(async () => {
  for (const type of ["image", "video", "animation"]) {
    const q = encodeURIComponent(`safety:safe type:${type}`);
    const head = await api(`/api/posts?query=${q}&limit=1&fields=id`);
    const total = head.total || 0;
    if (!total) { console.log(`${type}: 0件`); continue; }

    // 無作為に抜いてフィルタ通過率を測る
    let seen = 0, aspectOk = 0, noShot = 0, pass = 0;
    for (let i = 0; i < 6; i++) {
      const off = Math.floor(Math.random() * Math.max(1, total - 60));
      const d = await api(`/api/posts?query=${q}&limit=60&offset=${off}&fields=id,canvasWidth,canvasHeight,thumbnailUrl,tags`);
      for (const p of d.results || []) {
        if (!p.thumbnailUrl) continue;
        seen++;
        const a = goodAspect(p);
        if (a) aspectOk++;
        const names = (p.tags || []).map((t) => ((t.names && t.names[0]) || "").toLowerCase());
        const shot = names.some((n) => SCREENSHOT_TAGS.has(n));
        if (!shot) noShot++;
        const fewTags = names.length <= MAX_TAGS_PER_IMAGE;
        if (a && !shot && fewTags) pass++;
      }
    }
    const pct = (x) => ((x / seen) * 100).toFixed(0);
    console.log(`${type.padEnd(9)} 総数 ${String(total).padStart(6)} 枚`);
    console.log(`  ${seen}枚を抜き取り検査: アスペクトOK ${pct(aspectOk)}% / スクショ以外 ${pct(noShot)}% / 全部通過 ${pct(pass)}%`);
    console.log(`  → 実質使える枚数 約 ${Math.round((total * pass) / seen).toLocaleString()} 枚`);
  }
})().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
