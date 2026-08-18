#!/usr/bin/env node
import { Command, Option } from "commander";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  configPath,
  listProfiles,
  resolveProfile,
  writeProfile,
} from "../core/config.js";
import { PublicClient } from "../core/public/client.js";
import {
  getTransaction,
  hydrateLineItems,
  listTransactions,
} from "../core/public/transactions.js";
import { listPayouts, payoutsCsv } from "../core/public/payouts.js";
import { SessionClient } from "../core/session/client.js";
import {
  buildCatalogRows,
  CATALOG_COLUMNS,
  fetchCategories,
  fetchInventory,
  fetchItem,
  fetchTaxRates,
  taxPercent,
} from "../core/session/catalog.js";
import {
  ENDPOINTS,
  endpointSummary,
  unverifiedEndpoints,
} from "../core/session/endpoints.js";
import { captureSession } from "../core/session/capture.js";
import { exportCatalogCsv, validateNativeCsv } from "../core/session/nativeExport.js";
import { importCatalogCsv } from "../core/session/nativeImport.js";
import {
  applyRestock,
  assertNativeHeader,
  expectedQuantities,
  parseDeliveries,
} from "../core/session/restock.js";
import {
  cashbookReport,
  extensionFor,
  feeInvoice,
  fiscalExport,
  INVOICE_DOC_TYPES,
  invoicingReport,
  looksBinary,
  monthFrom,
  paymentsStatement,
  payoutStatement,
  REPORTS,
  runExportJob,
  stripBom,
  transactionsReport,
  UNMAPPED_REPORTS,
} from "../core/session/reports.js";
import {
  listPayoutsSession,
  listSales,
  salesByProductSummary,
} from "../core/session/sales.js";
import { computeProfit, formatProfit } from "../core/analysis/profit.js";
import {
  listSubscriptions,
  totalSubscriptionCost,
} from "../core/session/subscriptions.js";
import { catalogCandidates, formatReport, parseHar } from "../core/session/discover.js";
import { emit, fail, type Format } from "./output.js";

const program = new Command();

program
  .name("sumup")
  .description("CLI for SumUp: Umsatze, payouts, inventory, product edits")
  .version("0.1.0")
  .option("-p, --profile <name>", "named profile from ~/.sumup-cli/config.json");

function profile(cmd: Command) {
  return resolveProfile(cmd.optsWithGlobals().profile as string | undefined);
}

function publicClient(cmd: Command): PublicClient {
  return new PublicClient(profile(cmd));
}

const formatOption = new Option("-f, --format <format>", "output format")
  .choices(["table", "json", "csv"])
  .default("table");

// ---------------------------------------------------------------- auth

const auth = program.command("auth").description("credentials and session handling");

