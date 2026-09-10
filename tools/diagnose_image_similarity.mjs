// 画像そのものの類似度で「見分け不能な出題」を検出できるか実測する
//  背景: 「長袖」で同じ人物の雪山ジャケット連続写真8枚のうちタグが2枚にしか付かず、
//        人間には全部長袖に見えた(タグの重なりでは検出できない型の不公平)。
//  手法: 各画像を8x8グレースケールに落とし、平均を引いて二値化(64bit署名)。
//        ハミング距離で正解同士 / ダミーと正解 の近さを比べる。依存ゼロ(ffmpegのみ)。
import { spawnSync } from "node:child_process";

const DEBUG = process.argv[2] || "http://localhost:3108";
const N = Number(process.argv[3] || 6);
const UA = { "user-agent": "Mozilla/5.0" };

// 8x8グレースケール署名(64bit)を作る
function signature(buf) {
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", "pipe:0", "-vf", "scale=8:8", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"],
    { input: buf, maxBuffer: 1 << 20 }
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < 64) return null;
  const px = [...r.stdout.slice(0, 64)];
  const mean = px.reduce((a, b) => a + b, 0) / 64;
  return px.map((v) => (v > mean ? 1 : 0));
}

const ham = (a, b) => {
  let d = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++;
  return d;
};

async function main() {
  let bad = 0;
  for (let k = 0; k < N; k++) {
    let c = null;
    for (let t = 0; t < 3 && !c; t++) {
      try {
        const r = await fetch(DEBUG + "/api/challenge", { headers: UA });
        if (r.ok) c = await r.json();
      } catch {}
      if (!c) await new Promise((s) => setTimeout(s, 400));
    }
    if (!c) { console.log("取得失敗"); continue; }

    const sigs = [];
    for (const tile of c.tiles) {
      const img = await fetch(tile.url, { headers: UA });
      if (!img.ok) { sigs.push(null); continue; }
      sigs.push(signature(Buffer.from(await img.arrayBuffer())));
    }
    const tg = c.tiles.map((t, i) => (t.target ? i : -1)).filter((i) => i >= 0);
    const dm = c.tiles.map((t, i) => (t.target ? -1 : i)).filter((i) => i >= 0);
    if (tg.length < 2 || sigs.some((s) => !s)) { console.log(`「${c.prompt}」: 署名計算不可`); continue; }

    // 正解同士の平均ハミング距離(小さいほど似ている)
    let tt = 0, n = 0;
    for (let a = 0; a < tg.length; a++)
      for (let b = a + 1; b < tg.length; b++) { tt += ham(sigs[tg[a]], sigs[tg[b]]); n++; }
    tt = n ? tt / n : 0;
    // 各ダミーの正解への最小距離(=最も似ている正解との距離)の平均
    let dd = 0;
    for (const d of dm) {
      let m = 999;
      for (const t of tg) m = Math.min(m, ham(sigs[d], sigs[t]));
      dd += m;
    }
    dd = dd / dm.length;
    // 距離ベースの不公平度: ダミーが正解より近い(または同程度)なら1以上
    const unfair = tt / Math.max(1, dd);
    if (unfair >= 1.0) bad++;
    console.log(
      `「${c.prompt}」(${c.mode}) 正解${tg.length}枚 | 正解同士距離 ${tt.toFixed(1)} / ダミー最近距離 ${dd.toFixed(1)} | 不公平度 ${unfair.toFixed(2)}${unfair >= 1.0 ? "  ← 見分け不能" : ""}`
    );
    await new Promise((s) => setTimeout(s, 200));
  }
  console.log(`\n不公平(距離比>=1.0): ${bad}/${N}件`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
