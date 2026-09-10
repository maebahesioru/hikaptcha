// ウィジェットの最終的な見え方を再現したレビュー画像を作る
//  タイル = 3:2 / 背景 = 同じ画像をcover+ぼかし / 前景 = 同じ画像をcontain(全体)
//  ffmpegでこの合成を再現し、実際のUIと同じ見た目を確認する
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.argv[2] || "http://localhost:3107";
const OUT = process.argv[3] || "C:/Users/maeba/Desktop/hikamani-captcha/ui_preview.jpg";
const UA = { "user-agent": "Mozilla/5.0" };
const TMP = mkdtempSync(path.join(tmpdir(), "ui-"));
const TW = 300, TH = 200; // タイル 3:2

async function main() {
  const c = await (await fetch(BASE + "/api/challenge", { headers: UA })).json();
  const files = [];
  for (let i = 0; i < c.tiles.length; i++) {
    const buf = Buffer.from(await (await fetch(c.tiles[i].url, { headers: UA })).arrayBuffer());
    const p = path.join(TMP, `t${i}.jpg`);
    writeFileSync(p, buf);
    files.push(p);
  }

  // 各タイル: 背景(cover+ぼかし)の上に前景(contain)を重ねる
  const parts = [];
  for (let i = 0; i < files.length; i++) {
    parts.push(
      `[${i}:v]split=2[bg${i}][fg${i}];` +
      `[bg${i}]scale=${TW}:${TH}:force_original_aspect_ratio=increase,crop=${TW}:${TH},gblur=sigma=12,eq=brightness=-0.12:saturation=1.15[bgx${i}];` +
      `[fg${i}]scale=${TW}:${TH}:force_original_aspect_ratio=decrease[fgy${i}];` +
      `[bgx${i}][fgy${i}]overlay=(W-w)/2:(H-h)/2[c${i}]`
    );
  }
  const layout = [];
  for (let i = 0; i < 9; i++) {
    const col = i % 3, row = Math.floor(i / 3);
    layout.push(`${col * (TW + 4)}_${row * (TH + 4)}`);
  }
  const filter =
    parts.join(";") +
    ";" + Array.from({ length: 9 }, (_, i) => `[c${i}]`).join("") +
    `xstack=inputs=9:layout=${layout.join("|")}:fill=0x18181b[out]`;

  const args = ["-y", "-loglevel", "error"];
  for (const f of files) args.push("-i", f);
  args.push("-filter_complex", filter, "-map", "[out]", "-q:v", "2", OUT);
  execFileSync("ffmpeg", args);
  console.log(JSON.stringify({ prompt: c.prompt, mode: c.mode, out: OUT }));
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
