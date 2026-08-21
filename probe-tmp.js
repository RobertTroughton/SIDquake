const http=require('http'),fs=require('fs'),path=require('path');
const R='/home/user/SIDquake/public';
const T={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm'};
const s=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);
 if(u==='/hvsc-token'){r.writeHead(200,{'Content-Type':'application/json'});return r.end('{"token":"","exp":0}');}
 const f=u==='/'?'index.html':u;
 fs.readFile(path.join(R,f),(e,b)=>{if(e){r.writeHead(404);return r.end();}
  r.writeHead(200,{'Content-Type':T[path.extname(f)]||'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});r.end(b);});});
s.listen(0,async()=>{
 const {chromium}=require('playwright');
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
 const p=await b.newPage({viewport:{width:1400,height:900}});
 await p.goto(`http://127.0.0.1:${s.address().port}/`,{waitUntil:'load'});
 await p.waitForFunction(()=>!!window.uiController,null,{timeout:20000});
 const out=await p.evaluate(()=>{
   const ids=['studioModal','modalOverlay','busyOverlay','hvscModal','galleryModal'];
   const z={};
   for(const id of ids){const el=document.getElementById(id); z[id]=el?getComputedStyle(el).zIndex:'absent';}
   return z;
 });
 console.log(JSON.stringify(out,null,1));
 await b.close(); s.close(); process.exit(0);
});
