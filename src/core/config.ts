import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv();
loadDotenv({ path: join(process.cwd(), ".env.local"), override: true });

export interface Profile {
  /** Public API key, sk_live_* or sk_test_* */
  apiKey?: string;
  /** Merchant code, e.g. MXXXXXXX. Resolved from /v0.1/me when absent. */
  merchantCode?: string;
  /** Bearer token lifted from a logged-in me.sumup.com session. */
  sessionToken?: string;
  /** Cookie header for the internal API, when it is cookie- rather than token-authenticated. */
  sessionCookie?: string;
  apiBase?: string;
}

export interface ConfigFile {
  defaultProfile?: string;
  profiles?: Record<string, Profile>;
}

const CONFIG_DIR = join(homedir(), ".sumup-cli");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function configPath(): string {
  return CONFIG_PATH;
}

function readConfigFile(): ConfigFile {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ConfigFile;
  } catch (err) {
    throw new Error(
      `Config at ${CONFIG_PATH} is not valid JSON: ${(err as Error).message}`,
    );
  }
}

export function writeProfile(name: string, profile: Profile): void {
  const cfg = readConfigFile();
  cfg.profiles = { ...cfg.profiles, [name]: { ...cfg.profiles?.[name], ...profile } };
  cfg.defaultProfile ??= name;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

export function listProfiles(): string[] {
  return Object.keys(readConfigFile().profiles ?? {});
}

/**
 * Environment always wins over the config file, so a shell one-liner can
 * override a stored profile without editing anything.
 */
/**
 * Session cookies are long and expire every ~15 minutes, so a file is a far
 * more practical carrier than an env var that has to be re-exported each time.
 */
function readCookieFile(): string | undefined {
  const explicit = process.env.SUMUP_SESSION_COOKIE_FILE;
  const candidates = [
    explicit,
    join(process.cwd(), ".session-cookie.txt"),
    join(CONFIG_DIR, "session-cookie.txt"),
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    }
  }
  return undefined;
}

export function resolveProfile(name?: string): Profile {
  const cfg = readConfigFile();
  const key = name ?? process.env.SUMUP_PROFILE ?? cfg.defaultProfile;
  const stored = key ? (cfg.profiles?.[key] ?? {}) : {};

  if (name && !cfg.profiles?.[name]) {
    throw new Error(
      `No profile named "${name}". Known profiles: ${listProfiles().join(", ") || "(none)"}`,
    );
  }

  return {
    apiKey: process.env.SUMUP_API_KEY || stored.apiKey,
    merchantCode: process.env.SUMUP_MERCHANT_CODE || stored.merchantCode,
    sessionToken: process.env.SUMUP_SESSION_TOKEN || stored.sessionToken,
    sessionCookie:
      process.env.SUMUP_SESSION_COOKIE || stored.sessionCookie || readCookieFile(),
    apiBase: process.env.SUMUP_API_BASE || stored.apiBase || "https://api.sumup.com",
  };
}

export function requireApiKey(profile: Profile): string {
  if (!profile.apiKey) {
    throw new Error(
      "No SumUp API key. Set SUMUP_API_KEY, or run: sumup auth login --api-key sk_live_...\n" +
        "Create one at https://me.sumup.com/ under Developer settings -> API keys.",
    );
  }
  return profile.apiKey;
}

export function requireSession(profile: Profile): Profile {
  if (!profile.sessionToken && !profile.sessionCookie) {
    throw new Error(
      "This command needs a me.sumup.com session (the public API has no catalog endpoints).\n" +
        "Run: sumup auth session --help",
    );
  }
  return profile;
}
