import fs from "fs";
import path from "path";
import appleSignin from "apple-signin-auth";

// Verifying the identity token (login) needs only APPLE_CLIENT_ID. The values
// below are additionally required for the OPTIONAL revoke flow (App Store
// Guideline 5.1.1(v): deleting the account must revoke the Apple credential).
const clientID = process.env.APPLE_CLIENT_ID;
const teamID = process.env.APPLE_TEAM_ID;
const keyID = process.env.APPLE_KEY_ID;

/**
 * The .p8 signing key, supplied either inline via `APPLE_PRIVATE_KEY` (raw PEM
 * or base64 — convenient for hosted env vars) or as a file via
 * `APPLE_PRIVATE_KEY_PATH` (convenient locally). Returns null when neither is
 * configured, which downgrades revoke to a no-op instead of throwing.
 */
const resolvePrivateKey = (): string | null => {
    const inline = process.env.APPLE_PRIVATE_KEY?.trim();
    if (inline) {
        if (inline.includes("BEGIN PRIVATE KEY")) {
            // Raw PEM, possibly with the newlines escaped as literal "\n".
            return inline.replace(/\\n/g, "\n");
        }
        try {
            const decoded = Buffer.from(inline, "base64").toString("utf8");
            if (decoded.includes("BEGIN PRIVATE KEY")) return decoded;
        } catch {
            /* not base64 — fall through to the path lookup */
        }
    }

    const keyPath = process.env.APPLE_PRIVATE_KEY_PATH;
    if (keyPath) {
        const abs = path.isAbsolute(keyPath)
            ? keyPath
            : path.resolve(process.cwd(), keyPath);
        if (fs.existsSync(abs)) return fs.readFileSync(abs, "utf8");
        console.warn(`[apple] APPLE_PRIVATE_KEY_PATH not found at ${abs}`);
    }
    return null;
};

export const isAppleRevokeConfigured = (): boolean =>
    Boolean(clientID && teamID && keyID && resolvePrivateKey());

// A short-lived client secret JWT signed with the .p8 key. Apple allows up to
// ~6 months; we keep it to 5 minutes since it's minted fresh per request.
const buildClientSecret = (): string => {
    const privateKey = resolvePrivateKey();
    if (!clientID || !teamID || !keyID || !privateKey) {
        throw new Error(
            "Sign in with Apple revoke is not configured (need APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID and a private key).",
        );
    }
    return appleSignin.getClientSecret({
        clientID,
        teamID,
        keyIdentifier: keyID,
        privateKey,
        expAfter: 300,
    });
};

/**
 * Exchange the native authorization code for a refresh token we persist so the
 * user's Apple credential can be revoked later on account deletion. Best-effort:
 * returns null and never throws, so a login is never blocked by it.
 */
export const exchangeAppleAuthCode = async (
    code: string,
): Promise<string | null> => {
    if (!code || !isAppleRevokeConfigured()) return null;
    try {
        const tokens = await appleSignin.getAuthorizationToken(code, {
            clientID: clientID!,
            clientSecret: buildClientSecret(),
            redirectUri: "", // native app — no redirect URI
        });
        return tokens.refresh_token || null;
    } catch (err) {
        console.warn("[apple] authorization-code exchange failed:", err);
        return null;
    }
};

/**
 * Revoke a stored Apple refresh token. Best-effort — never throws — so it can
 * be called inline from account deletion without risking the deletion itself.
 */
export const revokeAppleToken = async (refreshToken: string): Promise<void> => {
    if (!refreshToken || !isAppleRevokeConfigured()) return;
    try {
        await appleSignin.revokeAuthorizationToken(refreshToken, {
            clientID: clientID!,
            clientSecret: buildClientSecret(),
            tokenTypeHint: "refresh_token",
        });
    } catch (err) {
        console.warn("[apple] token revoke failed:", err);
    }
};
