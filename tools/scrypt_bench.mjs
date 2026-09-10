// 純JS scrypt (RFC 7914) の最小実装でブラウザ相当の速度を測る
// WebCryptoはscrypt非対応のため、ウィジェットにはこの実装を積む想定
import { createHmac } from "node:crypto";

function salsa20_8(B) {
  const x = new Int32Array(16);
  for (let i = 0; i < 16; i++) x[i] = B[i];
  const rot = (v, n) => ((v << n) | (v >>> (32 - n))) | 0;
  for (let i = 0; i < 8; i += 2) {
    x[4] ^= rot(x[0] + x[12] | 0, 7); x[8] ^= rot(x[4] + x[0] | 0, 9);
    x[12] ^= rot(x[8] + x[4] | 0, 13); x[0] ^= rot(x[12] + x[8] | 0, 18);
    x[9] ^= rot(x[5] + x[1] | 0, 7); x[13] ^= rot(x[9] + x[5] | 0, 9);
    x[1] ^= rot(x[13] + x[9] | 0, 13); x[5] ^= rot(x[1] + x[13] | 0, 18);
    x[14] ^= rot(x[10] + x[6] | 0, 7); x[2] ^= rot(x[14] + x[10] | 0, 9);
    x[6] ^= rot(x[2] + x[14] | 0, 13); x[10] ^= rot(x[6] + x[2] | 0, 18);
    x[3] ^= rot(x[15] + x[11] | 0, 7); x[7] ^= rot(x[3] + x[15] | 0, 9);
    x[11] ^= rot(x[7] + x[3] | 0, 13); x[15] ^= rot(x[11] + x[7] | 0, 18);
    x[1] ^= rot(x[0] + x[3] | 0, 7); x[2] ^= rot(x[1] + x[0] | 0, 9);
    x[3] ^= rot(x[2] + x[1] | 0, 13); x[0] ^= rot(x[3] + x[2] | 0, 18);
    x[6] ^= rot(x[5] + x[4] | 0, 7); x[7] ^= rot(x[6] + x[5] | 0, 9);
    x[4] ^= rot(x[7] + x[6] | 0, 13); x[5] ^= rot(x[4] + x[7] | 0, 18);
    x[11] ^= rot(x[10] + x[9] | 0, 7); x[8] ^= rot(x[11] + x[10] | 0, 9);
    x[9] ^= rot(x[8] + x[11] | 0, 13); x[10] ^= rot(x[9] + x[8] | 0, 18);
    x[12] ^= rot(x[15] + x[14] | 0, 7); x[13] ^= rot(x[12] + x[15] | 0, 9);
    x[14] ^= rot(x[13] + x[12] | 0, 13); x[15] ^= rot(x[14] + x[13] | 0, 18);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
}

function blockMix(B, Y, r) {
  const X = new Int32Array(16);
  X.set(B.subarray((2 * r - 1) * 16, (2 * r - 1) * 16 + 16));
  for (let i = 0; i < 2 * r; i++) {
    for (let k = 0; k < 16; k++) X[k] ^= B[i * 16 + k];
    salsa20_8(X);
    Y.set(X, i * 16);
  }
  for (let i = 0; i < r; i++) B.set(Y.subarray(i * 2 * 16, i * 2 * 16 + 16), i * 16);
  for (let i = 0; i < r; i++) B.set(Y.subarray((i * 2 + 1) * 16, (i * 2 + 1) * 16 + 16), (i + r) * 16);
}

// ROMix部分のみを測る(salsa/blockMixの速度が支配的なのでこれで十分)
function romixCost(N, r) {
  const M = 128 * r;
  const V = new Int32Array(N * M / 4);
  const B = new Int32Array(M / 4);
  const Y = new Int32Array(M / 4);
  for (let j = 0; j < N; j++) { V.set(B, j * M / 4); blockMix(B, Y, r); }
  for (let j = 0; j < N; j++) {
    const idx = (B[(2 * r - 1) * 16] % N) * M / 4;
    for (let k = 0; k < M / 4; k++) B[k] ^= V[idx + k];
    blockMix(B, Y, r);
  }
}

for (const N of [1024, 4096, 16384]) {
  const rounds = 3;
  const t0 = Date.now();
  for (let i = 0; i < rounds; i++) { romixCost(N, 8); if (i === 0) romixCost(N, 8); }
  const ms = (Date.now() - t0) / (rounds * 2);
  console.log(`scrypt core N=${N} r=8: ${ms.toFixed(1)}ms/回 (メモリ ${(128 * 8 * N / 1024 / 1024).toFixed(1)}MB)`);
  // 難易度bビットを満たすのに必要な試行の期待値は 2^b。1回のコストと掛けて所要時間を見積もる
  for (const bits of [4, 6, 8]) {
    const attempts = Math.pow(2, bits);
    console.log(`   ${bits}bit(期待${attempts}回): 約${(ms * attempts / 1000).toFixed(1)}秒`);
  }
}
