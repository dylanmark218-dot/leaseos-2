export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};

/**
 * The shortest `JWT_SECRET` that may sign a session.
 *
 * HS256's own security proof assumes a key with at least as much entropy as the
 * hash it keys, and 32 bytes is that floor. The number is not a house style
 * preference — a shorter secret is brute-forcible offline against any session
 * token the holder already has, and every session token is handed to a browser.
 */
export const MIN_COOKIE_SECRET_LENGTH = 32;

/**
 * Refuse to start a production server that cannot sign a session safely.
 *
 * `cookieSecret` falls back to `""` so that development and the test suite do
 * not each need a secret configured before they can import this module. That
 * fallback is survivable in those places and is not survivable in production:
 * `signSession` and `verifySession` would both key HS256 with a zero-length
 * key, so anyone could mint a token for any `openId` and `roleProcedure` would
 * then look up that user's real roles and honour every one of them. There is no
 * error at the point of failure — the forged session simply works.
 *
 * So the check happens at boot rather than at the first request. A server that
 * has already accepted traffic and then discovers it cannot authenticate anyone
 * has nowhere useful to put the answer, and a misconfigured deploy that dies
 * immediately is one somebody notices.
 *
 * Throws rather than exiting: the caller decides what a failed start looks like,
 * and a thrown error carries the reason into whatever logs it.
 */
export function assertProductionSecrets(env: typeof ENV = ENV): void {
  if (!env.isProduction) return;

  const problems: string[] = [];

  if (!env.cookieSecret) {
    problems.push(
      "JWT_SECRET is not set. Sessions would be signed and verified with an empty key, " +
        "which lets anyone mint a session for any user."
    );
  } else if (env.cookieSecret.length < MIN_COOKIE_SECRET_LENGTH) {
    // The length, never the secret.
    problems.push(
      `JWT_SECRET is ${env.cookieSecret.length} characters; at least ${MIN_COOKIE_SECRET_LENGTH} are required ` +
        "so that a session token cannot be brute-forced offline."
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production:\n  - ${problems.join("\n  - ")}`
    );
  }
}
