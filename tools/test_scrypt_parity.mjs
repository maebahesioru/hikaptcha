// 検証: ウィジェットの純JS scrypt が Node(crypto.scryptSync) と完全一致するか
// ここが一致しないと、クライアントが解いてもサーバーが受理しない(認証が全滅する)
import { readFileSync } from "node:fs";
import { scryptSync } from "node:crypto";

const src = readFileSync("C:/Users/maeba/Desktop/hikamani-captcha/public/captcha.js", "utf8");
const start = src.indexOf("function salsa20_8");
const end = src.indexOf("async function solveScryptPow");
if (start < 0 || end < 0) throw new Error("scrypt実装が見つからない");
const code = src.slice(start, end);

// 注: new Function の body は自リポジトリのウィジェット実コード(ローカルファイル)のみ。
// 外部入力は混入しない(テスト目的で実コードを走らせるための評価)。
const factory = new Function("crypto", "TextEncoder", code + "\nreturn { scrypt, pbkdf2Sha256 };");
const w = factory(globalThis.crypto, TextEncoder);

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} ${detail || ""}`); }
}

function hex(u8) { return Buffer.from(u8).toString("hex"); }

async function main() {
  console.log("=== ウィジェットscrypt vs Node scryptSync の一致検証 ===");
  const cases = [
    { pw: "hello", salt: "00112233445566778899aabbccddeeff", N: 16, r: 1, p: 1 },
    { pw: "challenge123:0", salt: "aabbccddeeff00112233445566778899", N: 16, r: 1, p: 1 },
    { pw: "test", salt: "0123456789abcdef0123456789abcdef", N: 64, r: 2, p: 1 },
    { pw: "abc:42", salt: "ffffffffffffffffffffffffffffffff", N: 1024, r: 8, p: 1 },
  ];
  for (const c of cases) {
    const salt = Buffer.from(c.salt, "hex");
    const mine = await w.scrypt(new TextEncoder().encode(c.pw), new Uint8Array(salt), c.N, c.r, c.p, 32);
    const node = scryptSync(c.pw, salt, 32, { N: c.N, r: c.r, p: c.p, maxmem: 256 * 1024 * 1024 });
    const same = hex(mine) === hex(node);
    check(
      `N=${c.N} r=${c.r} p=${c.p} pw="${c.pw}"`,
      same,
      same ? "" : `\n     client=${hex(mine).slice(0, 32)}\n     server=${hex(node).slice(0, 32)}`
    );
  }

  console.log("\n=== PoW全体(先頭ゼロビット判定まで含めた一致) ===");
  const chal = "deadbeefdeadbeefdeadbeefdeadbeef";
  const saltHex = "112233445566778899aabbccddeeff00";
  const N = 1024, r = 8, p = 1, bits = 2;
  // クライアントと同じ手順で解く
  let found = null;
  for (let nonce = 0; nonce < 200; nonce++) {
    const dk = await w.scrypt(new TextEncoder().encode(chal + ":" + nonce), new Uint8Array(Buffer.from(saltHex, "hex")), N, r, p, 32);
    let z = 0;
    for (const b of dk) { if (b === 0) { z += 8; continue; } let x = b, n = 0; while ((x & 0x80) === 0) { n++; x = (x << 1) & 0xff; } z += n; break; }
    if (z >= bits) { found = nonce; break; }
  }
  check(`クライアントが${bits}bitの解を見つけられる`, found !== null, "");
  if (found !== null) {
    // サーバーの検証ロジックで受理されるか
    const dk = scryptSync(chal + ":" + found, Buffer.from(saltHex, "hex"), 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
    let z = 0;
    for (const b of dk) { if (b === 0) { z += 8; continue; } let x = b, n = 0; while ((x & 0x80) === 0) { n++; x = (x << 1) & 0xff; } z += n; break; }
    check(`サーバーの検証ロジックが受理する(nonce=${found}, ${z}bit)`, z >= bits, `zeros=${z}`);
  }

  console.log(`\n=== 合計: ${pass} PASS / ${fail} FAIL ===`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
