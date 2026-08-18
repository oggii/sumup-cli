import { request, type RequestOptions } from "../http.js";
import { requireSession, type Profile } from "../config.js";
import { ACCEPT_VERSION, PROXY_BASE } from "./endpoints.js";

/** Decodes a JWT payload without verifying it, to read `exp`. */
function jwtExpiry(token: string): number | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Client for the dashboard's own API, reached through the same-origin proxy at
 * me.sumup.com/api/proxy using the browser session cookie.
 *
 * The `oidc:token` cookie lives about 15 minutes, so this deliberately reports
 * expiry clearly rather than failing with an opaque 401 later.
 */
export class SessionClient {
  private readonly cookie: string;

  constructor(profile: Profile) {
    const checked = requireSession(profile);
    this.cookie = checked.sessionCookie ?? "";
    if (!this.cookie) {
      throw new Error(
        "The catalog API needs a full browser Cookie header, not a bearer token.\n" +
          "Run: sumup auth session --help",
      );
    }
  }

  /**
   * The access token already carries the merchant code, so catalog commands
   * never need the public API key just to learn who they are talking about.
   */
  merchantCode(): string | undefined {
    const match = /oidc:token=([^;]+)/.exec(this.cookie);
    const part = match?.[1]?.split(".")[1];
    if (!part) return undefined;
    try {
      const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
      const payload = JSON.parse(json) as {
        ext?: { classic?: { merchant_code?: string } };
      };
      return payload.ext?.classic?.merchant_code;
    } catch {
      return undefined;
    }
  }

  /** Seconds until the access token expires; negative when already stale. */
  secondsRemaining(): number | undefined {
    const match = /oidc:token=([^;]+)/.exec(this.cookie);
    if (!match?.[1]) return undefined;
    const exp = jwtExpiry(match[1]);
    return exp === undefined ? undefined : exp - Math.floor(Date.now() / 1000);
  }

  assertFresh(): void {
    const left = this.secondsRemaining();
    if (left !== undefined && left <= 0) {
      throw new Error(
        `Session expired ${Math.abs(left)}s ago. SumUp dashboard tokens last about 15 minutes.\n` +
          "Refresh it with: sumup auth capture",
      );
    }
  }

  async req<T>(path: string, opts?: RequestOptions): Promise<T> {
    this.assertFresh();
    try {
      return await request<T>(
        PROXY_BASE,
        path,
        {
          Cookie: this.cookie,
          // Without this header the upstream answers 404 on almost everything.
          "accept-version": ACCEPT_VERSION,
          Accept: "application/json, text/plain, */*",
          Origin: "https://me.sumup.com",
          Referer: "https://me.sumup.com/de-ch/catalog",
        },
        opts,
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        throw new Error(
          `Session rejected (HTTP ${status}). Refresh it with: sumup auth capture`,
        );
      }
      if (status === 404) {
        throw new Error(
          `404 on ${path}. If the path looks right, SumUp may have moved to a new ` +
            `accept-version (this build sends ${ACCEPT_VERSION}). Re-map with: sumup discover`,
        );
      }
      throw err;
    }
  }

  /** Walks an offset/limit search endpoint until every row is collected. */
  async *paginate<T>(
    path: string,
    itemsKey: string,
    countKey: string,
    opts: { pageSize?: number; query?: Record<string, string | number>; body?: unknown } = {},
  ): AsyncGenerator<T[]> {
    const pageSize = opts.pageSize ?? 200;
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const page = await this.req<Record<string, unknown>>(path, {
        method: "POST",
        query: { ...opts.query, offset, limit: pageSize },
        body: opts.body ?? { filters: [] },
      });
      const rows = (page[itemsKey] as T[]) ?? [];
      const count = page[countKey];
      if (typeof count === "number") total = count;
      if (rows.length === 0) return;
      yield rows;
      offset += rows.length;
      if (rows.length < pageSize && offset >= total) return;
    }
  }
}
