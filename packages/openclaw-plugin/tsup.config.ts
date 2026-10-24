import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/native-interactions.ts", "src/peer-context.ts"],
  format: ["esm"], target: "es2022", platform: "node", outDir: "dist",
  dts: true, clean: true, sourcemap: false, splitting: false,
  noExternal: [/@agent-phonon\//, "zod", "zod-to-json-schema"],
  external: ["openclaw/plugin-sdk/plugin-entry", "openclaw/plugin-sdk/command-auth-native"],
});
