#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveProfile } from "../core/config.js";
import { PublicClient } from "../core/public/client.js";
import {
  getTransaction,
  hydrateLineItems,
  listTransactions,
} from "../core/public/transactions.js";
import { listPayouts } from "../core/public/payouts.js";
import { SessionClient } from "../core/session/client.js";
import {
  buildCatalogRows,
  CATALOG_COLUMNS,
  fetchCategories,
  fetchInventory,
  fetchItem,
} from "../core/session/catalog.js";
import { ENDPOINTS, endpointSummary } from "../core/session/endpoints.js";
import { exportCatalogCsv, validateNativeCsv } from "../core/session/nativeExport.js";
import { importCatalogCsv } from "../core/session/nativeImport.js";
import {
  applyRestock,
  assertNativeHeader,
  expectedQuantities,
  parseDeliveries,
} from "../core/session/restock.js";
import { readFileSync } from "node:fs";
import { listPayoutsSession, listSales } from "../core/session/sales.js";
import { computeProfit } from "../core/analysis/profit.js";
import {
  cashbookReport,
  extensionFor,
  feeInvoice,
  fiscalExport,
  INVOICE_DOC_TYPES,
  invoicingReport,
  looksBinary,
  paymentsStatement,
  payoutStatement,
  REPORTS,
  runExportJob,
  stripBom,
  transactionsReport,
} from "../core/session/reports.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { unverifiedEndpoints } from "../core/session/endpoints.js";
import { toCsv } from "../core/export/csv.js";

// Keep stdout clean for the JSON-RPC stream; the catalog layer warns on stderr.
process.env.SUMUP_QUIET = "1";

const server = new McpServer({ name: "sumup", version: "0.1.0" });

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const body = (err as { body?: unknown }).body;
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: body ? `${message}\n${JSON.stringify(body, null, 2)}` : message,
      },
    ],
  };
}

function clients(profileName?: string) {
  const profile = resolveProfile(profileName);
  return {
    profile,
    pub: () => new PublicClient(profile),
    session: () => new SessionClient(profile),
  };
}

/** Catalog work needs only the session; the merchant code rides in the token. */
function sessionFor(profileName?: string): { client: SessionClient; merchant: string } {
  const profile = resolveProfile(profileName);
  const client = new SessionClient(profile);
  const merchant = profile.merchantCode ?? client.merchantCode() ?? "";
  if (!merchant) throw new Error("Could not read a merchant code from the session.");
  return { client, merchant };
}

const profileArg = z
  .string()
  .optional()
  .describe("Named profile from ~/.sumup-cli/config.json. Omit for the default.");

