import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pruneWindowsRuntime} from './windows-runtime-pruning.mjs';

test('Windows staging drops installers and duplicate development bytes, retaining required native loader code/notices',async()=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'phonon-windows-prune-'));
  const files={
    'package-lock.json':'{}','node_modules/npm/bin/npm-cli.js':'installer',
    'node_modules/.bin/npm.cmd':'installer','node_modules/esbuild/install.js':'installer',
    'node_modules/esbuild/bin/esbuild':'cli','node_modules/esbuild/lib/main.js':'required native plugin transform',
    'node_modules/@esbuild/win32-x64/esbuild.exe':'prepared native loader',
    'node_modules/esbuild/LICENSE':'required notice','node_modules/lib/tests/fixture.js':'test',
    'node_modules/lib/index.js':'runtime','node_modules/lib/index.ts':'duplicate',
    'node_modules/lib/native.ts':'runtime-only source','node_modules/lib/index.js.map':'map',
    'node_modules/lib/package-lock.json':'{}','node_modules/lib/package.json':JSON.stringify({name:'lib',main:'index.js',scripts:{build:'no'},devDependencies:{tool:'1'},dependencies:{runtime:'1'}}),
  };
  try{
    for(const [name,value]of Object.entries(files)){const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);}
    await pruneWindowsRuntime(root);
    for(const name of ['node_modules/npm','node_modules/.bin/npm.cmd','node_modules/esbuild/install.js','node_modules/esbuild/bin/esbuild',
      'node_modules/lib/tests','node_modules/lib/index.ts','node_modules/lib/index.js.map','node_modules/lib/package-lock.json'])await assert.rejects(fs.stat(path.join(root,name)),{code:'ENOENT'});
    for(const name of ['package-lock.json','node_modules/esbuild/lib/main.js','node_modules/esbuild/LICENSE','node_modules/@esbuild/win32-x64/esbuild.exe','node_modules/lib/native.ts'])assert((await fs.stat(path.join(root,name))).isFile());
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'node_modules/lib/package.json'))),{name:'lib',main:'index.js',dependencies:{runtime:'1'}});
  }finally{await fs.rm(root,{recursive:true});}
});
