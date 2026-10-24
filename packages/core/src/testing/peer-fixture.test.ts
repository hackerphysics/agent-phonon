import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { PeerFixture, withPeerFixture } from "./peer-fixture.js";

test("peer fixtures record ownership before work and clean setup/assertion failures without masking them",async()=>{
  const failure=new Error("original fixture failure");let fixture:PeerFixture|undefined;
  await assert.rejects(withPeerFixture("fixture-original-failure",async scope=>{
    fixture=scope;const marker=JSON.parse(readFileSync(join(scope.root,".peer-fixture.json"),"utf8"));
    assert.equal(marker.pid,process.pid);assert.equal(marker.workflow,"fixture-original-failure");
    writeFileSync(join(scope.root,"disposable.sqlite"),"synthetic data");
    scope.defer(()=>{throw new Error("secondary cleanup failure");});throw failure;
  }),error=>error===failure);
  assert.equal(existsSync(fixture!.root),false);assert.equal(existsSync(fixture!.cleanupFailurePath()),true);
  fixture!.clearOwnedCleanupFailure();assert.equal(existsSync(fixture!.cleanupFailurePath()),false);
});

test("peer fixture cleanup is ordered, idempotent and does not erase a changed ownership marker",()=>withPeerFixture("fixture-order",async outer=>{
  const scope=new PeerFixture("ordered",join(outer.root,"nested")),calls:number[]=[];
  scope.defer(()=>calls.push(1));scope.defer(()=>calls.push(2));
  await scope.dispose();await scope.dispose();assert.deepEqual(calls,[2,1]);assert.equal(existsSync(scope.root),false);
  const altered=new PeerFixture("altered",join(outer.root,"nested")),path=join(altered.root,".peer-fixture.json"),original=readFileSync(path,"utf8");
  writeFileSync(path,JSON.stringify({...JSON.parse(original),nonce:"foreign"}));
  await assert.rejects(altered.dispose(),/cleanup failed/);assert.equal(existsSync(altered.root),true);
  writeFileSync(path,original);await altered.dispose();assert.equal(existsSync(altered.root),false);
}));

test("peer fixtures reuse a leased real dependency view without copying its tree or deleting its target",()=>withPeerFixture("fixture-cache",async outer=>{
  const source=join(outer.root,"prepared"),packagePath=join(source,"node_modules","@opencode-ai","plugin");mkdirSync(packagePath,{recursive:true});
  writeFileSync(join(packagePath,"package.json"),JSON.stringify({name:"@opencode-ai/plugin",version:"1.14.20"}));
  writeFileSync(join(packagePath,"index.js"),"mock unit dependency; not installed-harness evidence");
  writeFileSync(join(source,"package.json"),JSON.stringify({dependencies:{"@opencode-ai/plugin":"1.14.20"}}));
  writeFileSync(join(source,"package-lock.json"),JSON.stringify({packages:{"":{dependencies:{"@opencode-ai/plugin":"1.14.20"}}}}));
  const base=join(outer.root,"scopes"),first=new PeerFixture("cache-first",base),second=new PeerFixture("cache-second",base);
  try{
    const target=join(first.root,"config");first.mountOpenCodeDependencies(source,"1.14.20",target);
    assert.equal(realpathSync(join(target,"node_modules")),realpathSync(join(source,"node_modules")));
    assert.throws(()=>second.mountOpenCodeDependencies(source,"1.14.20",join(second.root,"config")));
    await first.dispose();assert.equal(existsSync(join(packagePath,"index.js")),true);
    second.mountOpenCodeDependencies(source,"1.14.20",join(second.root,"config"));await second.dispose();
    assert.equal(existsSync(join(packagePath,"index.js")),true);
  }finally{await first.dispose();await second.dispose();}
}));

test("peer fixtures retain live owned processes, then allow verified cleanup of that same resource",()=>withPeerFixture("fixture-live",async outer=>{
  const scope=new PeerFixture("live-child",join(outer.root,"scopes"));
  const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:process.platform!=="win32"});
  const closed=once(child,"close");scope.watch(child,process.platform!=="win32");
  try{
    await assert.rejects(scope.dispose(),/cleanup failed/);assert.equal(existsSync(scope.root),true);
  }finally{
    if(process.platform!=="win32"&&child.pid)process.kill(-child.pid,"SIGTERM");else child.kill("SIGTERM");
    await closed;await scope.dispose();
  }
  assert.equal(existsSync(scope.root),false);assert.equal(existsSync(scope.cleanupFailurePath()),false);
}));

test("catchable test interruption runs only owned cleanup and preserves a nonzero signal exit",()=>withPeerFixture("fixture-signal",async outer=>{
  const loaderArgs:string[]=[];for(let i=0;i<process.execArgv.length;i++)if(process.execArgv[i]==="--import")loaderArgs.push(process.execArgv[i]!,process.execArgv[++i]!);
  const moduleURL=new URL(import.meta.url.endsWith(".ts")?"./peer-fixture.ts":"./peer-fixture.js",import.meta.url).href;
  const marker=join(outer.root,"cleanup-ran"),script=`import{PeerFixture}from${JSON.stringify(moduleURL)};import{writeFileSync}from'node:fs';const scope=new PeerFixture('interrupted',${JSON.stringify(join(outer.root,"child-scopes"))});scope.defer(()=>writeFileSync(${JSON.stringify(marker)},'done'));console.log(scope.root);setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,[...loaderArgs,"--input-type=module","-e",script],{stdio:["ignore","pipe","pipe"]});
  const closed=once(child,"close");outer.watch(child);outer.defer(async()=>{child.kill("SIGTERM");await closed;});
  let stderr="";child.stderr.on("data",chunk=>{stderr+=String(chunk);});
  const root=await new Promise<string>((resolve,reject)=>{let output="";child.stdout.on("data",chunk=>{output+=String(chunk);if(output.includes("\n"))resolve(output.trim());});child.once("error",reject);child.once("close",()=>{if(!output)reject(new Error(stderr||"interrupted fixture did not start"));});});
  assert.ok(existsSync(root));child.kill("SIGTERM");const [code]=await closed;
  assert.equal(code,143,stderr);assert.equal(readFileSync(marker,"utf8"),"done");assert.equal(existsSync(root),false);
}));
