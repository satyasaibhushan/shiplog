import {spawn} from "node:child_process";
import {createServer} from "node:net";
import assert from "node:assert/strict";
const portServer=createServer();await new Promise(resolve=>portServer.listen(0,"127.0.0.1",resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
const origin=`http://127.0.0.1:${port}`;
const child=spawn("node",["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{env:{...process.env,NEXT_TELEMETRY_DISABLED:"1",AUTH_SECRET:"synthetic-production-smoke-test-only-secret",AUTH_URL:origin,AUTH_TRUST_HOST:"true",APP_URL:origin,OWNER_EMAIL:"alex@example.test",SHIPLOG_DATABASE_URL:"",AUTH_GOOGLE_ID:"",AUTH_GOOGLE_SECRET:""},stdio:"pipe"});
let log="";child.stdout.on("data",b=>{log+=b;});child.stderr.on("data",b=>{log+=b;});
try{
 let ready=false;
 for(let i=0;i<100;i++){try{const r=await fetch(origin);if(r.status===200){assert.match(await r.text(),/Sign in with Google/);ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(ready,true,`Production server failed: ${log}`);
 for(const method of ["GET","POST"]){const response=await fetch(origin+"/api/reports",{method,headers:{origin,"content-type":"application/json"},...(method==="POST"?{body:"{}"}:{})});assert.equal(response.status,401);assert.match(response.headers.get("cache-control"),/no-store/);}
 console.log("PASS: actual production Next server sign-in page; unauthenticated report GET/POST denied with private no-store. No database/OAuth credentials or production access.");
}finally{child.kill("SIGTERM");}
