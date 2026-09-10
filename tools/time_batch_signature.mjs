// sigs8x8Batch(1回のffmpegで9枚まとめて署名)の所要時間と精度を単体で測る
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function sigs8x8Batch(bufs) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(path.join(tmpdir(), "hkcvis-"));
    const files = bufs.map((b, i) => {
      const f = path.join(dir, `i${i}.jpg`);
      writeFileSync(f, b);
      return f;
    });
    const args = ["-v", "error"];
    for (const f of files) args.push("-i", f);
    const parts = bufs.map((_, i) => `[${i}:v]scale=8:8,format=gray[a${i}]`).join(";");
    const stack = bufs.map((_, i) => `[a${i}]`).join("") + `vstack=inputs=${bufs.length}[out]`;
    args.push("-filter_complex", `${parts};${stack}`, "-map", "[out]", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1");
    const p = spawn("ffmpeg", args);
    const chunks = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("close", (code) => {
      const out = Buffer.concat(chunks);
      const sigs = [];
      for (let i = 0; i < bufs.length; i++) {
        const px = [...out.subarray(i * 64, i * 64 + 64)];
        if (px.length < 64) return resolve(null);
        const mean = px.reduce((a, c) => a + c, 0) / 64;
        sigs.push(px.map((v) => (v > mean ? 1 : 0)));
      }
      try { for (const f of readdirSync(dir)) unlinkSync(path.join(dir, f)); rmdirSync(dir); } catch {}
      resolve(code === 0 ? sigs : null);
    });
    p.on("error", () => resolve(null));
  });
}

const DEBUG = process.argv[2] || "http://localhost:3108";
const c = await (await fetch(DEBUG + "/api/challenge")).json();
const t0 = Date.now();
const bufs = await Promise.all(c.tiles.map(async (t) => Buffer.from(await (await fetch(t.url)).arrayBuffer())));
const t1 = Date.now();
const sigs = await sigs8x8Batch(bufs);
const t2 = Date.now();
console.log(`DL9枚 ${t1 - t0}ms / 一括署名 ${t2 - t1}ms / 合計 ${t2 - t0}ms`);
if (!sigs) { console.log("署名失敗"); process.exit(1); }
// 参考: 復号できるか(先頭bitの並び)
console.log(`署名OK 9個 × 64bit (例: ${sigs[0].join("").slice(0, 16)}...)`);
console.log(`target=${c.tiles.map((t) => (t.target ? 1 : 0)).join("")}`);
