import {execFile} from "node:child_process";
import {dirname} from "node:path";
import {z} from "zod";
import {hermesCommand,hermesBridgeInvocation} from "./hermes-command.js";
import {PhononError} from "../rpc.js";

const observation=z.object({home:z.string().min(1),nativeIdentity:z.string().min(1),documentHashes:z.record(z.string()),memoryBytes:z.number().int().nonnegative()}).strict();
const probe=String.raw`
import sys, os, json, stat, hashlib
wire=sys.stdout
sys.stdout=sys.stderr
sys.path[0]=os.path.dirname(os.path.realpath(sys.argv[1]))
try:
    request=json.load(sys.stdin)
    from hermes_cli.profiles import get_profile_dir, profile_exists
    if not profile_exists(request['profile']): raise RuntimeError('missing profile')
    home=get_profile_dir(request['profile']).resolve(strict=True)
    fd=os.open(home,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        before=os.fstat(fd)
        if before.st_uid!=os.getuid() or before.st_mode&0o022: raise RuntimeError('unsafe profile')
        def read(name):
            try: f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
            except FileNotFoundError: return b''
            try:
                info=os.fstat(f)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>1048576: raise RuntimeError('unsafe profile file')
                with os.fdopen(f,'rb',closefd=False) as stream: return stream.read(1048577)
            finally: os.close(f)
        hashes={name:hashlib.sha256(read(name)).hexdigest() for name in ['SOUL.md','AGENTS.md','USER.md','TOOLS.md']}
        memory=0
        try:
            memories=os.open('memories',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            try:
                for name in ['MEMORY.md','USER.md']:
                    try:
                        info=os.stat(name,dir_fd=memories,follow_symlinks=False)
                        if stat.S_ISREG(info.st_mode) and info.st_nlink==1: memory+=info.st_size
                    except FileNotFoundError: pass
            finally: os.close(memories)
        except FileNotFoundError: pass
        after=os.stat(home,follow_symlinks=False)
        if (before.st_dev,before.st_ino)!=(after.st_dev,after.st_ino): raise RuntimeError('profile changed')
        result={'home':str(home),'nativeIdentity':str(before.st_dev)+':'+str(before.st_ino),'documentHashes':hashes,'memoryBytes':memory}
    finally: os.close(fd)
    wire.write(json.dumps(result)+'\n')
except Exception:
    wire.write('{}\n')
wire.flush()
`;

export async function inspectExistingHermesProfile(bin:string,profile:string){
  if(process.platform==="win32"||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile))throw new PhononError("errCapabilityUnsupported","existing Hermes profile binding is unavailable on this runtime");
  const command=hermesCommand(bin),invocation=hermesBridgeInvocation(probe,[command.entry],JSON.stringify({profile}));
  return new Promise<z.infer<typeof observation>>((resolve,reject)=>{
    const failure=()=>new PhononError("employee_profile_source_unavailable","existing Hermes profile could not be verified");
    const child=execFile(command.python,invocation.args,{cwd:dirname(command.entry),timeout:8000,maxBuffer:16384,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}},(error,stdout)=>{
      try{if(error)throw error;resolve(observation.parse(JSON.parse(stdout)));}catch{reject(failure());}
    });
    child.stdin?.on("error",()=>{});child.stdin?.end(invocation.stdin);
  });
}
