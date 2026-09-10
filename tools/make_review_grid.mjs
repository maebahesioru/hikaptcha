// 実際のCAPTCHAグリッド(3x3)を1枚の画像に合成する。
// 目視評価用: タイルの見えづらさ・タグの妥当性を直接確認するため。
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.argv[2] || "http://localhost:3107";
const OUT = process.argv[3] || "C:/Users/maeba/Desktop/hikamani-captcha/grid_review.jpg";
const UA = { "user-agent": "Mozilla/5.0" };
const TMP = mkdtempSync(path.join(tmpdir(), "grid-"));

async function main() {
  const c = await (await fetch(BASE + "/api/challenge", { headers: UA })).json();
  const files = [];
  for (let i = 0; i < c.tiles.length; i++) {
    const buf = Buffer.from(await (await fetch(c.tiles[i].url, { headers: UA })).arrayBuffer());
    const p = path.join(TMP, `t${i}.jpg`);
    writeFileSync(p, buf);
    files.push(p);
  }
  // 3x3グリッドに合成(各タイル300x200 = 3:2、間隔4px)
  const args = ["-y", "-loglevel", "error"];
  for (const f of files) args.push("-i", f);
  const filter =
    "[0]scale=300:200[a0];[1]scale=300:200[a1];[2]scale=300:200[a2];" +
    "[3]scale=300:200[a3];[4]scale=300:200[a4];[5]scale=300:200[a5];" +
    "[6]scale=300:200[a6];[7]scale=300:200[a7];[8]scale=300:200[a8];" +
    "[a0][a1][a2][a3][a4][a5][a6][a7][a8]xstack=inputs=9:layout=0_0|304_0|608_0|0_204|304_204|608_204|0_408|304_408|608_408:fill=black[out]";
  args.push("-filter_complex", filter, "-map", "[out]", "-q:v", "2", OUT);
  execFileSync("ffmpeg", args);
  console.log(JSON.stringify({ prompt: c.prompt, tags: c.tags, mode: c.mode, out: OUT, tiles: c.tiles.length }));
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
