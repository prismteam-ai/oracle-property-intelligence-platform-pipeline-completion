const TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function getGoogleAccessToken(
  credentials: Record<string, string>,
): Promise<string> {
  const cached = credentials.accessToken;
  const expiresAt = Number(credentials.accessTokenExpiresAt ?? 0);
  if (cached && expiresAt > Date.now() + 60_000) return cached;

  const refreshToken = credentials.refreshToken;
  if (!refreshToken) {
    if (cached) return cached;
    throw new Error("Gmail refresh token required for live sync");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET required for Gmail live sync");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  credentials.accessToken = data.access_token;
  credentials.accessTokenExpiresAt = String(Date.now() + (data.expires_in ?? 3600) * 1000);
  return data.access_token;
}
