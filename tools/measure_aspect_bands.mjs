// アスペクト比の狭め方が「切れ」と「候補数」にどう効くか実測する
//  hikabooruのsafe画像が各アスペクト帯に何枚あるか + 3:2にクロップしたときの切れ量
const API = "https://hikabooru.hikamers.app/api";
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const TARGET = 1.5;

async function countInRange(lo, hi) {
  // サーバー側で絞れないので、ランダムサンプルから比率を推定する
  const q = encodeURIComponent("safety:safe type:image");
  const url = `${API}/posts?query=${q}&limit=100&offset=${Math.floor(Math.random() * 29000)}&fields=id,canvasWidth,canvasHeight`;
  const r = await fetch(url, { headers: UA });
  const d = await r.json();
  const rs = d.results || [];
  const total = d.total || 0;
  let inRange = 0, valid = 0;
  for (const p of rs) {
    const w = p.canvasWidth || 0, h = p.canvasHeight || 0;
    if (!w || !h) continue;
    valid++;
    const a = w / h;
    if (a >= lo && a <= hi) inRange++;
  }
  return { ratio: valid ? inRange / valid : 0, n: valid, total };
}

async function main() {
  const bands = [
    { lo: 1.35, hi: 1.85, name: "現行 1.35-1.85" },
    { lo: 1.42, hi: 1.60, name: "狭め 1.42-1.60" },
    { lo: 1.45, hi: 1.56, name: "厳しめ 1.45-1.56" },
    { lo: 1.48, hi: 1.53, name: "ほぼ3:2のみ" },
  ];
  const total = 30500;
  // 複数バッチの平均を取る
  const acc = new Map(bands.map((b) => [b.name, []]));
  for (let i = 0; i < 8; i++) {
    for (const b of bands) {
      const { ratio } = await countInRange(b.lo, b.hi);
      acc.get(b.name).push(ratio);
    }
    await new Promise((s) => setTimeout(s, 150));
  }
  console.log(`safe画像 約${total}枚に対する各アスペクト帯の割合(8バッチ平均)\n`);
  for (const b of bands) {
    const arr = acc.get(b.name);
    const avg = arr.reduce((x, y) => x + y, 0) / arr.length;
    // 3:2へのクロップで失う面積(最悪ケース)
    const worst = a => {
      const long = Math.max(a, TARGET), shortv = Math.min(a, TARGET);
      return 1 - (shortv / long) / 1; // 縦横どちらかを削る割合
    };
    const cutLo = 1 - (b.lo / TARGET > 1 ? TARGET / b.lo : b.lo / TARGET);
    const cutHi = 1 - (b.hi / TARGET > 1 ? TARGET / b.hi : b.hi / TARGET);
    console.log(
      `  ${b.name.padEnd(22)} 該当率 ${(avg * 100).toFixed(1)}% (約${Math.round(total * avg)}枚)  ` +
      `最大クロップ量 幅/高さ ${(Math.max(cutLo, cutHi) * 100).toFixed(0)}%`
    );
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
