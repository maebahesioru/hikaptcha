// 全形式を一括で監査する: 形式ごとにデバッグサーバーを立てて出題を作り、モンタージュを保存する
//  (FORCE_MODE で形式を固定。形式ごとに別ポートを使うので殺し合いにならない)
import { spawn, execFileSync } from "node:child_process";

const MODES = (process.argv[2] || "single,pick,not,notpick,or,and").split(",");
const CASES = Number(process.argv[3] || 3);
const DIR = "C:/Users/maeba/AppData/Local/Temp/vtest2";
const UA = { "user-agent": "Mozilla/5.0" };

// 前回の孤児サーバーがポートを掴んでいると「別の形式の出題」が返り、形式の取り違えが起きる。
// (実測で発生: FORCE_MODE=not のつもりが古い pick サーバーの応答だった)
// → 起動前にポートを掃除し、起動後に「実際に返る形式」を確認する。
const cleanPorts = () => {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split("\n")) {
      const m = line.match(/LISTENING\s+(\d+)\s*$/);
      if (!m) continue;
      if (/:(32[0-9][0-9])\s/.test(line)) pids.add(m[1]);
    }
    for (const pid of pids) {
      try { execFileSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { stdio: "ignore" }); } catch {}
    }
  } catch {}
};

const kids = [];
const up = async (port, mode) => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/api/health`, { headers: UA });
      if (r.ok) {
        // 実際に返る形式が期待どおりかを確認する(取り違え防止)
        const c = await (await fetch(`http://localhost:${port}/api/challenge`, { headers: UA })).json();
        if (c && c.mode === mode) return true;
      }
    } catch {}
    await new Promise((s) => setTimeout(s, 500));
  }
  return false;
};

cleanPorts();
await new Promise((s) => setTimeout(s, 800));

for (let i = 0; i < MODES.length; i++) {
  const port = 3200 + i;
  const mode = MODES[i].trim();
  const p = spawn("node", ["server.mjs"], {
    cwd: DIR,
    env: { ...process.env, PORT: String(port), FORCE_MODE: mode, IP_QUOTA: "100000" },
    stdio: "ignore",
  });
  kids.push({ p, port, mode });
}

try {
  for (const k of kids) {
    const ok = await up(k.port, k.mode);
    if (!ok) { console.log(`[${k.mode}] サーバー起動失敗(port ${k.port}・形式不一致か起動不可)`); continue; }
    console.log(`\n===== ${k.mode} (port ${k.port}) =====`);
    try {
      execFileSync("node", ["tools/audit_and_montage.mjs", `http://localhost:${k.port}`, String(CASES), k.mode, k.mode], {
        cwd: "C:/Users/maeba/Desktop/hikamani-captcha",
        stdio: "inherit",
      });
    } catch (e) {
      console.log(`[${k.mode}] 監査失敗: ${e.message}`);
    }
  }
} finally {
  for (const k of kids) {
    try { k.p.kill(); } catch {}
  }
}
console.log("\n完了");
