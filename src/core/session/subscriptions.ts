import type { SessionClient } from "./client.js";
import { resolvePath } from "./endpoints.js";
import { fromMinor, round2 } from "./catalog.js";

/**
 * Paid SumUp plans, e.g. "Kasse Plus".
 *
 * These matter for profit and are easy to miss: they are billed separately by
 * direct debit rather than deducted from payouts, so they appear nowhere in the
 * transaction, payout or fee data. A shop can look profitable while quietly
 * paying a monthly plan fee.
 */

interface RawPlan {
  id?: string;
  name?: string;
  sku?: string;
  frequency?: string;
  /** Minor units: 4215 means CHF 42.15. */
  price?: number;
  currency?: string;
  product?: { name?: string; category?: string };
}

export interface RawSubscription {
  id?: string;
  status?: string;
  quantity?: number;
  plan?: RawPlan;
  next_billing_at?: string;
  created_at?: string;
  trial?: { period?: number; ended_at?: string };
  contractual_obligation?: { iterations?: number; end_date?: string };
  has_failed_payment?: boolean;
  is_cancellable?: boolean;
}

export interface SubscriptionCharge {
  id?: string;
  name: string;
  product?: string;
  status?: string;
  frequency?: string;
  monthlyPrice?: number;
  currency?: string;
  quantity: number;
  startedAt?: string;
  trialEndedAt?: string;
  nextBillingAt?: string;
  /** Billing dates that fall inside the requested period. */
  billedDates: string[];
  /** What was actually charged during the period. */
  chargedInPeriod: number;
  committedUntil?: string;
}

/**
 * Billing runs monthly from the day the trial ended. Charges are counted by
 * walking those dates rather than by multiplying months, so a mid-period start
 * or an unfinished trial does not silently over- or under-count.
 */
function billingDates(sub: RawSubscription, from: string, to: string): string[] {
  const trialEnd = sub.trial?.ended_at;
  const created = sub.created_at;
  const firstBill = trialEnd ?? created;
  if (!firstBill) return [];

  const out: string[] = [];
  const cursor = new Date(firstBill);
  const end = new Date(`${to}T23:59:59.999Z`);
  const start = new Date(`${from}T00:00:00.000Z`);

  // Guard against a pathological loop on bad data.
  for (let i = 0; i < 240 && cursor <= end; i++) {
    if (cursor >= start) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

export async function listSubscriptions(
  client: SessionClient,
  merchant: string,
  opts: { from?: string; to?: string } = {},
): Promise<SubscriptionCharge[]> {
  const { path } = resolvePath("subscriptions", { merchant });
  const raw = await client.req<RawSubscription[]>(path);

  return (raw ?? []).map((s) => {
    const price = fromMinor(s.plan?.price);
    const qty = s.quantity ?? 1;
    const dates =
      opts.from && opts.to ? billingDates(s, opts.from, opts.to) : [];
    return {
      id: s.id,
      name: s.plan?.name ?? "(unbenannt)",
      product: s.plan?.product?.name,
      status: s.status,
      frequency: s.plan?.frequency,
      monthlyPrice: price,
      currency: s.plan?.currency,
      quantity: qty,
      startedAt: s.created_at?.slice(0, 10),
      trialEndedAt: s.trial?.ended_at?.slice(0, 10),
      nextBillingAt: s.next_billing_at?.slice(0, 10),
      billedDates: dates,
      chargedInPeriod: round2((price ?? 0) * qty * dates.length),
      committedUntil: s.contractual_obligation?.end_date?.slice(0, 10),
    };
  });
}

export function totalSubscriptionCost(subs: SubscriptionCharge[]): number {
  return round2(subs.reduce((s, x) => s + x.chargedInPeriod, 0));
}
