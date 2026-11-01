import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Console} from 'node:console';
import {Writable} from 'node:stream';

const allowedEnvironment=new Set(['PATH','COPILOT_CACHE_HOME','COPILOT_MODEL','COPILOT_PROVIDER_BASE_URL','COPILOT_PROVIDER_TYPE',
 'COPILOT_PROVIDER_API_KEY','COPILOT_PROVIDER_WIRE_API','COPILOT_PROVIDER_WIRE_MODEL','COPILOT_PROVIDER_MAX_PROMPT_TOKENS',
 'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS','OPENCODE_CONFIG_DIR','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH']);

export function applyWindowsRuntimeEnvironment(launcher,environment=process.env){
 assert(launcher&&launcher.version===1);
 assert(launcher.hermesHome===undefined||launcher.hermesHome===null||typeof launcher.hermesHome==='string');
 const selected=Object.entries(launcher.environment??{});
 for(const [key,value]of selected)assert(allowedEnvironment.has(key)&&typeof value==='string'&&!value.includes('\0'),'Untrusted runtime environment');
 if(launcher.hermesHome)environment.HERMES_HOME=launcher.hermesHome;
 for(const [key,value]of selected)environment[key]=value;
 Object.assign(environment,{HERMES_DISABLE_LAZY_INSTALLS:'1',PYTHONDONTWRITEBYTECODE:'1',PIP_NO_INDEX:'1',UV_OFFLINE:'1'});
}

export function rotatingWindowsLog(log,secure){
 if(!fs.existsSync(log))secure('create',log,{content:''});
 secure('inspect',log,{private:true});
 return new Writable({write(chunk,_encoding,done){
  try{
   if(fs.statSync(log).size+chunk.length>5*1024*1024){
    const previous=log+'.1';if(fs.existsSync(previous)){secure('inspect',previous,{private:true});fs.unlinkSync(previous);}
    fs.renameSync(log,previous);secure('create',log,{content:''});
   }
   fs.appendFileSync(log,chunk);done();
  }catch(error){done(error);}
 }});
}

async function start(){
 assert.equal(process.platform,'win32');assert.equal(process.argv[2],'start');
 const {PhononDaemon,loadConfig,windowsMcpFileOperation}=await import('./daemon.js');
 const runtime=dirname(fileURLToPath(import.meta.url)),data=join(homedir(),'.agent-phonon');
 const launcher=JSON.parse(windowsMcpFileOperation('read',join(data,'windows-runtime.json'),{private:true,limit:65536}));
 assert.equal(fs.realpathSync(launcher.runtime),fs.realpathSync(runtime));
 applyWindowsRuntimeEnvironment(launcher);
 const log=rotatingWindowsLog(join(data,'daemon.log'),windowsMcpFileOperation);
 globalThis.console=new Console({stdout:log,stderr:log});
 const configPath=join(data,'config.json'),config=loadConfig(configPath),daemon=new PhononDaemon(config,{configPath});
 let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;await daemon.stop();process.exit(0);};
 process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
 await daemon.start();console.log(JSON.stringify({type:'windows_account_daemon_started',pid:process.pid,deviceID:config.deviceId}));
 await new Promise(()=>{});
}

if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))){
 try{await start();}catch(error){console.error(JSON.stringify({type:'windows_account_daemon_failed',message:String(error.message).slice(0,300)}));process.exitCode=1;}
}
