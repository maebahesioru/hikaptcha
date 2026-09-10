// タグ品質の定量測定: サンプルしたお題を「具体物/不正」に分類して不良率を出す
//  分類は「実測で見つけた不正パターン」に照合するのではなく、
//  『人が見て画像から選べる具体名詞か』を機械的に判定する補助チェックを通す
const BASE = process.argv[2] || "http://localhost:3109";
const N = Number(process.argv[3] || 200);
const UA = { "user-agent": "Mozilla/5.0" };

async function main() {
  const prompts = [];
  for (let i = 0; i < N; i++) {
    try {
      const r = await fetch(BASE + "/api/challenge", { headers: UA });
      if (r.ok) { const j = await r.json(); if (j.prompt) prompts.push(j.prompt); }
    } catch {}
    await new Promise((s) => setTimeout(s, 300));
  }
  const uniq = [...new Set(prompts)];
  console.log(`取得成功 ${prompts.length} / ユニーク ${uniq.length}\n`);
  console.log(uniq.join(" | "));

  // 参考指標: 造語(カタカナが不自然に長い/意味不明)や抽象語尾の割合
  const suspicious = uniq.filter((t) => /(化|型|風|系|調|的|者|員|類)$/.test(t) || /^[ァ-ヶー]{2,}$/.test(t) && t.length >= 5);
  console.log(`\n機械的な要注意(語尾型/長いカタカナ): ${suspicious.length}/${uniq.length} = ${(suspicious.length / uniq.length * 100).toFixed(1)}%`);
  if (suspicious.length) console.log("  " + suspicious.join(" | "));
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
