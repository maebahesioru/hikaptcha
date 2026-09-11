// 「文字起こし系のタグ」は、画像に**実際に文字が写っている**のか、
// それとも「音声の内容」を表しているだけなのかを確かめる。
//
// これが「写っている」なら、新形式の認証(文字を読ませる)が作れる。
// 「音声の内容」なら人間には判定不能なので使えない。
//
// 使い方: node tools/validate_text_tags.mjs タグ名 [枚数=6]
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://hikabooru.hikamers.app";
const TAGS = process.argv.slice(2, -1).length ? process.argv.slice(2, -1) : ["どうもヒカキンです", "ありがとうございました"];
const PER = Number(process.argv[process.argv.length - 1]) || 3;
const OUT = `C:/Users/maeba/Desktop/hikamani-captcha/tools/text-${Date.now()}`;
const UA = { "user-agent": "hikamani-captcha/1.0" };

const api = async (p) => {
  const r = await fetch(BASE + p, { headers: UA });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};

mkdirSync(OUT, { recursive: true });
const truth = [];
let idx = 0;
for (const tag of TAGS) {
  const d = await api(`/api/posts?query=${encodeURIComponent(tag)}&limit=${PER + 3}&fields=id,thumbnailUrl,canvasWidth`);
  const posts = (d.results || []).slice(0, PER);
  console.log(`「${tag}」: 全${d.total}枚から ${posts.length}枚`);
  for (const p of posts) {
    const raw = p.thumbnailUrl || "";
    const url = raw.startsWith("http") ? raw : BASE + (raw.startsWith("/") ? raw : "/" + raw);
    const r = await fetch(url, { headers: UA });
    if (!r.ok) continue;
    idx++;
    writeFileSync(`${OUT}/${idx}.jpg`, Buffer.from(await r.arrayBuffer()));
    truth.push({ idx, tag, postId: p.id });
    console.log(`  ${idx}: https://hikabooru.hikamers.app/posts/${p.id}`);
  }
}
writeFileSync(`${OUT}/truth.json`, JSON.stringify(truth, null, 1));
console.log(`\n保存: ${OUT} (${truth.length}枚)`);
