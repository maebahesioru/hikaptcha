// バッチ取得: 取得枚数ごとの「フィルタ通過枚数」と「所要時間」を実測する
const BASE = "https://hikabooru.hikamers.app";
const UA = { "user-agent": "Mozilla/5.0" };
const LIMITS = (process.argv[2] || "30,60,90,100").split(",").map(Number);
const N = Number(process.argv[3] || 5);
const SCREENSHOT_TAGS = new Set(["日本語のテキスト","対話箱","文字の壁","プロフィール","凍結済みアカウント","スクリーンショット","偽のスクリーンショット","スクショ","スクリーンキャプチャ","ツイート","twitter","x","タイムライン","リツイート","トレンド","通知"]);
const MAX_TAGS = 26;
const goodAspect = (p) => { const w=Number(p.canvasWidth)||0,h=Number(p.canvasHeight)||0; if(!w||!h) return false; const r=w/h; return r>=1.0&&r<=2.2; };
for (const limit of LIMITS) {
  const pass = [], ms = [];
  for (let i=0;i<N;i++){
    const offset = Math.floor(Math.random()*29500);
    const q = encodeURIComponent("safety:safe type:image");
    const t0 = Date.now();
    const r = await fetch(`${BASE}/api/posts?query=${q}&limit=${limit}&offset=${offset}&fields=id,canvasWidth,canvasHeight,thumbnailUrl,tags`, { headers: UA });
    const d = await r.json();
    ms.push(Date.now()-t0);
    const res = d?.results || [];
    const l0 = res.filter((p)=>goodAspect(p) && !(p.tags||[]).map(x=>((x.names&&x.names[0])||"").toLowerCase()).some(n=>SCREENSHOT_TAGS.has(n)) && (p.tags||[]).length<=MAX_TAGS);
    pass.push(l0.length);
  }
  pass.sort((a,b)=>a-b); ms.sort((a,b)=>a-b);
  const shortRate = pass.filter(v=>v<9).length / pass.length;
  console.log(`limit=${limit}: 段階0通過 中央値${pass[Math.floor(pass.length/2)]}枚(最小${pass[0]}/最大${pass[pass.length-1]}) 9枚未満の割合 ${(shortRate*100).toFixed(0)}% / 取得 ${ms[Math.floor(ms.length/2)]}ms`);
}
