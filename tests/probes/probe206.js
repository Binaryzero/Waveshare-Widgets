'use strict';
const fs=require('fs'),path=require('path');
const REPO='/home/user/Waveshare-Widgets';
const SHELL=path.join(REPO,'src/Plinth/Shell');
const WIDGET=path.join(REPO,'widgets/notifications');
const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json'};
const {chromium}=require('/opt/node22/lib/node_modules/playwright');
const ITEMS=Array.from({length:24},(_,i)=>({id:'n'+i,app:'App '+(i%4),appId:'a'+(i%4),
  title:'Notification '+i,body:'Body long enough to make the list overflow nicely.',time:Date.now()-i*60000}));
// Shell WITH the real edge overlays (shell.css 135-154 + bindEdge from shell.js).
const SHELLPAGE='<!doctype html><meta charset=utf-8><style>'
 +'html,body{margin:0;height:100%;overflow:hidden;background:#000;touch-action:manipulation}'
 +'#pages{height:100%;display:flex;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scrollbar-width:none}'
 +'.page{flex:0 0 100vw;height:100%;scroll-snap-align:start}'
 +'iframe{border:0;width:100%;height:100%}'
 +'.edge{position:fixed;top:0;bottom:0;width:36px;z-index:5;touch-action:none}'
 +'.edge.left{left:0}.edge.right{right:0}'
 +'</style><div id=pages><div class=page id=p0></div><div class=page id=p1></div></div>'
 +'<div id=edgeLeft class="edge left"></div><div id=edgeRight class="edge right"></div>'
 +'<script>(function(){var pages=document.getElementById("pages");'
 +'function cur(){return Math.round(pages.scrollLeft/Math.max(1,pages.clientWidth));}'
 +'function go(n){pages.scrollTo({left:Math.max(0,n)*pages.clientWidth,behavior:"instant"});}'
 +'function bind(el,d){var sx=null;el.addEventListener("pointerdown",function(e){sx=e.clientX;el.setPointerCapture(e.pointerId);});'
 +'el.addEventListener("pointerup",function(e){if(sx===null)return;var dx=e.clientX-sx;sx=null;'
 +'if(Math.abs(dx)<12)go(cur()+d);else go(cur()+(dx<0?1:-1));});}'
 +'bind(document.getElementById("edgeLeft"),-1);bind(document.getElementById("edgeRight"),1);})();<\/script>';
const ROOTSCROLL='<!doctype html><meta charset=utf-8>'
 +'<link rel=stylesheet href="https://app.plinth/widget-base.css">'
 +'<style>html,body{overflow:auto !important}.tall{height:2000px}</style><div class=tall>root scroller</div>';
