// #84 repro: does every free region on a page offer an add affordance?
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), http = require('http');
const REPO = '/home/user/Waveshare-Widgets';
const SHELL = path.join(REPO, 'src/Plinth/Shell');
const PORT = 8962;
function srvr(root, port) {
  const t = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json' };
  const s = http.createServer((q, r) => {
    const p = decodeURIComponent(new URL(q.url,'http://x').pathname);
    const f = path.join(root, path.normalize(p).replace(/^([/\\.])+/,''));
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, {'Content-Type': t[path.extname(f)]||'application/octet-stream'});
    r.end(fs.readFileSync(f));
  });
  return new Promise(res => s.listen(port,'127.0.0.1',()=>res(s)));
}
const man = (slug) => JSON.parse(fs.readFileSync(path.join(REPO,'widgets',slug,'manifest.json'),'utf8'));
const entry = (slug) => { const m = man(slug); return { id:m.id, name:m.name, url:`https://${slug}.widgets.plinth/index.html`, supportedSlots:m.supported_slots, properties:m.properties||[] }; };
(async () => {
  const srv = await srvr(REPO, PORT);
  const b = await chromium.launch(process.env.CHROMIUM ? {executablePath:process.env.CHROMIUM}:{});
  const page = await b.newPage({ viewport:{width:1280,height:400} });
  const serve = (route, dir, name) => {
    const f = path.join(dir,name);
    if (!fs.existsSync(f)||!fs.statSync(f).isFile()) return route.fulfill({status:404,body:''});
    const ty = name.endsWith('.css')?'text/css':name.endsWith('.js')?'application/javascript':'text/html';
    route.fulfill({status:200,contentType:ty,body:fs.readFileSync(f)});
  };
  const rel = u => new URL(u).pathname.replace(/^\/+/,'');
  await page.route('https://app.plinth/**', r => serve(r, SHELL, rel(r.request().url())));
  await page.route('https://*.widgets.plinth/**', r => { const u=new URL(r.request().url());
    serve(r, path.join(REPO,'widgets',u.hostname.replace(/\.widgets\.plinth$/,'')), rel(r.request().url())); });
  const clock = entry('clock');
  // ONE page, two DISTINCT holes: cols0-1 upper filled, col3 lower filled.
  // Free: cols 0-1 lower (2x1) and cols 2-3 upper (2x1) and col2 lower (1x1).
  const layout = { pages: [{ name:'Holes', slots:[
    { widgetId: clock.id, size:'half-upper',  instanceId:'a' },
    { widgetId: clock.id, size:'quarter-lower', instanceId:'b' },
  ]}]};
  await page.addInitScript(() => {
    const L=new Set();
    window.chrome={webview:{addEventListener:(t,c)=>{if(t==='message')L.add(c);},postMessage:m=>window.__rec(JSON.stringify(m))}};
    window.__push=(j)=>{const data=JSON.parse(j);L.forEach(c=>{try{c({data});}catch(e){}});};
  });
  await page.exposeFunction('__rec', async (j) => {
    const m = JSON.parse(j);
    if (m.type === 'ready') page.evaluate(d=>window.__push(d), JSON.stringify({type:'init',data:{
      layout, widgets:[clock], sensors:[], status:{elevated:false,version:'probe'} }})).catch(()=>{});
  });
  await page.goto(`http://127.0.0.1:${PORT}/src/Plinth/Shell/index.html`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('editBtn') && document.getElementById('editBtn').click());
  await page.waitForTimeout(800);
  console.log(JSON.stringify(await page.evaluate(() => {
    const pg = document.querySelector('.page');
    const zones = [...document.querySelectorAll('.add-zone')].map(z => {
      const cs = getComputedStyle(z); const r = z.getBoundingClientRect();
      return { col: cs.gridColumn, row: cs.gridRow, shown: cs.display!=='none', w: Math.round(r.width), h: Math.round(r.height) };
    });
    const slots = [...document.querySelectorAll('.slot')].map(s => {
      const cs = getComputedStyle(s); return { col: cs.gridColumn, row: cs.gridRow };
    });
    return { pages: document.querySelectorAll('.page').length, zones, slots };
  }), null, 1));
  // Click the SMALL zone (row 2, col 2) and add — it must land THERE.
  const before = await page.evaluate(() => document.querySelectorAll('.slot').length);
  await page.evaluate(() => {
    const zs = [...document.querySelectorAll('.add-zone')];
    const small = zs.find(z => getComputedStyle(z).gridColumn.startsWith('2 /'));
    if (small) small.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const b = document.querySelector('#palette button:not([disabled])'); if (b) b.click(); });
  await page.waitForTimeout(900);
  console.log('  [after-add]', JSON.stringify(await page.evaluate((n) => ({
    slotsBefore: n,
    slots: [...document.querySelectorAll('.slot')].map(s => {
      const cs = getComputedStyle(s); return { col: cs.gridColumn, row: cs.gridRow };
    }),
    zones: [...document.querySelectorAll('.add-zone')].map(z => {
      const cs = getComputedStyle(z); return { col: cs.gridColumn, row: cs.gridRow, label: z.textContent };
    }),
  }), before)));
  await page.screenshot({ path: process.env.SCR + '/addzone2.png' });
  await b.close(); srv.close();
})();
