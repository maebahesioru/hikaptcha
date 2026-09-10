// 実時間でブラウザを操作して「レート制限の待機→自動再開」を検証する
//  (chrome-headless-shell を remote-debugging-port で起動し、CDPで実時間ウェイトしながらDOMを読む)
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const SHELL =
  process.env.LOCALAPPDATA +
  "/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";
const URL_ = process.argv[2] || "http://localhost:3106/_ratetest.html";
const PORT = Number(process.argv[3] || 9222);

const chrome = spawn(SHELL, [
  `--remote-debugging-port=${PORT}`,
  "--headless",
  "--disable-gpu",
  "--no-sandbox",
  "--no-first-run",
  "about:blank",
], { stdio: "ignore" });

const getJson = async (path) => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(300);
  }
  throw new Error("CDPに接続できない");
};

let ws;
try {
  const ver = await getJson("/json/version");
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  // 新しいタブでページを開く
  const target = await send("Target.createTarget", { url: "about:blank" });
  const targetId = target.result.targetId;
  const attach = await send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attach.result.sessionId;
  const sendS = (method, params) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, sessionId, method, params }));
  });

  await sendS("Page.enable", {});
  await sendS("Runtime.enable", {});
  await sendS("Page.navigate", { url: URL_ });

  const readOut = async () => {
    const r = await sendS("Runtime.evaluate", {
      expression: "document.getElementById('out') ? document.getElementById('out').textContent : '(no out)'",
      returnByValue: true,
    });
    return r.result && r.result.result ? r.result.result.value : "(?)";
  };

  let last = "";
  for (let i = 0; i < 20; i++) {
    await sleep(1500); // 実時間で待つ(virtual-timeと違いサーバー側の時計も進む)
    const out = await readOut();
    if (out !== last) console.log(`t=${((i + 1) * 1.5).toFixed(1)}s: ${out}`);
    last = out;
    if (out && (out.includes("出題") || out.includes("OK"))) break;
  }
  console.log("FINAL:", last);
} finally {
  try { ws && ws.close(); } catch {}
  try { chrome.kill(); } catch {}
}
