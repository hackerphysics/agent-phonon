import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, writeFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {HERMES_COMMAND_APPROVAL_BRIDGE, hermesCommandApprovalEnvironment} from '../packages/core/dist/adapters/hermes-command-approval.js';
const exec = promisify(execFile);
const python = process.env.PHONON_HERMES_TEST_PYTHON;
const hermesSource = process.env.PHONON_HERMES_TEST_SOURCE;

test('controller only enables paired interaction and receipt capabilities', () => {
  const base={turnId:'turn', verbosity:'final', emit(){}};
  assert.deepEqual(hermesCommandApprovalEnvironment(base), {PHONON_HERMES_APPROVAL_CONTEXT:''});
  const opts={...base, requestInteraction:async()=>{}, acknowledgeInteraction(){}, environment:{}};
  assert.throws(()=>hermesCommandApprovalEnvironment(opts));
  opts.environment={AGENT_PHONON_MCP_URL:'http://127.0.0.1:12345/mcp',AGENT_PHONON_INTERACTION_URL:'http://127.0.0.1:12345/interaction',AGENT_PHONON_INTERACTION_RECEIPT_URL:'http://127.0.0.1:12345/applied',AGENT_PHONON_INTERACTION_TOKEN:'a'.repeat(43)};
  const capsule=JSON.parse(hermesCommandApprovalEnvironment(opts).PHONON_HERMES_APPROVAL_CONTEXT);
  assert.equal(capsule.receipt,opts.environment.AGENT_PHONON_INTERACTION_RECEIPT_URL);
  opts.environment.AGENT_PHONON_INTERACTION_RECEIPT_URL='http://127.0.0.1:54321/applied';
  assert.throws(()=>hermesCommandApprovalEnvironment(opts));
});

for (const mode of ['allow','deny','cancel','timeout','wrong-id','wrong-proof','string-true','receipt-fails','closed','thread']) {
  test(`real Hermes guard and terminal: ${mode}`, {skip:!python||!hermesSource}, async () => {
    const dir=await mkdtemp(join(tmpdir(),'phonon-approval-test-'));
    let requests=0,receipts=0;
    const server=createServer(async(req,res)=>{
      assert.equal(req.headers.authorization,'Bearer '+'a'.repeat(43));
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader('content-type','application/json');
      if(req.url==='/interaction') {
        requests++;
        assert.equal(body.presentation.kind,'approval');assert.equal(body.form.fields[0].defaultValue,false);
        assert.match(body.form.description,/rm -r/);
        assert.equal(body.timeoutSeconds,2);
        const action=['cancel','timeout'].includes(mode)?mode:'submit';
        res.end(JSON.stringify({requestId:mode==='wrong-id'?'foreign':body.requestId,action,values:{approve:mode==='string-true'?'true':mode!=='deny'},decisionHash:mode==='wrong-proof'?'bad':'b'.repeat(64)}));
      } else {
        receipts++;assert.equal(body.decisionHash,'b'.repeat(64));
        if(mode==='receipt-fails'){res.statusCode=409;res.end('{}');}else res.end('{"applied":true}');
      }
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const port=server.address().port;
      await writeFile(join(dir,'config.yaml'),'approvals:\n  mode: manual\n  timeout: 2\n  single_query_mode: deny\nterminal:\n  backend: local\n');
      const script=`import os,sys,json,threading,shlex\nsys.path.insert(0,os.environ['NATIVE_SOURCE'])\n${HERMES_COMMAND_APPROVAL_BRIDGE}\nfrom tools.approval import check_all_command_guards,check_execute_code_guard\nfrom tools.terminal_tool import terminal_tool\nfrom tools.thread_context import propagate_context_to_thread\nfrom pathlib import Path\nroot=Path(os.environ['TEST_ROOT'])\nvictim=root/'owned-victim'\nvictim.mkdir()\n(victim/'marker').write_text('owned fixture')\ncommand='rm -r '+shlex.quote(str(victim))\nassert check_all_command_guards(command,'local')['approved'] is False\nclose=_phonon_install_command_approval()\ntry:\n    assert check_all_command_guards('rm -rf /','local')['approved'] is False\n    if os.environ['TEST_MODE']=='closed': close(); close=lambda:None\n    result=[]\n    def run(): result.append(json.loads(terminal_tool(command,workdir=str(root),timeout=10)))\n    if os.environ['TEST_MODE']=='thread':\n        worker=threading.Thread(target=propagate_context_to_thread(run));worker.start();worker.join(15);assert not worker.is_alive()\n    else: run()\n    print(json.dumps({'exists':victim.exists(),'result':result}))\nfinally: close()\nassert os.environ.get('HERMES_SINGLE_QUERY_SESSION')=='1'\nassert check_all_command_guards(command,'local')['approved'] is False\n`;
      const file=join(dir,'probe.py');await writeFile(file,script);
      const result=await exec(python,[file],{timeout:30000,maxBuffer:2**20,env:{...process.env,HERMES_HOME:dir,HERMES_SINGLE_QUERY_SESSION:'1',HERMES_INTERACTIVE:'1',HERMES_YOLO_MODE:'',HERMES_SESSION_PLATFORM:'',HERMES_GATEWAY_SESSION:'',HERMES_EXEC_ASK:'',NATIVE_SOURCE:hermesSource,TEST_ROOT:dir,TEST_MODE:mode,PHONON_HERMES_APPROVAL_CONTEXT:JSON.stringify({v:1,url:`http://127.0.0.1:${port}/interaction`,receipt:`http://127.0.0.1:${port}/applied`,token:'a'.repeat(43)})}});
      const output=JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.equal(output.exists,!['allow','thread'].includes(mode),result.stdout+result.stderr);
      if(mode==='timeout') assert.match(output.result[0].error,/timed out|timeout|no response/i);
      assert.equal(requests,mode==='closed'?0:1);
      assert.equal(receipts,['allow','deny','thread','receipt-fails','string-true'].includes(mode)?1:0);
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
  });
}
