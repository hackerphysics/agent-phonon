"""Cross-language real WS/SDK maintenance.edit; no LLM or mock RPC results."""
import asyncio
import json
import tempfile
from pathlib import Path
from agent_phonon import PhononServer

REPO = Path(__file__).resolve().parents[1]
NODE = r'''
import {AdapterRegistry, PhononClient} from "__CORE__";
const [url, dir] = process.argv.slice(2);
const client = new PhononClient({serverUrl:url,deviceId:"python-maint-edit",registry:new AdapterRegistry(),trustLocal:false,workspaceRoot:dir,
policy:{allowMaintenanceRead:true,allowMaintenanceConfigWrite:true},maintenance:{backupDir:dir+"/backups",targets:[{targetId:"fixture",label:"Fixture",configs:[{configId:"main",path:dir+"/config.toml",format:"toml",writable:true,textVisibility:"public",allowedRootKeys:["model"]}]}]}});
process.on("SIGTERM",async()=>{await client.close();});
await client.connect();
'''.replace('__CORE__', (REPO / 'packages/core/dist/index.js').as_uri())

async def main():
    async def auth(_device_id, _key=None):
        return "python-maintenance"
    server = PhononServer(authenticate=auth)
    ready = asyncio.get_running_loop().create_future()
    async def on_device(device):
        if not ready.done():
            ready.set_result(device)
    server.on_device(on_device)
    port = await server.listen()
    proc = None
    try:
        with tempfile.TemporaryDirectory(prefix="phonon-py-edit-") as directory:
            root = Path(directory)
            original = b'\xef\xbb\xbf# public\r\nmodel = "before"\r\nlocked = 1\r\n'
            file = root / 'config.toml'
            file.write_bytes(original)
            (root / 'client.mjs').write_text(NODE)
            proc = await asyncio.create_subprocess_exec('node', str(root/'client.mjs'), f'ws://127.0.0.1:{port}', directory,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            try:
                device = await asyncio.wait_for(ready, 15)
                before = await device.maintenance_config_get('fixture', 'main')
                assert before['format'] == 'toml'
                edits = [{'oldText':'before','newText':'after'}]
                result = await device.maintenance_config_edit('fixture','main',before['sha256'],edits,clientRequestId='py-edit-one')
                assert result['changed'] and file.read_bytes() == original.replace(b'before',b'after')
                assert await device.maintenance_config_edit('fixture','main',before['sha256'],edits,clientRequestId='py-edit-one') == result
                after = await device.maintenance_config_get('fixture', 'main')
                try:
                    await device.maintenance_config_edit('fixture','main',after['sha256'],[{'oldText':'locked = 1','newText':'locked = 2'}])
                    raise AssertionError('unauthorized root accepted')
                except AssertionError:
                    raise
                except Exception:
                    pass
                await device.maintenance_rollback(result['backupId'],after['sha256'])
                assert file.read_bytes() == original
                assert (await device.maintenance_config_get('fixture','main'))['sha256'] == before['sha256']
                print(json.dumps({'pythonWsEdit':'PASS','idempotency':True,'rootDenied':True,'bytesRestored':True}))
            finally:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), 15)
                assert proc.returncode == 0, (await proc.stderr.read()).decode()
                proc = None
    finally:
        if proc and proc.returncode is None:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), 15)
        await server.close()

if __name__ == '__main__':
    asyncio.run(asyncio.wait_for(main(), 60))
