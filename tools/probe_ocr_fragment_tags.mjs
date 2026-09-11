// OCR断片タグ(usages=1 の「画面に書かれた文字」っぽいタグ)を集めて、
// その画像の文字がタイルサイズ(300x200)でも読めるかを確認するための素材を作る。
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "hikamani-captcha/1.0" };
const api = async (p) => {
  const r = await fetch(BASE + p, { headers: UA });
  if (!r.ok) throw new Error(p + " " + r.status);
  return r.json();
};
const OUT = "C:/Users/maeba/Desktop/hikamani-captcha/tools/ocrshot";
mkdirSync(OUT, { recursive: true });

const pats = ["*してね*", "*お願いします*", "*チャンネル登録*", "*ありがとうございました*"];
const cands = [];
for (const p of pats) {
  const d = await api(`/api/tags?query=${encodeURIComponent("name:" + p)}&limit=40`);
  for (const t of d.results || []) cands.push({ name: t.names[0], usages: t.usages });
}
// 珍しい(=その画像にしか付いていない)ものを優先
cands.sort((a, b) => a.usages - b.usages);
console.log("候補タグ:", cands.length);
console.log(cands.slice(0, 10).map((c) => `${c.name}(${c.usages})`).join("  "));

const truth = [];
let i = 0;
for (const c of cands.slice(0, 8)) {
  const d = await api(`/api/posts?query=${encodeURIComponent(c.name)}&limit=1&fields=id,thumbnailUrl`);
  const p = (d.results || [])[0];
  if (!p) continue;
  const raw = p.thumbnailUrl || "";
  const url = raw.startsWith("http") ? raw : BASE + (raw.startsWith("/") ? raw : "/" + raw);
  const r = await fetch(url, { headers: UA });
  if (!r.ok) continue;
  i++;
  writeFileSync(`${OUT}/${i}.jpg`, Buffer.from(await r.arrayBuffer()));
  truth.push({ idx: i, tag: c.name, postId: p.id });
}
writeFileSync(`${OUT}/truth.json`, JSON.stringify(truth, null, 1));
console.log("\n画像:", truth.length);
for (const t of truth) console.log(`  ${t.idx}: 「${t.tag}」 https://hikabooru.hikamers.app/posts/${t.postId}`);
