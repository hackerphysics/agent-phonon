import { defineConfig } from "tsup";

// Bundle the daemon into a self-contained package: the internal
// @agent-phonon/core and @agent-phonon/protocol sources are inlined, so the
// published `agent-phonon` package does not depend on unpublished workspace
// packages. Real third-party deps (ws, zod, node:*) stay external.
export default defineConfig({
  entry: ["src/cli.ts", "src/daemon.ts"],
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Inline workspace packages; keep third-party + node builtins external.
  noExternal: [/@agent-phonon\//],
  external: ["ws", "zod"],
  platform: "node",
  // esbuild strips the `node:` prefix from builtin imports. Most builtins work
  // either way, but prefix-only ones (e.g. `node:sqlite`) break. Restore the
  // prefix on all builtins after the bundle is written.
  async onSuccess() {
    const { readFileSync, writeFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { builtinModules } = await import("node:module");
    // builtinModules omits experimental prefix-only builtins (e.g. sqlite, test).
    const builtins = [...new Set([...builtinModules, "sqlite", "test"])].filter((m) => !m.startsWith("_"));
    const re = new RegExp(`(from\\s*|import\\s*\\(?\\s*)"(${builtins.map((b) => b.replace(/\//g, "\\/")).join("|")})"`, "g");
    for (const f of readdirSync("dist").filter((n) => n.endsWith(".js"))) {
      const p = join("dist", f);
      const src = readFileSync(p, "utf8");
      const fixed = src.replace(re, (_m, pre, mod) => `${pre}"node:${mod}"`);
      if (fixed !== src) writeFileSync(p, fixed);
    }
  },
  // Tests are run from src via tsc separately; tsup only builds shippable code.
});
