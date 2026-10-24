export type NativeBrokerTarget = "darwin-arm64" | "linux-x64" | "win32-x64";

export function copyNativeFileBroker(
  source: string,
  destination: string,
  target?: NativeBrokerTarget,
): Promise<{destination: string; targets: NativeBrokerTarget[]; sourceSha256: string}>;
