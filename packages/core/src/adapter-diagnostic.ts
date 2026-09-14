/** Bounded native failure detail; never include configured auth material verbatim. */
export function adapterDiagnostic(text: string, secrets: Array<string | undefined> = []): string {
  let safe = text;
  for (const value of [...secrets, ...Object.entries(process.env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i.test(key)).map(([,value]) => value)]) {
    if (value && value.length >= 6) safe = safe.split(value).join("[REDACTED]");
  }
  return safe
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]+)\b/g, "[REDACTED]")
    .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[-_]?key|access[-_]?token|auth[-_]?token|password|authorization)["']?\s*[:=]\s*["']?)[^\s,}"']+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@")
    .slice(-2000);
}
