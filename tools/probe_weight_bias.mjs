// お題タグの「候補の重み」がどれだけ一部のタグに偏っているかを実測する。
// サーバーのルーレット(singleモード)と同じ計算を再現して、上位タグが重みを占める割合を見る。
//
// 使い方: node tools/probe_weight_bias.mjs [バッチ数=5]
const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "hikamani-captcha/1.0" };
const TAG_MIN_USAGES = 150;
const concreteness = (u) => Math.sqrt(Math.max(10, u) / 100);

async function slice(offset, limit) {
  const q = encodeURIComponent("safety:safe type:image");
  const r = await fetch(`${BASE}/api/posts?query=${q}&limit=${limit}&offset=${offset}&fields=id,tags`, { headers: UA });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.results || []).map((p) => ({
    id: p.id,
    tags: p.tags || [],
  }));
}

(async () => {
  const N = Number(process.argv[2] || 5);
  for (let b = 0; b < N; b++) {
    const offsets = [];
    while (offsets.length < 6) {
      const o = Math.floor(Math.random() * 29500);
      if (!offsets.includes(o)) offsets.push(o);
    }
    const parts = await Promise.all(offsets.map((o) => slice(o, 17).catch(() => [])));
    const byTag = new Map();
    for (const p of parts.flat()) {
      for (const t of p.tags) {
        const name = t.names[0];
        if (!name) continue;
        const cur = byTag.get(name) || { usages: t.usages, imgs: new Set() };
        cur.imgs.add(p.id);
        byTag.set(name, cur);
      }
    }
    // singleモードの重み
    const rows = [];
    for (const [tag, v] of byTag) {
      const n = v.imgs.size;
      if (v.usages < TAG_MIN_USAGES || n < 2) continue;
      const w = Math.max(1, Math.round(Math.min(n, 5) ** 2 * concreteness(v.usages) * 10));
      rows.push({ tag, n, usages: v.usages, w });
    }
    rows.sort((a, b) => b.w - a.w);
    const total = rows.reduce((s, r) => s + r.w, 0);
    const top3 = rows.slice(0, 3).reduce((s, r) => s + r.w, 0);
    console.log(`\nバッチ${b + 1}: 候補${rows.length}種 / 重み合計${total}`);
    console.log(`  上位3タグが重みの ${((top3 / total) * 100).toFixed(0)}% を占める`);
    for (const r of rows.slice(0, 6)) {
      console.log(`    ${((r.w / total) * 100).toFixed(1).padStart(4)}%  w=${String(r.w).padStart(4)}  n=${r.n}  usages=${String(r.usages).padStart(6)}  ${r.tag}`);
    }
  }
})().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
