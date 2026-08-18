import { readFileSync } from "node:fs";

/**
 * Turns a browser HAR export of a me.sumup.com session into a map of the
 * internal API surface: which paths the web app calls, with what payloads, and
 * what comes back. This is how endpoints.ts gets filled in.
 */

interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    postData?: { text?: string; mimeType?: string };
  };
  response: {
    status: number;
    content?: { text?: string; mimeType?: string; size?: number };
  };
}

export interface DiscoveredCall {
  method: string;
  host: string;
  path: string;
  /** Path with long ids and UUIDs collapsed, so repeats group together. */
  template: string;
  status: number;
  query: Record<string, string>;
  requestBodyKeys?: string[];
  responseShape?: string;
  sampleResponse?: unknown;
  count: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_DIGITS = /^\d{3,}$/;
/** Merchant and transaction codes: uppercase only, and containing a digit. */
const UPPER_CODE = /^(?=[A-Z0-9]*\d)[A-Z0-9]{6,}$/;
const LONG_HEX = /^[0-9a-f]{24,}$/i;
/** Opaque tokens: long, mixed alphabet, and containing a digit. */
const OPAQUE = /^(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}$/;

function isIdSegment(seg: string): boolean {
  return (
    UUID.test(seg) ||
    ALL_DIGITS.test(seg) ||
    UPPER_CODE.test(seg) ||
    LONG_HEX.test(seg) ||
    OPAQUE.test(seg)
  );
}

function templatise(path: string): string {
  return path
    .split("/")
    .map((seg) => (isIdSegment(seg) ? "{id}" : seg))
    .join("/");
}

function describeShape(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return depth > 2 ? "[...]" : `[${describeShape(value[0], depth + 1)}]`;
  }
  if (typeof value === "object") {
    if (depth > 2) return "{...}";
    const keys = Object.keys(value as object).slice(0, 25);
    return `{ ${keys.join(", ")} }`;
  }
  return typeof value;
}

export function parseHar(
  path: string,
  opts: { hostFilter?: RegExp; includeAssets?: boolean } = {},
): DiscoveredCall[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    log?: { entries?: HarEntry[] };
  };
  const entries = raw.log?.entries ?? [];
  const hostFilter = opts.hostFilter ?? /sumup\.(com|co\.uk)$/i;

  const grouped = new Map<string, DiscoveredCall>();

  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry.request.url);
    } catch {
      continue;
    }
    if (!hostFilter.test(url.hostname)) continue;

    const isAsset =
      /\.(js|css|png|jpe?g|svg|woff2?|ico|gif|webp|map)$/i.test(url.pathname);
    if (isAsset && !opts.includeAssets) continue;

    const mime = entry.response.content?.mimeType ?? "";
    if (!opts.includeAssets && mime && !/json|text\/plain/i.test(mime)) continue;

    const template = templatise(url.pathname);
    const key = `${entry.request.method} ${url.hostname}${template}`;

    const existing = grouped.get(key);
    if (existing) {
      existing.count++;
      continue;
    }

    let requestBodyKeys: string[] | undefined;
    if (entry.request.postData?.text) {
      try {
        const body = JSON.parse(entry.request.postData.text) as unknown;
        if (body && typeof body === "object") {
          requestBodyKeys = Object.keys(body as object);
        }
      } catch {
        /* form-encoded or opaque body */
      }
    }

    let sampleResponse: unknown;
    let responseShape: string | undefined;
    const text = entry.response.content?.text;
    if (text) {
      try {
        sampleResponse = JSON.parse(text);
        responseShape = describeShape(sampleResponse);
      } catch {
        /* not JSON */
      }
    }

    grouped.set(key, {
      method: entry.request.method,
      host: url.hostname,
      path: url.pathname,
      template,
      status: entry.response.status,
      query: Object.fromEntries(url.searchParams.entries()),
      requestBodyKeys,
      responseShape,
      sampleResponse,
      count: 1,
    });
  }

  return [...grouped.values()].sort((a, b) =>
    (a.host + a.template).localeCompare(b.host + b.template),
  );
}

/** Heuristic: which of the discovered calls look like catalog/inventory work. */
export function catalogCandidates(calls: DiscoveredCall[]): DiscoveredCall[] {
  const hint =
    /(catalog|catalogue|product|item|catego|variant|stock|inventor|price|modifier)/i;
  return calls.filter((c) => hint.test(c.template) || hint.test(c.responseShape ?? ""));
}

export function formatReport(calls: DiscoveredCall[]): string {
  if (calls.length === 0) return "No SumUp API calls found in this HAR.\n";
  const lines: string[] = [];
  for (const call of calls) {
    lines.push(
      `${call.method.padEnd(6)} ${call.host}${call.template}  [${call.status}]${
        call.count > 1 ? ` x${call.count}` : ""
      }`,
    );
    if (Object.keys(call.query).length) {
      lines.push(`       query: ${Object.keys(call.query).join(", ")}`);
    }
    if (call.requestBodyKeys?.length) {
      lines.push(`       body:  ${call.requestBodyKeys.join(", ")}`);
    }
    if (call.responseShape) {
      lines.push(`       resp:  ${call.responseShape}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
