import {
  loginAs,
  TwoFactorRequiredError,
  isTimeoutError,
  verifyAdmin,
} from "./admin-api.js";
import { saveAdmin, loadAdmin } from "./credentials.js";
import {
  color,
  promptPassword,
  promptSelect,
  promptText,
  promptTwoFactorCode,
  prompts as p,
  withSpinner,
} from "./ui.js";
import type { RCLoginResult } from "../types.js";

type AdminLoginReason = "not-admin" | "unauthorized" | "unreachable" | "error";

type AdminLoginResult =
  | { ok: true; auth: RCLoginResult }
  | { ok: false; reason: AdminLoginReason; message?: string };

export async function tryBotLogin(
  rcUrl: string,
  username: string,
  password: string,
): Promise<RCLoginResult | null> {
  return loginForServer(rcUrl, username, password, username);
}

export async function loginForServer(
  rcUrl: string,
  user: string,
  password: string,
  label: string,
): Promise<RCLoginResult | null> {
  return loginWithTwoFactor(rcUrl, user, password, label);
}

/** Log in, prompting for a 2FA code when the server requires it. */
async function loginWithTwoFactor(
  rcUrl: string,
  user: string,
  password: string,
  label: string,
): Promise<RCLoginResult | null> {
  const maxAttempts = 4;
  let transactionId: string | undefined;
  let methods: string[] = ["totp"];

  // Initial login attempt — triggers the 2FA challenge from the server.
  try {
    return await loginAs(rcUrl, user, password);
  } catch (e: unknown) {
    if (!(e instanceof TwoFactorRequiredError)) {
      if (isTimeoutError(e)) {
        p.log.error("Server timed out during login. Check your connection and try again.");
      } else {
        p.log.error(`Login failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return null;
    }
    transactionId = e.challenge.transactionId || undefined;
    methods = e.challenge.methods.length > 0 ? e.challenge.methods : ["totp"];
  }

  // Re-prompt and resubmit with the same transaction ID, avoiding a
  // redundant challenge round-trip on each retry.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const method =
      methods.length > 1
        ? await promptSelect<string>({
            message: "Two-factor method",
            options: methods.map((m) => ({ value: m, label: m })),
          })
        : methods[0] ?? "totp";

    if (method === "email") {
      p.log.info(
        `A verification code should have been emailed to ${color.cyan(label)}. If you don't receive it, the account may not have email 2FA enabled leave empty to abort.`,
      );
    }

    const code = await promptTwoFactorCode({
      message: `Two-factor code for ${label}`,
      method,
      allowEmpty: method === "email",
    });
    if (!code) {
      p.log.error("No code entered. Aborting two-factor login.");
      return null;
    }

    try {
      return await loginAs(rcUrl, user, password, {
        code,
        ...(transactionId ? { transactionId } : {}),
      });
    } catch (inner: unknown) {
      if (inner instanceof TwoFactorRequiredError) {
        transactionId = inner.challenge.transactionId || transactionId;
        methods = inner.challenge.methods.length > 0 ? inner.challenge.methods : methods;
        const retryMethod = inner.challenge.methods[0] ?? method;
        const hint =
          retryMethod === "email"
            ? "Invalid or expired email code. Check your inbox and try again (leave empty to abort)."
            : "Invalid or expired two-factor code. Please try again.";
        p.log.error(hint);
        continue;
      }
      const msg = inner instanceof Error ? inner.message : String(inner);
      if (isTimeoutError(inner)) {
        p.log.error("Server timed out while verifying the code. Check your connection and try again.");
        return null;
      }
      if (/rate.?limit|too many|too many requests/i.test(msg)) {
        p.log.error(
          "Too many login attempts. Rocket.Chat has rate-limited this endpoint. Wait a moment and re-run setup.",
        );
        return null;
      }
      p.log.error(`Login failed: ${msg}`);
      return null;
    }
  }

  p.log.error("Too many two-factor attempts. Re-run setup to try again.");
  return null;
}

export async function resolveAdminAuth(
  rcUrl: string,
  forceFresh = false,
): Promise<RCLoginResult | null> {
  if (!forceFresh) {
    const savedAdmin = (await loadAdmin(rcUrl)) ?? (await loadAdmin());
    if (savedAdmin) {
      const candidateAuth = { userId: savedAdmin.userId, authToken: savedAdmin.authToken };
      const verdict = await verifyAdmin(rcUrl, candidateAuth);
      if (verdict.ok) {
        p.log.success(`Reusing saved admin credentials for ${color.cyan(rcUrl)}`);
        return candidateAuth;
      }
      p.log.warn("Saved admin credentials are invalid for this server. Please log in again.");
    }
  }

  const adminUser = await promptText({
    message: "Admin username",
    validate: (value) => ((value ?? "").trim() ? undefined : "Username is required"),
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const adminPass = await promptPassword({
      message:
        attempt === 1
          ? "Admin password"
          : `Wrong password re-enter for ${adminUser} (${3 - attempt} attempt${3 - attempt === 1 ? "" : "s"} left)`,
      validate: (value) => (value ? undefined : "Password is required"),
    });

    let adminAuth: RCLoginResult | null = null;
    try {
      adminAuth = await loginForServer(rcUrl, adminUser, adminPass, adminUser);
    } catch (e: unknown) {
      if (isTimeoutError(e)) {
        p.log.error("Server timed out during login. Check your connection and try again.");
        return null;
      }
      const message = e instanceof Error ? e.message : String(e);
      p.log.error(`Login failed: ${message}`);
      if (attempt === 3) {
        p.log.error("Too many failed attempts. Re-run setup to try again.");
        return null;
      }
      continue;
    }
    if (!adminAuth) {
      p.log.error("Login failed: Unauthorized. Check the password and try again.");
      if (attempt === 3) {
        p.log.error("Too many failed attempts. Re-run setup to try again.");
        return null;
      }
      continue;
    }

    const result = await withSpinner<AdminLoginResult>("Verifying admin access", async () => {
      try {
        const verdict = await verifyAdmin(rcUrl, adminAuth);
        if (!verdict.ok) {
          return { ok: false, reason: verdict.reason as AdminLoginReason };
        }
        await saveAdmin({
          serverUrl: rcUrl,
          userId: adminAuth.userId,
          authToken: adminAuth.authToken,
        });
        p.log.success(`Logged in as ${color.cyan(adminUser)}`);
        return { ok: true, auth: adminAuth };
      } catch (e: unknown) {
        if (isTimeoutError(e)) {
          return {
            ok: false,
            reason: "error",
            message: "Server timed out while verifying admin status. Check your connection and try again.",
          };
        }
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, reason: "error", message };
      }
    });

    if (result.ok) return result.auth;

    if (result.reason === "not-admin") {
      p.log.error(
        `"${adminUser}" is not an admin (missing 'admin' role). Bot creation requires an admin account.`,
      );
      return null;
    } else if (result.reason === "unauthorized") {
      p.log.error("Admin login expired or invalid. Please log in again.");
    } else if (result.reason === "unreachable") {
      p.log.error("Could not verify admin status Rocket.Chat server unreachable.");
      return null;
    } else if (result.reason === "error") {
      p.log.error(`Login failed: ${result.message}`);
    }

    if (attempt === 3) {
      p.log.error("Too many failed attempts. Re-run setup to try again.");
      return null;
    }
  }

  return null;
}
