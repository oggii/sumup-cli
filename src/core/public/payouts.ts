import type { PublicClient } from "./client.js";
import type { Payout } from "../types.js";

export interface PayoutQuery {
  /** YYYY-MM-DD, inclusive. Required by the API. */
  from: string;
  /** YYYY-MM-DD, inclusive. Required by the API. */
  to: string;
  limit?: number;
  order?: "asc" | "desc";
}

function assertDate(label: string, value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD, got "${value}".`);
  }
}

export async function listPayouts(
  client: PublicClient,
  query: PayoutQuery,
): Promise<Payout[]> {
  assertDate("--from", query.from);
  assertDate("--to", query.to);
  const merchantCode = await client.resolveMerchantCode();
  const result = await client.req<Payout[] | { items?: Payout[] }>(
    `/v1.0/merchants/${merchantCode}/payouts`,
    {
      query: {
        start_date: query.from,
        end_date: query.to,
        format: "json",
        limit: query.limit ?? 9999,
        order: query.order ?? "desc",
      },
    },
  );
  return Array.isArray(result) ? result : (result.items ?? []);
}

/** The API can emit CSV directly, which keeps SumUp's own column names intact. */
export async function payoutsCsv(
  client: PublicClient,
  query: PayoutQuery,
): Promise<string> {
  assertDate("--from", query.from);
  assertDate("--to", query.to);
  const merchantCode = await client.resolveMerchantCode();
  return client.req<string>(`/v1.0/merchants/${merchantCode}/payouts`, {
    query: {
      start_date: query.from,
      end_date: query.to,
      format: "csv",
      limit: query.limit ?? 9999,
      order: query.order ?? "desc",
    },
    headers: { Accept: "text/csv" },
    raw: true,
  });
}
