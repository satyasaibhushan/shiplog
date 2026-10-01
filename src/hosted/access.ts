export function normalizedOwner(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || !value.includes("@")) return undefined;
  return value.trim().toLowerCase();
}
export function permitsGoogle(
  profile: { email?: unknown; email_verified?: unknown } | undefined,
  configured: unknown,
) {
  const owner = normalizedOwner(configured);
  return !!owner && profile?.email_verified === true && normalizedOwner(profile.email) === owner;
}
export function authenticatedOwner(email: unknown, configured: unknown) {
  const owner = normalizedOwner(configured);
  return owner && normalizedOwner(email) === owner ? owner : undefined;
}
export function permitsOrigin(request: Request, configured: unknown) {
  if (typeof configured !== "string") return false;
  try {
    const url = new URL(configured);
    return url.origin === configured && request.headers.get("origin") === url.origin;
  } catch {
    return false;
  }
}
