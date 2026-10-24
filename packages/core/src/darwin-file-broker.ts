import { spawn } from "node:child_process";
import { PhononError } from "./rpc.js";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_WIRE_BYTES = 4 * Math.ceil(MAX_BYTES / 3) + 64 * 1024;
const PYTHON = "/usr/bin/python3";
const SCRIPT = String.raw`
import base64, errno, json, os, stat, sys

def fail(code):
    raise OSError(code, "secure file operation failed")

def run(value):
    if os.open not in os.supports_dir_fd or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        fail(errno.ENOTSUP)
    if value.get("operation") == "probe":
        return {"supported": True}
    root, relative = value["root"], value["relative"]
    if not isinstance(root, str) or not root.startswith("/") or "\x00" in root:
        fail(errno.EINVAL)
    if not isinstance(relative, str) or relative.startswith("/") or "\x00" in relative:
        fail(errno.EINVAL)
    root_parts = [part for part in root.split("/") if part]
    parts = relative.split("/")
    if not parts or len(root_parts) + len(parts) > 512 or any(part in ("", ".", "..") for part in root_parts + parts):
        fail(errno.EINVAL)
    handles = []
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        current = os.open("/", flags)
        handles.append(current)
        for part in root_parts:
            current = os.open(part, flags, dir_fd=current)
            handles.append(current)
        writing = value["operation"] == "write"
        for part in parts[:-1]:
            if writing and value.get("createDirs", True):
                try:
                    os.mkdir(part, 0o700, dir_fd=current)
                except FileExistsError:
                    pass
            current = os.open(part, flags, dir_fd=current)
            handles.append(current)
        if writing:
            data = base64.b64decode(value["data"], validate=True)
            if len(data) > 20 * 1024 * 1024:
                fail(errno.EFBIG)
            mode = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
            if not value.get("overwrite", True):
                mode |= os.O_EXCL
            file = os.open(parts[-1], mode, 0o600, dir_fd=current)
            handles.append(file)
            if not stat.S_ISREG(os.fstat(file).st_mode):
                fail(errno.EINVAL)
            os.ftruncate(file, 0)
            view = memoryview(data)
            while view:
                written = os.write(file, view)
                if written <= 0:
                    fail(errno.EIO)
                view = view[written:]
            os.fsync(file)
            return {"sizeBytes": len(data), "written": True}
        if value["operation"] != "read":
            fail(errno.EINVAL)
        file = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
        handles.append(file)
        before = os.fstat(file)
        if not stat.S_ISREG(before.st_mode):
            fail(errno.EINVAL)
        limit = value.get("maxBytes", 20 * 1024 * 1024)
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 20 * 1024 * 1024:
            fail(errno.EINVAL)
        if before.st_size > limit and "maxBytes" not in value:
            fail(errno.EFBIG)
        chunks, total = [], 0
        while total < limit:
            chunk = os.read(file, min(65536, limit - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        size = max(before.st_size, os.fstat(file).st_size)
        return {"data": base64.b64encode(b"".join(chunks)).decode("ascii"), "sizeBytes": size, "truncated": size > total}
    finally:
        for handle in reversed(handles):
            os.close(handle)

try:
    raw = sys.stdin.buffer.read(${MAX_WIRE_BYTES} + 1)
    if len(raw) > ${MAX_WIRE_BYTES}:
        fail(errno.EFBIG)
    result = run(json.loads(raw))
    print(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
except OSError as error:
    print(json.dumps({"ok": False, "errno": error.errno}, separators=(",", ":")))
except Exception:
    print(json.dumps({"ok": False, "errno": errno.EINVAL}, separators=(",", ":")))
`;

function invoke(input: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-I", "-S", "-B", "-c", SCRIPT], {
      cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = []; let count = 0, stderr = 0, failed = false;
    const fail = () => { if (!failed) { failed = true; child.kill(); reject(new PhononError("errPolicyDenied", "secure macOS file broker unavailable")); } };
    const timer = setTimeout(fail, 30000);
    child.once("error", fail);
    child.stdin.once("error", fail);
    child.stdout.on("data", (chunk: Buffer) => { count += chunk.length; if (count > MAX_WIRE_BYTES) fail(); else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.length; if (stderr > 8192) fail(); });
    child.once("close", code => {
      clearTimeout(timer); if (failed) return;
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (code !== 0 || typeof reply?.ok !== "boolean") throw new Error("invalid broker response");
        if (!reply.ok) {
          const error = new PhononError([20, 40, 62, 95, 102].includes(reply.errno) ? "errPolicyDenied" : "errInvalidParams", "secure file operation refused") as PhononError & { errno?: number };
          error.errno = reply.errno; reject(error); return;
        }
        resolve(reply.result);
      } catch { reject(new PhononError("errPolicyDenied", "secure macOS file broker unavailable")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

let supported: Promise<boolean> | undefined;
export function darwinFileBrokerAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(false);
  return supported ??= invoke({ operation: "probe" }).then(value => value.supported === true, () => false);
}

export async function darwinFileRead(root: string, relative: string, maxBytes?: number) {
  if (!await darwinFileBrokerAvailable()) throw new PhononError("errPolicyDenied", "secure macOS file broker unavailable");
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES)) throw new PhononError("errInvalidParams", "file read limit exceeds 20 MiB");
  return invoke({ operation: "read", root, relative, ...(maxBytes === undefined ? {} : { maxBytes }) });
}

export async function darwinFileWrite(root: string, relative: string, data: Buffer, overwrite: boolean, createDirs: boolean) {
  if (!await darwinFileBrokerAvailable()) throw new PhononError("errPolicyDenied", "secure macOS file broker unavailable");
  if (data.length > MAX_BYTES) throw new PhononError("errInvalidParams", "file write exceeds 20 MiB");
  return invoke({ operation: "write", root, relative, data: data.toString("base64"), overwrite, createDirs });
}
