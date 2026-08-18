/**
 * Internal endpoints behind me.sumup.com.
 *
 * NOT OFFICIAL. Mapped on 2026-08-17 by driving the real dashboard and reading
 * its network traffic, against a real merchant account. SumUp can change any of this
 * without notice, so each entry records status and observation date.
 *
 * Two things are easy to get wrong and cost an hour each:
 *   1. Every call needs the `accept-version: 4.0.0` header. Without it the
 *      upstream returns 404, which reads like a wrong path but is not.
 *   2. Auth is the browser session cookie against the same-origin Next.js
 *      proxy at me.sumup.com/api/proxy, not a bearer token to api.sumup.com.
 *
 * See docs/api-map.md for the full surface including endpoints not wired up.
 */
export type EndpointStatus = "verified" | "unverified";

export interface EndpointSpec {
  method: string;
  /** Path template under the proxy base; {merchant} and {id} are substituted. */
  path: string;
  status: EndpointStatus;
  /** ISO date the call was last observed working. */
  observed?: string;
  notes?: string;
}

export const PROXY_BASE = "https://me.sumup.com/api/proxy";
/** The non-proxy root, used by a couple of Next.js route handlers. */
export const APP_BASE = "https://me.sumup.com/api";
export const ACCEPT_VERSION = "4.0.0";

