import * as p from "@clack/prompts";
import color from "picocolors";
import { isPrivateOrLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";

export function normalizeRocketChatUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const pathname = url.pathname.replace(/\/+$/, "");
  return pathname.length > 1 ? `${url.origin}${pathname}` : url.origin;
}

export function isLocalRocketChatUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  return isPrivateOrLoopbackHost(url.hostname.toLowerCase());
}

export function handleCancel(value: unknown): never | void {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
}

export async function promptText(opts: Parameters<typeof p.text>[0]): Promise<string> {
  const value = await p.text(opts);
  handleCancel(value);
  return value as string;
}

export async function promptPassword(opts: Parameters<typeof p.password>[0]): Promise<string> {
  const value = await p.password(opts);
  handleCancel(value);
  return value as string;
}

export async function promptTwoFactorCode(opts: {
  message?: string;
  method?: string;
  allowEmpty?: boolean;
}): Promise<string> {
  const isEmail = (opts.method ?? "totp") === "email";
  const methodHint = opts.method && opts.method !== "totp" ? ` (${opts.method})` : "";
  const value = await p.text({
    message:
      opts.message ??
      (isEmail
        ? "Email verification code (check your inbox)"
        : `Two-factor authentication code${methodHint}`),
    placeholder: isEmail ? "from email" : "123456",
    validate: (v) => {
      const trimmed = (v ?? "").trim();
      if (!trimmed) return opts.allowEmpty ? undefined : "Code is required";
      if (!/^[0-9a-zA-Z\s-]+$/.test(trimmed)) return "Enter the verification code";
      return undefined;
    },
  });
  handleCancel(value);
  return (value as string).replace(/\s+/g, "");
}

export async function promptConfirm(opts: Parameters<typeof p.confirm>[0]): Promise<boolean> {
  const value = await p.confirm(opts);
  handleCancel(value);
  return value as boolean;
}

export async function promptSelect<T>(opts: Parameters<typeof p.select>[0]): Promise<T> {
  const value = await p.select(opts);
  handleCancel(value);
  return value as T;
}

export async function promptAutocomplete<T>(
  opts: Parameters<typeof p.autocomplete>[0],
): Promise<T> {
  const value = await p.autocomplete(opts);
  handleCancel(value);
  return value as T;
}

export async function promptAutocompleteMultiselect<T>(
  opts: Parameters<typeof p.autocompleteMultiselect>[0],
): Promise<T[]> {
  const value = await p.autocompleteMultiselect(opts);
  handleCancel(value);
  return value as T[];
}

export async function withSpinner<T>(message: string, task: () => Promise<T>): Promise<T> {
  const spinner = p.spinner();
  spinner.start(message);
  try {
    const result = await task();
    spinner.stop(color.green("Done"));
    return result;
  } catch (err) {
    spinner.stop(color.red("Failed"));
    throw err;
  }
}

export function printSummary(rows: Array<{ label: string; value: string }>): void {
  const lines = rows.map(({ label, value }) => `${color.dim(label.padEnd(12))} ${value}`);
  p.note(lines.join("\n"), "Configuration");
}

export function printNextSteps(steps: string[]): void {
  p.note(steps.map((s, i) => `${color.dim(`${i + 1}.`)} ${s}`).join("\n"), "Next steps");
}

export async function showServerStatus(url: string, check: () => Promise<boolean>): Promise<void> {
  const online = await check();
  if (online) {
    p.log.success(`Rocket.Chat server: ${color.green("online")} (${color.dim(url)})`);
  } else {
    p.log.error(`Rocket.Chat server: ${color.red("offline")} (${color.dim(url)})`);
  }
}

export { p as prompts, color };
