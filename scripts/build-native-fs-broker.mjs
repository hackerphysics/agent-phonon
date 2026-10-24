import {buildNativeFileBroker} from "./native-fs-build.mjs";

const args=process.argv.slice(2),root=args.shift(),options={};
while(args.length){
 const key=args.shift(),value=args.shift();
 if(!["--zig","--verification-output"].includes(key)||!value||value.startsWith("--")||options[key])throw Error("Expected output folder, --zig <path> and optional --verification-output <new file>");
 options[key]=value;
}
const controller=new AbortController();let signalCode=0;
const stop=signal=>{signalCode=signal==="SIGINT"?130:143;controller.abort();};
const sigint=()=>stop("SIGINT"),sigterm=()=>stop("SIGTERM");
process.once("SIGINT",sigint);process.once("SIGTERM",sigterm);
try{process.stdout.write(JSON.stringify(await buildNativeFileBroker({root,zig:options["--zig"],verification:options["--verification-output"],signal:controller.signal}))+"\n");}
catch(error){process.stderr.write(String(error)+"\n");process.exitCode=signalCode||1;}
finally{process.removeListener("SIGINT",sigint);process.removeListener("SIGTERM",sigterm);}
