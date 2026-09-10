// バッチから観測した「タグ→(バッチ内出現枚数, usages)」を全部ダンプする(しきい値の検討用)
import { writeFileSync, mkdirSync } from "node:fs";
const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "Mozilla/5.0" };
const BATCHES = Number(process.argv[2] || 40);
const OUT = "C:/Users/maeba/Desktop/hikamani-captcha/tag_audit/tags.json";
mkdirSync("C:/Users/maeba/Desktop/hikamani-captcha/tag_audit", { recursive: true });

const rows = [];
for (let i = 0; i < BATCHES; i++) {
  const offset = Math.floor(Math.random() * 29500);
  const q = encodeURIComponent("safety:safe type:image");
  try {
    const r = await fetch(`${BASE}/api/posts?query=${q}&limit=20&offset=${offset}&fields=id,tags`, { headers: UA });
    if (!r.ok) continue;
    const d = await r.json();
    const imgs = (d?.results || []).filter((p) => p && p.tags);
    const byTag = new Map();
    for (const p of imgs) {
      for (const t of p.tags) {
        const name = (t.names && t.names[0]) || "";
        if (!name) continue;
        if (!byTag.has(name)) byTag.set(name, { n: 0, usages: t.usages || 0 });
        byTag.get(name).n++;
      }
    }
    for (const [name, v] of byTag) rows.push({ batch: i, tag: name, n: v.n, usages: v.usages });
  } catch {}
  if (i % 10 === 0) console.log(`...${i}/${BATCHES}`);
  await new Promise((s) => setTimeout(s, 250));
}
writeFileSync(OUT, JSON.stringify(rows));
console.log(`保存: ${OUT} (${rows.length}行)`);
