# SumUp dashboard API map

Mapped 2026-08-17 by driving the real me.sumup.com dashboard and recording its
network traffic, against a live retail account with locale `de-ch`.

None of this is official or documented by SumUp. It can change without notice.

## Ground rules

| Rule | Detail |
|---|---|
| Base | `https://me.sumup.com/api/proxy` (same-origin Next.js proxy) |
| Secondary base | `https://me.sumup.com/api` for a few Next route handlers, e.g. invoicing |
| Auth | Browser session cookies (`oidc:token`, `oidc:refresh_token`) |
| Required header | **`accept-version: 4.0.0`** |
| Token life | ~15 minutes; loading the dashboard mints a fresh one |

Forgetting `accept-version` returns **404**, not 401 or 400. That misleads you
into thinking the path is wrong. It is the single most expensive gotcha here.

## Unit conventions, which are not consistent

| Area | Convention | Example |
|---|---|---|
| Catalog prices, cost prices | Minor units | `290` = CHF 2.90 |
| Sales amounts | Minor units | `1180` = CHF 11.80 |
| **Payouts** | **Decimal** | `152.37` = CHF 152.37 |
| Tax rates | Percent × 1000 | `8100` = 8.1% |
| Margin | Computed on **net**, not gross | 2.68 net − 1.44 cost = 1.24 (46.3%) |

## Routes in the dashboard

Left nav: `/dashboard`, `/sales`, `/payouts`, `/reports/all-reports`,
`/reports/download-center`, `/catalog`, `/customer-directory`, `/members`,
`/settings?tab=business`.

Tools: `/shop`, `/pos-onboarding`, `/payment-links`, `/bookings`, `/ordering`,
`/kiosk`, `/online-selling/{overview,orders,marketing,theme-editor}`,
`/gift-cards`, `/invoicing/{overview,invoices,customers}`, `/expenses`, `/tools`.

Artikel tabs: `/catalog`, `/catalog/categories`, `/catalog/inventory`,
`/catalog/modifiers`, `/catalog/options`, `/catalog/deposits`,
`/catalog/discounts`.

## Catalog

| Method | Path | Notes |
|---|---|---|
| POST | `/merchants/{m}/catalog/items/search` | Body `{"filters":[]}`. `{ items, items_count }`. **No SKU or stock.** |
| POST | `/merchants/{m}/inventory/search` | Body `{"filters":[]}`. `{ inventories, inventories_count }`. Has SKU + stock, no prices. |
| GET | `/merchants/{m}/catalog/items/{id}` | `?custom_attributes=bookings,uber_eats`. Full record incl. `variants[].stock.sku`. |
| GET | `/merchants/{m}/catalog/categories` | `{ categories }` with `items_count`. |
| GET | `/merchants/{m}/tax-rates` | `{ taxes }`. |
| GET | `/merchants/{m}/catalog/modifier-sets` | Extras tab. |
| POST | `/merchants/{m}/catalog/modifiers/search` | Extras detail. |
| GET | `/merchants/{m}/catalog/options` | Optionsgruppen tab. |
| GET | `/merchants/{m}/catalog/deposits` | Pfand tab. |
| GET | `/v1/merchants/{m}/promotions?type=DISCOUNT` | Rabatte tab. Bare array. |
| GET | `/merchants/{m}/catalog/{colors,configs,unit-groups,statuses}` | Supporting lookups. |

**The item list and the inventory list must be joined on `variant_id`** to get a
complete row. Neither has all the fields. 646 items produce 687 variant rows.

## Catalog bulk CSV, the supported write path

| Method | Path | Notes |
|---|---|---|
| POST | `/merchants/{m}/catalog/exports/start` | No body. Returns `{ id, itemsCount, fileUrl }`. |
| GET | *(presigned S3 `fileUrl`)* | 47-column CSV, URL valid 1h. |
| POST | `/merchants/{m}/catalog/imports/start` | **Guessed, never called.** See below. |

The export is asynchronous. The presigned URL is returned before the object
exists, so S3 answers `NoSuchKey` for a few seconds. Poll the URL itself.
`catalog/statuses` stays `{import: null, export: null}` throughout a completed
export, so it does **not** track readiness, despite looking like it should.

The exported file is exactly what the Importieren button accepts, which makes
export → edit → import a fully supported bulk-edit path requiring no
reverse-engineered write endpoint. Columns end with `Item id (Do not change)`
and `Variant id (Do not change)`, which is how SumUp matches rows to records.

