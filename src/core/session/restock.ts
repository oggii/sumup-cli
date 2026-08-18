import { NATIVE_COLUMNS } from "./nativeExport.js";

/**
 * Applying a delivery to SumUp's own items CSV.
 *
 * The rule this encodes is the shop's, not SumUp's: a product that already
 * exists is never re-priced when it is restocked. Only the Quantity cell moves.
 * Cost and selling price were set when the item was created and stay put even
 * if the supplier's net price has drifted since.
 *
 * Everything else in a touched row is carried across untouched, byte for byte,
 * by splicing the raw record rather than re-serialising it. That keeps SumUp's
 * own quoting quirks intact, including the trailing-space names it quotes and a
 * plain CSV writer would not.
 */

interface Field {
  value: string;
  /** Offsets into the record's raw text, covering any surrounding quotes. */
  start: number;
  end: number;
}

interface CsvRecord {
  raw: string;
  fields: Field[];
}

/**
 * Splits the file into records and each record into fields, keeping the offsets
 * so a single cell can be replaced without touching the rest of the line.
 *
 * Quoted fields may contain commas and newlines, so records cannot simply be
 * split on a newline the way a line-based reader would.
 */
export function parseRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: Field[] = [];
  let recordStart = 0;
  let fieldStart = 0;
  let value = "";
  let quoted = false;
  let i = 0;

  const endField = (end: number): void => {
    fields.push({ value, start: fieldStart - recordStart, end: end - recordStart });
    value = "";
  };
  const endRecord = (end: number): void => {
    endField(end);
    records.push({ raw: text.slice(recordStart, end), fields });
    fields = [];
  };

  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      value += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField(i);
      i++;
      fieldStart = i;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      const end = i;
      const next = ch === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
      endRecord(end);
      i = next;
      recordStart = i;
      fieldStart = i;
      continue;
    }
    value += ch;
    i++;
  }
  if (i > recordStart || value !== "" || fields.length > 0) endRecord(i);

  return records;
}

/** Replaces one field's raw text, leaving every other byte of the record alone. */
function spliceField(record: CsvRecord, index: number, replacement: string): string {
  const field = record.fields[index];
  if (!field) throw new Error(`Record has no field ${index}.`);
  return record.raw.slice(0, field.start) + replacement + record.raw.slice(field.end);
}

export type RestockMode = "add" | "set";

export interface RestockChange {
  sku: string;
  name: string;
  before: number;
  delivered: number;
  after: number;
}

export interface RestockResult {
  /** A partial native CSV: the header plus only the rows that changed. */
  csv: string;
  changes: RestockChange[];
  /** SKUs asked for that the catalogue does not contain. */
  missing: string[];
  /** SKUs that resolve to more than one row; none are touched. */
  ambiguous: string[];
  /** Rows whose stock is not tracked, so a quantity would be meaningless. */
  untracked: string[];
}

function columnIndex(header: string[], name: string): number {
  const i = header.indexOf(name);
  if (i === -1) {
    throw new Error(
      `The file is missing the "${name}" column, so it is not a SumUp items export.`,
    );
  }
  return i;
}

function headerOf(record: CsvRecord): string[] {
  return record.fields.map((f) => f.value.replace(/^﻿/, ""));
}

/**
 * Builds the partial import file for a delivery.
 *
 * A partial file is deliberate: SumUp matches rows back by "Item id", so
 * shipping only the touched rows leaves the other 680-odd variants completely
 * out of the transaction. Nothing can be clobbered by a stale column.
 */
