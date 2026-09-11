// 埋め込み検証用の模擬サイト(別オリジン)を配信する静的サーバー
//  :3200 = 埋め込み先のサイト / :3108 = CAPTCHA本体(デバッグコピー)
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3200);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  try {
    const body = readFileSync(path.join(HERE, file));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
});
server.listen(PORT, () => console.log(`mock embed site on http://localhost:${PORT}`));
