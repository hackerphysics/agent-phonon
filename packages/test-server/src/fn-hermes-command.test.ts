import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {hermesWindowsPython,hermesBridgeInvocation} from "../../core/dist/adapters/hermes-command.js";

function launcher(shebang:string,main="from hermes_cli.main import main"){
  return Buffer.concat([Buffer.from("MZinstalled-launcher\0"),Buffer.from("#!"+shebang+"\n\r\n"),Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.from(main)]);
}
test("Hermes Windows launcher uses its own exact installed interpreter, including paths with spaces",()=>{
  for(const python of [String.raw`D:\Hermes\venv\Scripts\python.exe`,String.raw`C:\Program Files\Hermes\python3.13.exe`]){
    assert.equal(hermesWindowsPython(launcher(python)),python);
    assert.equal(hermesWindowsPython(launcher('"'+python+'"')),python);
  }
});
test("Hermes Windows interpreter discovery rejects shell arguments, relative paths and foreign launchers",()=>{
  for(const source of [
    launcher("python.exe"),launcher(String.raw`C:\Hermes\python.exe -I`),launcher(String.raw`C:\Hermes\cmd.exe`),
    launcher('"C:\\Hermes\\python.exe" --anything'),launcher("C:\\Hermes\\python.exe\nsecond-command"),
    launcher(String.raw`C:\Hermes\python.exe`,"from other_cli import main"),
    Buffer.from("#!/usr/bin/python3\nfrom hermes_cli.main import main"),
    Buffer.from("MZ#!C:\\Hermes\\python.exe\nfrom hermes_cli.main import main"),
    Buffer.concat([launcher(String.raw`C:\Hermes\python.exe`),Buffer.alloc(4*1024*1024)]),
  ])assert.equal(hermesWindowsPython(source),undefined);
});

test("Hermes Windows pipe bootstrap preserves large fixed scripts, native arguments and profile input without shell interpolation",()=>{
  const script="# native bridge\n".repeat(2500)+"import json,sys\nprint(json.dumps({'argv':sys.argv[1:],'input':sys.stdin.read()}))";
  const argv=[String.raw`C:\Program Files\Hermes\hermes.exe`,"--profile","phn-owned","-q","x".repeat(80000)+"\u4e2d\u6587 \u{1f600} %PATH% & echo never-execute\nquoted \"body\""];
  const input=JSON.stringify({documents:{soul:"Identity \u4e2d\u6587\nnext line"}});
  const invocation=hermesBridgeInvocation(script,argv,input,"win32");
  assert.ok(invocation.args.join(" ").length<2048);assert.equal(invocation.args.join(" ").includes(argv[4]!),false);
  const result=execFileSync(process.env.PHONON_TEST_HERMES_PROFILE_PYTHON??"python3",invocation.args,{input:invocation.stdin,encoding:"utf8",timeout:10000});
  assert.deepEqual(JSON.parse(result),{argv,input});
});

test("Hermes pipe input is bounded before launch and non-Windows invocation retains the native argument shape",()=>{
  assert.throws(()=>hermesBridgeInvocation("x".repeat(262145),[],"","win32"));
  assert.throws(()=>hermesBridgeInvocation("",Array(65).fill("a"),"","win32"));
  assert.throws(()=>hermesBridgeInvocation("",[],"x".repeat(2097152),"win32"));
  const ordinary=hermesBridgeInvocation("print('native')",["/native/hermes","--profile","owned"],"{}","darwin");
  assert.deepEqual(ordinary.args,["-c","print('native')","/native/hermes","--profile","owned"]);assert.equal(ordinary.stdin.toString(),"{}");
});
