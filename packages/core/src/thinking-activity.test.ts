import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AdapterRegistry, SessionEngine } from "./session-engine.js";
import { PhononStore } from "./store.js";
import type { SendOptions } from "./adapter.js";
import { withPeerFixture } from "./testing/peer-fixture.js";

for (const verbosity of ["final", "messages", "tools", "trace"] as const) {
  test(`native thinking bursts are bounded before sequencing and persistence (${verbosity})`, async t => {
    await withPeerFixture("thinking-activity", async scope => {
      const store = new PhononStore(join(scope.root, "state.sqlite")), events:any[]=[];
      const registry = new AdapterRegistry();let late:SendOptions["emit"]|undefined,now=0;
      t.mock.method(performance,"now",()=>now);
      registry.register({name:"fixture",capabilities:{},createSession:async()=>({
        sessionId:"fixture",terminate:async()=>{},
        send:async(_input:string,opts:SendOptions)=>{
          late=opts.emit;
          const emit=(event:Record<string,unknown>)=>opts.emit({sessionId:"fixture",turnId:opts.turnId,seq:0,at:new Date().toISOString(),...event} as never);
          for(const time of [0,100,14_999,15_000,30_000]){
            now=time;
            for(let n=0;n<10_000;n++)emit({type:"thinking",text:"private fixture reasoning",delta:true});
            emit({type:"tool_call",toolName:"read",args:{},toolCallId:String(time)});
          }
          emit({type:"message",role:"user",source:"native_input_accepted",text:"",delta:false});
          emit({type:"result",text:"original result",status:"completed",final:true});
        },
      })} as never);
      const engine=new SessionEngine(registry,event=>events.push(event),undefined,store,undefined,"owner");
      try{
        const {sessionId}=await engine.create({tenantId:"owner",project:"fixture",cwd:scope.root,agent:"fixture",model:"fixture",verbosity,
          workflowAttr:{workflowId:"fixture",nodeId:"reply",nativeRunId:"11111111-1111-4111-8111-111111111111"}});
        for(let turn=0;turn<2;turn++){
          const sent=await engine.send("owner",sessionId,"new input",{});await engine.settleTurn("owner",sessionId,sent.turnId);
        }
        const markers=events.filter(event=>event.type==="thinking");
        assert.equal(markers.length,verbosity==="tools"||verbosity==="trace"?6:0);
        assert.ok(markers.every(event=>event.text===""&&event.delta===false&&event.source==="thinking_activity"));
        assert.deepEqual(events.map(event=>event.seq),events.map((_,index)=>index));
        assert.equal(events.filter(event=>event.source==="native_input_accepted").length,2);
        assert.equal(events.filter(event=>event.type==="tool_call").length,10);
        const before=events.length;
        late!({type:"thinking",text:"late private fixture reasoning"} as never);assert.equal(events.length,before);
        const transcript=readFileSync(join(store.transcriptDir()!,sessionId+".jsonl"),"utf8");
        assert.doesNotMatch(transcript,/private fixture reasoning/);
        assert.equal(transcript.split("\n").filter(line=>line&&JSON.parse(line).event?.type==="thinking").length,markers.length);
      }finally{await engine.dispose();store.close();}
    });
  });
}
