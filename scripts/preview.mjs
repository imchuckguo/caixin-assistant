// Development-only UI fixture. No real browser storage or team service access.
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
const root = resolve("extension");
let port;
const sample = {
  settings: { qqCopy: true, hideAds: true, autoTabs: true, watchMinutes: 120 },
  inquiryLog: [
    {
      v: 2,
      id: "synthetic-1",
      time: Date.now(),
      company: "合成样本供应商 A",
      qq: "800000001",
      qqType: "enterprise",
      pn: "SYNTHETIC-100",
      brand: "示例厂牌",
      batch: "26+",
      qty: "500",
      price: "1.28",
      tax: "未税",
      goods: "原装",
      lead: "现货",
      valid: true,
      validAt: Date.now(),
      note: "仅用于界面测试",
    },
    {
      v: 2,
      id: "synthetic-2",
      time: Date.now(),
      company: "合成样本供应商 B",
      qq: "800000002",
      qqType: "enterprise",
      pn: "SYNTHETIC-100",
      brand: "示例厂牌",
      batch: "26+",
      qty: "500",
      price: "1.35",
      tax: "含税",
      goods: "原装",
      lead: "3 天",
      valid: false,
      validAt: 0,
      note: "",
    },
  ],
  watches: [],
  watchEvents: [],
};
function fixture() {
  return `globalThis.__CAIXIN_PREVIEW=true;const fixtureSeed=${JSON.stringify(sample)};let fixtureDb=structuredClone(fixtureSeed);const fixtureListeners=[];globalThis.chrome={runtime:{id:'preview',getManifest:()=>({version:'0.1.0',name:'采芯助手'}),getURL:p=>location.origin+'/'+p,sendMessage:async m=>m.type==='ping'?{build:'0.1.0',version:'0.1.0'}:m.type==='teamState'?{connected:false}:m.type==='teamSync'?{ok:true,offline:true}:m.type==='updateRecord'?(fixtureDb.inquiryLog=fixtureDb.inquiryLog.map(r=>r.id===m.id?{...r,...m.patch}:r),{ok:true}):m.type==='clearRecords'?(fixtureDb.inquiryLog=[],{ok:true}):{ok:true},onMessage:{addListener(){}}},storage:{local:{get:async k=>Object.fromEntries((Array.isArray(k)?k:[k]).filter(x=>x in fixtureDb).map(x=>[x,structuredClone(fixtureDb[x])])),set:async o=>{Object.assign(fixtureDb,o);for(const f of fixtureListeners)f(Object.fromEntries(Object.entries(o).map(([k,v])=>[k,{newValue:v}])),'local');},remove:async()=>{}},onChanged:{addListener:f=>fixtureListeners.push(f)}},alarms:{get:async()=>null},tabs:{create:async({url})=>window.open(url,'_blank')},permissions:{request:async()=>false}};document.addEventListener('DOMContentLoaded',()=>{const p=document.createElement('div');p.textContent='本地界面预览 · 合成数据 · 非已安装扩展';p.style.cssText='padding:4px 12px;color:#657570;font:12px sans-serif;background:#edf6f2';document.body.prepend(p);});`;
}
const server = createServer((req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/__preview.js") {
      res.setHeader("Content-Type", "application/javascript");
      return res.end(fixture());
    }
    if (u.pathname === "/isolation.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>报价来源隔离测试</title><style>body{font:16px sans-serif;padding:24px}iframe{width:100%;height:450px;border:1px solid #ddd}</style><h1>报价来源隔离测试</h1><p id="result">等待加载</p><iframe id="frame" src="http://localhost:${port}/records.html?embed=1"></iframe><script>const frame=document.getElementById('frame');frame.onload=()=>{let blocked=false;try{blocked=!frame.contentDocument;void frame.contentWindow.document.body.innerText;}catch{blocked=true;}document.getElementById('result').textContent=blocked?'PASS：宿主页面不能读取另一来源 iframe 的合成报价':'FAIL：宿主页面读取到了报价';};<\/script></html>`,
      );
    }
    const file = resolve(
      root,
      "." + decodeURIComponent(u.pathname === "/" ? "/popup.html" : u.pathname),
    );
    if (!file.startsWith(root + "/") || !statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    const type =
      {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript",
        ".css": "text/css",
        ".png": "image/png",
      }[extname(file)] || "text/plain";
    res.setHeader("Content-Type", type);
    let data = readFileSync(file);
    if (extname(file) === ".html")
      data = data
        .toString()
        .replace("<head>", '<head><script src="/__preview.js"></script>')
        .replace("<head><meta", "<head><meta");
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  console.log("UI preview: http://127.0.0.1:" + port + "/popup.html");
  console.log("Isolation: http://127.0.0.1:" + port + "/isolation.html");
});
