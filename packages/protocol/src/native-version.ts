/** Minimum native runtime version, not a whitelist of individually tested builds.
 * Stable floors exclude previews; a prerelease floor also admits later previews.
 * Self-contained so invocation-scoped JS plugins can embed the same comparison.
 */
export function nativeVersionAtLeast(value: unknown, minimum: string): boolean {
  const parse = (input: unknown) => {
    if (typeof input !== "string" || input.length > 256) return;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(input);
    if (!match || match[0] !== input) return;
    const release = match.slice(1, 4).map(Number), pre = match[4]?.split(".");
    if (release.some(n => !Number.isSafeInteger(n)) || pre?.some(p => /^\d+$/.test(p) && (p.length > 1 && p[0] === "0" || !Number.isSafeInteger(Number(p))))) return;
    return {release, pre};
  };
  const actual = parse(value), floor = parse(minimum);
  if (!actual || !floor || actual.pre && !floor.pre) return false;
  for (let i = 0; i < 3; i++) {
    if (actual.release[i]! !== floor.release[i]!) return actual.release[i]! > floor.release[i]!;
  }
  if (!actual.pre) return true;
  if (!floor.pre) return false;
  for (let i = 0; i < Math.max(actual.pre.length, floor.pre.length); i++) {
    const a = actual.pre[i], b = floor.pre[i];
    if (a === undefined || b === undefined) return b === undefined;
    if (a === b) continue;
    const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b);
    if (numericA !== numericB) return numericB;
    return numericA ? Number(a) > Number(b) : a > b;
  }
  return true;
}
