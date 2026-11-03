// Manual acceptance relay: passes the native callback's exact request to the
// current conversation tool operator. It never invents or defaults a decision.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const expected=process.argv[2];assert(['allow','deny'].includes(expected));
const root=resolve(`../approval-human-${expected}`);await mkdir(root,{mode:0o700});
const token=randomBytes(32).toString('base64url');
async function waitFile(name){const end=Date.now()+290000;while(Date.now()<end){try{return JSON.parse(await readFile(join(root,name),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,200));}throw Error('No human receipt');}
const server=createServer(async(req,res)=>{
 try{
  assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Bearer '+token);
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
  if(req.url==='/interaction'){
   await writeFile(join(root,'request.json'),JSON.stringify(body,null,2),{flag:'wx',mode:0o600});
   const reply=await waitFile('response.json');assert.equal(reply.requestId,body.requestId);
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(reply));
  }else if(req.url==='/applied'){
   await writeFile(join(root,'receipt-request.json'),JSON.stringify(body,null,2),{flag:'wx',mode:0o600});
   const proof=await waitFile('receipt-result.json');assert.equal(proof.applied,true);
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(proof));
  }else{res.writeHead(404).end('{}');}
 }catch{res.writeHead(409,{'content-type':'application/json'}).end('{"error":"verification_unavailable"}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const child=spawn(process.execPath,['scripts/hermes-command-approval-live.mjs',expected],{stdio:'inherit',env:{...process.env,AGENT_PHONON_MCP_URL:`http://127.0.0.1:${port}/mcp`,AGENT_PHONON_INTERACTION_URL:`http://127.0.0.1:${port}/interaction`,AGENT_PHONON_INTERACTION_RECEIPT_URL:`http://127.0.0.1:${port}/applied`,AGENT_PHONON_INTERACTION_TOKEN:token}});
process.on('SIGTERM',()=>child.kill('SIGTERM'));
const code=await new Promise(r=>child.once('exit',r));server.closeAllConnections();server.close();process.exitCode=code??1;
