import {mkdir,writeFile,rm,lstat} from 'node:fs/promises';
import {isAbsolute,posix,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";

/** Bind prepared Node CLIs to their runtime without changing the operator's PATH. */
export async function prepareNativeRuntimeLaunchers(outputDirectory,targetRoot){
  if(!isAbsolute(outputDirectory)||!posix.isAbsolute(targetRoot)||/[\x00-\x1f\x7f]/.test(targetRoot)
    ||posix.normalize(targetRoot)!==targetRoot||targetRoot==='/')throw new Error('Explicit canonical artifact and target paths are required');
  const entries={openclaw:'node_modules/openclaw/openclaw.mjs',pi:'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'};
  await mkdir(outputDirectory,{mode:0o700});
  const identity=await lstat(outputDirectory);
  let complete=false;
  try{
    for(const [name,entry]of Object.entries(entries)){
      const source='#!/bin/sh\nexec '+quote(posix.join(targetRoot,'node/bin/node'))+' '+quote(posix.join(targetRoot,entry))+' "$@"\n';
      await writeFile(join(outputDirectory,name),source,{mode:0o755,flag:'wx'});
    }
    complete=true;
    return Object.keys(entries);
  }finally{
    if(!complete){const stat=await lstat(outputDirectory);if(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.dev===identity.dev&&stat.ino===identity.ino)await rm(outputDirectory,{recursive:true});}
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length!==4)throw new Error('Usage: prepare-native-runtime-launchers.mjs <new-output-directory> <absolute-linux-runtime-root>');
  console.log(JSON.stringify({files:await prepareNativeRuntimeLaunchers(process.argv[2],process.argv[3]),targetRoot:process.argv[3]}));
}
