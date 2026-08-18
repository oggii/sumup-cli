import type { SessionClient } from "../session/client.js";
import {
  runExportJob,
  SALES_REPORT_COLUMNS,
  transactionsReport,
} from "../session/reports.js";
import { parseCsv, parseNumber, type Row } from "../export/csv.js";
import { round2 } from "../session/catalog.js";

/**
 * Profit for a period, assembled from two reports because neither alone has
 * both sides of the equation:
 *
 *   item_report_v1   revenue and Gewinn (net of VAT, minus cost price)
 *   transactions     the card fees SumUp charges
 *
 * Three traps, all found by reconciling against SumUp's own figures:
 *
 *  1. The transactions report lists every card payment TWICE, once as
 *     "Zahlung" and once as "Auszahlung", carrying the same fee. Summing
 *     blindly doubles the fees.
 *  2. The transactions report covers card payments only. Cash never appears,
 *     so it must come from the item report, and no fee applies to it.
 *  3. Items with no cost price (here: Swisslos lottery) report a blank Gewinn.
 *     They are revenue with no measurable margin and are reported separately
 *     rather than silently counted as either pure profit or pure loss.
 *
 * VAT needs no subtraction: Gewinn is already computed on the net price.
 */

const COL = {
  amount: ["Betrag", "Amount"],
  cost: ["Selbstkostenpreis", "Cost price"],
  profit: ["Gewinn", "Profit"],
  margin: ["Marge", "Margin"],
  qty: ["Menge", "Quantity"],
  name: ["Artikelname", "Item name"],
  variant: ["Variantenname", "Variation name"],
  category: ["Kategorie", "Category"],
  sku: ["Artikelnummer", "SKU"],
  txKind: ["Transaktionsart", "Transaction type"],
  fee: ["Gebührenbetrag", "Fee amount"],
  payMethod: ["Zahlungsmethode", "Payment method"],
  gross: ["Preis (brutto)", "Price (gross)"],
  vat: ["Steuer", "Tax"],
  status: ["Status"],
} as const;

/**
 * A payment row only means money if it actually succeeded. The report also
 * lists "Fehlgeschlagen" and "Abgebrochen" attempts at full value with zero
 * fee, and counting those inflates takings with money that never arrived.
 */
const SUCCESS = new Set(["Erfolgreich", "Successful", "SUCCESSFUL"]);

function pick(row: Row, names: readonly string[]): string {
  for (const n of names) {
    if (row[n] !== undefined) return String(row[n]);
  }
  return "";
}

function requireColumn(rows: Row[], names: readonly string[], label: string): void {
  if (rows.length === 0) return;
  const first = rows[0]!;
  if (!names.some((n) => first[n] !== undefined)) {
    throw new Error(
      `Could not find the ${label} column. Expected one of: ${names.join(", ")}. ` +
        `Got: ${Object.keys(first).join(", ")}. Try --locale de-CH.`,
    );
  }
}

/** A payment row, as opposed to its payout twin or a refund. */
const PAYMENT_KINDS = new Set(["Zahlung", "Payment"]);

export interface ProfitLine {
  sku?: string;
  name: string;
  /**
   * Variants matter: one item can appear on several rows that differ only by
   * variant, e.g. a six-pack and a single can, or per-piece pick-and-mix sold
   * as "Stück". Dropping this makes distinct rows look like duplicates.
   */
  variant?: string;
  category?: string;
  quantity: number;
  revenue: number;
  unitCost?: number;
  profit?: number;
  /**
   * Taken verbatim from SumUp, which computes margin against the NET price.
   * Recomputing it against gross gives a visibly lower number that would not
   * match the dashboard, so it is read rather than derived.
   */
  marginPct?: number;
}

export interface ProfitReport {
  from: string;
  to: string;
  currency: string;
  /** Gross revenue of everything sold as an article, including VAT. */
  revenue: number;
  /** Card takings from the transaction report, the payment-processing record. */
  cardRevenue: number;
  /** Cash takings from the sales report. Includes TWINT if that is rung up as cash. */
  cashRevenue: number;
  /** Cash plus card actually taken. Can exceed `revenue`, see unassignedRevenue. */
  totalTakings: number;
  /**
   * Takings that carry no article line. Should normally be 0. A non-zero value
   * means money was taken without recording what was sold.
   */
  unassignedRevenue: number;
  /** Failed and cancelled card attempts. No money moved; shown for transparency. */
  failedAttempts: number;
  failedAttemptCount: number;
  /** VAT collected, a pass-through and already excluded from grossProfit. */
  vat: number;
  /** Revenue from items that carry no cost price, so margin is unknown. */
  revenueWithoutCost: number;
  /** Net-of-VAT revenue minus cost of goods, as SumUp computes it. */
  grossProfit: number;
  cardFees: number;
  /** grossProfit minus card fees. Still before rent, wages and other overheads. */
  operatingProfit: number;
  marginPct: number;
  effectiveFeeRatePct: number;
  lines: ProfitLine[];
}