export const ENDPOINTS = {
  // ---------------------------------------------------------------- catalog
  searchItems: {
    method: "POST",
    path: "/merchants/{merchant}/catalog/items/search",
    status: "verified",
    observed: "2026-08-17",
    notes: 'Body {"filters":[]}. Returns { items, items_count }. No stock or SKU.',
  },
  searchInventory: {
    method: "POST",
    path: "/merchants/{merchant}/inventory/search",
    status: "verified",
    observed: "2026-08-17",
    notes:
      'Body {"filters":[]}. Returns { inventories, inventories_count }. One row per variant, carries sku and stock.',
  },
  getItem: {
    method: "GET",
    path: "/merchants/{merchant}/catalog/items/{id}",
    status: "verified",
    observed: "2026-08-17",
    notes: "Query custom_attributes=bookings,uber_eats. Includes variants[].stock with sku.",
  },
  listCategories: {
    method: "GET",
    path: "/merchants/{merchant}/catalog/categories",
    status: "verified",
    observed: "2026-08-17",
  },
  listTaxRates: {
    method: "GET",
    path: "/merchants/{merchant}/tax-rates",
    status: "verified",
    observed: "2026-08-17",
    notes: "tax_rate is percent times 1000, so 8100 means 8.1 percent.",
  },
  listUnitGroups: {
    method: "GET",
    path: "/merchants/{merchant}/catalog/unit-groups",
    status: "verified",
    observed: "2026-08-17",
  },
  listDeposits: {
    method: "GET",
    path: "/merchants/{merchant}/catalog/deposits",
    status: "verified",
    observed: "2026-08-17",
    notes: "Pfand tab.",
  },
  listModifierSets: {
    method: "GET",
    path: "/merchants/{merchant}/catalog/modifier-sets",
    status: "verified",
    observed: "2026-08-17",
    notes: "Extras tab. Returns { modifier_sets }.",
  },
  searchModifiers: {
    method: "POST",
    path: "/merchants/{merchant}/catalog/modifiers/search",
    status: "verified",
    observed: "2026-08-17",
    notes: 'Body {"filters":[]}, query offset/limit/order.',
  },
  listOptions: {
    method: "GET",
    path: "/merchants/{merchant}/catalog/options",
    status: "verified",
    observed: "2026-08-17",
    notes: "Optionsgruppen tab. Returns { options }.",
  },
  listPromotions: {
    method: "GET",
    path: "/v1/merchants/{merchant}/promotions",
    status: "verified",
    observed: "2026-08-17",
    notes: "Rabatte tab. Query type=DISCOUNT. Returns a bare array.",
  },
  listColors: {
    method: "GET",
    path: "/merchants/{merchant}/catalog/colors",
    status: "verified",
    observed: "2026-08-17",
  },
  catalogConfigs: {
    method: "GET",
    path: "/merchants/{merchant}/catalog/configs",
    status: "verified",
    observed: "2026-08-17",
  },

  // ------------------------------------------------- catalog bulk CSV round trip
  startCatalogExport: {
    method: "POST",
    path: "/merchants/{merchant}/catalog/exports/start",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "No body. Returns { id, itemsCount, fileUrl }. fileUrl is a presigned S3 CSV valid 1h, " +
      "but generated asynchronously: it 404s with NoSuchKey for a few seconds, so poll it. " +
      "47 columns, and it is exactly the format the Importieren button accepts.",
  },
  catalogJobStatuses: {
    method: "GET",
    path: "/merchants/{merchant}/catalog/statuses",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "Returns { import, export }. Stayed null throughout a full export, so it does NOT " +
      "track export readiness. Poll the presigned fileUrl instead.",
  },
  startCatalogImport: {
    method: "POST",
    path: "/merchants/{merchant}/catalog/imports/start",
    status: "unverified",
    notes:
      "GUESSED by symmetry with exports/start, and still never called. The Importieren " +
      "button only opens a native file picker (input[type=file] accept=text/csv) and fires " +
      "nothing until a file is chosen. Rather than guess the request, `sumup catalog import` " +
      "drives the real dialog in a browser: Weitere Optionen -> the Import menu entry -> " +
      "input[type=file] -> SELECTORS.IMPORT.CONTINUE_BUTTON. Verified working 2026-08-18 by " +
      "importing a one-row file, reading the change back, and importing the original value " +
      "again. The dialog reports nothing on success, so the CLI confirms by re-reading the " +
      "catalogue instead.",
  },

  // ---------------------------------------------------------------- sales
  salesHistory: {
    method: "GET",
    path: "/sales/v1/{merchant}/history",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "Query limit, timezone, pagination_token. Returns { items, pagination_token, daily_totals }. " +
      "Amounts in minor units. Includes product_summary and payment_type. This is the Umsätze " +
      "screen, and it needs no public API key.",
  },
  insights: {
    method: "POST",
    path: "/merchants/{merchant}/insights",
    status: "unverified",
    notes:
      "Body { start_date, end_date, modules }. 400s on modules:['revenue'], so the accepted " +
      "module names are still unknown.",
  },

  // ---------------------------------------------------------------- money
  payouts: {
    method: "GET",
    path: "/v1.1/merchants/{merchant}/payouts",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "Query limit. Returns { payouts, links }. NOTE: amounts here are DECIMAL (152.37), " +
      "unlike the catalog and sales endpoints which use minor units.",
  },
  receivables: {
    method: "GET",
    path: "/payout-reports-edge/api/v3/merchants/{merchant}/balances/receivables",
    status: "verified",
    observed: "2026-08-17",
  },
  payoutSettings: {
    method: "GET",
    path: "/payout-settings-edge/api/v5/merchants/{merchant}/payout-settings/overview",
    status: "verified",
    observed: "2026-08-17",
  },
  bankAccounts: {
    method: "GET",
    path: "/v1.1/merchants/{merchant}/bank-accounts",
    status: "verified",
    observed: "2026-08-17",
  },
  cashState: {
    method: "GET",
    path: "/v1.0/merchants/{merchant}/cash-management/cash-state",
    status: "verified",
    observed: "2026-08-17",
    notes: "Returns { expected_balance, last_started_session }.",
  },
  // ------------------------------------------------- Download Center reports
  createExportJob: {
    method: "POST",
    path: "/merchants/{merchant}/exports",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "Query locale, tz. Body { start_date, end_date, modules }. 202 with { export_id, status }. " +
      "Only three module names are accepted: sales_report_v1 (takes format + columns), " +
      "sales_overview_v1 (returns a PDF), item_report_v1. Anything else 400s with " +
      '"module can not be empty".',
  },
  exportJobStatus: {
    method: "GET",
    path: "/merchants/{merchant}/exports/{id}",
    status: "verified",
    observed: "2026-08-17",
    notes: "Poll until status is DONE. Usually ready in a couple of seconds.",
  },
  exportJobDownload: {
    method: "GET",
    path: "/merchants/{merchant}/exports/{id}/downloads",
    status: "verified",
    observed: "2026-08-17",
    notes: "Returns the file BODY directly, not a URL. May be CSV or PDF.",
  },
  transactionsExport: {
    method: "GET",
    path: "/v2.1/merchants/{merchant}/transactions/export",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "Transaktionsbericht, direct CSV. Query start_time, end_time, format, order, locale, " +
      "timezone. The dashboard sends start_time as the NEWER bound with order=descending.",
  },
  cashbookExport: {
    method: "GET",
    path: "/v1.0/merchants/{merchant}/cash-management/report",
    status: "verified",
    observed: "2026-08-17",
    notes: "Kassenbuch, direct CSV. Query format, from_date, until_date, locale, timezone.",
  },
  fiscalExportRequest: {
    method: "POST",
    path: "/fiscalization/merchants/{merchant}/export/request",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "KassenSichV. Body { period_start, period_end, country_code }. Returns { requestId } in " +
      "camelCase, unlike everything else here. Poll the status route, which 404s until the job " +
      "exists, then fetch the S3 zip of per-day archives.",
  },
  fiscalExportStatus: {
    method: "GET",
    path: "/fiscalization/merchants/{merchant}/export/request/{id}",
    status: "verified",
    observed: "2026-08-17",
    notes: "404 means not ready yet, not missing.",
  },
  payoutStatement: {
    method: "GET",
    path: "/payout-reports-edge/api/v3/merchants/{merchant}/reports/monthly/{id}",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "Auszahlungsbericht PDF, {id} is YYYY-MM. Query origin=dashboard. " +
      "Also /reports/daily/{YYYY-MM-DD} for a single day.",
  },
  feeInvoice: {
    method: "GET",
    path: "/payout-reports-edge/api/v3/merchants/{merchant}/invoices/monthly/{id}",
    status: "verified",
    observed: "2026-08-17",
    notes: "Gebührenabrechnung PDF, {id} is YYYY-MM.",
  },
  paymentsStatement: {
    method: "GET",
    path: "/payout-reports-edge/api/v3/merchants/{merchant}/reports/payments/monthly/{id}",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "Zahlungsbericht PDF, {id} is YYYY-MM. Daily variant at /reports/payments/daily/{date}. " +
      "The XLS version lives elsewhere, see paymentsStatementXls.",
  },
  paymentsStatementXls: {
    method: "GET",
    path: "/payout-reports-edge/api/v3/merchants/{merchant}/transactions/monthly/{id}",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "XLS form of the Zahlungsbericht. Requires BOTH locale and timezone query params or it " +
      "400s. Returns a legacy OLE2 .xls (D0 CF 11 E0), so it must be handled as bytes.",
  },
  invoicingExport: {
    method: "GET",
    path: "/merchants/{merchant}/documents/export/{id}/csv",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "Rechnungsbericht. {id} is the document type: invoices, invoices-lines, creditnotes, " +
      "creditnotes-lines, accounting-legacy, quotes-lines, deliverynotes-lines. Final path " +
      "segment is the format (csv or xlsx). Query fromDate, toDate, includeDocuments. " +
      "Emits its own UTF-8 BOM, so do not add a second one.",
  },
  salesReportMeta: {
    method: "GET",
    path: "/merchants/{merchant}/exports/sales_report_v1/meta",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "Returns { displayableColumns }: date, type, transaction_id, payment_method, quantity, " +
      "description, category, sku, currency, price_before_discount, discount, price_gross, " +
      "price_net, tax, tax_rate, account. The trigger endpoint for this report is NOT mapped.",
  },

  // ---------------------------------------------------------------- people
  listCustomers: {
    method: "GET",
    path: "/ucd/v2/merchants/{merchant}/customers",
    status: "verified",
    observed: "2026-08-17",
    notes: "Query limit, offset. Returns { items }.",
  },
  listMembers: {
    method: "GET",
    path: "/v0.1/merchants/{merchant}/members",
    status: "verified",
    observed: "2026-08-17",
    notes: "Query limit, offset, scroll, status. Returns { items, total_count }.",
  },
  listRoles: {
    method: "GET",
    path: "/v0.1/merchants/{merchant}/roles",
    status: "verified",
    observed: "2026-08-17",
  },

  // ---------------------------------------------------------------- expenses
  listExpenses: {
    method: "GET",
    path: "/merchants/{merchant}/expenses",
    status: "verified",
    observed: "2026-08-17",
    notes: "Query fromDate, toDate, limit, offset, order, source_type. Returns { data, pagination }.",
  },
  expenseCategories: {
    method: "GET",
    path: "/merchants/{merchant}/expenses-categories",
    status: "verified",
    observed: "2026-08-17",
  },
  expenseTotals: {
    method: "GET",
    path: "/merchants/{merchant}/expenses/totals",
    status: "verified",
    observed: "2026-08-17",
    notes: "Query currency, fromDate, toDate, interval, lng. Trailing slash variant 308s.",
  },

  // ---------------------------------------------------------------- online store
  storeOrders: {
    method: "GET",
    path: "/merchants/{merchant}/online-store/orders",
    status: "verified",
    observed: "2026-08-17",
    notes: "Query archived, paymentStatus[], limit, orderBy, orderDirection. Returns { total, items }.",
  },
  storeOrderCount: {
    method: "GET",
    path: "/merchants/{merchant}/online-store/orders/count",
    status: "verified",
    observed: "2026-08-17",
  },
  storeSettings: {
    method: "GET",
    path: "/online-store/shop/settings",
    status: "verified",
    observed: "2026-08-17",
    notes: "Not merchant-scoped in the path; the session identifies the shop.",
  },

  // ---------------------------------------------------------------- invoicing
  invoices: {
    method: "GET",
    path: "/merchants/{merchant}/debitoor-customers",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "Invoicing is the acquired Debitoor stack, hence the naming. Invoice list itself lives " +
      "on the app base, not the proxy: GET /api/invoicing/invoices/merchants/{merchant}.",
  },

  // ---------------------------------------------------------------- misc
  paymentLinkTokens: {
    method: "GET",
    path: "/v1/merchants/{merchant}/payment-links/tokens",
    status: "verified",
    observed: "2026-08-17",
    notes: "Returns { limit, offset, tokens, total }.",
  },
  merchantProfile: {
    method: "GET",
    path: "/v1/merchants/{merchant}",
    status: "verified",
    observed: "2026-08-17",
  },
  currentUser: {
    method: "GET",
    path: "/v0.1/user",
    status: "verified",
    observed: "2026-08-17",
  },
  subscriptions: {
    method: "GET",
    path: "/v1/merchants/{merchant}/subscriptions",
    status: "verified",
    observed: "2026-08-17",
    notes:
      "Paid plans such as 'Kasse Plus' (POS Plus). price is in MINOR UNITS (4215 = CHF 42.15) " +
      "and frequency is monthly. These are billed separately, NOT deducted from payouts, so " +
      "they are invisible in the transaction and payout data and easy to miss as a cost.",
  },
  entitlements: {
    method: "GET",
    path: "/v0.1/merchants/{merchant}/entitlements",
    status: "verified",
    observed: "2026-08-17",
    notes: "Query features[]=pos_cost_price etc. Gates paid features like cost price.",
  },

  // ---------------------------------------------------------------- writes
  updateItem: {
    method: "PUT",
    path: "/merchants/{merchant}/catalog/items/{id}",
    status: "unverified",
    notes:
      "Shape not captured. Prefer the CSV round trip (startCatalogExport, edit, import), " +
      "which is SumUp's own supported bulk-edit path.",
  },
} satisfies Record<string, EndpointSpec>;

export type EndpointName = keyof typeof ENDPOINTS;

export function resolvePath(
  name: EndpointName,
  vars: Record<string, string> = {},
): { method: string; path: string } {
  const spec = ENDPOINTS[name];
  const path = spec.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key];
    if (!value) throw new Error(`Missing "${key}" for endpoint ${name}.`);
    return encodeURIComponent(value);
  });
  return { method: spec.method, path };
}

export function unverifiedEndpoints(): string[] {
  return Object.entries(ENDPOINTS)
    .filter(([, spec]) => spec.status === "unverified")
    .map(([name]) => name);
}

export function endpointSummary(): string {
  const rows = Object.entries(ENDPOINTS).map(
    ([name, s]) => `${s.status === "verified" ? "ok " : "?? "} ${s.method.padEnd(5)} ${name}`,
  );
  return rows.sort().join("\n");
}