The import endpoint was **not** captured: the Importieren button only opens a
native file picker (`input[type=file]` `accept=text/csv`) and issues no request
until a file is chosen, which would perform a real import against the live
catalog.

## Sales and money

| Method | Path | Notes |
|---|---|---|
| GET | `/sales/v1/{m}/history` | `?limit&timezone&pagination_token`. `{ items, pagination_token, daily_totals }`. No date filter, so narrow client-side. |
| GET | `/v1.1/merchants/{m}/payouts` | `?limit`. **Decimal amounts.** |
| GET | `/payout-reports-edge/api/v3/merchants/{m}/balances/receivables` | Pending balance. |
| GET | `/payout-settings-edge/api/v5/merchants/{m}/payout-settings/overview` | |
| GET | `/v1.1/merchants/{m}/bank-accounts` | IBAN, holder, status. |
| GET | `/v1.0/merchants/{m}/cash-management/cash-state` | `{ expected_balance, last_started_session }`. |
| GET | `/v1.0/merchants/{m}/cash-management/setting[/history]` | Kassenbuch config. |
| GET | `/merchants/{m}/exports/sales_report_v1/meta` | `displayableColumns` for the itemised report. |
| POST | `/merchants/{m}/insights` | Body `{start_date,end_date,modules}`. **400s** on `modules:["revenue"]`; valid names unknown. |

A sale carries `product_summary`, a display string like
`"2 x Sparkling Water 0.5L, Cola 0.33L can"`. It is not
structured line items, so it ranks movers but cannot drive stock maths.

Sales report columns available: `date, type, transaction_id, payment_method,
quantity, description, category, sku, currency, price_before_discount,
discount, price_gross, price_net, tax, tax_rate, account`.

## Download Center reports

There is no single report mechanism. There are three, and which one a report
uses had to be found by driving each modal.

### 1. Async job API

```
POST /merchants/{m}/exports?locale=de-CH&tz=Europe/Zurich
  body { start_date, end_date, modules: { <module>: { enabled: true, ... } } }
  -> 202 { export_id, status: "PENDING" }
GET  /merchants/{m}/exports/{export_id}          -> poll until status "DONE"
GET  /merchants/{m}/exports/{export_id}/downloads -> the file BODY, not a URL
```

Only **three** module names are accepted. Everything else 400s with
`"module can not be empty"`, which is a misleading way of saying "unknown
module". Confirmed by probing 19 plausible names.

| Module | Report | Output |
|---|---|---|
| `sales_report_v1` | Verkäufe | CSV, accepts `format` and `columns` |
| `sales_overview_v1` | Umsätze | **PDF** |
| `item_report_v1` | Artikel | CSV |

`sales_report_v1` columns: `date, type, transaction_id, payment_method,
quantity, description, category, sku, currency, price_before_discount,
discount, price_gross, price_net, tax, tax_rate, account`.

### 2. Direct CSV

```
GET /v2.1/merchants/{m}/transactions/export
    ?start_time&end_time&format=csv&order=descending&locale&timezone
GET /v1.0/merchants/{m}/cash-management/report
    ?format=csv&from_date&until_date&locale&timezone
```

The transactions export sends **start_time as the newer bound** and end_time as
the older one, alongside `order=descending`. That looks inverted but is what the
dashboard does.

### 3. Fiscalization (KassenSichV)

```
POST /fiscalization/merchants/{m}/export/request
     body { period_start, period_end, country_code }
     -> 202 { requestId }     <- camelCase, unlike everywhere else
GET  /fiscalization/merchants/{m}/export/request/{requestId}
     -> 404 while pending, then JSON containing an S3 URL
```

The zip contains one `fiscal-daily-archive-YYYY-MM-DD_YYYY-MM-DD.zip` per
trading day.

### 4. payout-reports-edge (monthly PDF statements)

```
GET /payout-reports-edge/api/v3/merchants/{m}/reports/monthly/{YYYY-MM}   Auszahlungsbericht
GET /payout-reports-edge/api/v3/merchants/{m}/reports/daily/{YYYY-MM-DD}  same, single day
GET /payout-reports-edge/api/v3/merchants/{m}/invoices/monthly/{YYYY-MM}  Gebührenabrechnung
GET /payout-reports-edge/api/v3/merchants/{m}/reports/payments/monthly/{YYYY-MM}  Zahlungsbericht
GET /payout-reports-edge/api/v3/merchants/{m}/reports/payments/daily/{YYYY-MM-DD}
GET /payout-reports-edge/api/v3/merchants/{m}/transactions/monthly/{YYYY-MM}      Zahlungsbericht as XLS
```

