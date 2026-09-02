const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function resolveServerHost(configuredHost: string | undefined, allowRemote?: string): string {
  const host = configuredHost ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host) && allowRemote !== "1") {
    throw new Error("LMS-AiPanel host must be a loopback address unless LMS_AIPANEL_ALLOW_REMOTE=1 is set.");
  }
  return host;
}
