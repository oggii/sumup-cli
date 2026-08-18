export class SumUpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "SumUpError";
  }
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Return the raw text instead of parsing JSON (used for CSV responses). */
  raw?: boolean;
  /** Return a Buffer. Required for PDF and zip reports, which text-decoding corrupts. */
  binary?: boolean;
}

const MAX_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(
  base: string,
  path: string,
  query?: RequestOptions["query"],
): string {
  const url = new URL(path.startsWith("http") ? path : base.replace(/\/$/, "") + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Single HTTP layer for both the public API and the internal one. Retries on
 * 429 and 5xx with exponential backoff; SumUp rate-limits aggressively on
 * transaction history pulls.
 */
export async function request<T = unknown>(
  base: string,
  path: string,
  authHeaders: Record<string, string>,
  opts: RequestOptions = {},
): Promise<T> {
  const url = buildUrl(base, path, opts.query);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "sumup-cli/0.1.0",
    ...authHeaders,
    ...opts.headers,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let lastError: SumUpError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      if (opts.binary) return Buffer.from(await res.arrayBuffer()) as T;
      const text = await res.text();
      if (opts.raw) return text as T;
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    }

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep the raw text */
    }

    const retryable = res.status === 429 || res.status >= 500;
    lastError = new SumUpError(
      `${res.status} ${res.statusText} on ${opts.method ?? "GET"} ${url}`,
      res.status,
      url,
      parsed,
    );

    if (!retryable || attempt === MAX_RETRIES) throw lastError;

    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 2 ** attempt * 500;
    await sleep(delay);
  }

  throw lastError;
}
