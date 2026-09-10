// ウィジェットscryptの実測コスト(ブラウザUXの判断材料)
import { readFileSync } from "node:fs";
const src = readFileSync("C:/Users/maeba/Desktop/hikamani-captcha/public/captcha.js", "utf8");
const start = src.indexOf("function salsa20_8");
const end = src.indexOf("async function solveScryptPow");
const factory = new Function("crypto", "TextEncoder", src.slice(start, end) + "\nreturn { scrypt, pbkdf2Sha256 };");
const w = factory(globalThis.crypto, TextEncoder);

const enc = new TextEncoder();
const salt = new Uint8Array(16).fill(7);

async function bench(N, r) {
  const t0 = Date.now();
  const rounds = 5;
  for (let i = 0; i < rounds; i++) await w.scrypt(enc.encode("bench:" + i), salt, N, r, 1, 32);
  const ms = (Date.now() - t0) / rounds;
  console.log(`N=${N} r=${r}: ${ms.toFixed(1)}ms/試行 (メモリ ${(128 * r * N / 1048576).toFixed(1)}MB)`);
  for (const bits of [4, 5, 6]) {
    const attempts = Math.pow(2, bits);
    console.log(`   難易度${bits}bit(期待${attempts}試行): 約${(ms * attempts / 1000).toFixed(2)}秒`);
  }
}
for (const [N, r] of [[512, 8], [1024, 8], [2048, 8]]) await bench(N, r);
