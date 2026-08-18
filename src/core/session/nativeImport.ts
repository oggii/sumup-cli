import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DASHBOARD, launchArgs, PROFILE_DIR, resolveBrowserExecutable } from "./capture.js";
import { validateNativeCsv } from "./nativeExport.js";

/**
 * Uploading an edited items CSV through the dashboard's own Importieren flow.
 *
 * There is no import endpoint to call. The button opens a native file picker
 * and fires nothing until a file is chosen, so the request shape was never
 * captured and guessing one would put a 646-item catalogue at risk. Driving the
 * real control is the honest alternative: it is the same code path a human
 * takes, against the same session, with the same server-side validation.
 *
 * It runs in a visible window on purpose. The persistent profile here is a
 * Brave install, and Cloudflare will not let a headless Brave through the auth
 * bounce, so headless silently lands back on the sign-in page. Pass headless
 * when the profile is driven by a real Chrome or Edge.
 */

export interface ImportProbe {
  url: string;
  fileInputs: { attrs: Record<string, string>; visible: boolean }[];
  candidates: { tag: string; text: string; attrs: Record<string, string> }[];
  menuItems: string[];
  buttons: string[];
}

export interface ImportControl {
  selector: string;
  tag: string;
  text: string;
  disabled: boolean;
  visible: boolean;
}

export interface ImportOutcome {
  probe: ImportProbe;
  /** How the file input was reached, so a failure says which step broke. */
  route: string;
  uploaded: boolean;
  /** Text the page showed after the upload, the only confirmation on offer. */
  message: string;
  /** One line per stage of the dialog, for when something goes sideways. */
  steps: string[];
  controls?: ImportControl[];
}

/**
 * Read out of the page as source text rather than as a closure: the TypeScript
 * loader rewrites named functions and injects a __name helper that does not
 * exist in the browser, so a real closure throws ReferenceError there.
 */
const DUMP = `(() => {
  const attrs = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  const label = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 70);
  return {
    fileInputs: [...document.querySelectorAll("input[type=file]")].map((el) => ({
      attrs: attrs(el),
      visible: !!el.offsetParent,
    })),
    candidates: [...document.querySelectorAll("button,a,[role=button],[role=menuitem]")]
      .map((el) => ({ tag: el.tagName, text: label(el), attrs: attrs(el) }))
      .filter((c) => /import|hochlad|upload|csv|datei/i.test(c.text + JSON.stringify(c.attrs)))
      .slice(0, 20),
    menuItems: [...document.querySelectorAll("[role=menuitem],[role=option],[role=menuitemradio]")]
      .map(label)
      .filter(Boolean)
      .slice(0, 30),
    buttons: [...document.querySelectorAll("button,[role=button]")]
      .map(label)
      .filter(Boolean)
      .slice(0, 50),
  };
})()`;

/**
 * SumUp ships stable `data-selector` attributes on the import flow, e.g.
 * SELECTORS.IMPORT.CONTINUE_BUTTON. They survive translation and class-name
 * churn, so the flow is driven by those rather than by button labels.
 */
const IMPORT_STATE = `(() => {
  const label = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  return [...document.querySelectorAll("[data-selector]")]
    .filter((el) => /IMPORT/i.test(el.getAttribute("data-selector") || ""))
    .map((el) => ({
      selector: el.getAttribute("data-selector"),
      tag: el.tagName,
      text: label(el),
      disabled: el.getAttribute("aria-disabled") === "true" || el.disabled === true,
      visible: !!el.offsetParent,
    }))
    .slice(0, 30);
})()`;

/**
 * What the importer itself is saying.
 *
 * Scoped to the import dialog on purpose: the Artikel page carries a stack of
 * unrelated onboarding popovers that are also role=dialog, and a page-wide
 * sweep reports those as if they were the import result.
 */
const RESULT = `(() => {
  const seen = new Set();
  const out = [];
  const push = (t) => {
    const s = (t || "").replace(/\\s+/g, " ").trim();
    if (s && s.length < 400 && !seen.has(s)) { seen.add(s); out.push(s); }
  };
  const scopes = [...document.querySelectorAll("[data-selector]")].filter((el) =>
    /IMPORT/i.test(el.getAttribute("data-selector") || ""),
  );
  for (const el of scopes) {
    if (/HEADER|STATUS|RESULT|ERROR|SUCCESS|SUMMARY|DESCRIPTION/i.test(el.getAttribute("data-selector"))) {
      push(el.textContent);
    }
  }
  for (const el of document.querySelectorAll('[role=alert],[role=status],[class*="toast" i],[class*="snackbar" i]')) {
    push(el.textContent);
  }
  return out.slice(0, 10);
})()`;