export function applyRestock(
  csv: string,
  deliveries: Map<string, number>,
  opts: { mode?: RestockMode } = {},
): RestockResult {
  const mode = opts.mode ?? "add";
  const records = parseRecords(csv);
  const headerRecord = records[0];
  if (!headerRecord) throw new Error("The file is empty.");

  const header = headerOf(headerRecord);
  const iSku = columnIndex(header, "SKU");
  const iQty = columnIndex(header, "Quantity");
  const iName = columnIndex(header, "Item name");
  const iTracked = columnIndex(header, "Track inventory? (Yes/No)");
  const iVariation = columnIndex(header, "Variations");

  const bySku = new Map<string, CsvRecord[]>();
  for (const record of records.slice(1)) {
    const sku = record.fields[iSku]?.value.trim();
    if (!sku) continue;
    const list = bySku.get(sku);
    if (list) list.push(record);
    else bySku.set(sku, [record]);
  }

  const changes: RestockChange[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const untracked: string[] = [];
  const lines: string[] = [];

  for (const [sku, delivered] of deliveries) {
    const matches = bySku.get(sku);
    if (!matches || matches.length === 0) {
      missing.push(sku);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push(sku);
      continue;
    }
    const record = matches[0] as CsvRecord;

    // A variant row carries its own quantity but inherits "Track inventory"
    // from the parent item, where that cell sits blank. Only judge a standalone
    // row by its own cell.
    const isVariant = (record.fields[iVariation]?.value ?? "") !== "";
    const tracked = record.fields[iTracked]?.value.trim().toLowerCase();
    if (!isVariant && tracked === "no") {
      untracked.push(sku);
      continue;
    }

    const rawQty = record.fields[iQty]?.value.trim() ?? "";
    const before = rawQty === "" ? 0 : Number(rawQty);
    if (!Number.isFinite(before)) {
      throw new Error(`SKU ${sku} has a non-numeric quantity "${rawQty}".`);
    }
    const after = mode === "set" ? delivered : before + delivered;

    lines.push(spliceField(record, iQty, String(after)));
    changes.push({
      sku,
      name: record.fields[iName]?.value ?? "",
      before,
      delivered,
      after,
    });
  }

  // SumUp's own export is LF, carries no BOM, and ends with a newline. Match it
  // exactly, so its importer sees the shape it produced.
  const csvOut = [headerRecord.raw, ...lines].join("\n") + "\n";

  return { csv: csvOut, changes, missing, ambiguous, untracked };
}

/**
 * Parses "SKU=quantity" pairs, the form deliveries arrive in when they are read
 * off an invoice by hand.
 */
export function parseDeliveries(pairs: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const pair of pairs) {
    const match = /^\s*([^=:]+?)\s*[=:]\s*(-?\d+)\s*$/.exec(pair);
    if (!match) {
      throw new Error(
        `Cannot read "${pair}". Expected SKU=quantity, for example 1-0004=48.`,
      );
    }
    const sku = match[1] as string;
    const qty = Number(match[2]);
    if (out.has(sku)) {
      throw new Error(`SKU ${sku} was given twice. Add the quantities up instead.`);
    }
    out.set(sku, qty);
  }
  return out;
}

/**
 * The SKU-to-quantity pairs a prepared import file asserts.
 *
 * The importer's dialog says nothing at all once it accepts a file, so the only
 * honest confirmation is to read the catalogue back and check it now says what
 * the file said.
 */
export function expectedQuantities(csv: string): Map<string, number> {
  const records = parseRecords(csv);
  const headerRecord = records[0];
  if (!headerRecord) throw new Error("The file is empty.");
  const header = headerOf(headerRecord);
  const iSku = columnIndex(header, "SKU");
  const iQty = columnIndex(header, "Quantity");

  const out = new Map<string, number>();
  for (const record of records.slice(1)) {
    const sku = record.fields[iSku]?.value.trim();
    const qty = record.fields[iQty]?.value.trim();
    if (!sku || !qty) continue;
    const n = Number(qty);
    if (Number.isFinite(n)) out.set(sku, n);
  }
  return out;
}

/** Guards against a caller shipping a file whose columns no longer line up. */
export function assertNativeHeader(csv: string): void {
  const first = parseRecords(csv)[0];
  if (!first) throw new Error("The file is empty.");
  const header = headerOf(first);
  if (header.length !== NATIVE_COLUMNS.length) {
    throw new Error(
      `Header has ${header.length} columns, expected ${NATIVE_COLUMNS.length}. ` +
        "Re-export from SumUp rather than editing an old file.",
    );
  }
}
