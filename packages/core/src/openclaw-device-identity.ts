import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { inspectWindowsNativeSecurity } from "./windows-native-file-security.js";

const identitySchema = z.object({ version: z.literal(1), deviceId: z.string(), publicKey: z.string(), privateKey: z.string() }).strict();
const tokenSchema = z.object({ version: z.literal(1), deviceId: z.string(), clientId: z.literal("gateway-client"), role: z.literal("operator"), token: z.string().min(1), scopes: z.array(z.string()) }).strict();
type Identity = z.infer<typeof identitySchema>;
type Token = z.infer<typeof tokenSchema>;

function owned(stat: Stats): boolean {
  return process.platform === "win32" || stat.uid === process.getuid?.() && (Number(stat.mode) & 0o077) === 0;
}

/** Phonon owns this directory, not OpenClaw's own device identity or paired-device store. */
export class OpenClawDeviceStore {
  readonly directory: string;
  constructor(baseUrl: string, root = join(homedir(), ".agent-phonon", "openclaw-gateway")) {
    const url = new URL(baseUrl.replace(/^http/, "ws"));
    if (url.username || url.password || url.search || url.hash) throw new Error("Gateway URL must not contain credentials, query parameters or fragments");
    const endpoint = createHash("sha256").update(url.href).digest("hex");
    let createdRoot = false;
    try { mkdirSync(root, { mode: 0o700 }); createdRoot = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { mkdirSync(dirname(root), { recursive: true, mode: 0o700 }); try { mkdirSync(root, { mode: 0o700 }); createdRoot = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
      else if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const parent = lstatSync(root);
    if (!parent.isDirectory() || !owned(parent)) throw new Error("Gateway identity directory must be privately owned (0700), not a symlink");
    if (process.platform === "win32") inspectWindowsNativeSecurity(root, true, undefined, true, createdRoot);
    this.directory = join(root, endpoint);
    try { lstatSync(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Publish a nonempty directory atomically: concurrent creators cannot replace a key
      // or observe a partially written identity (including a transient hard link).
      const temporary = mkdtempSync(join(root, ".identity-"));
      try {
        if (process.platform === "win32") inspectWindowsNativeSecurity(temporary, true, undefined, true);
        const pair = generateKeyPairSync("ed25519");
        const publicKey = (pair.publicKey.export({ format: "jwk" }).x)!;
        const identity: Identity = { version: 1, publicKey,
          deviceId: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"),
          privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
        const fd = openSync(join(temporary, "identity.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { writeFileSync(fd, JSON.stringify(identity) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
        try { renameSync(temporary, this.directory); }
        catch (error) { if (!["EEXIST", "ENOTEMPTY", ...(process.platform === "win32" ? ["EPERM"] : [])].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
    this.guard();
  }

  private guard(): void {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || !owned(stat)) throw new Error("Gateway device state must be privately owned (0700), not a symlink");
    if (process.platform === "win32") inspectWindowsNativeSecurity(this.directory, true, undefined, true);
  }

  private read(name: string): unknown {
    this.guard();
    let fd: number;
    try { fd = openSync(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || !owned(stat) || stat.size > 65536) throw new Error("Gateway device state must be a private regular file (0600)");
      if (process.platform === "win32") inspectWindowsNativeSecurity(join(this.directory, name), false, undefined, true);
      return JSON.parse(readFileSync(fd, "utf8"));
    } finally { closeSync(fd); }
  }

  private publish(name: string, value: unknown): void {
    this.guard();
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      renameSync(temporary, join(this.directory, name));
    }
    finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }

  identity(): Identity {
    const identity = identitySchema.parse(this.read("identity.json"));
    const privateKey = createPrivateKey(identity.privateKey);
    if (privateKey.asymmetricKeyType !== "ed25519" || createPublicKey(privateKey).export({ format: "jwk" }).x !== identity.publicKey
      || identity.deviceId !== createHash("sha256").update(Buffer.from(identity.publicKey, "base64url")).digest("hex")) throw new Error("Gateway device key/fingerprint mismatch");
    return identity;
  }

  token(deviceId: string): Token | undefined {
    const raw = this.read("operator-token.json");
    if (raw === undefined) return undefined;
    const token = tokenSchema.parse(raw);
    if (token.deviceId !== deviceId) throw new Error("Gateway device token belongs to a different identity");
    return token;
  }

  saveToken(identity: Identity, auth: unknown): void {
    const receipt = z.object({ deviceToken: z.string().min(1), role: z.literal("operator").optional(), scopes: z.array(z.string()) }).parse(auth);
    const previous = this.token(identity.deviceId);
    this.publish("operator-token.json", { version: 1, deviceId: identity.deviceId, clientId: "gateway-client", role: "operator", token: receipt.deviceToken,
      scopes: previous?.token === receipt.deviceToken ? previous.scopes : receipt.scopes });
  }
}

export function signOpenClawDevice(identity: Identity, challenge: unknown, scopes: string[], token: string) {
  const { nonce, ts } = z.object({ nonce: z.string().min(1).refine(value => value.trim().length > 0), ts: z.number().int().nonnegative() }).parse(challenge);
  const payload = ["v3", identity.deviceId, "gateway-client", "cli", "operator", scopes.join(","), String(ts), token, nonce, process.platform, ""].join("|");
  return { id: identity.deviceId, publicKey: identity.publicKey, signedAt: ts, nonce,
    signature: sign(null, Buffer.from(payload), identity.privateKey).toString("base64url") };
}
