import { existsSync,readFileSync,realpathSync } from "node:fs";
import { join,isAbsolute,delimiter,dirname,win32 } from "node:path";

const WINDOWS_BRIDGE_BOOTSTRAP=String.raw`import sys,json,io
raw=sys.stdin.buffer.read(2097153)
if len(raw)>2097152: raise ValueError('native bridge input too large')
value=json.loads(raw)
if not isinstance(value,dict) or set(value)!={'script','argv','input'} or not isinstance(value['script'],str) or len(value['script'].encode('utf8'))>262144 or not isinstance(value['argv'],list) or len(value['argv'])>64 or not all(isinstance(arg,str) for arg in value['argv']) or not isinstance(value['input'],str): raise ValueError('invalid native bridge input')
sys.argv=['-c',*value['argv']]
sys.stdin=io.StringIO(value['input'])
exec(compile(value['script'],'phonon-hermes-native-bridge','exec'))`;

/** Keep fixed bridge code and native arguments off Windows' command line. */
export function hermesBridgeInvocation(script:string,argv:string[],input="",platform:NodeJS.Platform=process.platform):{args:string[];stdin:Buffer}{
  if(platform!=="win32")return {args:["-c",script,...argv],stdin:Buffer.from(input)};
  const stdin=Buffer.from(JSON.stringify({script,argv,input}));
  if(Buffer.byteLength(script)>262144||argv.length>64||stdin.length>2097152)throw new Error("Hermes native bridge input exceeds its bounded pipe envelope");
  return {args:["-B","-c",WINDOWS_BRIDGE_BOOTSTRAP],stdin};
}

export function hermesWindowsPython(source:Buffer):string|undefined{
  if(source.length>4*1024*1024||source.subarray(0,2).toString()!=="MZ")return;
  const archive=source.indexOf(Buffer.from([0x50,0x4b,0x03,0x04]));
  if(archive<0||!source.subarray(archive).includes(Buffer.from("from hermes_cli.main import main")))return;
  // Python's installed Windows launcher puts its interpreter shebang directly
  // before the embedded console script. Do not guess another Python from PATH.
  const start=source.lastIndexOf(Buffer.from("#!"),archive);
  if(start<2||archive-start>4096)return;
  const line=source.subarray(start+2,archive).toString("utf8").trim();
  const python=line.startsWith('"')&&line.endsWith('"')?line.slice(1,-1):line;
  if(/[\x00-\x1f"]/.test(python)||!win32.isAbsolute(python)||!/[\\/]python[\d.]*\.exe$/i.test(python))return;
  return python;
}

export function hermesCommand(bin:string):{python:string;entry:string}{
  const entry=isAbsolute(bin)?bin:(process.env.PATH??"").split(delimiter).map(path=>join(path,bin)).find(path=>existsSync(path));
  if(!entry)throw new Error("Hermes CLI not found on daemon PATH; configure hermesBinPath");
  const real=realpathSync(entry),bytes=readFileSync(real),source=bytes.toString("utf8"),lines=source.split("\n"),shebang=lines[0]?.trim()??"";
  let python=shebang.match(/^#!(\/[^\r\n]+\/python[\d.]*)$/)?.[1];
  if(!python&&process.platform==="win32"&&/\.exe$/i.test(real))python=hermesWindowsPython(bytes);
  const uvShim=String.raw`'''exec' "$(dirname -- "$(realpath -- "$0")")"/'python3' "$0" "$@"`;
  if(!python&&shebang==="#!/bin/sh"&&lines[1]===uvShim&&lines[2]==="' '''"&&source.includes("from hermes_cli.main import main"))python=join(dirname(real),"python3");
  if(!python||!existsSync(python))throw new Error("Hermes structured bridge requires an installed Python console script or native Windows launcher (configure hermesBinPath); refusing unstructured success fallback");
  return {python,entry:real};
}
