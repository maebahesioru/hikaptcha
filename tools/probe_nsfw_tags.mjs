// 帯域 usages:80..149 のタグを全部取って、CAPTCHAのお題に出すと問題がある語を洗い出す。
// 推測で除外リストを作らないため、実際のタグ名を全部見てから決める。
const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "hikamani-captcha/1.0" };
const q = encodeURIComponent("usages:80..149");

// 明示的な性器・性行為まわり(画像はsafeでも、お題の語として出したくない)
const NSFW = /性器|陰部|陰茎|陰嚢|睾丸|膣|肛門|乳首|乳輪|おっぱい|ちんこ|まんこ|ペニス|ヴァギナ|性行為|セックス|射精|精液|勃起|ヌード|全裸|半裸|裸体|排泄|うんこ|うんち|糞|放尿|おしっこ/;
// 体の部位そのもの(お題としては成立するが、露出度が高くなる語)
const BODY = /乳|尻|太もも|へそ|脇|わき/;

const rows = [];
for (let off = 0; off < 1200; off += 100) {
  const r = await fetch(`${BASE}/api/tags?query=${q}&limit=100&offset=${off}`, { headers: UA });
  if (!r.ok) break;
  const d = await r.json();
  const res = d.results || [];
  if (!res.length) break;
  for (const t of res) rows.push({ name: t.names[0], usages: t.usages });
  if (off + 100 >= (d.total || 0)) break;
}
console.log(`帯域80〜149のタグ: ${rows.length}個`);

const nsfw = rows.filter((r) => NSFW.test(r.name));
const body = rows.filter((r) => !NSFW.test(r.name) && BODY.test(r.name));
console.log(`\n== 明示的な性表現(${nsfw.length}個) — 除外すべき ==`);
console.log("  " + nsfw.map((r) => `${r.name}(${r.usages})`).join("  "));
console.log(`\n== 体の部位(${body.length}個) — 判断が必要 ==`);
console.log("  " + body.map((r) => `${r.name}(${r.usages})`).join("  "));

// 現在の帯域(150..3000)にも同種の語が無いか確認
const rows2 = [];
for (let off = 0; off < 1600; off += 100) {
  const r = await fetch(`${BASE}/api/tags?query=${encodeURIComponent("usages:150..3000")}&limit=100&offset=${off}`, { headers: UA });
  if (!r.ok) break;
  const d = await r.json();
  if (!(d.results || []).length) break;
  for (const t of d.results) rows2.push({ name: t.names[0], usages: t.usages });
  if (off + 100 >= (d.total || 0)) break;
}
const nsfw2 = rows2.filter((r) => NSFW.test(r.name));
console.log(`\n== 現行の帯域(150〜3000)にある性表現(${nsfw2.length}個) ==`);
console.log("  " + (nsfw2.map((r) => `${r.name}(${r.usages})`).join("  ") || "(なし)"));
