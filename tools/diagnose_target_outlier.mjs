// 正解画像の中の「外れ値」(タグの付き方が他と違う1枚)を検出できるか検証する
//  実測の失敗: 「ツインテール」の正解2枚のうち1枚は髪を下ろしたキャラ(誤付与)だった。
//  誤付与された1枚は、他の正解とタグの重なりが薄い可能性がある。
const DEBUG = process.argv[2] || "http://localhost:3108";
const N = Number(process.argv[3] || 6);
const UA = { "user-agent": "Mozilla/5.0" };

const jac = (a, b) => {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / new Set([...A, ...B]).size;
};

async function main() {
  for (let i = 0; i < N; i++) {
    let c = null;
    for (let t = 0; t < 3 && !c; t++) {
      try {
        const r = await fetch(DEBUG + "/api/challenge", { headers: UA });
        if (r.ok) c = await r.json();
      } catch {}
      if (!c) await new Promise((s) => setTimeout(s, 400));
    }
    if (!c || !c.tiles?.[0]?.tags) { console.log("tagsなし"); return; }
    const prompt = new Set(c.tags || [c.prompt]);
    const targets = c.tiles.filter((t) => t.target);
    const strip = (arr) => arr.filter((t) => !prompt.has(t));

    console.log(`\n=== 「${c.prompt}」(${c.mode}) 正解${targets.length}枚 ===`);
    if (targets.length < 2) {
      console.log("  正解1枚 → 外れ値判定は不可");
      continue;
    }
    const sets = targets.map((t) => strip(t.tags));
    // 各正解の「他の正解との平均類似度」
    const avgs = sets.map((s, i) => {
      let sum = 0;
      for (let j = 0; j < sets.length; j++) if (j !== i) sum += jac(s, sets[j]);
      return sum / (sets.length - 1);
    });
    const mean = avgs.reduce((a, b) => a + b, 0) / avgs.length;
    avgs.forEach((a, i) => {
      const ratio = mean > 0 ? a / mean : 0;
      const tag = ratio < 0.6 ? "  ← 外れ値の疑い" : "";
      console.log(`  正解${i + 1}: 他との平均類似 ${a.toFixed(3)} (平均比 ${ratio.toFixed(2)})${tag}`);
      console.log(`     タグ例: ${strip(targets[i].tags).slice(0, 10).join(", ")}`);
    });
    console.log(`  正解同士の平均 ${mean.toFixed(3)}`);
    await new Promise((s) => setTimeout(s, 300));
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
