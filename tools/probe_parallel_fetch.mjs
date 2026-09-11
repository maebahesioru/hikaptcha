// 出題1回あたり6並列で画像を取るので、booru側が並列を制限していないか実測する。
// 使い方: node tools/probe_parallel_fetch.mjs [並列数=6] [回数=20]
const BASE = "https://hikabooru.hikamers.app";
const PAR = Number(process.argv[2] || 6);
const ROUNDS = Number(process.argv[3] || 20);
const UA = { "user-agent": "hikamani-captcha/1.0" };
const q = encodeURIComponent("safety:safe type:image");

async function one(offset) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/posts?query=${q}&limit=17&offset=${offset}&fields=id,canvasWidth,canvasHeight,thumbnailUrl,tags,source`, { headers: UA, signal: AbortSignal.timeout(8000) });
    const j = r.ok ? await r.json() : null;
    return { ok: r.ok, status: r.status, n: (j?.results || []).length, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, err: e.name, ms: Date.now() - t0 };
  }
}

let bad = 0;
let total = 0;
const slow = [];
for (let r = 0; r < ROUNDS; r++) {
  const offsets = Array.from({ length: PAR }, () => Math.floor(Math.random() * 29500));
  const res = await Promise.all(offsets.map(one));
  total += res.length;
  const failed = res.filter((x) => !x.ok);
  bad += failed.length;
  const ms = Math.max(...res.map((x) => x.ms));
  slow.push(ms);
  if (failed.length) {
    console.log(`  ラウンド${r + 1}: 失敗${failed.length}/${PAR} ${JSON.stringify(failed.slice(0, 3))}`);
  }
}
slow.sort((a, b) => a - b);
console.log(`\n並列${PAR} × ${ROUNDS}ラウンド = ${total}リクエスト`);
console.log(`失敗: ${bad} (${((bad / total) * 100).toFixed(1)}%)`);
console.log(`ラウンド所要: 中央値${slow[Math.floor(slow.length / 2)]}ms / 最大${slow[slow.length - 1]}ms`);
