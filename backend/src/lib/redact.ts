/**
 * Crash-path secret redaction (production hardening).
 *
 * Fatal conditions (uncaughtException / unhandledRejection) and shutdown
 * failures are logged BEFORE the process exits. Raw error messages and stacks
 * could in principle carry credential material, so every such log line passes
 * through this redactor. Known secret values are masked with `[REDACTED]`;
 * nothing is ever dropped silently — the structure of the error stays visible.
 *
 * Secret VALUES are pulled lazily via the provider so rotated IG session
 * tokens (CST / X-SECURITY-TOKEN) are always the current ones at log time.
 *
 * Secrets covered (per the Render deployment audit):
 *   - IG account password
 *   - IG API key
 *   - IG session CST token
 *   - IG session X-SECURITY-TOKEN (XST)
 *   - Supabase service-role key
 */

/** Values shorter than this are never treated as secrets (avoids mangling logs). */
const MIN_SECRET_LENGTH = 8;

/** Hard cap on a single fatal log line (stacks/bodies can be huge). */
const MAX_FATAL_LOG_CHARS = 4_000;

/** Returns the secret VALUES to mask. Called lazily on every redaction. */
export type SecretProvider = () => Array<string | undefined | null>;

/**
 * Describe any thrown/rejected value as a bounded log string: Error values use
 * their stack (message included), everything else is JSON-stringified with a
 * `String()` fallback. Truncated, NOT redacted — pair with {@link SecretRedactor}.
 */
export function describeUnknown(value: unknown): string {
  let raw: string;
  if (value instanceof Error) {
    raw = value.stack || `${value.name}: ${value.message}`;
  } else if (typeof value === "string") {
    raw = value;
  } else {
    try {
      const json = JSON.stringify(value);
      raw = json === undefined ? String(value) : json;
    } catch {
      raw = String(value); // circular / BigInt / symbol — still log something truthful
    }
  }
  return raw.length > MAX_FATAL_LOG_CHARS
    ? `${raw.slice(0, MAX_FATAL_LOG_CHARS)} …[truncated ${raw.length - MAX_FATAL_LOG_CHARS} chars]`
    : raw;
}

export class SecretRedactor {
  constructor(private readonly getSecrets: SecretProvider) {}

  /** Mask every known secret value inside `text`. */
  redact(text: string): string {
    let out = text;
    for (const secret of this.currentSecrets()) out = out.split(secret).join("[REDACTED]");
    return out;
  }

  /** Describe any thrown/rejected value as a truncated, redacted log line. */
  describe(value: unknown): string {
    return this.redact(describeUnknown(value));
  }

  private currentSecrets(): string[] {
    return this.getSecrets()
      .filter((s): s is string => typeof s === "string" && s.trim().length >= MIN_SECRET_LENGTH)
      .map((s) => s.trim());
  }
}
