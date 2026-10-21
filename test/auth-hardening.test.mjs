import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCookie, authMiddleware } from '../src/auth.mjs';
import { createApp } from '../src/server.mjs';

test('signed session carries the authenticated operator identity into audit context',()=>{
  const previous={NODE_ENV:process.env.NODE_ENV,AUTH_SESSION_SECRET:process.env.AUTH_SESSION_SECRET};
  Object.assign(process.env,{NODE_ENV:'production',AUTH_SESSION_SECRET:'test-session-secret'});
  try{
    const cookie=createSessionCookie(60000,'quang-huy').split(';')[0];
    const req={path:'/api/admin/catalog/clients',headers:{cookie}};
    let passed=false;
    authMiddleware(req,{},()=>{passed=true;});
    assert.equal(passed,true);
    assert.deepEqual(req.auth,{user:'quang-huy',mechanism:'session'});
  }finally{
    for(const [key,value] of Object.entries(previous))value===undefined?delete process.env[key]:process.env[key]=value;
  }
});

test('login rate limiter blocks repeated credential guessing and security headers are present',async t=>{
  const keys=['NODE_ENV','AUTH_SESSION_SECRET','DASHBOARD_BASIC_USER','DASHBOARD_BASIC_PASS','LOGIN_RATE_MAX_FAILURES','LOGIN_RATE_WINDOW_MS'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{NODE_ENV:'production',AUTH_SESSION_SECRET:'test-session-secret',DASHBOARD_BASIC_USER:'admin',DASHBOARD_BASIC_PASS:'correct',LOGIN_RATE_MAX_FAILURES:'2',LOGIN_RATE_WINDOW_MS:'60000'});
  const app=createApp({reportCustomers:[],jobWorker:{kick(){}}});
  const server=app.listen(0);
  t.after(()=>{server.close();for(const [key,value] of Object.entries(previous))value===undefined?delete process.env[key]:process.env[key]=value;});
  await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/auth/login`;
  const attempt=()=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'wrong'})});
  const first=await attempt(),second=await attempt(),third=await attempt();
  assert.equal(first.status,401);assert.equal(second.status,401);assert.equal(third.status,429);
  assert.equal(first.headers.get('x-content-type-options'),'nosniff');
  assert.equal(first.headers.get('x-frame-options'),'DENY');
  assert.match(first.headers.get('strict-transport-security')||'',/max-age=/);
});

