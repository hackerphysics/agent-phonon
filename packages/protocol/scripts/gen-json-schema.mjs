import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { METHODS, METHOD_NAMES } from "../dist/schemas/methods.js";

// 从已编译的 dist 读方法注册表，导出 JSON Schema 供非 TS 服务端消费。
const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "dist", "json-schema");
mkdirSync(outDir, { recursive: true });

const index = {};
for (const name of METHOD_NAMES) {
  const spec = METHODS[name];
  const entry = {
    direction: spec.direction,
    kind: spec.kind,
    params: zodToJsonSchema(spec.params, `${name}.params`),
    result: zodToJsonSchema(spec.result, `${name}.result`),
  };
  index[name] = entry;
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(entry, null, 2));
}
writeFileSync(join(outDir, "_index.json"), JSON.stringify(index, null, 2));
console.log(`Wrote JSON Schema for ${METHOD_NAMES.length} methods → ${outDir}`);
