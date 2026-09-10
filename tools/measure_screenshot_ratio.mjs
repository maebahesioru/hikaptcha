// スクリーンショット/UI画像の割合と、タグ数の分布を実測する
//  お題の被写体が「画面の小さなアバター」として写っている画像は人間には判定不能 →
//  そういう画像を出題プールから外すための指標を探す
const API = "https://hikabooru.hikamers.app/api";
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// スクリーンショット/UIを示すタグ(これが付いていれば画面キャプチャの可能性が高い)
const SCREENSHOT_TAGS = [
  "twitter", "x", "スクリーンショット", "ツイート", "プロフィール", "凍結済みアカウント",
  "対話箱", "文字の壁", "日本語のテキスト", "テロップ", "字幕", "アイコン", "絵文字",
  "スタンプ", "チャットログ", "メニュー", "チャンネル", "通知", "タイムライン",
  "リツイート", "フォロー", "トレンド", "偽のスクリーンショット", "スクショ", "ui",
  "スクリーンキャプチャ", "画面", "ウィンドウ", "ブラウザ", "アプリ", "サイト",
  "エクセル", "ワード", "検索結果", "アップロード", "投稿画面", "ウェブサイト",
];

async function fetchBatch() {
  const q = encodeURIComponent("safety:safe type:image");
  const url = `${API}/posts?query=${q}&limit=100&offset=${Math.floor(Math.random() * 29000)}&fields=id,canvasWidth,canvasHeight,tags`;
  const r = await fetch(url, { headers: UA });
  const d = await r.json();
  return (d.results || []).filter((p) => {
    const w = p.canvasWidth || 0, h = p.canvasHeight || 0;
    if (!w || !h) return false;
    const a = w / h;
    return a >= 1.0 && a <= 2.2;
  });
}

async function main() {
  const tagCounts = [];
  let withShot = 0, total = 0;
  const shotExample = [];
  for (let i = 0; i < 12; i++) {
    const batch = await fetchBatch();
    for (const p of batch) {
      const names = (p.tags || []).map((x) => (x.names || [""])[0]).filter(Boolean);
      if (!names.length) continue;
      total++;
      tagCounts.push(names.length);
      const lower = names.map((n) => n.toLowerCase());
      const has = SCREENSHOT_TAGS.some((s) => lower.includes(s.toLowerCase()));
      if (has) {
        withShot++;
        if (shotExample.length < 12) {
          shotExample.push(names.filter((n) => SCREENSHOT_TAGS.some((s) => s.toLowerCase() === n.toLowerCase())).join(","));
        }
      }
    }
    await new Promise((s) => setTimeout(s, 150));
  }
  tagCounts.sort((a, b) => a - b);
  const pct = (p) => tagCounts[Math.floor(tagCounts.length * p)];
  console.log(`サンプル ${total}枚`);
  console.log(` スクリーンショット系タグ付き: ${withShot}枚 (${(withShot / total * 100).toFixed(1)}%)`);
  console.log(` タグ数の分布: 最小${tagCounts[0]} / 25%点${pct(0.25)} / 中央${pct(0.5)} / 75%点${pct(0.75)} / 最大${tagCounts[tagCounts.length - 1]}`);
  const below = (n) => tagCounts.filter((x) => x <= n).length;
  for (const n of [10, 15, 20, 25, 30, 40]) {
    console.log(`   タグ数 <= ${n}: ${below(n)}枚 (${(below(n) / total * 100).toFixed(0)}%)`);
  }
  console.log("\n 検出されたスクリーンショット系タグの例:");
  for (const e of shotExample) console.log("   ", e);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
