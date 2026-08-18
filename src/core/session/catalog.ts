import type { SessionClient } from "./client.js";
import { resolvePath } from "./endpoints.js";

/** Keeps derived money out of binary-float territory, e.g. 1.5399999999999998. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** SumUp returns money in minor units: 290 CHF cents is 2.90. */
export function fromMinor(value: number | undefined, decimals = 2): number | undefined {
  return value === undefined || value === null ? undefined : value / 10 ** decimals;
}

export function toMinor(value: number, decimals = 2): number {
  return Math.round(value * 10 ** decimals);
}

/** tax_rate arrives as percent times 1000, so 8100 means 8.1 percent. */
export function taxPercent(rate: number | null | undefined): number | undefined {
  return rate === null || rate === undefined ? undefined : rate / 1000;
}

export interface RawMoney {
  currency?: string;
  value?: number;
}

export interface RawVariant {
  variant_id: string;
  name?: string;
  barcode?: string;
  price_type?: string;
  price?: {
    amount?: RawMoney;
    amount_net?: RawMoney;
    amount_gross?: RawMoney;
    tax_included?: boolean;
  };
  cost_price?: { value?: number };
  tracking_quantity?: boolean;
  selected_status?: string;
  is_sold_out?: boolean;
  stock?: { quantity?: number; low_inventory_threshold?: number; sku?: string };
  position?: number;
}

