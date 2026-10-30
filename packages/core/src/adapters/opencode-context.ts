import {lstatSync,realpathSync} from "node:fs";
import {basename,dirname,join} from "node:path";
import {DatabaseSync} from "node:sqlite";

type Identity={sessionId:string;cwd:string;model:string;prompt:string;notBefore:number};
const id=(value:unknown,prefix:string)=>typeof value==="string"&&value.length<=512&&new RegExp("^"+prefix+"_[A-Za-z0-9]+$").test(value);
const timestamp=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;

/** Read only after the owned process exits normally. Missing CLI output is not itself completion. */
export function readOpenCodeCompletion(file:string,identity:Identity):{messageId:string;text:string}|undefined {
  let db:DatabaseSync|undefined;
  try{
    if(process.platform==="win32"||!id(identity.sessionId,"ses")||!timestamp(identity.notBefore)||identity.model&&!identity.model.includes("/"))return;
    const directory=realpathSync(dirname(file)),cwd=realpathSync(identity.cwd),info=lstatSync(file),parent=lstatSync(directory);
    const owned=(stat:typeof info)=>stat.uid===process.getuid?.()&&(stat.mode&0o022)===0;
    if(!owned(info)||!owned(parent)||!parent.isDirectory()||!info.isFile()||info.isSymbolicLink()||info.nlink!==1
      ||realpathSync(file)!==join(directory,basename(file)))return;
    db=new DatabaseSync(file,{readOnly:true});db.exec("BEGIN");
    const session=db.prepare("SELECT directory,parent_id FROM session WHERE id=?").get(identity.sessionId);
    if(!session||session.parent_id!==null||typeof session.directory!=="string"||realpathSync(session.directory)!==cwd)return;
    // Keep an oversized latest record visible as a refusal, never skip back to an older success.
    const rows=db.prepare("SELECT id,time_created,CASE WHEN length(CAST(data AS BLOB))<=262144 THEN data END data FROM message WHERE session_id=? AND time_created>=? ORDER BY time_created,id LIMIT 257")
      .all(identity.sessionId,identity.notBefore);
    if(rows.length<2||rows.length>256)return;
    let userId:string|undefined,last:any,lastId:string|undefined,model=identity.model;
    for(const row of rows){
      if(!id(row.id,"msg")||typeof row.data!=="string"||!timestamp(row.time_created))return;
      const message=JSON.parse(row.data);
      if(!timestamp(message.time?.created)||message.time.created<identity.notBefore||message.time.created>Date.now())return;
      if(message.role==="user"){
        const selected=message.model?.providerID+"/"+message.model?.modelID;
        if(userId||typeof message.model?.providerID!=="string"||!message.model.providerID||typeof message.model?.modelID!=="string"||!message.model.modelID
          ||selected.length>1024||model&&selected!==model)return;
        model=selected;
        userId=row.id as string;
        const parts=db.prepare("SELECT CASE WHEN length(CAST(data AS BLOB))<=1048576 THEN data END data FROM part WHERE session_id=? AND message_id=? ORDER BY time_created,id LIMIT 257").all(identity.sessionId,userId);
        if(!parts.length||parts.length>256)return;
        const text=[];
        for(const part of parts){if(typeof part.data!=="string")return;const value=JSON.parse(part.data);if(value.type!=="text"||typeof value.text!=="string")return;text.push(value.text);}
        const prompt=text.join("\n");if(prompt!==identity.prompt&&prompt!==identity.prompt+"\n")return;
      }else if(message.role!=="assistant"||!userId||message.parentID!==userId||message.providerID+"/"+message.modelID!==model
        ||message.error||message.summary===true||typeof message.path?.cwd!=="string"||realpathSync(message.path.cwd)!==cwd)return;
      last=message;lastId=row.id as string;
    }
    if(!userId||last?.role!=="assistant"||last.finish!=="stop"||!timestamp(last.time?.completed)||last.time.completed<last.time.created||last.time.completed>Date.now())return;
    const parts=db.prepare("SELECT CASE WHEN length(CAST(data AS BLOB))<=262144 THEN data END data FROM part WHERE session_id=? AND message_id=? ORDER BY time_created,id LIMIT 257").all(identity.sessionId,lastId!);
    if(!parts.length||parts.length>256)return;
    const text:string[]=[];let stops=0;
    for(const part of parts){
      if(typeof part.data!=="string")return;const value=JSON.parse(part.data);
      if(value.type==="text"){
        if(typeof value.text!=="string"||!timestamp(value.time?.end)||value.time.end>last.time.completed)return;
        text.push(value.text);
      }else if(value.type==="step-finish"){if(value.reason!=="stop"||++stops>1)return;}
      else if(value.type!=="step-start"&&value.type!=="reasoning")return;
    }
    const result=text.join("\n"),current=lstatSync(file);
    if(stops!==1||!result.trim()||Buffer.byteLength(result)>128000||current.ino!==info.ino||current.dev!==info.dev
      ||!current.isFile()||current.isSymbolicLink()||current.nlink!==1||!owned(current))return;
    return {messageId:lastId!,text:result};
  }catch{return;}
  finally{try{db?.close();}catch{/* Optional source proof never replaces the native exit. */}}
}