(async()=>{
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
 const ctx=await b.newContext({viewport:{width:640,height:400},hasTouch:true});
 const p=await ctx.newPage();
 const serve=(r,dir,rel)=>{const root=path.resolve(dir),f=path.resolve(root,rel);
   if((f===root||f.startsWith(root+path.sep))&&fs.existsSync(f)&&fs.statSync(f).isFile())
     return r.fulfill({contentType:MIME[path.extname(f)]||'text/plain',body:fs.readFileSync(f)});
   return r.fulfill({status:404,body:''});};
 await p.route('https://app.plinth/**',r=>serve(r,SHELL,decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/,'')));
 await p.route('https://widget.test/**',r=>serve(r,WIDGET,decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/,'')||'index.html'));
 await p.route('https://shell.test/**',r=>r.fulfill({contentType:'text/html',body:SHELLPAGE}));
 await p.route('https://rootscroll.test/**',r=>r.fulfill({contentType:'text/html',body:ROOTSCROLL}));
 await p.route(/https?:\/\/(?!(?:app\.plinth|widget\.test|shell\.test|rootscroll\.test)(?:[/?#]|$)).*/,r=>r.abort());
 const shim=fs.readFileSync(path.join(SHELL,'widget-api.js'),'utf8')+'\n'+fs.readFileSync(path.join(SHELL,'icue-compat.js'),'utf8');
 await p.addInitScript(shim);
 await p.addInitScript(({items})=>{if(window.top!==window)return;let fr=null;
  window.__mount=()=>{fr=document.createElement('iframe');fr.setAttribute('sandbox','allow-scripts allow-same-origin');
   fr.src='https://widget.test/index.html#ww-slot=p0s0';document.getElementById('p0').appendChild(fr);};
  window.addEventListener('message',ev=>{if(!fr||ev.source!==fr.contentWindow)return;const m=ev.data||{};
   if(m.type==='ww-ready'){fr.contentWindow.postMessage({type:'ww-init',settings:{bgStyle:'solid',maxItems:24},
     sensors:[],media:null,theme:{},game:{active:false,process:''},status:{elevated:false,apiVersion:1}},'https://widget.test');
    fr.contentWindow.postMessage({type:'ww-notifications',data:{items,supported:true}},'https://widget.test');}});},{items:ITEMS});
 await p.goto('https://shell.test/h.html');
 await p.evaluate(()=>window.__mount());
 const fe=await p.waitForSelector('#p0 iframe');const fr=await fe.contentFrame();
 await p.waitForTimeout(1500);
 const cdp=await ctx.newCDPSession(p);
 const drag=async(x,y,dx,dy,steps=10)=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  for(let i=1;i<=steps;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/steps,y:y+dy*i/steps,id:1}]});await p.waitForTimeout(16);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(500);};
 const tap=async(x,y)=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  await p.waitForTimeout(40);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(500);};
 const left=()=>p.evaluate(()=>document.getElementById('pages').scrollLeft);

 // M3: does the eye overlap the edge overlay, and does tapping it page?
 const eye=await fr.locator('#eyeBtn').boundingBox();
 const vw=640;
 console.log('M3 eye box x='+eye.x.toFixed(0)+' w='+eye.width.toFixed(0)
   +' -> right edge gap='+(vw-(eye.x+eye.width)).toFixed(0)+'px; edge zone = rightmost 36px ('+(vw-36)+'..'+vw+')');
 console.log('M3 overlap with edge zone: '+(eye.x+eye.width>vw-36?'YES':'no'));
 await p.evaluate(()=>{document.getElementById('pages').scrollLeft=0;});await p.waitForTimeout(200);
 await tap(eye.x+eye.width-4, eye.y+eye.height/2);   // right-hand sliver of the eye
 console.log('M3 tap on the eye\'s right sliver -> pages scrollLeft = '+await left());

 // M1: HORIZONTAL drag starting on a control inside the vertical list
 await p.evaluate(()=>{document.getElementById('pages').scrollLeft=0;});await p.waitForTimeout(200);
 const row=await fr.locator('.app-head').first().boundingBox();
 await drag(row.x+row.width*0.4,row.y+row.height/2,-160,0);
 console.log('M1 horizontal drag from a control INSIDE #list -> pages scrollLeft = '+await left());

 // M2: third-party widget whose ROOT document scrolls
 const p2=await ctx.newPage();
 await p2.route('https://app.plinth/**',r=>serve(r,SHELL,decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/+/,'')));
 await p2.route('https://rootscroll.test/**',r=>r.fulfill({contentType:'text/html',body:ROOTSCROLL}));
 await p2.goto('https://rootscroll.test/w.html');await p2.waitForTimeout(400);
 const cdp2=await ctx.newCDPSession(p2);
 await cdp2.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:320,y:300,id:1}]});
 for(let i=1;i<=10;i++){await cdp2.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:320,y:300-i*15,id:1}]});await p2.waitForTimeout(16);}
 await cdp2.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p2.waitForTimeout(500);
 console.log('M2 third-party ROOT-document scroller -> scrollTop = '+await p2.evaluate(()=>document.scrollingElement.scrollTop));
 await b.close();
})();