export interface RawItem {
  item_id: string;
  name: string;
  description?: string;
  category_ids?: string[];
  tax_ids?: string[];
  image_urls?: string[];
  variants?: RawVariant[];
  variants_count?: number;
  unit_id?: string;
  color_tag?: string;
  sell_online?: boolean;
  visible_channels?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface RawCategory {
  category_id: string;
  name: string;
  items_count?: number;
  color_tag?: string | null;
  display_name?: string | null;
}

export interface RawTax {
  tax_id: string;
  name: string;
  tax_code?: string;
  tax_rate?: number | null;
  country_code?: string;
}

export interface RawInventory {
  item_id: string;
  variant_id: string;
  category_id?: string;
  item_name?: string;
  variant_name?: string;
  inventory_name?: string;
  sku?: string;
  unit_id?: string;
  tracking_quantity?: boolean;
  selected_status?: string;
  is_sold_out?: boolean;
  stock?: { quantity?: number; low_inventory_threshold?: number };
}

/** One flat row per sellable variant, which is the unit people actually reason about. */
export interface CatalogRow {
  [key: string]: unknown;
  item_id: string;
  variant_id: string;
  name: string;
  variant_name?: string;
  sku?: string;
  barcode?: string;
  category?: string;
  category_id?: string;
  price?: number;
  price_net?: number;
  cost_price?: number;
  margin?: number;
  margin_pct?: number;
  currency?: string;
  tax_name?: string;
  tax_pct?: number;
  unit?: string;
  tracking_quantity?: boolean;
  stock?: number;
  low_stock_threshold?: number;
  sold_out?: boolean;
  status?: string;
  sell_online?: boolean;
  channels?: string;
  variants_count?: number;
  updated_at?: string;
}

async function collect<T>(gen: AsyncGenerator<T[]>): Promise<T[]> {
  const out: T[] = [];
  for await (const page of gen) out.push(...page);
  return out;
}

export async function fetchItems(
  client: SessionClient,
  merchant: string,
): Promise<RawItem[]> {
  const { path } = resolvePath("searchItems", { merchant });
  return collect(
    client.paginate<RawItem>(path, "items", "items_count", {
      query: {
        order: "item.name",
        tax_included: "true",
        include_modifier_sets_count: "true",
        include_deposit_ids: "false",
      },
    }),
  );
}

export async function fetchInventory(
  client: SessionClient,
  merchant: string,
): Promise<RawInventory[]> {
  const { path } = resolvePath("searchInventory", { merchant });
  return collect(
    client.paginate<RawInventory>(path, "inventories", "inventories_count", {
      query: { order: "-inventory.tracking_enabled,inventory.quantity" },
    }),
  );
}

export async function fetchCategories(
  client: SessionClient,
  merchant: string,
): Promise<RawCategory[]> {
  const { path } = resolvePath("listCategories", { merchant });
  const res = await client.req<{ categories?: RawCategory[] }>(path);
  return res.categories ?? [];
}

export async function fetchTaxRates(
  client: SessionClient,
  merchant: string,
): Promise<RawTax[]> {
  const { path } = resolvePath("listTaxRates", { merchant });
  const res = await client.req<{ taxes?: RawTax[] }>(path);
  return res.taxes ?? [];
}

export async function fetchItem(
  client: SessionClient,
  merchant: string,
  id: string,
): Promise<RawItem> {
  const { path } = resolvePath("getItem", { merchant, id });
  return client.req<RawItem>(path, {
    query: { custom_attributes: "bookings,uber_eats" },
  });
}

/**
 * Builds the flat export.
 *
 * The item search carries prices but no SKU or stock; the inventory search
 * carries SKU and stock but no prices. Joining them on variant_id is the only
 * way to get one complete row, and it is what the dashboard does visually.
 */
export async function buildCatalogRows(
  client: SessionClient,
  merchant: string,
): Promise<CatalogRow[]> {
  const [items, inventory, categories, taxes] = await Promise.all([
    fetchItems(client, merchant),
    fetchInventory(client, merchant),
    fetchCategories(client, merchant),
    fetchTaxRates(client, merchant),
  ]);

  const categoryById = new Map(categories.map((c) => [c.category_id, c]));
  const taxById = new Map(taxes.map((t) => [t.tax_id, t]));
  const inventoryByVariant = new Map(inventory.map((i) => [i.variant_id, i]));

  const rows: CatalogRow[] = [];

  for (const item of items) {
    const categoryId = item.category_ids?.[0];
    const category = categoryId ? categoryById.get(categoryId) : undefined;
    const tax = item.tax_ids?.[0] ? taxById.get(item.tax_ids[0]) : undefined;

    for (const variant of item.variants ?? []) {
      const inv = inventoryByVariant.get(variant.variant_id);
      const price = fromMinor(variant.price?.amount_gross?.value ?? variant.price?.amount?.value);
      const priceNet = fromMinor(variant.price?.amount_net?.value);
      const cost = fromMinor(variant.cost_price?.value);

      // SumUp's own "Gewinn" and "Marge" are computed against the NET price,
      // not the gross one. Verified against the dashboard: 2.68 net minus 1.44
      // cost shows as CHF 1.24 and 46.3 percent, which gross would not give.
      const marginBase = priceNet ?? price;
      const margin =
        marginBase !== undefined && cost !== undefined
          ? round2(marginBase - cost)
          : undefined;

      rows.push({
        item_id: item.item_id,
        variant_id: variant.variant_id,
        name: item.name,
        variant_name: variant.name || inv?.variant_name || undefined,
        // SKU only exists on the inventory side, except on a single-item fetch.
        sku: variant.stock?.sku ?? inv?.sku,
        barcode: variant.barcode,
        category: category?.name,
        category_id: categoryId,
        price,
        price_net: fromMinor(variant.price?.amount_net?.value),
        cost_price: cost,
        margin,
        margin_pct:
          margin !== undefined && marginBase
            ? Math.round((margin / marginBase) * 1000) / 10
            : undefined,
        currency: variant.price?.amount?.currency,
        tax_name: tax?.name,
        tax_pct: taxPercent(tax?.tax_rate),
        unit: item.unit_id,
        tracking_quantity: variant.tracking_quantity ?? inv?.tracking_quantity,
        stock: variant.stock?.quantity ?? inv?.stock?.quantity,
        low_stock_threshold:
          variant.stock?.low_inventory_threshold ?? inv?.stock?.low_inventory_threshold,
        sold_out: variant.is_sold_out ?? inv?.is_sold_out,
        status: variant.selected_status ?? inv?.selected_status,
        sell_online: item.sell_online,
        channels: item.visible_channels?.join("|"),
        variants_count: item.variants_count,
        updated_at: item.updated_at,
      });
    }
  }

  return rows;
}

export const CATALOG_COLUMNS: Array<keyof CatalogRow> = [
  "sku",
  "name",
  "variant_name",
  "category",
  "price",
  "cost_price",
  "margin",
  "margin_pct",
  "tax_pct",
  "currency",
  "stock",
  "low_stock_threshold",
  "tracking_quantity",
  "sold_out",
  "status",
  "barcode",
  "unit",
  "sell_online",
  "channels",
  "item_id",
  "variant_id",
  "category_id",
  "updated_at",
];