auth
  .command("login")
  .description("store a public API key in ~/.sumup-cli/config.json")
  .requiredOption("--api-key <key>", "sk_live_... or sk_test_...")
  .option("--name <name>", "profile name", "default")
  .option("--merchant-code <code>", "pin the merchant code")
  .action(async (opts) => {
    try {
      writeProfile(opts.name, {
        apiKey: opts.apiKey,
        merchantCode: opts.merchantCode,
      });
      const client = new PublicClient(resolveProfile(opts.name));
      const me = await client.me();
      process.stdout.write(
        `saved profile "${opts.name}" to ${configPath()}\n` +
          `merchant: ${me.merchant_profile?.company_name ?? "?"} ` +
          `(${me.merchant_profile?.merchant_code ?? "?"})\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

auth
  .command("session")
  .description("store a me.sumup.com bearer token for the catalog endpoints")
  .option("--token <token>", "bearer token lifted from a logged-in session")
  .option("--cookie <cookie>", "full Cookie header, if the API is cookie-authenticated")
  .option("--name <name>", "profile name", "default")
  .addHelpText(
    "after",
    `
How to get the token:
  1. Log in at https://me.sumup.com and open the item catalog page.
  2. DevTools -> Network -> click any request to api.sumup.com.
  3. Copy the Authorization header value after "Bearer ".
  4. sumup auth session --token <value>

These tokens are short-lived. Re-run this when calls start returning 401.`,
  )
  .action((opts) => {
    if (!opts.token && !opts.cookie) fail(new Error("Pass --token or --cookie."));
    writeProfile(opts.name, {
      sessionToken: opts.token,
      sessionCookie: opts.cookie,
    });
    process.stdout.write(`session stored on profile "${opts.name}"\n`);
  });

auth
  .command("capture")
  .description("refresh the me.sumup.com session cookie using a saved browser profile")
  .option("--login", "open a visible window so you can sign in (needed once, and after 2FA expiry)")
  .option(
    "--timeout <seconds>",
    "how long the window waits for you to finish signing in, default 300",
    Number,
  )
  .addHelpText(
    "after",
    `
First run:
  sumup auth capture --login      opens a browser, you sign in, cookie is saved

After that:
  sumup auth capture              runs headless and mints a fresh token

Loading the dashboard exchanges the long-lived refresh cookie for a new
15-minute access token, so the headless refresh keeps working for as long as
SumUp keeps the profile signed in.`,
  )
  .action(async (opts) => {
    try {
      const result = await captureSession({
        login: opts.login,
        timeoutMs: opts.timeout ? Number(opts.timeout) * 1000 : undefined,
      });
      process.stdout.write(
        `session saved to ${result.cookiePath}\n` +
          `merchant: ${result.merchantCode ?? "?"}\n` +
          `valid for: ${result.secondsValid ?? "?"}s\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

auth
  .command("status")
  .description("show what credentials are configured and whether they work")
  .action(async (_opts, cmd: Command) => {
    const p = profile(cmd);
    process.stdout.write(
      `config:   ${configPath()}\n` +
        `profiles: ${listProfiles().join(", ") || "(none)"}\n` +
        `api key:  ${p.apiKey ? p.apiKey.slice(0, 11) + "..." : "(none)"}\n`,
    );

    if (p.sessionCookie) {
      const client = new SessionClient(p);
      const left = client.secondsRemaining();
      process.stdout.write(
        `session:  ${client.merchantCode() ?? "?"}, ` +
          (left === undefined
            ? "expiry unknown\n"
            : left > 0
              ? `valid ${left}s\n`
              : `EXPIRED ${Math.abs(left)}s ago, run: sumup auth capture\n`),
      );
    } else {
      process.stdout.write("session:  (none), run: sumup auth capture --login\n");
    }

    if (p.apiKey) {
      try {
        const me = await new PublicClient(p).me();
        process.stdout.write(
          `public API OK: ${me.merchant_profile?.company_name ?? "?"} ` +
            `(${me.merchant_profile?.merchant_code ?? "?"})\n`,
        );
      } catch (err) {
        process.stdout.write(`public API FAILED: ${(err as Error).message}\n`);
      }
    }
    const pending = unverifiedEndpoints();
    if (pending.length) {
      process.stdout.write(
        `\nunverified internal endpoints: ${pending.join(", ")}\n` +
          `run \`sumup discover <file.har>\` to confirm them\n`,
      );
    }
  });

// ---------------------------------------------------------------- me

program
  .command("me")
  .description("merchant and account profile")
  .addOption(formatOption)
  .action(async (opts, cmd: Command) => {
    try {
      emit(await publicClient(cmd).me(), { format: opts.format as Format });
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- transactions

const tx = program
  .command("transactions")
  .alias("umsatz")
  .description("sales history");

tx
  .command("list")
  .description("list transactions in a date range")
  .option("--from <date>", "YYYY-MM-DD or ISO timestamp, inclusive")
  .option("--to <date>", "YYYY-MM-DD or ISO timestamp, inclusive")
  .option("--status <list>", "comma-separated: SUCCESSFUL,REFUNDED,FAILED,...")
  .option("--payment-type <list>", "comma-separated: POS,ECOM,CASH,...")
  .option("--max <n>", "stop after n transactions", Number)
  .option("--line-items", "fetch per-sale product breakdown (one call per sale)")
  .addOption(formatOption)
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (opts, cmd: Command) => {
    try {
      const client = publicClient(cmd);
      const rows = await listTransactions(client, {
        from: opts.from,
        to: opts.to,
        statuses: opts.status?.split(","),
        paymentTypes: opts.paymentType?.split(","),
        max: opts.max,
      });
      const data = opts.lineItems ? await hydrateLineItems(client, rows) : rows;
      emit(data, { format: opts.format as Format, out: opts.out });
    } catch (err) {
      fail(err);
    }
  });

tx
  .command("get <idOrCode>")
  .description("one transaction with its line items")
  .addOption(formatOption)
  .action(async (idOrCode: string, opts, cmd: Command) => {
    try {
      const looksLikeId = idOrCode.includes("-") || idOrCode.length > 20;
      const detail = await getTransaction(publicClient(cmd),
        looksLikeId ? { id: idOrCode } : { transactionCode: idOrCode });
      emit(detail, { format: (opts.format as Format) ?? "json" });
    } catch (err) {
      fail(err);
    }
  });

tx
  .command("items")
  .description("flatten sales into one row per product sold")
  .requiredOption("--from <date>", "YYYY-MM-DD")
  .requiredOption("--to <date>", "YYYY-MM-DD")
  .addOption(formatOption)
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (opts, cmd: Command) => {
    try {
      const client = publicClient(cmd);
      const summaries = await listTransactions(client, {
        from: opts.from,
        to: opts.to,
        statuses: ["SUCCESSFUL"],
      });
      const details = await hydrateLineItems(client, summaries);
      const rows = details.flatMap((t) =>
        (t.products ?? []).map((p) => ({
          timestamp: t.timestamp,
          transaction_code: t.transaction_code,
          product: p.name,
          quantity: p.quantity,
          unit_price: p.price,
          vat_rate: p.vat_rate,
          total: p.total_with_vat ?? p.total_price,
          currency: t.currency,
          payment_type: t.payment_type,
        })),
      );
      emit(rows, { format: opts.format as Format, out: opts.out });
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- payouts

const payouts = program.command("payouts").description("payout statements");

payouts
  .command("list")
  .description("payouts in a date range")
  .requiredOption("--from <date>", "YYYY-MM-DD")
  .requiredOption("--to <date>", "YYYY-MM-DD")
  .addOption(formatOption)
  .option("--native-csv", "use SumUp's own CSV rendering instead of ours")
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (opts, cmd: Command) => {
    try {
      const client = publicClient(cmd);
      if (opts.nativeCsv) {
        const csv = await payoutsCsv(client, { from: opts.from, to: opts.to });
        if (opts.out) writeFileSync(opts.out, csv, "utf8");
        else process.stdout.write(csv);
        return;
      }
      const rows = await listPayouts(client, { from: opts.from, to: opts.to });
      emit(rows, { format: opts.format as Format, out: opts.out });
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- catalog

const catalog = program
  .command("catalog")
  .alias("inventar")
  .description("products, stock and categories (uses the me.sumup.com session)");

/** Catalog work needs only the session; the merchant code rides in the token. */
function session(cmd: Command): { client: SessionClient; merchant: string } {
  const p = profile(cmd);
  const client = new SessionClient(p);
  const merchant = p.merchantCode ?? client.merchantCode() ?? "";
  if (!merchant) {
    throw new Error("Could not read a merchant code from the session. Set SUMUP_MERCHANT_CODE.");
  }
  return { client, merchant };
}

catalog
  .command("export")
  .alias("products")
  .description("full catalog: one row per variant, with price, cost, margin and stock")
  .addOption(formatOption)
  .option("-o, --out <file>", "write to a file instead of stdout")
  .option("--all-columns", "include every column instead of the curated order")
  .action(async (opts, cmd: Command) => {
    try {
      const { client, merchant } = session(cmd);
      const rows = await buildCatalogRows(client, merchant);
      emit(rows, {
        format: opts.format as Format,
        out: opts.out,
        columns: opts.allColumns ? undefined : (CATALOG_COLUMNS as string[]),
      });
    } catch (err) {
      fail(err);
    }
  });

catalog
  .command("native-export")
  .description("SumUp's own 47-column items CSV, the exact format its importer accepts")
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (opts, cmd: Command) => {
    try {
      const { client, merchant } = session(cmd);
      const { csv, itemsCount, id } = await exportCatalogCsv(client, merchant, (m) =>
        process.stderr.write(m + "\n"),
      );
      if (opts.out) {
        mkdirSync(dirname(opts.out), { recursive: true });
        writeFileSync(opts.out, csv, "utf8");
        process.stderr.write(`wrote ${itemsCount} items (export ${id}) to ${opts.out}\n`);
      } else {
        process.stdout.write(csv);
      }
    } catch (err) {
      fail(err);
    }
  });

catalog
  .command("validate <file>")
  .description("check an edited native CSV before importing it into SumUp")
  .action((file: string) => {
    try {
      const result = validateNativeCsv(readFileSync(file, "utf8"));
      process.stdout.write(
        `${result.ok ? "OK" : "PROBLEMS"}: ${result.rowCount} data row(s)\n`,
      );
      for (const p of result.problems) process.stdout.write(`  - ${p}\n`);
      if (!result.ok) process.exitCode = 1;
    } catch (err) {
      fail(err);
    }
  });

catalog
  .command("restock")
  .alias("lieferung")
  .description("book a delivery: raise stock for the SKUs given, and change nothing else")
  .option(
    "--sku <SKU=qty...>",
    "delivered quantity per SKU, repeatable, e.g. --sku 1-0004=48 --sku 1-0008=48",
  )
  .option("--base <file>", "an existing native export to work from instead of pulling a fresh one")
  .option("--set", "treat the numbers as the resulting stock rather than as a delivery")
  .option("-n, --dry-run", "show what would change without writing a file")
  .option("-o, --out <file>", "write the partial import CSV here, default stdout")
  .action(async (opts, cmd: Command) => {
    try {
      const pairs = (opts.sku as string[] | undefined) ?? [];
      if (pairs.length === 0) {
        throw new Error("Nothing to book. Pass at least one --sku SKU=quantity.");
      }
      const deliveries = parseDeliveries(pairs);

      let base: string;
      if (opts.base) {
        base = readFileSync(opts.base as string, "utf8");
        process.stderr.write(`base: ${opts.base}\n`);
      } else {
        // Stock moves with every sale, so a delivery must be added to what the
        // catalogue says right now, not to a file from last week.
        const { csv, itemsCount } = await (async () => {
          const { client, merchant } = session(cmd);
          return exportCatalogCsv(client, merchant, (m) => process.stderr.write(m + "\n"));
        })();
        process.stderr.write(`base: live export, ${itemsCount} items\n`);
        base = csv;
      }
      assertNativeHeader(base);

      const result = applyRestock(base, deliveries, { mode: opts.set ? "set" : "add" });

      for (const c of result.changes) {
        const arrow = opts.set
          ? `${c.before} -> ${c.after}`
          : `${c.before} + ${c.delivered} -> ${c.after}`;
        process.stderr.write(`  ${c.sku.padEnd(10)}${c.name.slice(0, 34).padEnd(36)}${arrow}\n`);
      }
      for (const sku of result.missing) {
        process.stderr.write(`  ${sku.padEnd(10)}NOT IN THE CATALOGUE, skipped\n`);
      }
      for (const sku of result.ambiguous) {
        process.stderr.write(`  ${sku.padEnd(10)}SKU is on more than one row, skipped\n`);
      }
      for (const sku of result.untracked) {
        process.stderr.write(`  ${sku.padEnd(10)}inventory tracking is off, skipped\n`);
      }

      const skipped =
        result.missing.length + result.ambiguous.length + result.untracked.length;
      if (result.changes.length === 0) {
        throw new Error("No row could be booked, so no file was written.");
      }

      const check = validateNativeCsv(result.csv);
      if (!check.ok) {
        for (const p of check.problems) process.stderr.write(`  - ${p}\n`);
        throw new Error("The generated file did not validate, so it was not written.");
      }

      if (opts.dryRun) {
        process.stderr.write(
          `\ndry run: ${result.changes.length} row(s) would be written` +
            (skipped ? `, ${skipped} skipped` : "") +
            "\n",
        );
        return;
      }

      if (opts.out) {
        mkdirSync(dirname(opts.out as string), { recursive: true });
        writeFileSync(opts.out as string, result.csv, "utf8");
        process.stderr.write(
          `\nwrote ${result.changes.length} row(s)` +
            (skipped ? `, skipped ${skipped}` : "") +
            ` to ${opts.out}\nupload it with Importieren on the Artikel page\n`,
        );
      } else {
        process.stdout.write(result.csv);
      }
    } catch (err) {
      fail(err);
    }
  });

catalog
  .command("import <file>")
  .description("upload an edited items CSV through the dashboard's own Importieren flow")
  .option("-n, --dry-run", "open the page and report what it offers, upload nothing")
  .option("--headless", "no visible window; only works on a real Chrome or Edge profile")
  .option("--yes", "actually upload; without it the command stops at the dry run")
  .option("--no-verify", "skip reading the catalogue back to confirm the import landed")
  .addHelpText(
    "after",
    `
There is no import endpoint to call, so this drives the real control in a
visible window. Leave that window alone; it closes itself when done.

  sumup catalog import out/lieferung.csv --dry-run   # map the page, change nothing
  sumup catalog import out/lieferung.csv --yes       # actually upload

The file is validated before the browser is even started.`,
  )
  .action(async (file: string, opts, cmd: Command) => {
    try {
      // An import mutates a live catalogue, so silence is not consent: without
      // --yes this degrades to the dry run rather than uploading.
      const dryRun = Boolean(opts.dryRun) || !opts.yes;
      if (dryRun && !opts.dryRun) {
        process.stderr.write("no --yes given, so this is a dry run\n");
      }

      const result = await importCatalogCsv(file, {
        dryRun,
        headless: Boolean(opts.headless),
        onProgress: (m) => process.stderr.write(m + "\n"),
      });

      process.stdout.write(`url: ${result.probe.url}\n`);
      process.stdout.write(`file inputs: ${result.probe.fileInputs.length} (${result.route})\n`);
      if (result.probe.candidates.length > 0) {
        process.stdout.write("import-ish controls:\n");
        for (const c of result.probe.candidates) {
          process.stdout.write(`  ${c.tag} "${c.text}" ${JSON.stringify(c.attrs)}\n`);
        }
      }
      for (const step of result.steps) process.stdout.write(`  ${step}\n`);
      if (result.controls && result.controls.length > 0) {
        process.stdout.write("import controls:\n");
        for (const c of result.controls.filter((x) => x.visible)) {
          process.stdout.write(
            `  ${c.selector}${c.disabled ? " (disabled)" : ""} ${c.tag} "${c.text}"\n`,
          );
        }
      }
      if (dryRun) {
        process.stdout.write(`buttons seen: ${result.probe.buttons.join(" | ")}\n`);
        return;
      }
      if (result.message) process.stdout.write(`\nSumUp said: ${result.message}\n`);

      // The dialog goes quiet once it accepts the file, so the only trustworthy
      // confirmation is to read the catalogue back and see whether it now says
      // what the file said. Give the import a moment to land first.
      if (!opts.noVerify) {
        const expected = expectedQuantities(readFileSync(file, "utf8"));
        if (expected.size > 0) {
          const { client, merchant } = session(cmd);
          process.stdout.write("\nverifying against the live catalogue...\n");
          let ok = false;
          for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
            await new Promise((r) => setTimeout(r, 4000));
            const inventory = await fetchInventory(client, merchant);
            const live = new Map<string, number | undefined>();
            for (const row of inventory) {
              if (row.sku) live.set(row.sku.trim(), row.stock?.quantity);
            }
            const mismatches = [...expected].filter(([sku, qty]) => live.get(sku) !== qty);
            if (mismatches.length === 0) {
              ok = true;
              for (const [sku, qty] of expected) {
                process.stdout.write(`  ${sku.padEnd(10)}now ${qty}\n`);
              }
              process.stdout.write(`confirmed: ${expected.size} row(s) match the file\n`);
            } else if (attempt === 5) {
              for (const [sku, qty] of mismatches) {
                process.stdout.write(
                  `  ${sku.padEnd(10)}expected ${qty}, catalogue says ${live.get(sku) ?? "?"}\n`,
                );
              }
              process.stderr.write(
                "the catalogue does not match the file; the import may have failed\n",
              );
              process.exitCode = 1;
            }
          }
        }
      }
    } catch (err) {
      fail(err);
    }
  });

catalog
  .command("item <id>")
  .description("one item with its full untouched payload")
  .action(async (id: string, _opts, cmd: Command) => {
    try {
      const { client, merchant } = session(cmd);
      emit(await fetchItem(client, merchant, id), { format: "json" });
    } catch (err) {
      fail(err);
    }
  });

catalog
  .command("categories")
  .description("list all categories with item counts")
  .addOption(formatOption)
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (opts, cmd: Command) => {
    try {
      const { client, merchant } = session(cmd);
      const rows = (await fetchCategories(client, merchant)).map((c) => ({
        category_id: c.category_id,
        name: c.name,
        items_count: c.items_count,
      }));
      emit(rows, { format: opts.format as Format, out: opts.out });
    } catch (err) {
      fail(err);
    }
  });

catalog
  .command("stock")
  .description("stock levels per variant")
  .option("--low", "only rows at or below their low-stock threshold")
  .option("--negative", "only rows with negative stock")
  .option("--tracked", "only rows with inventory tracking enabled")
  .addOption(formatOption)
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (opts, cmd: Command) => {
    try {
      const { client, merchant } = session(cmd);
      let rows = (await fetchInventory(client, merchant)).map((i) => ({
        sku: i.sku,
        name: i.item_name,
        variant: i.variant_name,
        quantity: i.stock?.quantity,
        low_threshold: i.stock?.low_inventory_threshold,
        tracked: i.tracking_quantity,
        sold_out: i.is_sold_out,
        status: i.selected_status,
        item_id: i.item_id,
        variant_id: i.variant_id,
      }));

      if (opts.tracked) rows = rows.filter((r) => r.tracked);
      if (opts.negative) rows = rows.filter((r) => (r.quantity ?? 0) < 0);
      if (opts.low) {
        rows = rows.filter(
          (r) => r.tracked && (r.quantity ?? 0) <= (r.low_threshold ?? 0),
        );
      }
      emit(rows, { format: opts.format as Format, out: opts.out });
    } catch (err) {
      fail(err);
    }
  });

catalog
  .command("taxes")
  .description("configured tax rates")
  .addOption(formatOption)
  .action(async (opts, cmd: Command) => {
    try {
      const { client, merchant } = session(cmd);
      const rows = (await fetchTaxRates(client, merchant)).map((t) => ({
        tax_id: t.tax_id,
        code: t.tax_code,
        name: t.name,
        percent: taxPercent(t.tax_rate),
      }));
      emit(rows, { format: opts.format as Format });
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- sales (session)

const sales = program
  .command("sales")
  .description("Umsätze via the dashboard session, so no public API key is needed");

sales
  .command("list")
  .description("sales history, newest first")
  .option("--from <date>", "YYYY-MM-DD, inclusive")
  .option("--to <date>", "YYYY-MM-DD, inclusive")
  .option("--max <n>", "stop after n sales", Number)
  .addOption(formatOption)
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (opts, cmd: Command) => {
    try {
      const { client, merchant } = session(cmd);
      const rows = await listSales(client, merchant, {
        from: opts.from,
        to: opts.to,
        max: opts.max ?? 500,
      });
      emit(rows, { format: opts.format as Format, out: opts.out });
    } catch (err) {
      fail(err);
    }
  });

sales
  .command("movers")
  .description("rank products by how often they appear in sales in a window")
  .option("--from <date>", "YYYY-MM-DD")
  .option("--to <date>", "YYYY-MM-DD")
  .option("--max <n>", "sales to scan", Number)
  .addOption(formatOption)
  .action(async (opts, cmd: Command) => {
    try {
      const { client, merchant } = session(cmd);
      const rows = await salesByProductSummary(client, merchant, {
        from: opts.from,
        to: opts.to,
        max: opts.max ?? 1000,
      });
      process.stderr.write(
        "note: counts how often a product appears in a sale, not units sold\n",
      );
      emit(rows, { format: opts.format as Format });
    } catch (err) {
      fail(err);
    }
  });

sales
  .command("payouts")
  .description("payouts via the session (amounts are decimal, not minor units)")
  .option("--limit <n>", "how many payouts", Number)
  .addOption(formatOption)
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (opts, cmd: Command) => {
    try {
      const { client, merchant } = session(cmd);
      const rows = await listPayoutsSession(client, merchant, opts.limit ?? 100);
      emit(rows, { format: opts.format as Format, out: opts.out });
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- reports

const reports = program
  .command("reports")
  .alias("berichte")
  .description("Download Center reports");

reports
  .command("list")
  .description("which reports are available and how each one is fetched")
  .action(() => {
    for (const r of REPORTS) {
      process.stdout.write(
        `${r.key.padEnd(13)} ${r.period.padEnd(6)} ${r.mechanism.padEnd(12)} ` +
          `${r.formats.join("/").padEnd(9)} ${r.label}${r.note ? `  (${r.note})` : ""}\n`,
      );
    }
    if (UNMAPPED_REPORTS.length) {
      process.stdout.write("\nnot mapped yet:\n");
      for (const u of UNMAPPED_REPORTS) process.stdout.write(`  - ${u}\n`);
    }
  });

reports
  .command("get <name>")
  .description("download a report; see `sumup reports list` for names")
  .option("--from <date>", "YYYY-MM-DD, for range reports")
  .option("--to <date>", "YYYY-MM-DD, for range reports")
  .option("--month <month>", "YYYY-MM, for monthly statements")
  .option("--day <date>", "YYYY-MM-DD, single-day payouts or payments statement")
  .option("--doc-type <type>", "invoicing only: " + INVOICE_DOC_TYPES.join(", "))
  .option("--format <fmt>", "csv, xlsx, xls or pdf where supported")
  .option("--locale <locale>", "affects column headers", "de-CH")
  .option("--tz <tz>", "period boundaries are computed in this zone", "Europe/Zurich")
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (name: string, opts, cmd: Command) => {
    try {
      const def = REPORTS.find((r) => r.key === name);
      if (!def) {
        throw new Error(
          `Unknown report "${name}". Known: ${REPORTS.map((r) => r.key).join(", ")}`,
        );
      }
      if (def.period === "range" && !(opts.from && opts.to)) {
        throw new Error(`Report "${name}" needs --from and --to.`);
      }
      if (def.period === "month" && !opts.month && !opts.day && !opts.from) {
        throw new Error(`Report "${name}" needs --month YYYY-MM (or --day YYYY-MM-DD).`);
      }
      const { client, merchant } = session(cmd);
      const common = {
        from: opts.from,
        to: opts.to,
        tz: opts.tz,
        locale: opts.locale,
        format: opts.format,
        onProgress: (m: string) => process.stderr.write(m + "\n"),
      };

      let body: Buffer;
      if (def.mechanism === "fiscal") {
        const { url } = await fiscalExport(client, merchant, {
          from: opts.from,
          to: opts.to,
          onProgress: common.onProgress,
        });
        if (!url) throw new Error("No download URL returned.");
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Fiscal zip download failed: ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const target = opts.out ?? `out/${merchant}-fiscal-${opts.from}_${opts.to}.zip`;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, buf);
        process.stderr.write(`wrote ${buf.length} bytes to ${target}\n`);
        return;
      }

      if (def.mechanism === "job") {
        body = await runExportJob(client, merchant, def.module!, common);
      } else if (def.mechanism === "invoicing") {
        body = await invoicingReport(client, merchant, {
          from: opts.from,
          to: opts.to,
          docType: opts.docType,
          format: opts.format,
        });
      } else if (def.mechanism === "payout-edge") {
        const periodArgs = { month: opts.month, from: opts.from, day: opts.day };
        body =
          name === "fees"
            ? await feeInvoice(client, merchant, periodArgs)
            : name === "payouts"
              ? await payoutStatement(client, merchant, periodArgs)
              : await paymentsStatement(client, merchant, {
                  ...periodArgs,
                  format: opts.format,
                  locale: opts.locale,
                  tz: opts.tz,
                });
      } else if (name === "transactions") {
        body = await transactionsReport(client, merchant, common);
      } else {
        body = await cashbookReport(client, merchant, common);
      }

      const ext = extensionFor(body);
      const period =
        def.period === "month"
          ? (opts.day ?? opts.month ?? monthFrom({ from: opts.from }))
          : `${opts.from}_${opts.to}`;
      const target = opts.out ?? `out/${merchant}-${name}-${period}.${ext}`;
      mkdirSync(dirname(target), { recursive: true });

      if (looksBinary(body)) {
        // Writing a PDF or zip as text silently corrupts it.
        writeFileSync(target, body);
        process.stderr.write(`wrote ${body.length} bytes (${ext}) to ${target}\n`);
      } else {
        // BOM keeps umlauts and emoji intact in Excel, but SumUp already sends
        // one on some reports, and two in a row render as visible junk.
        const text = stripBom(body.toString("utf8"));
        writeFileSync(target, "﻿" + text, "utf8");
        const rows = text.split(/\r?\n/).filter(Boolean).length - 1;
        process.stderr.write(`wrote ${Math.max(rows, 0)} row(s) to ${target}\n`);
      }
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- subscriptions

program
  .command("subscriptions")
  .alias("abos")
  .description("paid SumUp plans, billed separately and therefore absent from the payout data")
  .option("--from <date>", "YYYY-MM-DD, to count the charges in a period")
  .option("--to <date>", "YYYY-MM-DD")
  .addOption(formatOption)
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (opts, cmd: Command) => {
    try {
      const { client, merchant } = session(cmd);
      const subs = await listSubscriptions(client, merchant, {
        from: opts.from,
        to: opts.to,
      });
      if (opts.format === "table" && opts.from && opts.to) {
        for (const s of subs) {
          process.stdout.write(
            `${s.name} (${s.product ?? "?"})  ${s.status}\n` +
              `  ${s.monthlyPrice?.toFixed(2)} ${s.currency} ${s.frequency}` +
              (s.quantity > 1 ? ` x${s.quantity}` : "") + "\n" +
              `  Start ${s.startedAt}, Testphase bis ${s.trialEndedAt ?? "keine"}, nächste Abrechnung ${s.nextBillingAt}\n` +
              (s.committedUntil ? `  Mindestlaufzeit bis ${s.committedUntil}\n` : "") +
              `  im Zeitraum belastet: ${s.chargedInPeriod.toFixed(2)} ` +
              `(${s.billedDates.length} x, ${s.billedDates.join(", ") || "keine"})\n`,
          );
        }
        process.stdout.write(
          `\nTotal im Zeitraum: ${totalSubscriptionCost(subs).toFixed(2)}\n` +
            `Diese Kosten werden separat per Lastschrift belastet und erscheinen NICHT\n` +
            `in den Auszahlungen oder Transaktionsgebühren.\n`,
        );
        return;
      }
      emit(subs, { format: opts.format as Format, out: opts.out });
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- profit

program
  .command("profit")
  .alias("gewinn")
  .description("Rohertrag and Ergebnis for a period: revenue, cost of goods, card fees")
  .requiredOption("--from <date>", "YYYY-MM-DD")
  .requiredOption("--to <date>", "YYYY-MM-DD")
  .option("--by-item", "list the per-item breakdown instead of the summary")
  .addOption(formatOption)
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action(async (opts, cmd: Command) => {
    try {
      const { client, merchant } = session(cmd);
      const report = await computeProfit(client, merchant, {
        from: opts.from,
        to: opts.to,
        onProgress: (m) => process.stderr.write(m + "\n"),
      });

      if (opts.byItem) {
        emit(report.lines, { format: opts.format as Format, out: opts.out });
        return;
      }
      if (opts.format === "json") {
        emit(report, { format: "json", out: opts.out });
        return;
      }
      process.stdout.write(formatProfit(report) + "\n");
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- endpoints

program
  .command("endpoints")
  .description("show the mapped internal API surface and its verification status")
  .action(() => {
    process.stdout.write(endpointSummary() + "\n");
    const pending = unverifiedEndpoints();
    process.stdout.write(
      `\n${Object.keys(ENDPOINTS).length} mapped, ${pending.length} unverified` +
        (pending.length ? `: ${pending.join(", ")}` : "") +
        "\n",
    );
  });

// ---------------------------------------------------------------- discover

program
  .command("discover <harFile>")
  .description("map the internal API from a browser HAR export of me.sumup.com")
  .option("--catalog-only", "show only calls that look catalog-related")
  .option("--json", "emit machine-readable output")
  .option("-o, --out <file>", "write to a file instead of stdout")
  .addHelpText(
    "after",
    `
Capturing a HAR:
  1. Log in at https://me.sumup.com
  2. DevTools -> Network -> tick "Preserve log"
  3. Click through Artikel/Inventar, open a product, change a price
  4. Right-click the request list -> "Save all as HAR with content"
  5. sumup discover capture.har --catalog-only

The HAR contains your live session token. Keep it out of git; .gitignore
already excludes *.har.`,
  )
  .action((harFile: string, opts) => {
    try {
      const all = parseHar(harFile);
      const calls = opts.catalogOnly ? catalogCandidates(all) : all;
      const text = opts.json
        ? JSON.stringify(calls, null, 2) + "\n"
        : formatReport(calls);
      if (opts.out) writeFileSync(opts.out, text, "utf8");
      else process.stdout.write(text);
      if (!opts.json) {
        process.stderr.write(
          `\n${calls.length} distinct call(s)` +
            (opts.catalogOnly ? ` of ${all.length} total` : "") +
            `\ncurrent endpoints.ts entries: ` +
            Object.entries(ENDPOINTS)
              .map(([k, v]) => `${k}=${v.status}`)
              .join(" ") +
            "\n",
        );
      }
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync(process.argv).catch(fail);
