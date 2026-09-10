// 出題の「見分けやすさ」をタグの重なりから診断する
//  仮説: ダミー画像が正解画像とタグをたくさん共有している場合、
//        人間にも見分けがつかない(タグの付与が不整合なだけ) → 不公平な出題
//  実測で「青いシャツ」がこれに該当した(真実2枚 vs vision7枚)
const DEBUG = process.argv[2] || "http://localhost:3108";
const N = Number(process.argv[3] || 8);
const UA = { "user-agent": "Mozilla/5.0" };

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 0;
}
// 正解同士の結びつきの強さ(小さいほど「バラバラの集合」= カテゴリとして弱い)
function avgPairwise(sets) {
  let sum = 0, n = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) { sum += jaccard(sets[i], sets[j]); n++; }
  }
  return n ? sum / n : 0;
}

async function main() {
  const rows = [];
  for (let i = 0; i < N; i++) {
    let c = null;
    for (let t = 0; t < 3 && !c; t++) {
      try {
        const r = await fetch(DEBUG + "/api/challenge", { headers: UA });
        if (r.ok) c = await r.json();
      } catch {}
      if (!c) await new Promise((s) => setTimeout(s, 400));
    }
    if (!c || !c.tiles || !c.tiles[0].tags) { console.log("tagsが取得できません(デバッグコピーを再生成して)"); return; }

    const prompt = new Set(c.tags || [c.prompt]);
    const strip = (arr) => arr.filter((t) => !prompt.has(t));
    const targets = c.tiles.filter((t) => t.target).map((t) => strip(t.tags));
    const dummies = c.tiles.filter((t) => !t.target).map((t) => strip(t.tags));

    // 正解同士の平均類似度
    const tt = avgPairwise(targets);
    // ダミーが正解とどれだけ似ているか(最大値の平均)
    let dmax = 0;
    for (const d of dummies) {
      let m = 0;
      for (const t of targets) m = Math.max(m, jaccard(d, t));
      dmax += m;
    }
    dmax = dummies.length ? dmax / dummies.length : 0;

    // お題タグを持つ画像の数(バッチ内)
    const withTag = c.tiles.filter((t) => t.tags.includes(c.tags ? c.tags[0] : c.prompt)).length;

    rows.push({
      prompt: c.prompt, mode: c.mode, targets: targets.length, dummies: dummies.length,
      tt: +tt.toFixed(3), dmax: +dmax.toFixed(3), ratio: +dmax / Math.max(0.001, tt),
      withTag,
    });
    await new Promise((s) => setTimeout(s, 250));
  }

  rows.sort((a, b) => b.ratio - a.ratio);
  console.log(`プロンプト            mode   正解 ダミー  正解同士類似 ダミー最大類似 比(不公平度)`);
  for (const r of rows) {
    console.log(
      `${r.prompt.padEnd(18)} ${r.mode.padEnd(6)} ${String(r.targets).padStart(2)}  ${String(r.dummies).padStart(2)}    ` +
      `${String(r.tt).padStart(6)}      ${String(r.dmax).padStart(6)}     ${r.ratio.toFixed(2)}`
    );
  }
  const avg = rows.reduce((a, r) => a + r.ratio, 0) / rows.length;
  console.log(`\n平均の比(ダミー最大類似 / 正解同士類似) = ${avg.toFixed(2)}`);
  console.log(`※ 1.0以上 = ダミーが正解と同程度に似ている → 人間には見分け不能な出題`);
  const bad = rows.filter((r) => r.ratio >= 0.9).length;
  console.log(`※ 比が0.9以上の出題: ${bad}/${rows.length}件 (${(bad / rows.length * 100).toFixed(0)}%)`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
