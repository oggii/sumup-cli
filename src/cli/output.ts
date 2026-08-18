import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { toCsv, toJson, type Row } from "../core/export/csv.js";

export type Format = "json" | "csv" | "table";

export interface EmitOptions {
  format?: Format;
  out?: string;
  columns?: string[];
  delimiter?: string;
}

function table(rows: Row[]): string {
  if (rows.length === 0) return "(no rows)\n";
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 8);
  const cell = (v: unknown): string =>
    v === null || v === undefined
      ? ""
      : typeof v === "object"
        ? "[...]"
        : String(v);

  const widths = columns.map((c) =>
    Math.min(
      40,
      Math.max(c.length, ...rows.map((r) => cell(r[c]).length)),
    ),
  );
  const line = (cells: string[]): string =>
    cells
      .map((v, i) => v.slice(0, widths[i]).padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();

  return [
    line(columns),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map((r) => line(columns.map((c) => cell(r[c])))),
  ].join("\n") + "\n";
}

export function emit(data: unknown, opts: EmitOptions = {}): void {
  const format = opts.format ?? "table";
  const rows = Array.isArray(data) ? (data as Row[]) : [data as Row];

  let text: string;
  if (format === "csv") {
    text = toCsv(rows, { columns: opts.columns, delimiter: opts.delimiter });
  } else if (format === "json") {
    text = toJson(data);
  } else {
    text = table(rows);
  }

  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, text, "utf8");
    process.stderr.write(`wrote ${rows.length} row(s) to ${opts.out}\n`);
  } else {
    process.stdout.write(text);
  }
}

export function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  const body = (err as { body?: unknown }).body;
  if (body) process.stderr.write(JSON.stringify(body, null, 2) + "\n");
  process.exit(1);
}
