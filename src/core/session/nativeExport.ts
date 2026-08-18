import type { SessionClient } from "./client.js";
import { resolvePath } from "./endpoints.js";

export interface ExportJob {
  id: string;
  itemsCount: number;
  fileUrl: string;
}

/**
 * SumUp's own items CSV export.
 *
 * This matters more than it looks: the file it produces is byte-for-byte the
 * format the dashboard's Importieren button accepts, so export, edit, import is
 * a fully supported bulk-edit path that needs no reverse-engineered write API.
 */
export async function startCatalogExport(
  client: SessionClient,
  merchant: string,
): Promise<ExportJob> {
  const { method, path } = resolvePath("startCatalogExport", { merchant });
  return client.req<ExportJob>(path, { method });
}

/**
 * The presigned URL is handed back before the object exists, so S3 answers
 * NoSuchKey for the first few seconds. Poll it rather than the statuses
 * endpoint, which stays null for the whole job.
 */
export async function waitForExport(
  fileUrl: string,
  opts: { attempts?: number; intervalMs?: number; onWait?: (n: number) => void } = {},
): Promise<string> {
  const attempts = opts.attempts ?? 20;
  const intervalMs = opts.intervalMs ?? 2000;

  for (let i = 1; i <= attempts; i++) {
    // Deliberately a bare fetch: this is S3, not SumUp, and must not receive
    // the session cookie or the accept-version header.
    const res = await fetch(fileUrl);
    if (res.ok) return res.text();
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(`Export download failed: ${res.status} ${res.statusText}`);
    }
    opts.onWait?.(i);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Export did not become available after ${attempts} attempts. ` +
      "The presigned URL is valid for an hour, so it may simply be slow.",
  );
}

export async function exportCatalogCsv(
  client: SessionClient,
  merchant: string,
  onProgress?: (msg: string) => void,
): Promise<{ csv: string; itemsCount: number; id: string }> {
  const job = await startCatalogExport(client, merchant);
  onProgress?.(`export ${job.id} queued for ${job.itemsCount} items`);
  const csv = await waitForExport(job.fileUrl, {
    onWait: (n) => onProgress?.(`waiting for the file (attempt ${n})`),
  });
  return { csv, itemsCount: job.itemsCount, id: job.id };
}

/**
 * The 47 columns SumUp emits, in order. Kept here so an edited file can be
 * validated before anyone tries to import it.
 */
export const NATIVE_COLUMNS = [
  "Item name",
  "Variations",
  "Option set 1",
  "Option 1",
  "Option set 2",
  "Option 2",
  "Option set 3",
  "Option 3",
  "Option set 4",
  "Option 4",
  "Is variation visible? (Yes/No)",
  "Price",
  "Cost price",
  "Variable price? (Yes/No)",
  "Tax rate (%)",
  "On sale in Online Store?",
  "Regular price (before sale)",
  "Set up different prices and VAT for takeaway",
  "Takeaway price",
  "Takeaway tax rate",
  "Unit",
  "Track inventory? (Yes/No)",
  "Quantity",
  "Low stock threshold",
  "SKU",
  "Barcode",
  "Modifiers",
  "Description (Online Store and Invoices only)",
  "Category",
  "Display item at Checkout? (Yes/No)",
  "Display colour in POS checkout",
  "Image 1",
  "Image 2",
  "Image 3",
  "Image 4",
  "Image 5",
  "Image 6",
  "Image 7",
  "Display item in Online Store? (Yes/No)",
  "SEO title (Online Store only)",
  "SEO description (Online Store only)",
  "Shipping weight [kg] (Online Store only)",
  "Display service in Bookings? (Yes/No)",
  "Duration [minutes] (Bookings only)",
  "Location [business/customer] (Bookings only)",
  "Item id (Do not change)",
  "Variant id (Do not change)",
] as const;

export interface CsvCheck {
  ok: boolean;
  rowCount: number;
  problems: string[];
}

function splitCsvLine(line: string): string[] {
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
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Sanity-checks an edited file before it is handed to SumUp's importer, which
 * gives far worse errors than this does.
 */
export function validateNativeCsv(csv: string): CsvCheck {
  const problems: string[] = [];
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { ok: false, rowCount: 0, problems: ["File is empty."] };

  const header = splitCsvLine(lines[0]!);
  if (header.length !== NATIVE_COLUMNS.length) {
    problems.push(
      `Header has ${header.length} columns, expected ${NATIVE_COLUMNS.length}.`,
    );
  }
  NATIVE_COLUMNS.forEach((expected, i) => {
    if (header[i] !== undefined && header[i] !== expected) {
      problems.push(`Column ${i + 1} is "${header[i]}", expected "${expected}".`);
    }
  });

  const idIndex = NATIVE_COLUMNS.indexOf("Item id (Do not change)");
  lines.slice(1).forEach((line, n) => {
    const cells = splitCsvLine(line);
    if (cells.length !== header.length) {
      problems.push(`Row ${n + 2} has ${cells.length} cells, expected ${header.length}.`);
    }
    const id = cells[idIndex];
    if (id && !/^[0-9a-f-]{36}$/i.test(id)) {
      problems.push(`Row ${n + 2} has a malformed item id "${id}".`);
    }
  });

  return { ok: problems.length === 0, rowCount: lines.length - 1, problems: problems.slice(0, 25) };
}
