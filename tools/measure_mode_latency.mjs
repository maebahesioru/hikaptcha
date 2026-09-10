// 形式ごとの出題生成時間を実測する(遅い形式を特定する)
import { spawn, execFileSync } from "node:child_process";
const MODES = (process.argv[2] || "single,not,pick,notpick,or").split(",");
const N = Number(process.argv[3] || 6);
const DIR = "C:/Users/maeba/AppData/Local/Temp/vtest2";
const UA = { "user-agent": "Mozilla/5.0" };

const clean = () => {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split("\n")) {
      const m = line.match(/LISTENING\s+(\d+)\s*$/);
      if (m && /:(32[0-9][0-9])\s/.test(line)) pids.add(m[1]);
    }
    for (const pid of pids) { try { execFileSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { stdio: "ignore" }); } catch {} }
  } catch {}
};
clean();
await new Promise((s) => setTimeout(s, 800));

const kids = MODES.map((mode, i) => ({
  mode: mode.trim(),
  port: 3200 + i,
  p: spawn("node", ["server.mjs"], {
    cwd: DIR,
    env: { ...process.env, PORT: String(3200 + i), FORCE_MODE: mode.trim(), IP_QUOTA: "100000" },
    stdio: "ignore",
  }),
}));

for (const k of kids) {
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    try { ok = (await fetch(`http://localhost:${k.port}/api/health`, { headers: UA })).ok; } catch {}
    if (!ok) await new Promise((s) => setTimeout(s, 500));
  }
  if (!ok) { console.log(`[${k.mode}] 起動失敗`); continue; }
  const t = [];
  for (let i = 0; i < N; i++) {
    const s = Date.now();
    try { const r = await fetch(`http://localhost:${k.port}/api/challenge`, { headers: UA }); await r.json(); } catch {}
    t.push(Date.now() - s);
    await new Promise((s) => setTimeout(s, 200));
  }
  t.sort((a, b) => a - b);
  const st = (await (await fetch(`http://localhost:${k.port}/api/health`, { headers: UA })).json()).stats;
  console.log(
    `[${k.mode}] 中央値 ${t[Math.floor(t.length / 2)]}ms / 最大 ${t[t.length - 1]}ms | 却下(タグ${st.tagRejects}/視覚${st.visRejects}) 緩和${st.relaxedUsed}/${st.challenges}`
  );
  // 失敗理由の内訳(1試行=1バッチ取得。attempts が challenges より大きいほど空振りが多い)
  const reasons = Object.entries(st)
    .filter(([key, v]) => key.startsWith("f") && typeof v === "number" && v > 0)
    .map(([key, v]) => `${key.replace(/^f/, "")}:${v}`)
    .join(" ");
  console.log(`    試行 ${st.attempts}回 / 出題 ${st.challenges}件 → 空振り理由: ${reasons || "なし"}`);
}
for (const k of kids) { try { k.p.kill(); } catch {} }
