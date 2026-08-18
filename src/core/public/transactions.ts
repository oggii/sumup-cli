import type { PublicClient } from "./client.js";
import type {
  Paginated,
  TransactionDetail,
  TransactionSummary,
} from "../types.js";

export interface TransactionQuery {
  /** ISO date or datetime, inclusive. */
  from?: string;
  /** ISO date or datetime, inclusive. */
  to?: string;
  statuses?: string[];
  paymentTypes?: string[];
  /** Stop after this many transactions overall. */
  max?: number;
  /** Page size handed to the API (SumUp caps this well below 1000). */
  pageSize?: number;
  order?: "ascending" | "descending";
}

function toIso(value: string | undefined, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  // Bare YYYY-MM-DD needs widening, or a whole day of sales goes missing.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
  }
  return value;
}

/**
 * Walks the full transaction history, following the API's `next` links.
 * Yields pages so callers can stream straight to CSV on large date ranges.
 */
export async function* streamTransactions(
  client: PublicClient,
  query: TransactionQuery = {},
): AsyncGenerator<TransactionSummary[]> {
  const merchantCode = await client.resolveMerchantCode();
  const basePath = `/v2.1/merchants/${merchantCode}/transactions/history`;

  let path = basePath;
  let params: Record<string, string | number | undefined> | undefined = {
    limit: query.pageSize ?? 100,
    order: query.order ?? "descending",
    oldest_time: toIso(query.from, false),
    newest_time: toIso(query.to, true),
    statuses: query.statuses?.join(","),
    payment_types: query.paymentTypes?.join(","),
  };

  let emitted = 0;

  while (true) {
    const page: Paginated<TransactionSummary> = await client.req(path, {
      query: params,
    });
    const items = page.items ?? [];
    if (items.length === 0) return;

    if (query.max && emitted + items.length >= query.max) {
      yield items.slice(0, query.max - emitted);
      return;
    }

    emitted += items.length;
    yield items;

    const next = page.links?.find((l) => l.rel === "next")?.href;
    if (!next) return;

    // `next` arrives as a path with its own query string already applied.
    path = next.startsWith("http") ? next : next;
    params = undefined;
  }
}

export async function listTransactions(
  client: PublicClient,
  query: TransactionQuery = {},
): Promise<TransactionSummary[]> {
  const all: TransactionSummary[] = [];
  for await (const page of streamTransactions(client, query)) all.push(...page);
  return all;
}

export async function getTransaction(
  client: PublicClient,
  ref: { id?: string; transactionCode?: string },
): Promise<TransactionDetail> {
  const merchantCode = await client.resolveMerchantCode();
  if (!ref.id && !ref.transactionCode) {
    throw new Error("Pass either an id or a transaction_code.");
  }
  return client.req<TransactionDetail>(
    `/v2.1/merchants/${merchantCode}/transactions`,
    { query: { id: ref.id, transaction_code: ref.transactionCode } },
  );
}

/**
 * Transaction history omits line items, so a per-sale product breakdown needs
 * one detail call each. Kept concurrency-limited to stay under the rate limit.
 */
export async function hydrateLineItems(
  client: PublicClient,
  transactions: TransactionSummary[],
  concurrency = 4,
): Promise<TransactionDetail[]> {
  const out: TransactionDetail[] = new Array(transactions.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < transactions.length) {
      const index = cursor++;
      const tx = transactions[index];
      if (!tx) continue;
      try {
        out[index] = await getTransaction(client, { id: tx.id });
      } catch {
        // A single unreadable sale should not sink a month-long export.
        out[index] = tx as TransactionDetail;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, transactions.length) }, worker),
  );
  return out.filter(Boolean);
}
