import type { SessionClient } from "./client.js";

/**
 * Download Center reports.
 *
 * These do not share one mechanism. There are three, and which one a report
 * uses was determined by driving the real UI:
 *
 *   1. Async job API  POST /merchants/{m}/exports, poll, then /downloads
 *   2. Direct CSV     a single GET that returns the file body
 *   3. Fiscalization  POST /fiscalization/.../export/request, poll, S3 zip
 *
 * Only three module names are accepted by the job API. Everything else 400s
 * with "module can not be empty", so the remaining reports live elsewhere.
 */

const DEFAULT_TZ = "Europe/Zurich";

/** Offset in ms between UTC and `tz` at the given instant. */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - at.getTime();
}

/**
 * Turns a local calendar date into the UTC instant SumUp expects. The dashboard
 * sends 2026-08-16T22:00:00.000Z for a period starting 2026-08-17 in Zurich, so
 * the boundary has to be zone-aware or reports silently shift by a day.
 */
export function zonedInstant(
  date: string,
  time: "start" | "end",
  tz = DEFAULT_TZ,
): string {
  const clock = time === "start" ? "00:00:00.000" : "23:59:59.999";
  const naive = Date.parse(`${date}T${clock}Z`);
  let guess = new Date(naive);
  for (let i = 0; i < 3; i++) guess = new Date(naive - tzOffsetMs(guess, tz));
  return guess.toISOString();
}

