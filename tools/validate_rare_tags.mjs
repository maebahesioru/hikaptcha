// 「珍しいタグ(usages 80〜149)は、今使っているタグ(150〜3000)と同じくらい信頼できるのか?」
// 帯域ごとにタグを無作為に選び、その画像を1枚ずつ並べて vision に「本当に写っているか」を判定させる。
//
// 使い方: node tools/validate_rare_tags.mjs [下限] [上限] [枚数] [出力名]
//   例: node tools/validate_rare_tags.mjs 80 149 12 rare
//       node tools/validate_rare_tags.mjs 150 3000 12 normal
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://hikabooru.hikamers.app";
const MIN = Number(process.argv[2] || 80);
const MAX = Number(process.argv[3] || 149);
const N = Number(process.argv[4] || 12);
const NAME = process.argv[5] || "band";
const OUT = `C:/Users/maeba/Desktop/hikamani-captcha/tools/band-${NAME}`;
const UA = { "user-agent": "hikamani-captcha/1.0" };
const NSFW = /性器|陰部|陰茎|陰嚢|睾丸|膣|肛門|乳首|乳輪|おっぱい|ちんこ|まんこ|ペニス|性行為|セックス|射精|精液|勃起|ヌード|全裸|半裸|裸体|排泄|糞|放尿/;

const api = async (p) => {
  const r = await fetch(BASE + p, { headers: UA });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};

mkdirSync(OUT, { recursive: true });

// 帯域から無作為にタグを選ぶ
const band = await api(`/api/tags?query=${encodeURIComponent(`usages:${MIN}..${MAX}`)}&limit=1`);
const total = band.total || 0;
const picked = [];
const seen = new Set();
let guard = 0;
while (picked.length < N && guard++ < 40) {
  const off = Math.floor(Math.random() * Math.max(1, total - 100));
  const d = await api(`/api/tags?query=${encodeURIComponent(`usages:${MIN}..${MAX}`)}&limit=40&offset=${off}`);
  for (const t of d.results || []) {
    const name = t.names[0];
    if (seen.has(name) || NSFW.test(name)) continue;
    if (/[_@\s]|[A-Za-z]/.test(name)) continue; // 名前フィルタが弾く種類は除外しておく
    seen.add(name);
    picked.push({ name, usages: t.usages });
    if (picked.length >= N) break;
  }
}
console.log(`帯域 ${MIN}..${MAX} から ${picked.length}個: ${picked.map((p) => `${p.name}(${p.usages})`).join(", ")}`);

// それぞれの画像を1枚取る
const truth = [];
for (let i = 0; i < picked.length; i++) {
  const t = picked[i];
  const d = await api(`/api/posts?query=${encodeURIComponent(t.name)}&limit=1&fields=id,thumbnailUrl`);
  const p = (d.results || [])[0];
  if (!p) continue;
  const raw = p.thumbnailUrl || "";
  const url = raw.startsWith("http") ? raw : BASE + (raw.startsWith("/") ? raw : "/" + raw);
  const r = await fetch(url, { headers: UA });
  if (!r.ok) continue;
  writeFileSync(`${OUT}/${i + 1}.jpg`, Buffer.from(await r.arrayBuffer()));
  truth.push({ idx: i + 1, tag: t.name, usages: t.usages, postId: p.id });
}
writeFileSync(`${OUT}/truth.json`, JSON.stringify(truth, null, 1));
console.log(`画像 ${truth.length}枚を保存: ${OUT}`);
for (const t of truth) console.log(`  ${t.idx}: 「${t.tag}」(${t.usages}) https://hikabooru.hikamers.app/posts/${t.postId}`);
