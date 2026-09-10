// バッチ取得の「フィルタ通過率」を実測する(空振り=9枚未満の原因を特定する)
//  サーバーと同じクエリ・同じフィルタ条件で取得して、何枚残るかを数える
import { writeFileSync } from "node:fs";
const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "Mozilla/5.0" };
const LIMITS = (process.argv[2] || "20,30,60").split(",").map(Number);
const TRIES = Number(process.argv[3] || 3);

const SCREENSHOT_TAGS = new Set([
  "日本語のテキスト", "対話箱", "文字の壁", "プロフィール", "凍結済みアカウント",
  "スクリーンショット", "偽のスクリーンショット", "スクショ", "スクリーンキャプチャ",
  "ツイート", "twitter", "x", "タイムライン", "リツイート", "トレンド", "通知",
]);
const MAX_TAGS = 26;
const goodAspect = (p) => {
  const w = Number(p.canvasWidth) || 0, h = Number(p.canvasHeight) || 0;
  if (!w || !h) return false;
  const r = w / h;
  return r >= 1.0 && r <= 2.2;
};

for (const limit of LIMITS) {
  const rows = [];
  for (let i = 0; i < TRIES; i++) {
    const offset = Math.floor(Math.random() * 29500);
    const q = encodeURIComponent("safety:safe type:image");
    const r = await fetch(`${BASE}/api/posts?query=${q}&limit=${limit}&offset=${offset}&fields=id,canvasWidth,canvasHeight,thumbnailUrl,tags`, { headers: UA });
    const d = await r.json();
    const res = d?.results || [];
    const l0 = res.filter((p) => goodAspect(p) && !(p.tags || []).map((x) => ((x.names && x.names[0]) || "").toLowerCase()).some((n) => SCREENSHOT_TAGS.has(n)) && (p.tags || []).length <= MAX_TAGS);
    const l1 = res.filter((p) => goodAspect(p) && !(p.tags || []).map((x) => ((x.names && x.names[0]) || "").toLowerCase()).some((n) => SCREENSHOT_TAGS.has(n)));
    const l2 = res.filter((p) => goodAspect(p));
    rows.push({ got: res.length, l0: l0.length, l1: l1.length, l2: l2.length });
    await new Promise((s) => setTimeout(s, 300));
  }
  const avg = (k) => (rows.reduce((a, b) => a + b[k], 0) / rows.length).toFixed(1);
  console.log(
    `limit=${limit}: 返却${avg("got")}枚 → 段階0通過 ${avg("l0")} / 段階1通過 ${avg("l1")} / 段階2通過 ${avg("l2")} (9枚必要)`
  );
}
