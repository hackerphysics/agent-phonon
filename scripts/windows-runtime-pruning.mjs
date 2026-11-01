import fs from 'node:fs/promises';
import path from 'node:path';

/** Only prune an owned staging tree, never the device's installed packages. */
export async function pruneWindowsRuntime(root){
  root=await fs.realpath(root);
  const removed=[];
  const remove=async file=>{await fs.rm(file,{recursive:true});removed.push(path.relative(root,file));};
  for(const name of ['npm','.bin/npm','.bin/npm.cmd','.bin/npm.ps1','.bin/npx','.bin/npx.cmd','.bin/npx.ps1']){
    const file=path.join(root,'node_modules',name);
    try{await fs.lstat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    await remove(file);
  }
  async function prune(folder){
    for(const item of await fs.readdir(folder,{withFileTypes:true})){
      const file=path.join(folder,item.name);
      if(/licen[sc]e|copying|copyright|notice/i.test(item.name))continue;
      if(item.isSymbolicLink()){
        const resolved=await fs.realpath(file);
        if(!resolved.startsWith(root+path.sep))throw Error('Escaping runtime link');
        continue;
      }
      if(item.isDirectory()){
        if(/^(?:tests?|__tests__|fixtures?|__fixtures__|__mocks__|examples?|benchmarks?|coverage|\.cache|\.github|\.git|\.vscode)$/.test(item.name))await remove(file);
        else await prune(file);
      }else if(/\.(?:map|tsbuildinfo)$|\.d\.[cm]?ts$|(?:^|\.)(?:test|spec)\.[cm]?[jt]s$/.test(item.name)
        ||['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml'].includes(item.name)&&folder!==root)await remove(file);
      else if(item.name==='package.json'){
        const pkg=JSON.parse(await fs.readFile(file));delete pkg.scripts;delete pkg.devDependencies;
        await fs.writeFile(file,JSON.stringify(pkg)+'\n');
      }else if(item.name.endsWith('.ts')){
        const js=file.slice(0,-3)+'.js';
        try{if((await fs.stat(js)).isFile())await remove(file);}catch(error){if(error.code!=='ENOENT')throw error;}
      }
    }
  }
  await prune(root);
  // OpenClaw uses esbuild's transformSync at runtime to load native plugins.
  // Keep the paired host library/binary, but not its installation or CLI entry.
  for(const name of ['esbuild/install.js','esbuild/bin/esbuild','.bin/esbuild','.bin/esbuild.cmd','.bin/esbuild.ps1']){
    const file=path.join(root,'node_modules',name);
    try{await fs.lstat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    await remove(file);
  }
  return removed;
}
