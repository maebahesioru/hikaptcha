// 視覚フィルタをサーバーに組み込む前のコスト実測(画像DL + 署名計算の所要時間)
import { spawnSync } from "node:child_process";

const DEBUG = process.argv[2] || "http://localhost:3108";
const t0 = Date.now();
const r = await fetch(DEBUG + "/api/challenge");
const c = await r.json();
const t1 = Date.now();
const bufs = await Promise.all(
  c.tiles.map(async (t) => {
    const res = await fetch(t.url);
    return Buffer.from(await res.arrayBuffer());
  })
);
const t2 = Date.now();
const sigs = bufs.map(
  (b) =>
    spawnSync(
      "ffmpeg",
      ["-v", "error", "-i", "pipe:0", "-vf", "scale=8:8", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"],
      { input: b, maxBuffer: 1 << 20 }
    ).stdout
);
const t3 = Date.now();
console.log(`出題取得 ${t1 - t0}ms / 画像9枚DL ${t2 - t1}ms / 署名9個 ${t3 - t2}ms / 合計 ${t3 - t0}ms`);
console.log(`サイズ: ${bufs.map((b) => Math.round(b.length / 1024)).join(",")}KB`);
console.log(`署名長: ${sigs.map((s) => s.length).join(",")}`);
