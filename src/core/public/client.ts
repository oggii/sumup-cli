import { request, type RequestOptions } from "../http.js";
import { requireApiKey, type Profile } from "../config.js";
import type { Account } from "../types.js";

/**
 * Client for the documented API at developer.sumup.com. Covers transactions,
 * payouts, receipts and merchant data. It has no catalog endpoints; inventory
 * lives in SessionClient.
 */
export class PublicClient {
  private readonly apiKey: string;
  private readonly base: string;
  private merchantCode?: string;
  private mePromise?: Promise<Account>;

  constructor(profile: Profile) {
    this.apiKey = requireApiKey(profile);
    this.base = profile.apiBase ?? "https://api.sumup.com";
    this.merchantCode = profile.merchantCode;
  }

  get isTestKey(): boolean {
    return this.apiKey.startsWith("sk_test_");
  }

  req<T>(path: string, opts?: RequestOptions): Promise<T> {
    return request<T>(
      this.base,
      path,
      { Authorization: `Bearer ${this.apiKey}` },
      opts,
    );
  }

  /** GET /v0.1/me: account plus merchant profile. Cached per client. */
  me(): Promise<Account> {
    this.mePromise ??= this.req<Account>("/v0.1/me");
    return this.mePromise;
  }

  async resolveMerchantCode(): Promise<string> {
    if (this.merchantCode) return this.merchantCode;
    const me = await this.me();
    const code = me.merchant_profile?.merchant_code;
    if (!code) {
      throw new Error(
        "Could not resolve a merchant_code from /v0.1/me. Set SUMUP_MERCHANT_CODE explicitly.",
      );
    }
    this.merchantCode = code;
    return code;
  }
}
