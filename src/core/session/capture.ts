import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".sumup-cli");
export const PROFILE_DIR = join(CONFIG_DIR, "browser-profile");
const COOKIE_PATH = join(CONFIG_DIR, "session-cookie.txt");

export const DASHBOARD = "https://me.sumup.com/de-ch/catalog";

/**
 * The real Chrome or Edge that is installed on the machine.
 *
 * Preferred over Playwright's own Chromium for the interactive login: SumUp
 * puts a Cloudflare Turnstile in front of the sign-in page, and Turnstile
 * refuses to complete on a bundled Chromium build. The checkbox is ticked, the
 * tick disappears, and the challenge silently restarts forever. A genuine
 * Chrome binary driven through the same persistent profile passes it.
 */
function findRealBrowser(): string | undefined {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const roots = [
      process.env["PROGRAMFILES"],
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean) as string[];
    for (const root of roots) {
      candidates.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
      candidates.push(join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));
      candidates.push(join(root, "Vivaldi", "Application", "vivaldi.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    candidates.push("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/microsoft-edge",
      "/usr/bin/brave-browser",
      "/usr/bin/chromium",
    );
  }
  return candidates.find((p) => existsSync(p));
}

/**
 * playwright-core ships no browsers, so reuse whatever Playwright build is
 * already on the machine rather than pulling a 150 MB download.
 */
function findChromium(): string | undefined {
  if (process.env.SUMUP_CHROMIUM_PATH) return process.env.SUMUP_CHROMIUM_PATH;

  const root =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? "", "ms-playwright")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Caches", "ms-playwright")
        : join(homedir(), ".cache", "ms-playwright");

  if (!existsSync(root)) return undefined;

  const builds = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));

  for (const build of builds) {
    for (const rel of [
      join("chrome-win", "chrome.exe"),
      join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      join("chrome-linux", "chrome"),
    ]) {
      const candidate = join(root, build, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The browser the persistent profile is driven with, resolved the same way for
 * every consumer so the login and the import share one profile and one binary.
 */
export function resolveBrowserExecutable(): string {
  const executablePath =
    process.env.SUMUP_CHROMIUM_PATH ?? findRealBrowser() ?? findChromium();
  if (!executablePath) {
    throw new Error(
      "No browser found. Install Chrome or Edge, run `npx playwright install chromium`, " +
        "or point SUMUP_CHROMIUM_PATH at a Chrome or Edge executable.",
    );
  }
  return executablePath;
}

/** Launch flags shared with the login, including the anti-automation hints. */
export function launchArgs(): { ignoreDefaultArgs: string[]; args: string[] } {
  return {
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  };
}

export interface CaptureResult {
  cookiePath: string;
  merchantCode?: string;
  secondsValid?: number;
  loggedIn: boolean;
}

function decodeExp(cookieHeader: string): { exp?: number; merchant?: string } {
  const match = /oidc:token=([^;]+)/.exec(cookieHeader);
  const part = match?.[1]?.split(".")[1];
  if (!part) return {};
  try {
    const payload = JSON.parse(
      Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    ) as { exp?: number; ext?: { classic?: { merchant_code?: string } } };
    return { exp: payload.exp, merchant: payload.ext?.classic?.merchant_code };
  } catch {
    return {};
  }
}

/**
 * Opens the dashboard in a persistent browser profile and saves the resulting
 * session cookie.
 *
 * Merely loading the dashboard makes it mint a fresh 15 minute access token
 * from the long-lived refresh cookie, so once the profile has logged in
 * interactively, later refreshes run headless with no user involvement.
 */
export async function captureSession(
  opts: { login?: boolean; timeoutMs?: number } = {},
): Promise<CaptureResult> {
  const { chromium } = await import("playwright-core");

  // An explicit override always wins. Otherwise take the installed Chrome or
  // Edge, because Cloudflare's Turnstile on the sign-in page does not complete
  // on Playwright's bundled Chromium. The bundled build is only a fallback.
  //
  // Brave counts as a real browser here but its Shields block the scripts
  // Turnstile needs, so the challenge loops. Turn Shields off for
  // auth.sumup.com in the window that opens; the persistent profile keeps it.
  const executablePath = resolveBrowserExecutable();

  mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !opts.login,
    executablePath,
    viewport: { width: 1400, height: 900 },
    // "Chrome is being controlled by automated test software" is itself one of
    // the signals Turnstile scores against, so do not advertise it.
    ...launchArgs(),
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(DASHBOARD, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // A signed-in profile is still bounced through auth.sumup.com to trade the
    // refresh cookie for a new token, and on a Cloudflare-protected flow that
    // takes several redirects. Reading the URL straight after goto therefore
    // says "auth" even when nothing is wrong; wait for the bounce to settle
    // before concluding the profile needs a human.
    if (/auth\.sumup\.com/.test(page.url())) {
      const settle = opts.login ? (opts.timeoutMs ?? 300_000) : 45_000;
      try {
        await page.waitForURL(/me\.sumup\.com/, { timeout: settle });
      } catch {
        throw new Error(
          opts.login
            ? "Timed out waiting for the sign-in to finish."
            : "The saved browser profile is not logged in, or Cloudflare held the redirect.\n" +
              "Run `sumup auth capture --login`, sign in in the window that opens, " +
              "and the session will be reused headlessly from then on.",
        );
      }
      await page.goto(DASHBOARD, { waitUntil: "domcontentloaded" });
    }

    // The token is minted during page bootstrap, so wait for it to settle.
    await page.waitForTimeout(2500);

    const cookies = await context.cookies();
    const header = cookies
      .filter((c) => c.name.startsWith("oidc:"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    if (!header.includes("oidc:token=")) {
      throw new Error("Loaded the dashboard but found no oidc:token cookie.");
    }

    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(COOKIE_PATH, header + "\n", { mode: 0o600 });

    const { exp, merchant } = decodeExp(header);
    return {
      cookiePath: COOKIE_PATH,
      merchantCode: merchant,
      secondsValid: exp ? exp - Math.floor(Date.now() / 1000) : undefined,
      loggedIn: true,
    };
  } finally {
    await context.close();
  }
}