server.registerTool(
  "sumup_me",
  {
    title: "SumUp merchant profile",
    description:
      "Merchant and account profile, including merchant_code, company name, country and currency.",
    inputSchema: { profile: profileArg },
  },
  async ({ profile }) => {
    try {
      return json(await clients(profile).pub().me());
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_transactions_list",
  {
    title: "List SumUp transactions",
    description:
      "Sales history for a date range. Returns summaries without line items; set line_items to include the products sold, which costs one extra API call per sale.",
    inputSchema: {
      from: z.string().optional().describe("YYYY-MM-DD or ISO timestamp, inclusive"),
      to: z.string().optional().describe("YYYY-MM-DD or ISO timestamp, inclusive"),
      statuses: z
        .array(z.enum(["SUCCESSFUL", "CANCELLED", "FAILED", "REFUNDED", "CHARGE_BACK"]))
        .optional(),
      payment_types: z.array(z.string()).optional().describe("e.g. POS, ECOM, CASH"),
      max: z.number().int().positive().max(5000).optional().describe("cap on rows returned"),
      line_items: z.boolean().optional(),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      const c = clients(args.profile).pub();
      const rows = await listTransactions(c, {
        from: args.from,
        to: args.to,
        statuses: args.statuses,
        paymentTypes: args.payment_types,
        max: args.max ?? 500,
      });
      return json(args.line_items ? await hydrateLineItems(c, rows) : rows);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_transaction_get",
  {
    title: "Get one SumUp transaction",
    description: "Full detail for a single sale, including the products array and events.",
    inputSchema: {
      id: z.string().optional().describe("transaction id"),
      transaction_code: z.string().optional(),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      return json(
        await getTransaction(clients(args.profile).pub(), {
          id: args.id,
          transactionCode: args.transaction_code,
        }),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_sales_by_product",
  {
    title: "SumUp sales aggregated per product",
    description:
      "Aggregates successful sales in a date range into one row per product: quantity sold and revenue. Useful for deciding what to reorder or reprice.",
    inputSchema: {
      from: z.string().describe("YYYY-MM-DD"),
      to: z.string().describe("YYYY-MM-DD"),
      as_csv: z.boolean().optional(),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      const c = clients(args.profile).pub();
      const summaries = await listTransactions(c, {
        from: args.from,
        to: args.to,
        statuses: ["SUCCESSFUL"],
      });
      const details = await hydrateLineItems(c, summaries);

      const totals = new Map<string, { product: string; quantity: number; revenue: number }>();
      for (const t of details) {
        for (const p of t.products ?? []) {
          const name = p.name ?? "(unnamed)";
          const entry = totals.get(name) ?? { product: name, quantity: 0, revenue: 0 };
          entry.quantity += p.quantity ?? 0;
          entry.revenue += p.total_with_vat ?? p.total_price ?? 0;
          totals.set(name, entry);
        }
      }
      const rows = [...totals.values()].sort((a, b) => b.revenue - a.revenue);
      return args.as_csv ? text(toCsv(rows)) : json(rows);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_payouts_list",
  {
    title: "List SumUp payouts",
    description: "Payout statements with fees for a date range, for reconciliation.",
    inputSchema: {
      from: z.string().describe("YYYY-MM-DD"),
      to: z.string().describe("YYYY-MM-DD"),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      return json(
        await listPayouts(clients(args.profile).pub(), { from: args.from, to: args.to }),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_catalog_export",
  {
    title: "Export the SumUp catalog",
    description:
      "Every sellable variant with price, net price, cost price, margin, tax rate, SKU, barcode and stock. Joins the item and inventory endpoints, since neither has all the fields. Uses the me.sumup.com session, because the public API has no catalog endpoints.",
    inputSchema: {
      as_csv: z.boolean().optional().describe("return CSV instead of JSON"),
      category: z.string().optional().describe("filter by category name, case-insensitive"),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      const { client, merchant } = sessionFor(args.profile);
      let rows = await buildCatalogRows(client, merchant);
      if (args.category) {
        const needle = args.category.toLowerCase();
        rows = rows.filter((r) => r.category?.toLowerCase().includes(needle));
      }
      return args.as_csv
        ? text(toCsv(rows, { columns: CATALOG_COLUMNS as string[] }))
        : json(rows);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_catalog_native_export",
  {
    title: "SumUp native items CSV",
    description:
      "Triggers SumUp's own items export and returns the resulting 47-column CSV. This is byte-for-byte the format the dashboard's import accepts, so it is the supported route for bulk edits: export, change cells, re-import. Do not alter the 'Item id' or 'Variant id' columns.",
    inputSchema: {
      save_to: z.string().optional().describe("absolute path to write the CSV to"),
      preview_rows: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("how many data rows to include in the reply, default 5"),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      const { client, merchant } = sessionFor(args.profile);
      const { csv, itemsCount, id } = await exportCatalogCsv(client, merchant);
      let saved = "";
      if (args.save_to) {
        mkdirSync(dirname(args.save_to), { recursive: true });
        writeFileSync(args.save_to, csv, "utf8");
        saved = `\nSaved to ${args.save_to}`;
      }
      const lines = csv.split(/\r?\n/).filter(Boolean);
      const n = args.preview_rows ?? 5;
      return text(
        `Export ${id}: ${itemsCount} items, ${lines.length - 1} variant rows, ` +
          `${(lines[0] ?? "").split(",").length} columns.${saved}\n\n` +
          lines.slice(0, n + 1).join("\n"),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_catalog_restock",
  {
    title: "Book a delivery into stock",
    description:
      "Takes delivered quantities per SKU and produces the partial 47-column CSV to hand to the dashboard's Importieren button. Only the Quantity cell moves: selling price and cost price are left exactly as they are, which is the shop's rule for an item that already exists. Stock is read live unless base_file is given, because a delivery has to be added to what the catalogue says now, not to an older export. Unknown SKUs, SKUs sitting on more than one row, and items with inventory tracking off are reported and skipped rather than guessed at.",
    inputSchema: {
      deliveries: z
        .array(z.string())
        .describe('one "SKU=quantity" per line item, e.g. ["1-0004=48", "1-0008=48"]'),
      save_to: z.string().optional().describe("absolute path to write the import CSV to"),
      base_file: z
        .string()
        .optional()
        .describe("an existing native export to work from instead of pulling a fresh one"),
      mode: z
        .enum(["add", "set"])
        .optional()
        .describe('"add" treats the numbers as a delivery, "set" as the resulting stock'),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      const deliveries = parseDeliveries(args.deliveries);

      let base: string;
      let source: string;
      if (args.base_file) {
        base = readFileSync(args.base_file, "utf8");
        source = args.base_file;
      } else {
        const { client, merchant } = sessionFor(args.profile);
        const { csv, itemsCount } = await exportCatalogCsv(client, merchant);
        base = csv;
        source = `live export, ${itemsCount} items`;
      }
      assertNativeHeader(base);

      const result = applyRestock(base, deliveries, { mode: args.mode ?? "add" });
      const check = validateNativeCsv(result.csv);
      if (!check.ok) {
        return errorResult(
          new Error(`The generated file did not validate: ${check.problems.join("; ")}`),
        );
      }

      let saved = "";
      if (args.save_to && result.changes.length > 0) {
        mkdirSync(dirname(args.save_to), { recursive: true });
        writeFileSync(args.save_to, result.csv, "utf8");
        saved = `\n\nSaved to ${args.save_to} — import it with the Importieren button on the Artikel page.`;
      }

      const lines = result.changes.map(
        (c) =>
          `  ${c.sku.padEnd(10)}${c.name.slice(0, 34).padEnd(36)}` +
          (args.mode === "set"
            ? `${c.before} -> ${c.after}`
            : `${c.before} + ${c.delivered} -> ${c.after}`),
      );
      const skipped = [
        ...result.missing.map((s) => `  ${s.padEnd(10)}not in the catalogue`),
        ...result.ambiguous.map((s) => `  ${s.padEnd(10)}SKU is on more than one row`),
        ...result.untracked.map((s) => `  ${s.padEnd(10)}inventory tracking is off`),
      ];

      return text(
        `base: ${source}\n\n${lines.join("\n") || "  (nothing booked)"}` +
          (skipped.length ? `\n\nskipped:\n${skipped.join("\n")}` : "") +
          saved,
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_catalog_import",
  {
    title: "Import an items CSV into the live catalogue",
    description:
      "Uploads a prepared 47-column CSV through the dashboard's own Importieren dialog, which is the only route that exists: there is no import endpoint, the button just opens a file picker. It opens a visible browser window using the saved profile. Defaults to a dry run that opens the flow and attaches the file without submitting; pass confirm true to actually import. The dialog reports nothing on success, so afterwards the live catalogue is read back and checked against the file, and that check is the real confirmation.",
    inputSchema: {
      file: z.string().describe("absolute path to the items CSV to upload"),
      confirm: z.boolean().optional().describe("must be true to actually import"),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      const dryRun = args.confirm !== true;
      const result = await importCatalogCsv(args.file, { dryRun });

      const head =
        `route: ${result.route}\n` +
        `file inputs found: ${result.probe.fileInputs.length}\n` +
        result.steps.map((s) => `  ${s}`).join("\n");

      if (dryRun) {
        return text(
          `${head}\n\nDry run: the file was attached but not submitted, so nothing was ` +
            `imported. Call again with confirm true to import it.`,
        );
      }

      // Reading the catalogue back is the only trustworthy confirmation.
      const expected = expectedQuantities(readFileSync(args.file, "utf8"));
      let verdict = "No SKU rows to verify.";
      if (expected.size > 0) {
        const { client, merchant } = sessionFor(args.profile);
        const lines: string[] = [];
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
            lines.push(`confirmed: ${expected.size} row(s) match the file`);
            for (const [sku, qty] of expected) lines.push(`  ${sku} now ${qty}`);
          } else if (attempt === 5) {
            lines.push("the catalogue does not match the file; the import may have failed");
            for (const [sku, qty] of mismatches) {
              lines.push(`  ${sku} expected ${qty}, catalogue says ${live.get(sku) ?? "?"}`);
            }
          }
        }
        verdict = lines.join("\n");
      }

      return text(
        `${head}\n` +
          (result.message ? `\nSumUp said: ${result.message}\n` : "") +
          `\n${verdict}`,
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_sales_list",
  {
    title: "SumUp sales history (session)",
    description:
      "Umsätze straight from the dashboard session, so it needs no public API key. Newest first. Amounts are converted from minor units. product_summary is a display string, not structured line items.",
    inputSchema: {
      from: z.string().optional().describe("YYYY-MM-DD, inclusive"),
      to: z.string().optional().describe("YYYY-MM-DD, inclusive"),
      max: z.number().int().positive().max(2000).optional(),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      const { client, merchant } = sessionFor(args.profile);
      return json(
        await listSales(client, merchant, {
          from: args.from,
          to: args.to,
          max: args.max ?? 200,
        }),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_payouts_session",
  {
    title: "SumUp payouts (session)",
    description:
      "Auszahlungen via the dashboard session, no API key needed. Note these amounts are already decimal, unlike catalog and sales figures which arrive in minor units.",
    inputSchema: {
      limit: z.number().int().positive().max(500).optional(),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      const { client, merchant } = sessionFor(args.profile);
      return json(await listPayoutsSession(client, merchant, args.limit ?? 50));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_report",
  {
    title: "Download a SumUp Download Center report",
    description:
      "Fetches an accounting report. 'sales' is the itemised sales report with per-line tax, category and SKU, and is usually the one you want for bookkeeping. 'revenue' returns a PDF and 'fiscal' a zip, so those must be saved to a file rather than read inline.",
    inputSchema: {
      report: z
        .enum([
          "sales",
          "revenue",
          "items",
          "transactions",
          "cashbook",
          "fiscal",
          "payouts",
          "fees",
          "payments",
          "invoicing",
        ])
        .describe(
          "CSV: sales, items, transactions, cashbook, invoicing. PDF: revenue, payouts, fees, payments. ZIP: fiscal.",
        ),
      from: z.string().optional().describe("YYYY-MM-DD, for range reports"),
      to: z.string().optional().describe("YYYY-MM-DD, for range reports"),
      month: z
        .string()
        .optional()
        .describe("YYYY-MM, required for payouts, fees and payments"),
      day: z.string().optional().describe("YYYY-MM-DD, single-day payouts or payments"),
      doc_type: z.enum(INVOICE_DOC_TYPES).optional().describe("invoicing only"),
      format: z.string().optional().describe("csv, xlsx, xls or pdf where supported"),
      save_to: z.string().optional().describe("absolute path; required for any PDF or ZIP"),
      locale: z.string().optional().describe("column-header language, default de-CH"),
      preview_rows: z.number().int().min(0).max(40).optional(),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      const { client, merchant } = sessionFor(args.profile);
      const def = REPORTS.find((r) => r.key === args.report)!;

      if (def.period === "range" && !(args.from && args.to)) {
        return text(`Report "${args.report}" needs from and to.`);
      }
      if (def.period === "month" && !args.month && !args.day && !args.from) {
        return text(`Report "${args.report}" needs month (YYYY-MM) or day.`);
      }

      const common = {
        from: args.from!,
        to: args.to!,
        locale: args.locale ?? "de-CH",
        format: args.format,
      };

      if (def.mechanism === "fiscal") {
        if (!args.save_to) return text("fiscal returns a zip; pass save_to.");
        const { url } = await fiscalExport(client, merchant, { from: args.from!, to: args.to! });
        if (!url) return text("No download URL returned.");
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        mkdirSync(dirname(args.save_to), { recursive: true });
        writeFileSync(args.save_to, buf);
        return text(`Wrote ${buf.length} bytes (zip) to ${args.save_to}`);
      }

      const periodArgs = { month: args.month, from: args.from, day: args.day };
      const body =
        def.mechanism === "job"
          ? await runExportJob(client, merchant, def.module!, common)
          : def.mechanism === "invoicing"
            ? await invoicingReport(client, merchant, {
                from: args.from!,
                to: args.to!,
                docType: args.doc_type,
                format: args.format,
              })
            : def.mechanism === "payout-edge"
              ? args.report === "fees"
                ? await feeInvoice(client, merchant, periodArgs)
                : args.report === "payouts"
                  ? await payoutStatement(client, merchant, periodArgs)
                  : await paymentsStatement(client, merchant, {
                      ...periodArgs,
                      format: args.format,
                      locale: args.locale,
                    })
              : args.report === "transactions"
                ? await transactionsReport(client, merchant, common)
                : await cashbookReport(client, merchant, common);

      if (looksBinary(body)) {
        if (!args.save_to) {
          return text(
            `${args.report} returned ${extensionFor(body)} (${body.length} bytes). Pass save_to to keep it.`,
          );
        }
        mkdirSync(dirname(args.save_to), { recursive: true });
        writeFileSync(args.save_to, body);
        return text(`Wrote ${body.length} bytes (${extensionFor(body)}) to ${args.save_to}`);
      }

      const csv = stripBom(body.toString("utf8"));
      let saved = "";
      if (args.save_to) {
        mkdirSync(dirname(args.save_to), { recursive: true });
        writeFileSync(args.save_to, "﻿" + csv, "utf8");
        saved = `\nSaved to ${args.save_to}`;
      }
      const lines = csv.split(/\r?\n/).filter(Boolean);
      const period = args.month ?? args.day ?? `${args.from} to ${args.to}`;
      const n = args.preview_rows ?? 10;
      return text(
        `${args.report}: ${lines.length - 1} rows, ${period}.${saved}\n\n` +
          lines.slice(0, n + 1).join("\n"),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_profit",
  {
    title: "SumUp profit for a period",
    description:
      "Rohertrag and Ergebnis: gross revenue split by card and cash, net-of-VAT revenue minus cost of goods, minus SumUp's card fees. VAT is already excluded because SumUp computes profit on the net price. This is BEFORE rent, wages and other overheads, so it is an operating contribution, not a final Nettogewinn. Items lacking a cost price are reported separately rather than counted as profit.",
    inputSchema: {
      from: z.string().describe("YYYY-MM-DD"),
      to: z.string().describe("YYYY-MM-DD"),
      by_item: z.boolean().optional().describe("include the per-item breakdown"),
      top: z.number().int().min(1).max(200).optional().describe("limit item rows, default 20"),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      const { client, merchant } = sessionFor(args.profile);
      const report = await computeProfit(client, merchant, { from: args.from, to: args.to });
      if (!args.by_item) {
        const { lines, ...summary } = report;
        return json(summary);
      }
      return json({
        ...report,
        lines: report.lines.slice(0, args.top ?? 20),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_endpoints",
  {
    title: "Mapped SumUp internal API surface",
    description:
      "Lists every internal endpoint this tool knows about and whether it has been verified against live traffic. Useful for answering what is and is not possible before attempting something.",
    inputSchema: {},
  },
  async () => text(endpointSummary()),
);

server.registerTool(
  "sumup_catalog_item",
  {
    title: "Get one SumUp catalog item",
    description: "Full untouched payload for a single item, including all variants.",
    inputSchema: { id: z.string().describe("item_id"), profile: profileArg },
  },
  async (args) => {
    try {
      const { client, merchant } = sessionFor(args.profile);
      return json(await fetchItem(client, merchant, args.id));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_catalog_stock",
  {
    title: "SumUp stock levels",
    description:
      "Stock per variant, with filters for low stock and negative stock. Negative quantities mean sales were rung up past a zero count.",
    inputSchema: {
      low: z.boolean().optional().describe("only rows at or below their low-stock threshold"),
      negative: z.boolean().optional().describe("only rows with negative stock"),
      tracked_only: z.boolean().optional(),
      profile: profileArg,
    },
  },
  async (args) => {
    try {
      const { client, merchant } = sessionFor(args.profile);
      let rows = (await fetchInventory(client, merchant)).map((i) => ({
        sku: i.sku,
        name: i.item_name,
        variant: i.variant_name,
        quantity: i.stock?.quantity,
        low_threshold: i.stock?.low_inventory_threshold,
        tracked: i.tracking_quantity,
        sold_out: i.is_sold_out,
        item_id: i.item_id,
        variant_id: i.variant_id,
      }));
      if (args.tracked_only) rows = rows.filter((r) => r.tracked);
      if (args.negative) rows = rows.filter((r) => (r.quantity ?? 0) < 0);
      if (args.low) {
        rows = rows.filter((r) => r.tracked && (r.quantity ?? 0) <= (r.low_threshold ?? 0));
      }
      return json(rows);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_catalog_categories",
  {
    title: "List SumUp catalog categories",
    description: "All item-catalog categories with their item counts.",
    inputSchema: { profile: profileArg },
  },
  async (args) => {
    try {
      const { client, merchant } = sessionFor(args.profile);
      const rows = (await fetchCategories(client, merchant)).map((c) => ({
        category_id: c.category_id,
        name: c.name,
        items_count: c.items_count,
      }));
      return json(rows);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "sumup_catalog_update_product",
  {
    title: "Update a SumUp product",
    description:
      "Writes changes to one product in the live catalog. Defaults to a dry run; pass confirm true to actually apply it.",
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      price: z.number().optional().describe("gross price"),
      cost_price: z.number().optional(),
      vat_rate: z.number().optional(),
      sku: z.string().optional(),
      barcode: z.string().optional(),
      active: z.boolean().optional(),
      confirm: z.boolean().optional().describe("must be true to write"),
      profile: profileArg,
    },
  },
  async (args) => {
    const patch = {
      name: args.name,
      price: args.price,
      cost_price: args.cost_price,
      vat_rate: args.vat_rate,
      sku: args.sku,
      barcode: args.barcode,
      active: args.active,
    };
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );

    // Reads were mapped from real traffic; the write shape was not. Firing a
    // guessed PUT at a live catalog of 646 items is not worth the risk.
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text:
            `Writes are not enabled yet. The update endpoint is still marked ` +
            `"${ENDPOINTS.updateItem.status}" in endpoints.ts.\n\n` +
            `Requested change to item ${args.id}:\n${JSON.stringify(defined, null, 2)}\n\n` +
            `To enable it, someone needs to save one product in the dashboard while ` +
            `traffic is being captured, so the real method and body can be recorded. ` +
            `Until then this tool refuses rather than guessing.`,
        },
      ],
    };
  },
);

server.registerTool(
  "sumup_status",
  {
    title: "SumUp connection status",
    description:
      "What credentials are configured, whether the public API responds, and which internal endpoints are still unverified.",
    inputSchema: { profile: profileArg },
  },
  async (args) => {
    const p = resolveProfile(args.profile);
    const lines = [
      `api key: ${p.apiKey ? p.apiKey.slice(0, 11) + "..." : "(none)"}`,
      `session: ${p.sessionToken || p.sessionCookie ? "present" : "(none)"}`,
    ];
    if (p.apiKey) {
      try {
        const me = await new PublicClient(p).me();
        lines.push(
          `public API OK: ${me.merchant_profile?.company_name ?? "?"} (${
            me.merchant_profile?.merchant_code ?? "?"
          })`,
        );
      } catch (err) {
        lines.push(`public API FAILED: ${(err as Error).message}`);
      }
    }
    const pending = unverifiedEndpoints();
    if (pending.length) lines.push(`unverified internal endpoints: ${pending.join(", ")}`);
    return text(lines.join("\n"));
  },
);

await server.connect(new StdioServerTransport());
