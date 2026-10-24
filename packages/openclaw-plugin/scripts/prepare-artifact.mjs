import { readFile, copyFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2];
if (!output || process.argv.length !== 3 || !isAbsolute(output)) throw new Error("Provide one absolute, new local artifact directory");
const code = await readFile(join(root, "dist/index.js"), "utf8");
const builtins = new Set([...builtinModules, ...builtinModules.map(name => "node:" + name)]);
const validate = specifier => {
  if (!["openclaw/plugin-sdk/plugin-entry", "openclaw/plugin-sdk/command-auth-native"].includes(specifier) && !builtins.has(specifier)) throw new Error("Unbundled runtime dependency: " + specifier);
};
const source = ts.createSourceFile("index.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const visit = node => {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) validate(node.moduleSpecifier.text);
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new Error("Unverifiable dynamic import");
    validate(node.arguments[0].text);
  }
  ts.forEachChild(node, visit);
};
visit(source);
const original = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = await readFile(join(root, "openclaw.plugin.json"));
const runtime = { name: original.name, version: original.version, private: true, license: original.license,
  type: "module", main: "./dist/index.js", openclaw: original.openclaw };
await mkdir(output); // Never replace a user's old export or other directory.
await mkdir(join(output, "dist"));
await writeFile(join(output, "package.json"), JSON.stringify(runtime, null, 2) + "\n");
await writeFile(join(output, "openclaw.plugin.json"), manifest);
await writeFile(join(output, "dist/index.js"), code);
await copyFile(join(root, "THIRD_PARTY_NOTICES.txt"), join(output, "THIRD_PARTY_NOTICES.txt"));
await copyFile(join(root, "../../LICENSE"), join(output, "LICENSE"));
const files = ["package.json", "openclaw.plugin.json", "dist/index.js", "THIRD_PARTY_NOTICES.txt", "LICENSE"];
const checksums = {};
for (const name of files) checksums[name] = createHash("sha256").update(await readFile(join(output, name))).digest("hex");
// Verification metadata is a sidecar, not an unnecessary installed runtime file.
const checksumFile = join(dirname(output), basename(output) + ".sha256.json");
await writeFile(checksumFile, JSON.stringify(checksums, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify({ path: output, checksumFile, files, bytes: Buffer.byteLength(code) }) + "\n");
