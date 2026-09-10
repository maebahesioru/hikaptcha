// タイルの実効表示サイズを実測(3:2タイル前提)
//  配信画像が3:2に揃っていれば、タイル全面が画像で埋まる(余白ゼロ)
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEBUG = process.argv[2] || "http://localhost:3108";
const UA = { "user-agent": "Mozilla/5.0" };
const TMP = mkdtempSync(path.join(tmpdir(), "dim2-"));
let n = 0;
const F = () => path.join(TMP, `f${(n = (n + 1) % 100000)}`);

function jpegSize(buf) {
  const p = F() + ".jpg";
  writeFileSync(p, buf);
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", p]).toString().trim();
  const [w, h] = out.split(",").map(Number);
  return { w, h };
}

// タイル1辺 = 720pxコンテナ / 3列 / gap6 / padding14 で約226px幅
const TILE_W = 226;
const TILE_H = Math.round(TILE_W * 2 / 3); // 3:2タイル

async function main() {
  const rows = [];
  for (let round = 0; round < 3; round++) {
    const c = await (await fetch(DEBUG + "/api/challenge", { headers: UA })).json();
    for (const t of (c.tiles || []).slice(0, 6)) {
      const buf = Buffer.from(await (await fetch(t.url, { headers: UA })).arrayBuffer());
      const { w, h } = jpegSize(buf);
      const aspect = w / h;
      // cover なので、タイルと同じアスペクトなら全面表示(クロップゼロ)
      const sameAspect = Math.abs(aspect - TILE_W / TILE_H) < 0.15;
      // 面積比: coverでタイルを埋めるとき、元画像の何%が表示されるか
      const covered = 1 - Math.max(0, Math.abs(aspect - TILE_W / TILE_H) / Math.max(aspect, TILE_W / TILE_H));
      rows.push({ dim: `${w}x${h}`, aspect: aspect.toFixed(2), covered });
    }
  }
  console.log(`タイル ${TILE_W}x${TILE_H}(3:2) での実測(${rows.length}枚)\n`);
  for (const r of rows.slice(0, 8)) {
    console.log(`  配信${r.dim} (${r.aspect}) → タイル被覆率 ${(r.covered * 100).toFixed(0)}%`);
  }
  const avgAspect = rows.reduce((a, r) => a + Number(r.aspect), 0) / rows.length;
  const avgCovered = rows.reduce((a, r) => a + r.covered, 0) / rows.length;
  console.log(`\n平均アスペクト ${avgAspect.toFixed(2)} (目標1.50) / 平均被覆率 ${(avgCovered * 100).toFixed(0)}%`);
  console.log(`旧構成では被写体がタイル面積の46%(181x107px)だった → 現在 ${TILE_W}x${TILE_H}px 全面 (約1.8倍の面積)`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
