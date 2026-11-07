import test from "node:test";
import assert from "node:assert/strict";
import {mkdirSync,writeFileSync,readFileSync,chmodSync,symlinkSync} from "node:fs";
import {join} from "node:path";
import {PhononStore} from "@agent-phonon/core";
import {runLocalDirectoryCommand} from "./local-directory-cli.js";
const {withPeerFixture}=await import(new URL("../../core/src/testing/peer-fixture.ts",import.meta.url).href);

for(const scenario of ["supported-cli","no-observation","unconfigured","unprotected-config","symlink-config","unprotected-state","missing-pin"]){
  test(`local owner directory CLI ${scenario}`,()=>withPeerFixture("directory-cli",async (scope:{root:string;defer:(callback:()=>unknown)=>void})=>{
    const state=join(scope.root,"state"),root=join(scope.root,"workspace"),path=join(scope.root,"sandbox");
    for(const dir of [state,root,path])mkdirSync(dir,{mode:0o700});
    const source={url:"wss://source.example.test/phonon",deviceKey:"synthetic",expectedTenantId:"alice"};
    const dbPath=join(state,"phonon.db"),configPath=join(state,"config.json");
    const config={deviceId:"synthetic",dbPath,workspaceRoot:root,adapters:[],servers:[scenario==="missing-pin"?{...source,expectedTenantId:undefined}:source]};
    writeFileSync(configPath,JSON.stringify(config),{mode:0o600});const before=readFileSync(configPath);
    const store=new PhononStore(dbPath);scope.defer(()=>store.close());
    if(scenario!=="no-observation")store.localDirectoryAdmissions().observe(source,"alice");
    let selectedConfig=configPath;
    if(scenario==="unprotected-config")chmodSync(configPath,0o644);
    if(scenario==="unprotected-state")chmodSync(state,0o755);
    if(scenario==="symlink-config"){selectedConfig=join(state,"alias.json");symlinkSync(configPath,selectedConfig);}
    const options=["--server",scenario==="unconfigured"?"wss://unknown.example.test":"0","--config",selectedConfig];
    if(scenario!=="supported-cli")assert.throws(()=>runLocalDirectoryCommand(["admit",path,...options]));
    else{
      const admitted=runLocalDirectoryCommand(["admit",path,...options]) as any;assert.equal(admitted.path,path);
      assert.equal((runLocalDirectoryCommand(["list",...options]) as any[]).length,1);
      runLocalDirectoryCommand(["admit",path,...options]);assert.equal((runLocalDirectoryCommand(["list",...options]) as any[]).length,1);
      runLocalDirectoryCommand(["revoke",path,...options]);assert.ok((runLocalDirectoryCommand(["list",...options]) as any[])[0].revokedAt);
    }
    assert.deepEqual(readFileSync(configPath),before);
  }));
}
