import { ProjectCoordinationEvidenceParams, ProjectCoordinationEvidenceResult } from "@agent-phonon/protocol";
import type { PeerContextJournal } from "./peer-context.js";

const rank={offered:0,context_hook:1,provider_payload:2};

/** Connection-scoped sender; durable metadata survives without keeping a model turn alive. */
export class PeerContextReporter {
  private timer:ReturnType<typeof setInterval>;
  private running?:Promise<void>;
  private active=true;
  private changed=false;
  constructor(private journal:PeerContextJournal,private tenant:string,private authority:string,
    private send:(params:ProjectCoordinationEvidenceParams)=>Promise<unknown>){
    this.timer=setInterval(()=>this.kick(),30000);this.timer.unref();
    queueMicrotask(()=>this.kick());
  }
  kick():void {
    if(!this.active)return;
    this.changed=true;
    if(this.running)return;
    const task=this.flush();this.running=task;
    void task.finally(()=>{if(this.running===task)this.running=undefined;});
  }
  private async flush():Promise<void>{
    try{
      for(let page=0;page<8&&this.active&&this.changed;page++){
        this.changed=false;
        const reports=this.journal.pendingReports(this.tenant,this.authority);
        if(!reports.length)return;
        const result=ProjectCoordinationEvidenceResult.parse(await this.send(ProjectCoordinationEvidenceParams.parse({version:1,reports})));
        if(!this.active)return;
        if(result.receipts.length!==reports.length||new Set(result.receipts.map(row=>row.deliveryId)).size!==reports.length
          ||result.receipts.some(row=>!reports.some(report=>report.deliveryId===row.deliveryId
            &&(row.status==="rejected"||rank[row.state]>=rank[report.state]))))throw new Error("Runtime evidence receipt mismatch");
        for(const report of reports){
          const receipt=result.receipts.find(row=>row.deliveryId===report.deliveryId)!;
          this.journal.confirmReport(this.tenant,this.authority,report.deliveryId,report.state,receipt.status==="rejected");
        }
        this.changed=true;
      }
    }catch{ /* Retry metadata on the next connection heartbeat; never replay peer context. */ }
  }
  close():void{this.active=false;clearInterval(this.timer);}
}
