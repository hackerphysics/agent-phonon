import { basename, dirname, delimiter, isAbsolute, join, resolve } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { discoveryProbe } from "../discovery-probe.js";

export interface ClaudeSdkBinding { entry: string; sdk: string; node?: string }

/** Use the interpreter paired with an owner-selected npm CLI, not a project's Node. */
export function claudeNodeCommand(bin: string): {entry:string;node:string}|undefined {
  try{
    const candidate=isAbsolute(bin)?bin:(process.env.PATH??"").split(delimiter).map(path=>join(path,bin)).find(path=>existsSync(path));
    if(!candidate)return;
    const entry=realpathSync(candidate);if(basename(entry)!=="cli.js")return;
    const node=[join(dirname(candidate),process.platform==="win32"?"node.exe":"node"),resolve(dirname(entry),"../../../../bin/node"),process.execPath]
      .find(path=>existsSync(path)&&statSync(path).isFile());
    return node?{entry,node}:undefined;
  }catch{return;}
}

/** No inference, installation, owner-config rewrite or selection from project dependencies. */
export async function qualifyClaudePeerContext(bin: string): Promise<ClaudeSdkBinding | undefined> {
  try {
    const command=claudeNodeCommand(bin);if(!command)return;
    const {entry,node}=command,sdk = join(dirname(entry), "sdk.mjs");
    if (!statSync(sdk).isFile()) return undefined;
    const version = await discoveryProbe(node, [entry,"--version"]);
    if (!/^2\.0\.1(?:\s|$)/.test(version?.trim() ?? "")) return undefined;
    const result = await discoveryProbe(node, ["--input-type=module", "-e",
      "const sdk=await import(process.argv[1]);if(typeof sdk.query==='function'&&typeof sdk.createSdkMcpServer==='function')console.log('phonon_claude_hooks_v1');", pathToFileURL(sdk).href]);
    return result?.trim() === "phonon_claude_hooks_v1" ? {entry,sdk,node} : undefined;
  } catch { return undefined; }
}
