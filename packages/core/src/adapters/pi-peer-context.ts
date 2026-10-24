/** Embedded in the existing invocation-scoped Phonon extension, never a second plugin. */
export const PI_PEER_CONTEXT_SOURCE = String.raw`
function piPeerBudget(pi,event,ctx){
  const unknown={state:"unknown",source:"native_estimate"};
  try{
    const usage=ctx.getContextUsage?.(),model=ctx.model;
    if(!usage||!model||!Number.isFinite(usage.tokens)||usage.tokens===null||usage.tokens<0
      ||!Number.isSafeInteger(usage.contextWindow)||usage.contextWindow<=0||model.contextWindow!==usage.contextWindow
      ||!Number.isSafeInteger(model.maxTokens)||model.maxTokens<0||!Array.isArray(event.messages)
      ||typeof ctx.getSystemPrompt!=="function"||typeof pi.getAllTools!=="function"||typeof pi.getActiveTools!=="function")return unknown;
    const system=ctx.getSystemPrompt(),tools=pi.getAllTools(),active=pi.getActiveTools();
    if(typeof system!=="string"||!Array.isArray(tools)||!Array.isArray(active)||active.some(name=>!tools.some(tool=>tool.name===name)))return unknown;
    const inputTokens=Math.max(Math.ceil(usage.tokens),Buffer.byteLength(JSON.stringify(event.messages)));
    const overheadTokens=Buffer.byteLength(system)+Buffer.byteLength(JSON.stringify(tools.filter(tool=>active.includes(tool.name)).map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters}))))+1024;
    if([inputTokens,overheadTokens,usage.contextWindow,model.maxTokens].some(value=>!Number.isSafeInteger(value)||value<0||value>1000000000))return unknown;
    return {state:"known",source:"native_estimate",contextWindowTokens:usage.contextWindow,inputTokens,outputTokens:model.maxTokens,overheadTokens};
  }catch{return unknown;}
}
async function installPeerContext(pi, environment) {
  const url = environment.AGENT_PHONON_PEER_CONTEXT_URL;
  if (!url) return false;
  const endpoint = new URL(url), token = environment.AGENT_PHONON_PEER_CONTEXT_TOKEN;
  if(endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/peer-context"
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[A-Za-z0-9_-]{43}$/.test(token || "")) throw failure();
  delete environment.AGENT_PHONON_PEER_CONTEXT_URL;
  delete environment.AGENT_PHONON_PEER_CONTEXT_TOKEN;
  let batch;
  async function checkpoint(path, input) {
    return new Promise((resolve,reject) => {
      const target = new URL(path, endpoint);
      const req = httpRequest(target,{method:"POST",agent:false,signal:AbortSignal.timeout(1500),headers:{Authorization:"Bearer " + token,"Content-Type":"application/json"}},res=>{
        const chunks=[];let size=0;
        res.on("data",chunk=>{size+=chunk.length;if(size>65536){res.destroy();reject(failure());}else chunks.push(chunk);});
        res.on("error",reject);
        res.on("end",()=>{try{if(res.statusCode!==200)throw failure();resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch{reject(failure());}});
      });
      req.on("error",reject);req.end(JSON.stringify(input));
    });
  }
  pi.on("context", async (event, ctx) => {
    batch = undefined;
    try {
      const boundaryId = randomUUID(), nativeSessionId = ctx.sessionManager.getSessionId();
      const result = await checkpoint("/peer-context", {boundaryId, nativeSessionId,budget:piPeerBudget(pi,event,ctx)});
      if(result.boundaryId!==boundaryId || result.nativeSessionId!==nativeSessionId || !Array.isArray(result.messages)
        || result.messages.length>8 || result.messages.some(m=>typeof m.messageId!=="string" || typeof m.content!=="string")) throw failure();
      if(!result.messages.length) return;
      batch = result;
      return {messages:[...event.messages,...result.messages.map(m=>({role:"custom",customType:"phonon.peer",content:m.content,
        display:false,details:{messageId:m.messageId,source:"phonon-peer"},timestamp:Date.now()}))]};
    } catch { return; }
  });
  const contains = (value, text) => typeof value === "string" ? value === text
    : Array.isArray(value) ? value.some(v=>contains(v,text))
    : value && typeof value === "object" ? Object.values(value).some(v=>contains(v,text)) : false;
  pi.on("before_provider_request", async event => {
    const current = batch; batch = undefined;
    if(!current) return;
    const messageIds = current.messages.filter(m=>contains(event.payload,m.content)).map(m=>m.messageId);
    if(!messageIds.length) return;
    try { await checkpoint("/peer-context/observe",{boundaryId:current.boundaryId,nativeSessionId:current.nativeSessionId,messageIds,evidence:"provider_payload"}); }
    catch { /* An uncertain observation never becomes an ACK or a repeated insertion. */ }
  });
  return true;
}
`;
