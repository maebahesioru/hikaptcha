// 画像改変パイプラインの試作と「逆検索・事前索引攻撃」への効果を実測する
//  方針: クロップ + 微小回転 + リサイズ + 再圧縮
//  効果: 元画像とバイト一致しなくなり、知覚ハッシュ(pHash)も大きく変わる
//        → 「hikabooruを全件スクレイプして事前にタグ索引を作る」攻撃が無効化される
const jpeg = require("jpeg-js");
const { createHash } = require("node:crypto");

// --- 知覚ハッシュ(8x8平均・64bit) ---
function pHash(rgba, width, height) {
  // 8x8に縮小(ブロック平均)
  const n = 8;
  const vals = [];
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

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// --- 改変(クロップ→回転→リサイズ→再圧縮) ---
function transform(buf, opts = {}) {
  const dec = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
  const { width: W, height: H, data } = dec;

  // 1) ランダムクロップ(4〜10%を四方から削る)
  const cx = Math.floor(W * (0.04 + Math.random() * 0.06));
  const cy = Math.floor(H * (0.04 + Math.random() * 0.06));
  const cw = W - cx * 2, chh = H - cy * 2;

  // 2) リサイズ(長辺320px固定・バイリニア)
  const scale = 320 / Math.max(cw, chh);
  const tw = Math.max(24, Math.round(cw * scale));
  const th = Math.max(24, Math.round(chh * scale));
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = cy + Math.min(chh - 1, Math.floor((y * chh) / th));
    for (let x = 0; x < tw; x++) {
      const sx = cx + Math.min(cw - 1, Math.floor((x * cw) / tw));
      const si = (sy * W + sx) * 4, di = (y * tw + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
    }
  }

  // 3) 微小回転(±3°)※再圧縮と合わせてハッシュをさらに崩す
  const angle = (Math.random() * 6 - 3) * (Math.PI / 180);
  let rw = tw, rh = th;
  let rot = out;
  if (Math.abs(angle) > 0.001) {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const dW = Math.floor(tw * Math.abs(cos) + th * Math.abs(sin));
    const dH = Math.floor(tw * Math.abs(sin) + th * Math.abs(cos));
    const rbuf = Buffer.alloc(dW * dH * 4);
    const cxs = dW / 2, cys = dH / 2, ocx = tw / 2, ocy = th / 2;
    for (let y = 0; y < dH; y++) {
      for (let x = 0; x < dW; x++) {
        const sx = Math.round(cos * (x - cxs) + sin * (y - cys) + ocx);
        const sy = Math.round(-sin * (x - cxs) + cos * (y - cys) + ocy);
        const di = (y * dW + x) * 4;
        if (sx >= 0 && sx < tw && sy >= 0 && sy < th) {
          const si = (sy * tw + sx) * 4;
          rbuf[di] = out[si]; rbuf[di + 1] = out[si + 1]; rbuf[di + 2] = out[si + 2]; rbuf[di + 3] = 255;
        } else {
          rbuf[di] = 0; rbuf[di + 1] = 0; rbuf[di + 2] = 0; rbuf[di + 3] = 255;
        }
      }
    }
    rot = rbuf; rw = dW; rh = dH;
  }
  // 回転でできた黒帯を避けて中央を刈る
  const mx = Math.floor(rw * 0.06), my = Math.floor(rh * 0.06);
  const fw = rw - mx * 2, fh = rh - my * 2;
  const fin = Buffer.alloc(fw * fh * 4);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const si = ((y + my) * rw + (x + mx)) * 4, di = (y * fw + x) * 4;
      fin[di] = rot[si]; fin[di + 1] = rot[si + 1]; fin[di + 2] = rot[si + 2]; fin[di + 3] = 255;
    }
  }

  // 4) 再圧縮
  const quality = 72 + Math.floor(Math.random() * 10);
  const enc = jpeg.encode({ data: fin, width: fw, height: fh }, quality);
  return { buf: enc.data, width: fw, height: fh, quality };
}

async function main() {
  const url = process.argv[2];
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  const orig = Buffer.from(await r.arrayBuffer());
  console.log(`元画像: ${orig.length} bytes`);

  const d0 = jpeg.decode(orig, { useTArray: true });
  const h0 = pHash(d0.data, d0.width, d0.height);
  const sha0 = createHash("sha256").update(orig).digest("hex").slice(0, 16);
  console.log(`元: ${d0.width}x${d0.height} sha=${sha0} pHash=${h0}`);

  for (let i = 0; i < 3; i++) {
    const t = transform(orig);
    const dd = jpeg.decode(t.buf, { useTArray: true });
    const h1 = pHash(dd.data, dd.width, dd.height);
    const sha1 = createHash("sha256").update(t.buf).digest("hex").slice(0, 16);
    console.log(
      `改変${i + 1}: ${t.width}x${t.height} q=${t.quality} ${t.buf.length}bytes sha=${sha1} ` +
      `sha一致=${sha1 === sha0} pHash距離=${hamming(h0, h1)}/64`
    );
  }
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