export interface ImportOptions {
  dryRun?: boolean;
  headless?: boolean;
  /** How long to wait for the page to report a result, default 45s. */
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export async function importCatalogCsv(
  file: string,
  opts: ImportOptions = {},
): Promise<ImportOutcome> {
  const csv = readFileSync(file, "utf8");
  const check = validateNativeCsv(csv);
  if (!check.ok) {
    throw new Error(
      `${basename(file)} is not a valid items CSV, so it was not uploaded:\n  ` +
        check.problems.join("\n  "),
    );
  }
  const say = opts.onProgress ?? (() => {});
  say(`${basename(file)}: ${check.rowCount} data row(s), validated`);

  const { chromium } = await import("playwright-core");
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: opts.headless ?? false,
    executablePath: resolveBrowserExecutable(),
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
    ...launchArgs(),
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(DASHBOARD, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Same bounce as the session capture: a signed-in profile still detours
    // through auth.sumup.com, so let the redirects settle before judging.
    if (/auth\.sumup\.com/.test(page.url())) {
      say("bounced through auth, waiting for the redirect back");
      await page.waitForURL(/me\.sumup\.com/, { timeout: 60_000 }).catch(() => {
        throw new Error(
          "The browser profile is not signed in. Run `sumup auth capture --login` first.",
        );
      });
    }
    await page.waitForTimeout(6000);

    let probe = (await page.evaluate(DUMP)) as ImportProbe;
    probe.url = page.url();
    let route = "input[type=file] already in the DOM";

    // The input is not in the page until the import flow is opened, and that
    // sits two levels deep: an overflow menu in the toolbar, then an Import
    // entry inside it. Walk those two levels rather than assuming either.
    //
    // "Aktionen" is deliberately not an opener: every product row has one, so
    // matching it hits a row menu instead of the toolbar.
    if (probe.fileInputs.length === 0) {
      const openers = [/weitere optionen/i, /more options/i, /importieren/i, /import/i];
      for (const name of openers) {
        const control = page.getByRole("button", { name }).first();
        if ((await control.count()) === 0) continue;
        say(`no file input yet, opening ${String(name)}`);
        await control.click({ timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(2000);
        probe = (await page.evaluate(DUMP)) as ImportProbe;
        probe.url = page.url();
        if (probe.fileInputs.length > 0) {
          route = `revealed by ${String(name)}`;
          break;
        }

        // Second level: whatever the menu now offers that reads like import.
        for (const role of ["menuitem", "button", "link"] as const) {
          const entry = page.getByRole(role, { name: /import/i }).first();
          if ((await entry.count()) === 0) continue;
          say(`clicking the ${role} matching /import/i`);
          await entry.click({ timeout: 5000 }).catch(() => undefined);
          await page.waitForTimeout(2500);
          probe = (await page.evaluate(DUMP)) as ImportProbe;
          probe.url = page.url();
          if (probe.fileInputs.length > 0) {
            route = `revealed by ${String(name)} then the ${role} matching /import/i`;
            break;
          }
        }
        if (probe.fileInputs.length > 0) break;
      }
    }

    if (probe.fileInputs.length === 0) {
      say("no file input appeared; the flow could not be opened");
      return { probe, route, uploaded: false, message: "", steps: [] };
    }

    // Attaching the file only fills the dialog in; nothing is submitted until
    // Weiter is pressed, so a dry run can safely go this far and report what
    // the importer actually offers.
    say(`attaching the file via ${route}`);
    await page.setInputFiles("input[type=file]", file);
    await page.waitForTimeout(3000);
    const steps: string[] = [];
    const state = (await page.evaluate(IMPORT_STATE)) as ImportControl[];
    steps.push(
      "after attaching: " +
        state
          .filter((c) => c.visible)
          .map((c) => `${c.selector}${c.disabled ? " (disabled)" : ""}`)
          .join(", "),
    );

    if (opts.dryRun) {
      say("dry run: file attached but not submitted, nothing was imported");
      return { probe, route, uploaded: false, message: "", steps, controls: state };
    }

    // From here the dialog is a short wizard. Advance it by pressing whichever
    // IMPORT control is currently enabled, rather than assuming a fixed number
    // of steps, and stop as soon as nothing is left to press.
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    let pressed = 0;
    while (Date.now() < deadline && pressed < 6) {
      const controls = (await page.evaluate(IMPORT_STATE)) as ImportControl[];
      const next = controls.find(
        (c) =>
          c.visible &&
          !c.disabled &&
          c.tag === "BUTTON" &&
          /CONTINUE|CONFIRM|IMPORT_BUTTON|SUBMIT|FINISH|DONE/i.test(c.selector) &&
          !/DOWNLOAD|CANCEL|CLOSE/i.test(c.selector),
      );
      if (!next) break;
      say(`pressing ${next.selector}`);
      steps.push(`pressed ${next.selector}`);
      await page
        .locator(`[data-selector="${next.selector}"]`)
        .first()
        .click({ timeout: 10_000 })
        .catch((e) => steps.push(`  click failed: ${String(e).slice(0, 120)}`));
      pressed++;
      await page.waitForTimeout(4000);
    }

    // The importer answers in the page, not in a navigation, so watch for
    // whatever it renders rather than waiting on a request that may not come.
    let message = "";
    const resultDeadline = Date.now() + 30_000;
    while (Date.now() < resultDeadline) {
      const found = (await page.evaluate(RESULT)) as string[];
      if (found.length > 0) {
        message = found.join(" | ");
        break;
      }
      await page.waitForTimeout(2000);
    }

    const finalState = (await page.evaluate(IMPORT_STATE)) as ImportControl[];
    return {
      probe,
      route,
      uploaded: pressed > 0,
      message,
      steps,
      controls: finalState,
    };
  } finally {
    await context.close();
  }
}
