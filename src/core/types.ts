export interface MerchantProfile {
  merchant_code: string;
  company_name?: string;
  country?: string;
  currency?: string;
  [key: string]: unknown;
}

export interface Account {
  account?: { username?: string; type?: string };
  merchant_profile?: MerchantProfile;
  personal_profile?: Record<string, unknown>;
  [key: string]: unknown;
}

export type TransactionStatus =
  | "SUCCESSFUL"
  | "CANCELLED"
  | "FAILED"
  | "REFUNDED"
  | "CHARGE_BACK"
  | "PENDING";

export interface TransactionProduct {
  name?: string;
  price?: number;
  quantity?: number;
  vat_rate?: number;
  total_price?: number;
  total_with_vat?: number;
  [key: string]: unknown;
}

export interface TransactionSummary {
  id: string;
  transaction_code?: string;
  amount?: number;
  currency?: string;
  timestamp?: string;
  status?: TransactionStatus;
  payment_type?: string;
  card_type?: string;
  type?: string;
  user?: string;
  payout_plan?: string;
  [key: string]: unknown;
}

export interface TransactionDetail extends TransactionSummary {
  products?: TransactionProduct[];
  events?: Array<Record<string, unknown>>;
  vat_amount?: number;
  tip_amount?: number;
  entry_mode?: string;
  [key: string]: unknown;
}

export interface Payout {
  id?: number;
  amount?: number;
  currency?: string;
  date?: string;
  fee?: number;
  reference?: string;
  status?: string;
  transaction_code?: string;
  type?: string;
  [key: string]: unknown;
}

export interface Paginated<T> {
  items: T[];
  links?: Array<{ rel?: string; href?: string; type?: string }>;
}

/** Normalised catalog shapes. The internal API's raw payload is mapped onto these. */
export interface CatalogProduct {
  id: string;
  name: string;
  description?: string;
  categoryId?: string;
  categoryName?: string;
  price?: number;
  costPrice?: number;
  currency?: string;
  vatRate?: number;
  sku?: string;
  barcode?: string;
  trackStock?: boolean;
  stock?: number;
  active?: boolean;
  variants?: CatalogVariant[];
  raw?: unknown;
}

export interface CatalogVariant {
  id: string;
  name?: string;
  price?: number;
  costPrice?: number;
  sku?: string;
  barcode?: string;
  stock?: number;
  raw?: unknown;
}

export interface CatalogCategory {
  id: string;
  name: string;
  colour?: string;
  productCount?: number;
  raw?: unknown;
}
