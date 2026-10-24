import { networkInterfaces, userInfo, platform } from "node:os";
import { isIP } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export interface SSHAddress { address: string; kind: "public" | "private" | "tailscale"; family: "IPv4" | "IPv6"; interface?: string }
export interface DeviceSSHHints { username?: string; port: number; addresses: SSHAddress[] }

export function addressKind(address: string): SSHAddress["kind"] | undefined {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) return;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ? "private" : "public";
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1" || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("::ffff:")) return;
    return /^f[cd]/.test(lower) ? "private" : "public";
  }
}

export function sshAddressList(interfaces: ReturnType<typeof networkInterfaces>, tailscale: string[], publicIPs: string[]): SSHAddress[] {
  const found = new Map<string, SSHAddress>();
  for (const [name, values] of Object.entries(interfaces)) for (const value of values ?? []) {
    const kind = addressKind(value.address);
    if (!value.internal && kind) found.set(value.address, { address: value.address, kind: /tailscale/i.test(name) ? "tailscale" : kind, family: isIP(value.address) === 4 ? "IPv4" : "IPv6", interface: name.slice(0, 120) });
  }
  for (const address of publicIPs) if (addressKind(address) === "public" && !found.has(address)) found.set(address, { address, kind: "public", family: isIP(address) === 4 ? "IPv4" : "IPv6" });
  for (const address of tailscale) if (addressKind(address)) found.set(address, { ...found.get(address), address, kind: "tailscale", family: isIP(address) === 4 ? "IPv4" : "IPv6" });
  const order = { tailscale: 0, private: 1, public: 2 };
  return [...found.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.address.localeCompare(b.address)).slice(0, 64);
}

async function tailscaleIPs(): Promise<string[]> {
  const commands = platform() === "darwin" ? ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] : ["tailscale"];
  for (const command of commands) {
    try {
      const { stdout } = await run(command, ["status", "--json"], { timeout: 1200, maxBuffer: 1024 * 1024, windowsHide: true });
      const result = JSON.parse(stdout);
      if (Array.isArray(result?.Self?.TailscaleIPs)) return result.Self.TailscaleIPs.filter((value: unknown): value is string => typeof value === "string" && isIP(value) !== 0);
    } catch { /* Tailscale is optional, including on hosts without its CLI. */ }
  }
  return [];
}

let publicCache: { until: number; addresses: string[] } | undefined;
let publicRequest: Promise<string[]> | undefined;
async function publicIPs(): Promise<string[]> {
  if (publicCache && publicCache.until > Date.now()) return publicCache.addresses;
  if (publicRequest) return publicRequest;
  publicRequest = (async () => {
    const values = await Promise.all(["https://api4.ipify.org", "https://api6.ipify.org"].map(async url => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "error" });
        if (!response.ok) return;
        // Read only a bounded IP literal, never an arbitrary response body.
        const reader = response.body?.getReader();
        if (!reader) return;
        let result = "";
        try {
          for (;;) { const part = await reader.read(); if (part.done) break; result += Buffer.from(part.value).toString("utf8"); if (result.length > 64) return; }
        } finally { await reader.cancel().catch(() => {}); }
        const address = result.trim();
        return addressKind(address) === "public" ? address : undefined;
      } catch { return; }
    }));
    const addresses = values.filter((value): value is string => value !== undefined);
    publicCache = { addresses, until: Date.now() + (addresses.length ? 600_000 : 60_000) };
    return addresses;
  })();
  try { return await publicRequest; } finally { publicRequest = undefined; }
}

export async function collectDeviceSSHHints(): Promise<DeviceSSHHints> {
  let username: string | undefined;
  try { const name = userInfo().username; if (name.length <= 255 && !/[\p{Cc}]/u.test(name)) username = name; } catch { /* Some service accounts have no user database entry. */ }
  let interfaces: ReturnType<typeof networkInterfaces> = {};
  try { interfaces = networkInterfaces(); } catch { /* Discovery must never prevent device.info. */ }
  const [tailscale, publicAddresses] = await Promise.all([tailscaleIPs(), publicIPs()]);
  return { ...(username ? { username } : {}), port: 22, addresses: sshAddressList(interfaces, tailscale, publicAddresses) };
}
