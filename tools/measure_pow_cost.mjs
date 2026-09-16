// PoWの実コストを実測する(1試行あたりの時間と、bits ごとの期待時間)
// 使い方: node tools/measure_pow_cost.mjs
import { scryptSync, randomBytes } from "node:crypto";

const N = Number(process.env.POW_N || 1024);
const r = Number(process.env.POW_R || 8);
const p = Number(process.env.POW_P || 1);
const salt = randomBytes(16);
const t0 = Date.now();
const ROUNDS = 200;
for (let i = 0; i < ROUNDS; i++) scryptSync("challenge:" + i, salt, 32, { N, r, p, maxmem: 2 ** 28 });
const per = (Date.now() - t0) / ROUNDS;

console.log(`scrypt(N=${N}, r=${r}, p=${p}) 1試行 = ${per.toFixed(2)}ms (Nodeのネイティブ実装)`);
console.log("ブラウザの純JS実装はおおむねこの2〜5倍かかる\n");
console.log("bits  期待試行数   期待時間(ネイティブ)   ブラウザ目安(3倍)");
for (const bits of [6, 7, 8, 9, 10, 11, 12]) {
  const tries = 2 ** bits;
  const native = (tries * per) / 1000;
  console.log(` ${String(bits).padStart(2)}   ${String(tries).padStart(9)}   ${native.toFixed(2).padStart(8)}秒 ${(native * 3).toFixed(2).padStart(14)}秒`);
}
console.log("\n※ 適応難易度: 突破 IP_SOLVED_DECAY_MS(既定30分)以内に POW_RAMP_EVERY(既定3)回で+1bit");
console.log("   → ボットは数回で POW_BITS_MAX に到達し、1回あたりのコストが上がる");