export async function computeProfit(
  client: SessionClient,
  merchant: string,
  opts: { from: string; to: string; locale?: string; tz?: string; onProgress?: (m: string) => void },
): Promise<ProfitReport> {
  const common = {
    from: opts.from,
    to: opts.to,
    locale: opts.locale ?? "de-CH",
    tz: opts.tz,
    onProgress: opts.onProgress,
  };

  // Three sources, each authoritative for something different: the item report
  // for margin, the transaction report for card takings and fees, the sales
  // report for how customers actually paid.
  const [itemsCsv, txCsv, salesCsv] = await Promise.all([
    runExportJob(client, merchant, "item_report_v1", common),
    transactionsReport(client, merchant, common),
    runExportJob(client, merchant, "sales_report_v1", {
      ...common,
      columns: SALES_REPORT_COLUMNS,
    }),
  ]);

  const items = parseCsv(itemsCsv.toString("utf8"));
  const tx = parseCsv(txCsv.toString("utf8"));
  const salesLines = parseCsv(salesCsv.toString("utf8"));
  requireColumn(items, COL.profit, "profit");
  requireColumn(tx, COL.txKind, "transaction type");
  requireColumn(salesLines, COL.payMethod, "payment method");

  let revenue = 0;
  let grossProfit = 0;
  let revenueWithoutCost = 0;
  const lines: ProfitLine[] = [];

  for (const row of items) {
    const amount = parseNumber(pick(row, COL.amount));
    const costRaw = pick(row, COL.cost).trim();
    const profitRaw = pick(row, COL.profit).trim();
    const quantity = parseNumber(pick(row, COL.qty));

    revenue += amount;
    if (costRaw === "") {
      revenueWithoutCost += amount;
    } else {
      grossProfit += parseNumber(profitRaw);
    }

    const profit = profitRaw === "" ? undefined : round2(parseNumber(profitRaw));
    lines.push({
      sku: pick(row, COL.sku) || undefined,
      name: pick(row, COL.name),
      variant: pick(row, COL.variant) || undefined,
      category: pick(row, COL.category) || undefined,
      quantity,
      revenue: round2(amount),
      unitCost: costRaw === "" ? undefined : round2(parseNumber(costRaw)),
      profit,
      marginPct:
        profit === undefined
          ? undefined
          : Math.round(parseNumber(pick(row, COL.margin)) * 10) / 10,
    });
  }

  // Payment rows only, and only successful ones. The Auszahlung twins repeat
  // the same fee, and failed or cancelled attempts are not income.
  let cardRevenue = 0;
  let cardFees = 0;
  let failedAttempts = 0;
  let failedAttemptCount = 0;
  for (const row of tx) {
    if (!PAYMENT_KINDS.has(pick(row, COL.txKind).trim())) continue;
    if (!SUCCESS.has(pick(row, COL.status).trim())) {
      failedAttempts += parseNumber(pick(row, COL.amount));
      failedAttemptCount++;
      continue;
    }
    cardRevenue += parseNumber(pick(row, COL.amount));
    cardFees += parseNumber(pick(row, COL.fee));
  }

  // Cash comes from the sales report, not from subtracting card off revenue:
  // subtraction silently absorbs any takings that have no article behind them.
  let cashRevenue = 0;
  let vat = 0;
  for (const row of salesLines) {
    vat += parseNumber(pick(row, COL.vat));
    if (/bar|cash/i.test(pick(row, COL.payMethod))) {
      cashRevenue += parseNumber(pick(row, COL.gross));
    }
  }
  const totalTakings = cashRevenue + cardRevenue;

  const operatingProfit = grossProfit - cardFees;
  return {
    from: opts.from,
    to: opts.to,
    currency: "CHF",
    revenue: round2(revenue),
    cardRevenue: round2(cardRevenue),
    cashRevenue: round2(cashRevenue),
    totalTakings: round2(totalTakings),
    unassignedRevenue: round2(totalTakings - revenue),
    failedAttempts: round2(failedAttempts),
    failedAttemptCount,
    vat: round2(vat),
    revenueWithoutCost: round2(revenueWithoutCost),
    grossProfit: round2(grossProfit),
    cardFees: round2(cardFees),
    operatingProfit: round2(operatingProfit),
    marginPct: revenue ? Math.round((operatingProfit / revenue) * 1000) / 10 : 0,
    effectiveFeeRatePct: cardRevenue
      ? Math.round((cardFees / cardRevenue) * 10000) / 100
      : 0,
    lines: lines.sort((a, b) => (b.profit ?? -1) - (a.profit ?? -1)),
  };
}

export function formatProfit(r: ProfitReport): string {
  const f = (n: number): string => n.toFixed(2).padStart(10);
  return [
    `Zeitraum            ${r.from} bis ${r.to}   (${r.currency})`,
    ``,
    `Einnahmen total    ${f(r.totalTakings)}    Karte ${r.cardRevenue.toFixed(2)}, Bar ${r.cashRevenue.toFixed(2)}`,
    Math.abs(r.unassignedRevenue) > 0.005
      ? `  ohne Artikel     ${f(-r.unassignedRevenue)}    Differenz zum Artikelbericht`
      : null,
    r.failedAttemptCount > 0
      ? `  (nicht gezählt:  ${r.failedAttempts.toFixed(2)} aus ${r.failedAttemptCount} fehlgeschlagenen/abgebrochenen Kartenzahlungen)`
      : null,
    `Umsatz Artikel     ${f(r.revenue)}    davon MwSt ${r.vat.toFixed(2)}`,
    `Rohertrag          ${f(r.grossProfit)}    Verkauf netto minus Selbstkosten`,
    `Kartengebühren     ${f(-r.cardFees)}    ${r.effectiveFeeRatePct}% vom Kartenumsatz`,
    `${"-".repeat(52)}`,
    `Ergebnis           ${f(r.operatingProfit)}    ${r.marginPct}% vom Umsatz`,
    ``,
    r.revenueWithoutCost > 0
      ? `Hinweis: ${r.revenueWithoutCost.toFixed(2)} Umsatz stammt aus Artikeln ohne ` +
        `Selbstkostenpreis und zählt mit 0 Gewinn.`
      : `Alle verkauften Artikel haben einen Selbstkostenpreis.`,
    `MwSt ist bereits herausgerechnet. Vor Miete, Löhnen und übrigen Ausgaben.`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}
