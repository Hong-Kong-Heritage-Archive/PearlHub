const defaultDevelopmentCorsOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

export function parseDevelopmentCorsOrigins(value: string | undefined): string[] {
  const origins = value === undefined
    ? defaultDevelopmentCorsOrigins
    : value.split(",").map((origin) => origin.trim()).filter(Boolean);
  const normalized = new Set<string>();

  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("PEARLHUB_DEV_CORS_ORIGINS must be a comma-separated list of HTTP(S) origins.");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
    ) {
      throw new Error("PEARLHUB_DEV_CORS_ORIGINS must contain HTTP(S) origins without paths or credentials.");
    }
    normalized.add(parsed.origin);
  }

  return [...normalized];
}
