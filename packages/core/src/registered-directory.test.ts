import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,renameSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {directoryIdentity,assertDirectoryIdentity,assertRegisteredDirectory} from './directory-identity.js';

test('a registered path permits local replacement while an operation-local directory pin stays strict',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'phonon-registered-directory-')));
  try{
    const path=join(root,'workspace');mkdirSync(path);
    const previous=directoryIdentity(path);
    renameSync(path,path+'-old');mkdirSync(path);
    assert.doesNotThrow(()=>assertRegisteredDirectory(path));
    assert.throws(()=>assertDirectoryIdentity(path,previous),/directory identity changed/);
    rmSync(path,{recursive:true});symlinkSync(path+'-old',path);
    assert.throws(()=>assertRegisteredDirectory(path),/directory identity could not be verified/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
