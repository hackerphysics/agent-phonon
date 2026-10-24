import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { Parser, type ReadEntry } from "tar";
import { PhononError } from "./rpc.js";

export const SKILL_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 16 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024, metadataBytes: 64 * 1024,
  entries: 4096, pathBytes: 2048, depth: 64, preparations: 2,
});
export interface SkillArchiveSource { format: "tar.gz"; contentBase64: string; sha256?: string; sizeBytes?: number }
export interface PreparedSkillArchive {
  hash: string;
  directories: string[];
  files: Array<{ path: string; data: Buffer;executable?:boolean }>;
}
const inflate = promisify(gunzip);
let preparations = 0;
const invalid = (reason: string) => new PhononError("errSkillInstallFailed", "skill archive " + reason);

function portablePath(path: string, directory: boolean): string {
  if (typeof path !== "string" || Buffer.byteLength(path) > SKILL_ARCHIVE_LIMITS.pathBytes
    || /[\p{Cc}\ufffd<>:"\\|?*]/u.test(path) || path.startsWith("/")) throw invalid("has an unsafe path");
  while (path.startsWith("./")) path = path.slice(2);
  if (directory) path = path.replace(/\/+$/, "");
  if (directory && (path === "." || path === "")) return "";
  const parts = path.split("/");
  if (parts.length > SKILL_ARCHIVE_LIMITS.depth || parts.some(part => !part || Buffer.byteLength(part) > 255 || part.length > 255 || part === "." || part === ".."
    || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i.test(part.split(".")[0]!.trimEnd())))
    throw invalid("has an unsafe path");
  return path;
}

function parseTar(bytes: Buffer, hash: string): Promise<PreparedSkillArchive> {
  return new Promise((resolve, reject) => {
    const parser = new Parser({ strict: true, maxMetaEntrySize: SKILL_ARCHIVE_LIMITS.metadataBytes });
    const nodes = new Map<string, { path: string; directory: boolean; explicit: boolean }>();
    const files: PreparedSkillArchive["files"] = [];
    let failed = false, eof = false, entries = 0, total = 0;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      const cause = error instanceof PhononError ? error : invalid("is malformed or unsupported");
      reject(cause); parser.abort(cause);
    };
    const count = () => { if (++entries > SKILL_ARCHIVE_LIMITS.entries) throw invalid("has too many entries"); };
    const register = (path: string, directory: boolean) => {
      const parts = path ? path.split("/") : [""];
      for (let n = 0; n < parts.length; n++) {
        const name = parts.slice(0, n + 1).join("/"), key = name.normalize("NFC").toLowerCase();
        const explicit = n === parts.length - 1, folder = !explicit || directory, previous = nodes.get(key);
        if (previous && (previous.path !== name || previous.directory !== folder || explicit && previous.explicit))
          throw invalid("contains duplicate, aliased or conflicting paths");
        if (previous) previous.explicit ||= explicit;
        else nodes.set(key, { path: name, directory: folder, explicit });
        if (nodes.size > SKILL_ARCHIVE_LIMITS.entries) throw invalid("has too many paths");
      }
    };
    parser.on("error", fail);
    parser.on("warn", () => fail(invalid("is malformed or unsupported")));
    parser.on("ignoredEntry", () => fail(invalid("contains an unsupported entry")));
    parser.on("meta", (body: string) => {
      if (failed) return;
      try {
        count();
        if (Buffer.byteLength(body) > SKILL_ARCHIVE_LIMITS.metadataBytes || /GNU\.sparse|SCHILY\.(?:filetype|realsize)/.test(body))
          throw invalid("contains unsupported or oversized metadata");
      } catch (error) { fail(error); }
    });
    parser.on("entry", (entry: ReadEntry) => {
      if (failed) return;
      try {
        count();
        const directory = entry.type === "Directory";
        if (!directory && entry.type !== "File" && entry.type !== "OldFile" || entry.linkpath
          || entry.nlink !== undefined && entry.nlink !== 1 || !Number.isSafeInteger(entry.size) || entry.size < 0
          || entry.header.size === undefined || !Number.isSafeInteger(entry.header.size) || entry.header.size < 0)
          throw invalid("must contain only ordinary files and directories");
        // Validate raw names too: the library normalizes Windows separators.
        portablePath(entry.header.path!, directory);
        const path = portablePath(entry.path, directory);
        register(path, directory);
        if (directory) { entry.resume(); return; }
        if (entry.size > SKILL_ARCHIVE_LIMITS.fileBytes || (total += entry.size) > SKILL_ARCHIVE_LIMITS.expandedBytes)
          throw invalid("exceeds its file or total byte limit");
        const chunks: Buffer[] = []; let size = 0;
        entry.on("error", fail);
        entry.on("data", (chunk: Buffer) => {
          if (failed) return;
          size += chunk.length;
          if (size > entry.size || size > SKILL_ARCHIVE_LIMITS.fileBytes) { fail(invalid("has an invalid file size")); return; }
          chunks.push(chunk);
        });
        entry.on("end", () => {
          if (failed) return;
          if (entry.invalid || size !== entry.size) { fail(invalid("has a truncated file")); return; }
          files.push({ path, data: Buffer.concat(chunks, size),...(entry.mode&&entry.mode&0o111?{executable:true}:{}) });
        });
        entry.resume();
      } catch (error) { fail(error); }
    });
    parser.on("eof", () => { eof = true; });
    parser.on("end", () => {
      if (failed) return;
      if (!eof || files.length === 0) { fail(invalid("has no complete file archive")); return; }
      resolve({ hash, files, directories: [...nodes.values()].filter(node => node.directory && node.path)
        .map(node => node.path).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)) });
    });
    try {
      // Block-sized writes locate the parser's EOF without a second tar parser.
      for (let offset = 0; offset < bytes.length && !failed; offset += 512) {
        parser.write(bytes.subarray(offset, offset + 512));
        if (eof) {
          if (bytes.subarray(offset + 512).some(byte => byte !== 0)) throw invalid("has data after its end marker");
          break;
        }
      }
      if (!failed) parser.end();
    } catch (error) { fail(error); }
  });
}