function assertDate(label: string, value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD, got "${value}".`);
  }
}

// ---------------------------------------------------------------- job API

/** The only module names the export job API accepts. */
export const EXPORT_MODULES = {
  sales_report_v1: "Verkäufe: itemised sales with tax breakdown",
  sales_overview_v1: "Umsätze: sales overview",
  item_report_v1: "Artikel: per-item performance",
} as const;

export type ExportModule = keyof typeof EXPORT_MODULES;

/** Columns `sales_report_v1` accepts. Order here drives column order out. */
export const SALES_REPORT_COLUMNS = [
  "date",
  "type",
  "transaction_id",
  "payment_method",
  "quantity",
  "description",
  "category",
  "sku",
  "currency",
  "price_before_discount",
  "discount",
  "price_gross",
  "price_net",
  "tax",
  "tax_rate",
  "account",
] as const;

interface CreatedExport {
  export_id: string;
  status: string;
}

interface ExportStatus {
  export_id: string;
  status: string;
  finished_at?: string;
  expires_at?: string;
}

export interface ReportOptions {
  from: string;
  to: string;
  tz?: string;
  locale?: string;
  /** Loose on purpose: valid values differ per report (csv, xlsx, xls, pdf). */
  format?: string;
  columns?: readonly string[];
  onProgress?: (msg: string) => void;
}

export async function runExportJob(
  client: SessionClient,
  merchant: string,
  module: ExportModule,
  opts: ReportOptions,
): Promise<Buffer> {
  assertDate("--from", opts.from);
  assertDate("--to", opts.to);
  const tz = opts.tz ?? DEFAULT_TZ;
  const locale = opts.locale ?? "de-CH";

  const config: Record<string, unknown> = { enabled: true };
  if (module === "sales_report_v1") {
    config.format = opts.format ?? "csv";
    config.columns = opts.columns ?? SALES_REPORT_COLUMNS;
  }

  const created = await client.req<CreatedExport>(`/merchants/${merchant}/exports`, {
    method: "POST",
    query: { locale, tz },
    body: {
      start_date: zonedInstant(opts.from, "start", tz),
      end_date: zonedInstant(opts.to, "end", tz),
      modules: { [module]: config },
    },
  });

  const id = created.export_id;
  opts.onProgress?.(`export ${id} ${created.status}`);

  for (let i = 0; i < 40; i++) {
    const status = await client.req<ExportStatus>(
      `/merchants/${merchant}/exports/${id}`,
    );
    if (/DONE|READY|COMPLETED|SUCCE/i.test(status.status)) {
      opts.onProgress?.(`export ${id} ${status.status}`);
      break;
    }
    if (/FAIL|ERROR|CANCEL/i.test(status.status)) {
      throw new Error(`Export ${id} ended as ${status.status}.`);
    }
    if (i === 39) throw new Error(`Export ${id} still ${status.status} after 40 polls.`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Returns the file body itself, not a link to it. Fetched as bytes because
  // sales_overview_v1 answers with a PDF, which text-decoding would corrupt.
  return client.req<Buffer>(`/merchants/${merchant}/exports/${id}/downloads`, {
    binary: true,
    headers: { Accept: "text/csv, application/pdf, */*" },
  });
}

/**
 * PDFs, zips and legacy XLS must be written as bytes; CSV wants a BOM for Excel.
 *
 * The legacy XLS case matters: SumUp's payments export is an OLE2 compound file
 * starting D0 CF 11 E0, and decoding that as UTF-8 replaces every high byte with
 * U+FFFD, producing a file Excel refuses to open.
 */
export function looksBinary(body: Buffer): boolean {
  if (body.length === 0) return false;
  const head = body.subarray(0, 8);
  const latin = head.toString("latin1");
  if (latin.startsWith("%PDF")) return true;
  if (latin.startsWith("PK")) return true;
  if (head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) return true;
  // Anything with a NUL in the first block is not text we should touch.
  return body.subarray(0, 512).includes(0x00);
}

export function extensionFor(body: Buffer, fallback = "csv"): string {
  const latin = body.subarray(0, 8).toString("latin1");
  if (latin.startsWith("%PDF")) return "pdf";
  if (latin.startsWith("PK")) return "zip";
  if (body.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) return "xls";
  return fallback;
}

/** SumUp already prefixes some CSVs with a BOM; a second one shows up as text. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------------------------------------------------------------- direct CSV

/**
 * Transaktionsbericht.
 *
 * The dashboard sends start_time as the NEWER bound and end_time as the older
 * one alongside order=descending, which looks inverted but is what it does.
 * Mirrored here so results match the UI exactly.
 */
export async function transactionsReport(
  client: SessionClient,
  merchant: string,
  opts: ReportOptions,
): Promise<Buffer> {
  assertDate("--from", opts.from);
  assertDate("--to", opts.to);
  const tz = opts.tz ?? DEFAULT_TZ;
  return client.req<Buffer>(`/v2.1/merchants/${merchant}/transactions/export`, {
    query: {
      start_time: zonedInstant(opts.to, "end", tz),
      end_time: zonedInstant(opts.from, "start", tz),
      format: opts.format ?? "csv",
      order: "descending",
      locale: opts.locale ?? "de-CH",
      timezone: tz,
    },
    binary: true,
    headers: { Accept: "text/csv, */*" },
  });
}

/** Kassenbuch. Takes plain calendar dates rather than instants. */
export async function cashbookReport(
  client: SessionClient,
  merchant: string,
  opts: ReportOptions,
): Promise<Buffer> {
  assertDate("--from", opts.from);
  assertDate("--to", opts.to);
  return client.req<Buffer>(`/v1.0/merchants/${merchant}/cash-management/report`, {
    query: {
      format: opts.format ?? "csv",
      from_date: opts.from,
      until_date: opts.to,
      locale: opts.locale ?? "de-CH",
      timezone: opts.tz ?? DEFAULT_TZ,
    },
    binary: true,
    headers: { Accept: "text/csv, */*" },
  });
}

// ------------------------------------------- payout-reports-edge (PDF statements)

const PAYOUT_EDGE = "/payout-reports-edge/api/v3/merchants";

function assertMonth(value: string): void {
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new Error(`--month must be YYYY-MM, got "${value}".`);
  }
}

/** Derives YYYY-MM from an explicit month or from the start of a range. */
export function monthFrom(opts: { month?: string; from?: string }): string {
  if (opts.month) {
    assertMonth(opts.month);
    return opts.month;
  }
  if (opts.from) {
    assertDate("--from", opts.from);
    return opts.from.slice(0, 7);
  }
  throw new Error("This report needs --month YYYY-MM (or --from to derive it).");
}

/** Auszahlungsbericht. Monthly or single-day PDF. */
export async function payoutStatement(
  client: SessionClient,
  merchant: string,
  opts: { month?: string; day?: string },
): Promise<Buffer> {
  const path = opts.day
    ? `${PAYOUT_EDGE}/${merchant}/reports/daily/${opts.day}`
    : `${PAYOUT_EDGE}/${merchant}/reports/monthly/${monthFrom(opts)}`;
  if (opts.day) assertDate("--day", opts.day);
  return client.req<Buffer>(path, {
    query: { origin: "dashboard" },
    binary: true,
    headers: { Accept: "application/pdf, */*" },
  });
}

/** Gebührenabrechnung. Monthly fee invoice PDF. */
export async function feeInvoice(
  client: SessionClient,
  merchant: string,
  opts: { month?: string; from?: string },
): Promise<Buffer> {
  return client.req<Buffer>(`${PAYOUT_EDGE}/${merchant}/invoices/monthly/${monthFrom(opts)}`, {
    query: { origin: "dashboard" },
    binary: true,
    headers: { Accept: "application/pdf, */*" },
  });
}

/**
 * Zahlungsbericht. PDF comes from reports/payments; the XLS variant lives on a
 * completely different path and insists on both locale and timezone.
 */
export async function paymentsStatement(
  client: SessionClient,
  merchant: string,
  opts: { month?: string; from?: string; day?: string; format?: string; locale?: string; tz?: string },
): Promise<Buffer> {
  if (opts.format && /xls/i.test(opts.format)) {
    return client.req<Buffer>(
      `${PAYOUT_EDGE}/${merchant}/transactions/monthly/${monthFrom(opts)}`,
      {
        query: {
          origin: "dashboard",
          locale: opts.locale ?? "de-CH",
          timezone: opts.tz ?? DEFAULT_TZ,
        },
        binary: true,
        headers: { Accept: "application/vnd.ms-excel, */*" },
      },
    );
  }
  if (opts.day) assertDate("--day", opts.day);
  const path = opts.day
    ? `${PAYOUT_EDGE}/${merchant}/reports/payments/daily/${opts.day}`
    : `${PAYOUT_EDGE}/${merchant}/reports/payments/monthly/${monthFrom(opts)}`;
  return client.req<Buffer>(path, {
    query: { origin: "dashboard" },
    binary: true,
    headers: { Accept: "application/pdf, */*" },
  });
}

// ---------------------------------------------------------------- invoicing

/** Document types the Rechnungsbericht can emit. */
export const INVOICE_DOC_TYPES = [
  "invoices",
  "invoices-lines",
  "creditnotes",
  "creditnotes-lines",
  "accounting-legacy",
  "quotes-lines",
  "deliverynotes-lines",
] as const;

export type InvoiceDocType = (typeof INVOICE_DOC_TYPES)[number];

/** Rechnungsbericht. One call per document type. */
export async function invoicingReport(
  client: SessionClient,
  merchant: string,
  opts: {
    from: string;
    to: string;
    docType?: InvoiceDocType;
    format?: string;
    includeDocuments?: boolean;
  },
): Promise<Buffer> {
  assertDate("--from", opts.from);
  assertDate("--to", opts.to);
  const docType = opts.docType ?? "invoices";
  const format = /xlsx/i.test(opts.format ?? "") ? "xlsx" : "csv";
  return client.req<Buffer>(
    `/merchants/${merchant}/documents/export/${docType}/${format}`,
    {
      query: {
        fromDate: opts.from,
        toDate: opts.to,
        includeDocuments: String(opts.includeDocuments ?? false),
      },
      binary: true,
      headers: { Accept: "text/csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*" },
    },
  );
}

// ---------------------------------------------------------------- fiscal

interface FiscalRequest {
  /** This service uses camelCase, unlike the snake_case used everywhere else. */
  requestId?: string;
  id?: string;
  request_id?: string;
  [key: string]: unknown;
}

/**
 * KassenSichV / Steuerexporte. Produces a zip on S3 rather than a CSV, and the
 * status endpoint 404s until the job exists, so a 404 means "keep waiting".
 */
export async function fiscalExport(
  client: SessionClient,
  merchant: string,
  opts: { from: string; to: string; country?: string; onProgress?: (m: string) => void },
): Promise<{ url?: string; raw: unknown }> {
  assertDate("--from", opts.from);
  assertDate("--to", opts.to);

  const created = await client.req<FiscalRequest>(
    `/fiscalization/merchants/${merchant}/export/request`,
    {
      method: "POST",
      body: {
        period_start: `${opts.from}T00:00:00Z`,
        period_end: `${opts.to}T00:00:00Z`,
        country_code: opts.country ?? "CH",
      },
    },
  );
  const id = created.requestId ?? created.id ?? created.request_id;
  if (!id) throw new Error(`No request id in response: ${JSON.stringify(created)}`);
  opts.onProgress?.(`fiscal export ${id} requested`);

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const status = await client.req<Record<string, unknown>>(
        `/fiscalization/merchants/${merchant}/export/request/${id}`,
      );
      const text = JSON.stringify(status);
      const url = /"(https:\/\/[^"]*amazonaws[^"]*)"/.exec(text)?.[1];
      if (url) return { url, raw: status };
      if (/FAIL|ERROR/i.test(text)) throw new Error(`Fiscal export failed: ${text}`);
    } catch (err) {
      // The status route 404s until the job materialises.
      if (!/404/.test(String((err as Error).message))) throw err;
    }
  }
  throw new Error("Fiscal export did not produce a download URL in time.");
}

// ---------------------------------------------------------------- registry

export interface ReportDef {
  key: string;
  label: string;
  mechanism: "job" | "direct" | "fiscal" | "payout-edge" | "invoicing";
  module?: ExportModule;
  formats: string[];
  /** "range" wants --from/--to, "month" wants --month YYYY-MM. */
  period: "range" | "month";
  note?: string;
}

/** All ten Download Center reports. */
export const REPORTS: ReportDef[] = [
  { key: "sales", label: "Verkäufe (itemised, tax breakdown)", mechanism: "job", module: "sales_report_v1", formats: ["csv", "xlsx"], period: "range" },
  { key: "revenue", label: "Umsätze (overview)", mechanism: "job", module: "sales_overview_v1", formats: ["pdf"], period: "range", note: "returns a PDF, not CSV" },
  { key: "items", label: "Artikel (per-item performance)", mechanism: "job", module: "item_report_v1", formats: ["csv"], period: "range" },
  { key: "transactions", label: "Transaktionen (payments, fees, payouts)", mechanism: "direct", formats: ["csv", "xls"], period: "range" },
  { key: "cashbook", label: "Kassenbuch", mechanism: "direct", formats: ["csv"], period: "range" },
  { key: "fiscal", label: "Steuerexporte / KassenSichV", mechanism: "fiscal", formats: ["zip"], period: "range" },
  { key: "payouts", label: "Auszahlungsbericht", mechanism: "payout-edge", formats: ["pdf"], period: "month", note: "also accepts --day for a single date" },
  { key: "fees", label: "Gebührenabrechnung (monthly fee invoice)", mechanism: "payout-edge", formats: ["pdf"], period: "month" },
  { key: "payments", label: "Zahlungsbericht", mechanism: "payout-edge", formats: ["pdf", "xls"], period: "month", note: "xls comes from a different path" },
  { key: "invoicing", label: "Rechnungsbericht (invoices, credit notes, quotes)", mechanism: "invoicing", formats: ["csv", "xlsx"], period: "range", note: "--doc-type selects the document set" },
];

/** Everything in the Download Center is mapped. */
export const UNMAPPED_REPORTS: string[] = [];
