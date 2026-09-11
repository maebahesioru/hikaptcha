// 「文字が写っている画像」をお題にできるかを検証する。
//   ・「日本語のテキスト」タグ(20,886枚)が付いた画像 → 本当に文字が写っているか
//   ・付いていない画像 → 文字が写っていないか
// 読めなくても「文字があるかどうか」だけなら、タイルサイズ(300x200)でも人間に判定できる。
//
// 使い方: node tools/validate_text_presence.mjs [枚数=6]
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://hikabooru.hikamers.app";
const N = Number(process.argv[2] || 6);

const OUT = `C:/Users/maeba/Desktop/hikamani-captcha/tools/presence-${Date.now()}`;
const UA = { "user-agent": "hikamani-captcha/1.0" };
const api = async (p) => {
  const r = await fetch(BASE + p, { headers: UA });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};
mkdirSync(OUT, { recursive: true });

const truth = [];
let idx = 0;
async function grab(label, query, count) {
  // まず総数を取り、その範囲で無作為な位置から取る(offsetが総数を超えると0枚になる)
  const head = await api(`/api/posts?query=${encodeURIComponent(query)}&limit=1&fields=id`);
  const total = head.total || 0;
  const off = Math.floor(Math.random() * Math.max(1, total - count));
  const d = await api(`/api/posts?query=${encodeURIComponent(query)}&limit=${count}&offset=${off}&fields=id,thumbnailUrl`);
  for (const p of d.results || []) {
    const raw = p.thumbnailUrl || "";
    const url = raw.startsWith("http") ? raw : BASE + (raw.startsWith("/") ? raw : "/" + raw);
    const r = await fetch(url, { headers: UA });
    if (!r.ok) continue;
    idx++;
    writeFileSync(`${OUT}/${idx}.jpg`, Buffer.from(await r.arrayBuffer()));
    truth.push({ idx, group: label, postId: p.id });
  }
  console.log(`${label}: ${(d.results || []).length}枚 (全${d.total})`);
}

const TAG = process.argv[3] || "日本語のテキスト";
await grab(`${TAG}あり`, TAG, N);
await grab(`${TAG}なし`, `-${TAG} type:image`, N);
writeFileSync(`${OUT}/truth.json`, JSON.stringify(truth, null, 1));
console.log(`\n保存: ${OUT}`);
for (const t of truth) console.log(`  ${t.idx} [${t.group}] https://hikabooru.hikamers.app/posts/${t.postId}`);
