export type Row = Record<string, unknown>;

function escape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Flattens one level of nesting so `merchant_profile.company_name` style keys
 * survive into a spreadsheet. Arrays are left as JSON.
 */
export function flatten(row: Row, prefix = ""): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Row, name));
    } else {
      out[name] = value;
    }
  }
  return out;
}

export interface CsvOptions {
  /** Excel on a Swiss/German locale opens semicolon-separated files cleanly. */
  delimiter?: string;
  /** Fix the column order and set instead of inferring from the first row. */
  columns?: string[];
  /** Prepend a UTF-8 BOM so Excel renders umlauts correctly. */
  bom?: boolean;
}

export function toCsv(rows: Row[], opts: CsvOptions = {}): string {
  const delimiter = opts.delimiter ?? ";";
  const flat = rows.map((r) => flatten(r));

  const columns =
    opts.columns ??
    [...new Set(flat.flatMap((r) => Object.keys(r)))];

  const lines = [
    columns.map(escape).join(delimiter),
    ...flat.map((r) => columns.map((c) => escape(r[c])).join(delimiter)),
  ];

  return (opts.bom === false ? "" : "﻿") + lines.join("\r\n") + "\r\n";
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Minimal RFC4180-ish reader for the report CSVs. Handles quoted fields with
 * embedded delimiters, which SumUp does emit (payment notes, timestamps).
 */
export function parseCsv(text: string, delimiter = ","): Row[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const header = splitLine(lines[0]!, delimiter).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = splitLine(line, delimiter);
    const row: Row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

/** Swiss exports use a plain dot, but be tolerant of a comma decimal mark. */
export function parseNumber(value: unknown): number {
  if (typeof value === "number") return value;
  // Percentages arrive as "48.299%", thousands as "1'234.50".
  const s = String(value ?? "").trim().replace(/%$/, "");
  if (!s) return 0;
  const n = Number(s.replace(/'/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}
