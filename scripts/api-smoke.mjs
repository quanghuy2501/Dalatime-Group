import { spawn } from 'child_process';
const env = { ...process.env };
const server = spawn(process.execPath, ['src/server.mjs'], { env, stdio: ['ignore','pipe','pipe'] });
let ready = false;
server.stdout.on('data', d => { if (String(d).includes('listening')) ready = true; });
server.stderr.on('data', d => process.stderr.write(d));
for (let i=0;i<50 && !ready;i++) await new Promise(r=>setTimeout(r,100));
if (!ready) throw new Error('API server not ready');
const endpoints=['/api/status','/api/overview','/api/brands?limit=3','/api/staff?limit=3','/api/channels?limit=3','/api/posts?limit=3','/api/health?limit=3','/api/dashboard'];
const out={};
for(const ep of endpoints){ const r=await fetch('http://localhost:4177'+ep); out[ep]={status:r.status, body:await r.json()}; if(!r.ok) throw new Error(ep+' failed'); }
server.kill('SIGTERM');
console.log(JSON.stringify({ok:true, endpoints:Object.fromEntries(Object.entries(out).map(([k,v])=>[k,v.status])), overview:out['/api/overview'].body},null,2));
