// パラメータ探索: 「人間には判別できるが、pHash逆検索は失敗する」改変を探す
// pHash距離が大きいほど、事前索引型の逆検索が効かなくなる(目安: 20以上で別物判定)
const jpeg = require("jpeg-js");

function pHash(rgba, width, height) {
  const n = 8, vals = [];
  for (let by = 0; by < n; by++) {
    for (let bx = 0; bx < n; bx++) {
      let sum = 0, cnt = 0;
      const x0 = Math.floor((bx * width) / n), x1 = Math.floor(((bx + 1) * width) / n);
      const y0 = Math.floor((by * height) / n), y1 = Math.floor(((by + 1) * height) / n);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          cnt++;
        }
      }
      vals.push(cnt ? sum / cnt : 0);
    }
  }
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  let bits = "";
  for (const v of vals) bits += v >= avg ? "1" : "0";
  return bits;
}
const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

// cropFrac: 中央をどれだけ残すか / rotDeg: 回転 / bright: 明るさ係数 / gamma: ガンマ
function transform(buf, { cropFrac = 0.75, rotDeg = 3, bright = 1.0, gamma = 1.0, out = 300, quality = 78, mirror = false } = {}) {
  const dec = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
  const { width: W, height: H, data } = dec;
  const cw = Math.max(16, Math.floor(W * cropFrac)), chh = Math.max(16, Math.floor(H * cropFrac));
  const cx = Math.floor((W - cw) / 2), cy = Math.floor((H - chh) / 2);

  const tw = out, th = Math.max(24, Math.round((chh / cw) * out));
  // ルックアップテーブル(明るさ・ガンマ)を先に作る
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = Math.min(255, Math.max(0, Math.round(255 * Math.pow(i / 255, gamma) * bright)));
    lut[i] = v;
  }
  const src = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = cy + Math.min(chh - 1, Math.floor((y * chh) / th));
    for (let x = 0; x < tw; x++) {
      const xx = mirror ? tw - 1 - x : x;
      const sx = cx + Math.min(cw - 1, Math.floor((xx * cw) / tw));
      const si = (sy * W + sx) * 4, di = (y * tw + x) * 4;
      src[di] = lut[data[si]]; src[di + 1] = lut[data[si + 1]]; src[di + 2] = lut[data[si + 2]]; src[di + 3] = 255;
    }
  }
  let rw = tw, rh = th, rot = src;
  if (Math.abs(rotDeg) > 0.01) {
    const a = (rotDeg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const dW = Math.floor(tw * Math.abs(cos) + th * Math.abs(sin));
    const dH = Math.floor(tw * Math.abs(sin) + th * Math.abs(cos));
    const rb = Buffer.alloc(dW * dH * 4);
    for (let y = 0; y < dH; y++) {
      for (let x = 0; x < dW; x++) {
        const sx = Math.round(cos * (x - dW / 2) + sin * (y - dH / 2) + tw / 2);
        const sy = Math.round(-sin * (x - dW / 2) + cos * (y - dH / 2) + th / 2);
        const di = (y * dW + x) * 4;
        if (sx >= 0 && sx < tw && sy >= 0 && sy < th) {
          const si = (sy * tw + sx) * 4;
          rb[di] = src[si]; rb[di + 1] = src[si + 1]; rb[di + 2] = src[si + 2]; rb[di + 3] = 255;
        } else { rb[di + 2] = 255; rb[di + 3] = 255; }
      }
    }
    rot = rb; rw = dW; rh = dH;
  }
  // 回転の黒帯を刈る
  const mx = Math.floor(rw * 0.07), my = Math.floor(rh * 0.07);
  const fw = rw - mx * 2, fh = rh - my * 2;
  const fin = Buffer.alloc(fw * fh * 4);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const si = ((y + my) * rw + (x + mx)) * 4, di = (y * fw + x) * 4;
      fin[di] = rot[si]; fin[di + 1] = rot[si + 1]; fin[di + 2] = rot[si + 2]; fin[di + 3] = 255;
    }
  }
  const enc = jpeg.encode({ data: fin, width: fw, height: fh }, quality);
  return { buf: enc.data, width: fw, height: fh };
}

async function main() {
  const url = process.argv[2];
  const orig = Buffer.from(await (await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } })).arrayBuffer());
  const d0 = jpeg.decode(orig, { useTArray: true });
  const h0 = pHash(d0.data, d0.width, d0.height);
  console.log(`元 ${d0.width}x${d0.height}`);

  const variants = [
    { name: "無改変(基準)", cropFrac: 1.0, rotDeg: 0, bright: 1, gamma: 1 },
    { name: "反転のみ", cropFrac: 0.95, rotDeg: 0, bright: 1, gamma: 1, mirror: true },
    { name: "反転+明るさ", cropFrac: 0.95, rotDeg: 0, bright: 1.15, gamma: 0.94, mirror: true },
    { name: "反転+クロップ88%", cropFrac: 0.88, rotDeg: 2, bright: 1.12, gamma: 0.95, mirror: true },
    { name: "反転+クロップ80%", cropFrac: 0.8, rotDeg: 2, bright: 1.15, gamma: 0.94, mirror: true },
    { name: "反転+クロップ70%", cropFrac: 0.7, rotDeg: 3, bright: 1.15, gamma: 0.94, mirror: true },
    { name: "クロップ88%のみ", cropFrac: 0.88, rotDeg: 2, bright: 1.12, gamma: 0.95 },
  ];
  for (const v of variants) {
    let dists = [], sizes = [];
    for (let i = 0; i < 5; i++) {
      const t = transform(orig, v);
      const dd = jpeg.decode(t.buf, { useTArray: true });
      dists.push(hamming(h0, pHash(dd.data, dd.width, dd.height)));
      sizes.push(`${t.width}x${t.height}`);
    }
    const avg = (dists.reduce((a, b) => a + b, 0) / dists.length).toFixed(1);
    const min = Math.min(...dists);
    console.log(`  ${v.name.padEnd(22)} pHash距離 avg=${avg} min=${min} /64  ${sizes[0]}`);
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
