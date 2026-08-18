import type { SessionClient } from "./client.js";
import { resolvePath } from "./endpoints.js";
import { fromMinor, round2 } from "./catalog.js";

export interface RawSale {
  id: string;
  sale_id?: string;
  status?: string;
  timestamp?: string;
  amount?: { currency?: string; value?: number };
  transaction_code?: string;
  type?: string;
  product_summary?: string;
  payment_type?: string;
  card_type?: string;
  entry_mode?: string;
  installments_count?: number;
  payout_plan?: string;
  gift_card?: unknown;
}

export interface SaleRow {
  [key: string]: unknown;
  timestamp?: string;
  transaction_code?: string;
  amount?: number;
  currency?: string;
  status?: string;
  type?: string;
  payment_type?: string;
  card_type?: string;
  products?: string;
  sale_id?: string;
  id: string;
}

export interface DailyTotal {
  label?: string;
  amount?: { currency?: string; value?: number };
}

interface HistoryPage {
  items?: RawSale[];
  pagination_token?: string | null;
  daily_totals?: DailyTotal[];
}

export interface SalesQuery {
  /** Stop after this many sales. */
  max?: number;
  pageSize?: number;
  timezone?: string;
  /** Client-side filter, since the endpoint takes no date range. */
  from?: string;
  to?: string;
}

/**
 * Walks the Umsätze history.
 *
 * Unlike the public API this takes no date filter, only a pagination token, so
 * date narrowing happens client-side and paging stops early once the cursor
 * runs past `from`.
 */
export async function* streamSales(
  client: SessionClient,
  merchant: string,
  query: SalesQuery = {},
): AsyncGenerator<RawSale[]> {
  const { path } = resolvePath("salesHistory", { merchant });
  const pageSize = query.pageSize ?? 100;
  const timezone = query.timezone ?? "Europe/Zurich";
  const fromTs = query.from ? Date.parse(query.from) : undefined;

  let token: string | undefined;
  let emitted = 0;

  while (true) {
    const page = await client.req<HistoryPage>(path, {
      query: { limit: pageSize, timezone, pagination_token: token },
    });
    const items = page.items ?? [];
    if (items.length === 0) return;

    yield items;
    emitted += items.length;

    if (query.max && emitted >= query.max) return;

    // History comes back newest first, so once a page ends before the window
    // there is nothing older worth fetching.
    if (fromTs !== undefined) {
      const oldest = items[items.length - 1]?.timestamp;
      if (oldest && Date.parse(oldest) < fromTs) return;
    }

    token = page.pagination_token ?? undefined;
    if (!token) return;
  }
}

function inWindow(sale: RawSale, from?: number, to?: number): boolean {
  if (from === undefined && to === undefined) return true;
  if (!sale.timestamp) return false;
  const t = Date.parse(sale.timestamp);
  if (from !== undefined && t < from) return false;
  if (to !== undefined && t > to) return false;
  return true;
}

export function toSaleRow(s: RawSale): SaleRow {
  return {
    timestamp: s.timestamp,
    transaction_code: s.transaction_code,
    amount: fromMinor(s.amount?.value),
    currency: s.amount?.currency,
    status: s.status,
    type: s.type,
    payment_type: s.payment_type,
    card_type: s.card_type === "UNKNOWN" ? undefined : s.card_type,
    products: s.product_summary,
    sale_id: s.sale_id,
    id: s.id,
  };
}

export async function listSales(
  client: SessionClient,
  merchant: string,
  query: SalesQuery = {},
): Promise<SaleRow[]> {
  const from = query.from ? Date.parse(query.from) : undefined;
  // A bare date means the whole day, not midnight.
  const to = query.to
    ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(query.to) ? `${query.to}T23:59:59.999` : query.to)
    : undefined;

  const rows: SaleRow[] = [];
  for await (const page of streamSales(client, merchant, query)) {
    for (const sale of page) {
      if (inWindow(sale, from, to)) rows.push(toSaleRow(sale));
    }
    if (query.max && rows.length >= query.max) break;
  }
  return query.max ? rows.slice(0, query.max) : rows;
}

export interface RawPayout {
  id?: number;
  reference?: string;
  payout_date?: string;
  payout_amount?: number;
  total_fee?: number;
  total_amount?: number;
  target?: string;
  status?: string;
}

/**
 * Payouts via the session.
 *
 * Careful: this endpoint reports DECIMAL amounts (152.37), unlike the catalog
 * and sales endpoints which use minor units. No conversion here on purpose.
 */
export async function listPayoutsSession(
  client: SessionClient,
  merchant: string,
  limit = 100,
): Promise<RawPayout[]> {
  const { path } = resolvePath("payouts", { merchant });
  const res = await client.req<{ payouts?: RawPayout[] }>(path, { query: { limit } });
  return (res.payouts ?? []).map((p) => ({
    ...p,
    payout_amount: p.payout_amount === undefined ? undefined : round2(p.payout_amount),
    total_fee: p.total_fee === undefined ? undefined : round2(p.total_fee),
    total_amount: p.total_amount === undefined ? undefined : round2(p.total_amount),
  }));
}

export async function salesByProductSummary(
  client: SessionClient,
  merchant: string,
  query: SalesQuery,
): Promise<Array<{ product: string; appearances: number }>> {
  const sales = await listSales(client, merchant, query);
  const counts = new Map<string, number>();
  for (const s of sales) {
    if (!s.products) continue;
    // product_summary is a display string, so this counts appearances rather
    // than units sold. Good enough to rank movers, not to do stock maths.
    for (const name of String(s.products).split(",")) {
      const key = name.trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([product, appearances]) => ({ product, appearances }))
    .sort((a, b) => b.appearances - a.appearances);
}