All take `origin=dashboard`. The XLS variant additionally **requires both
`locale` and `timezone`** or it 400s, and it returns a legacy OLE2 `.xls`
(`D0 CF 11 E0`), not a CSV and not a modern xlsx zip. Decoding it as text
destroys it.

These modals default to a **daily** period with an empty date, which is why the
export button appears to do nothing. Switching to Monatlich swaps the custom
date widget for two ordinary `<select>` elements (`MONTH_SELECT`, `YEAR_SELECT`),
which is the practical way to drive them.

### 5. Invoicing (Rechnungsbericht)

```
GET /merchants/{m}/documents/export/{docType}/{format}
    ?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&includeDocuments=false
```

`docType` is one of `invoices`, `invoices-lines`, `creditnotes`,
`creditnotes-lines`, `accounting-legacy`, `quotes-lines`, `deliverynotes-lines`.
`format` is `csv` or `xlsx`. This response **already carries a UTF-8 BOM**, so
adding another produces visible junk in the first cell.

### Period boundaries

Boundaries are zone-aware. For a period starting 2026-08-17 in Zurich the
dashboard sends `2026-08-16T22:00:00.000Z`. Computing these in UTC shifts every
report by a day.

### UI notes that cost time

The report modals are native `<dialog>` elements, so scoping queries to
`dialog[open]` is far more reliable than hunting for a div whose class contains
"modal". Trigger buttons carry `data-selector="<card>-modal-trigger-button"` but
their accessible name is `"loadingHerunterladen"`, because a permanently-present
spinner label sits inside the button. Each trigger also exists twice in the DOM,
once off-screen, so a plain locator resolves to an element Playwright refuses to
click as "outside of the viewport". Enlarging the viewport to about 1500x2200
sidesteps that entirely.

## People, expenses, selling

| Method | Path | Notes |
|---|---|---|
| GET | `/ucd/v2/merchants/{m}/customers` | `{ items }`. |
| GET | `/v0.1/merchants/{m}/members` | `{ items, total_count }`. |
| GET | `/v0.1/merchants/{m}/roles` | |
| GET | `/merchants/{m}/expenses` | `?fromDate&toDate&limit&offset&source_type`. `{ data, pagination }`. |
| GET | `/merchants/{m}/expenses-categories`, `/expenses-budgets`, `/expenses/totals` | Trailing slash on totals 308s. |
| GET | `/merchants/{m}/online-store/orders` | `{ total, items }`. |
| GET | `/merchants/{m}/online-store/orders/count`, `/returns/count`, `/settings` | |
| GET | `/online-store/{shop/settings,marketing/shop,storefront/settings/visibility}` | Not merchant-scoped. |
| GET | `/api/invoicing/invoices/merchants/{m}` | **App base, not the proxy.** `{ invoices, count }`. |
| GET | `/merchants/{m}/debitoor-*` | Invoicing internals; SumUp acquired Debitoor. |
| GET | `/v1/merchants/{m}/payment-links/{tokens,charges}` | |
| POST | `/order-and-pay/graphql` | QR Order & Pay is GraphQL, unmapped. |

## Identity and gating

| Method | Path | Notes |
|---|---|---|
| GET | `/v0.1/user` | Current user. |
| GET | `/v1/merchants/{m}` and `/api/merchants/{m}` | Merchant profile. |
| GET | `/v1/merchants/{m}/persons` | |
| POST | `/v0.1/permissions` | Permission check the app runs constantly. |
| GET | `/v0.1/merchants/{m}/entitlements?features[]=` | Feature gates, e.g. `pos_cost_price`, `pos_barcode_scanning`, `pos_deposits`, `pos_cash_management`. |

## Known gaps

- **Catalog import** endpoint: not captured, deliberately.
- **Item write** (`PUT .../catalog/items/{id}`): not captured. Use the CSV route.
- **Insights** module names.
- **QR Order & Pay** GraphQL schema.

All ten Download Center reports are mapped.
