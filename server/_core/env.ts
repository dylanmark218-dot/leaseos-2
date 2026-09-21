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
 * The shortest `JWT_SECRET` that may sign a session, in BYTES.
 *
 * HS256's security argument assumes a key with at least as much entropy as the
 * hash it keys, and 32 bytes is that floor. The measure is bytes rather than
 * characters because the two differ for exactly the secrets people use here: a
 * 32-character hex string is 16 bytes, and half the entropy the number promises.
 */
export const MIN_COOKIE_SECRET_LENGTH = 32;

/**
 * Refuse to start a production server that cannot authenticate anyone.
 *
 * `cookieSecret` and `appId` fall back to `""` so that development and the test
 * suite do not each need them configured before this module can be imported.
 * That fallback is survivable in those places and is not survivable in
 * production.
 *
 * What an empty `JWT_SECRET` actually does, stated precisely because an earlier
 * version of this comment got it wrong: `jose` refuses a zero-length HS256 key
 * outright — `SignJWT.sign()` throws `DOMException: Zero-length key is not
 * supported`. So the failure is closed, not open: no session can be minted and
 * `verifySession` rejects everything. Nobody forges a session; nobody logs in
 * at all, and the only symptom is a login loop with a stack trace in the server
 * log. The guard exists to turn that into a refusal at boot that names the
 * cause.
 *
 * A SHORT secret is the open failure, and it is why the length floor is here
 * rather than a mere non-empty check: a low-entropy key can be recovered
 * offline from any session token its holder already has, and every session
 * token is handed to a browser.
 *
 * `VITE_APP_ID` is required for a second reason. `verifySession` already
 * refuses a token whose `appId` is not a non-empty string, and `signSession`
 * fills that claim from `ENV.appId` — so with it unset the server mints tokens
 * it will itself reject. It is already mandatory in fact; the only thing
 * missing was saying so before the first request rather than after. Requiring
 * it here is also what makes the appId equality check in `verifySession` do
 * anything at all: that check is conditional on `ENV.appId` being set.
 *
 * Throws rather than exiting: the caller decides what a failed start looks
 * like, and a thrown error carries the reason into whatever logs it.
 */
export function assertProductionSecrets(
  env: typeof ENV = ENV,
  enforce: boolean = env.isProduction
): void {
  if (!enforce) return;

  const problems: string[] = [];

  // Bytes, not characters — see MIN_COOKIE_SECRET_LENGTH.
  const secretBytes = Buffer.byteLength(env.cookieSecret, "utf8");

  if (!env.cookieSecret) {
    problems.push(
      "JWT_SECRET is not set. jose refuses a zero-length HS256 key, so no session " +
        "could be signed or verified and every sign-in would fail."
    );
  } else if (secretBytes < MIN_COOKIE_SECRET_LENGTH) {
    // The length, never the secret.
    problems.push(
      `JWT_SECRET is ${secretBytes} bytes; at least ${MIN_COOKIE_SECRET_LENGTH} are required ` +
        "so that a session token cannot be brute-forced offline."
    );
  }

  if (!env.appId) {
    problems.push(
      "VITE_APP_ID is not set. Sessions are signed with it and verifySession refuses " +
        "a token whose appId is empty, so the server would reject every session it mints."
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production:\n  - ${problems.join("\n  - ")}`
    );
  }
}