/** Validate a bounded byte plan without extracting any archive onto disk. */
export async function prepareSkillArchive(source: SkillArchiveSource): Promise<PreparedSkillArchive> {
  if (preparations >= SKILL_ARCHIVE_LIMITS.preparations) throw invalid("preparation is busy");
  preparations++;
  try {
    const text = source.contentBase64;
    if (source.format !== "tar.gz" || typeof text !== "string" || !text.length || text.length % 4 !== 0
      || text.length > Math.ceil(SKILL_ARCHIVE_LIMITS.compressedBytes / 3) * 4 || /[^A-Za-z0-9+/=]/.test(text))
      throw invalid("has invalid or oversized base64");
    const compressed = Buffer.from(text, "base64");
    if (compressed.length > SKILL_ARCHIVE_LIMITS.compressedBytes || compressed.toString("base64") !== text
      || source.sizeBytes !== undefined && source.sizeBytes !== compressed.length) throw invalid("has an invalid encoded size");
    const hash = createHash("sha256").update(compressed).digest("hex");
    if (source.sha256 !== undefined && source.sha256 !== hash) throw invalid("sha256 mismatch");
    let bytes: Buffer;
    try { bytes = await inflate(compressed, { maxOutputLength: SKILL_ARCHIVE_LIMITS.expandedBytes }); }
    catch { throw invalid("has invalid gzip data or exceeds its expanded byte limit"); }
    if (bytes.length < 1024 || bytes.length % 512 !== 0) throw invalid("has an incomplete tar block");
    return await parseTar(bytes, hash);
  } finally { preparations--; }
}
