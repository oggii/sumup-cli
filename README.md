# sumup-cli

**English** · [Deutsch](README.de.md)

CLI and MCP server for SumUp: catalogue, stock, sales, payouts and bulk product
edits, including the things the official API does not expose at all.

One TypeScript core, two thin wrappers over it:

- `src/cli/` command line, for scripts and cron
- `src/mcp/` MCP server, for use inside Claude and other MCP clients

Built and tested against a live Swiss kiosk account of roughly 650 items.

> **Not affiliated with SumUp.** Half of what this tool does rides on the
> undocumented internal API behind the merchant dashboard, which SumUp can
> change or break at any time without notice. It reads your own account with
> your own credentials, and it will happily edit your live catalogue if you ask
> it to. Keep an export around before you bulk-edit anything. MIT licensed, no
> warranty.

## The two halves

SumUp has a documented public API and an undocumented internal one, and the
things you want live on both sides.

| What | Where | Auth | Stability |
|---|---|---|---|
| Merchant profile, transactions, line items, payouts | `api.sumup.com` | `sup_sk_*` secret key | Documented and versioned |
| Catalog: items, prices, cost prices, SKUs, stock, categories, taxes | `me.sumup.com/api/proxy` | Browser session cookie | No compatibility promise |

There is no product or inventory endpoint anywhere in the public API, which is
why the catalog half rides on a logged-in dashboard session.

### Two things that cost an hour each if you forget them

1. **Every internal call needs `accept-version: 4.0.0`.** Without it the
   upstream returns `404`, which reads like a wrong path but is not.
2. **Auth is the session cookie against the same-origin Next.js proxy**, not a
   bearer token to `api.sumup.com`.

Both are encoded in [`src/core/session/endpoints.ts`](src/core/session/endpoints.ts),
where every path records a `verified` / `unverified` status and the date it was
last observed working.

## Data quirks worth knowing

- **Money is in minor units.** `value: 290` is CHF 2.90, `cost_price.value: 144`
  is CHF 1.44.
- **`tax_rate` is percent times 1000.** `8100` means 8.1 percent, `2600` means
  2.6 percent.
- **Margin is computed on the net price, not the gross one.** SumUp's own
  "Gewinn" and "Marge" for a 2.90 gross / 2.68 net / 1.44 cost item read
  CHF 1.24 and 46.3 percent. This tool matches that.
- **SKU and stock are not in the item list.** The item search has prices but no
  SKU or stock; the inventory search has SKU and stock but no prices. `catalog
  export` joins them on `variant_id`.
- **Stock goes negative.** SumUp lets a count fall below zero, which just means
  sales were rung up past an empty shelf. Treat it as data, not as an error.
- **Rows are per variant, not per item.** 646 items produce 670 rows.

## Setup

```bash
npm install
```

### Catalog access (session)

```bash
sumup auth capture --login    # opens a browser once, you sign in
sumup auth capture            # afterwards, headless, mints a fresh token
```

The dashboard's access token lives about **15 minutes**. Loading the dashboard
exchanges the long-lived refresh cookie for a new one, so the headless refresh
keeps working for as long as SumUp keeps the profile signed in. The cookie is
written to `~/.sumup-cli/session-cookie.txt` with mode 600.

`sumup auth status` prints exactly how many seconds are left.

The headless refresh depends on which browser the profile runs on. A real
Chrome or Edge gets through; **Brave** does not, because Cloudflare holds the
auth redirect on a headless Brave, so there `auth capture` needs `--login` and a
visible window every time the token lapses. Either way a signed-in profile is
still redirected via auth.sumup.com to trade its refresh cookie, so the code
waits for that bounce to settle rather than reading the URL straight after
navigation and wrongly concluding it is logged out.

`playwright-core` is used deliberately: it ships no browsers, and reuses a
Chromium build already on the machine instead of pulling a 150 MB download.
Point `SUMUP_CHROMIUM_PATH` at a binary if none is found.

### Public API access (key)

The key SumUp shows you by default is a **public** key (`sup_pk_*`) and their
docs say not to use it. It returns 401 on `/v0.1/me`. You need a **secret** key:

me.sumup.com → profile → For Developers → Toolkit → API Keys → **Create**

Copy it immediately, SumUp does not store it. Then:

```bash
sumup auth login --api-key sup_sk_xxxxx
```

## Usage

```bash
sumup auth status                       # credentials, session expiry, endpoint health

# Catalog (session only, no API key needed)
sumup catalog export -f csv -o out/inventar.csv    # 670 rows, price/cost/margin/stock
sumup catalog export -f csv --all-columns
sumup catalog native-export -o out/sumup.csv       # SumUp's own 47-column CSV
sumup catalog validate out/sumup.csv               # check an edited file before import
sumup catalog restock --sku 1-0004=48 --sku 1-0008=48 -o out/lieferung.csv
                                                   # book a delivery, stock only
sumup catalog import out/lieferung.csv --yes        # upload it through the dashboard
sumup catalog categories
sumup catalog stock --low               # at or below the low-stock threshold
sumup catalog stock --negative          # sold past zero
sumup catalog taxes
sumup catalog item <item_id>            # full raw payload

# Download Center reports, all ten (session only)
sumup reports list

# range reports, --from / --to
sumup reports get sales        --from 2026-08-01 --to 2026-08-17 -o out/verkaeufe.csv
sumup reports get transactions --from 2026-08-01 --to 2026-08-17 -o out/transaktionen.csv
sumup reports get cashbook     --from 2026-08-01 --to 2026-08-17 -o out/kassenbuch.csv
sumup reports get items        --from 2026-08-01 --to 2026-08-17 -o out/artikel.csv
sumup reports get invoicing    --from 2026-07-01 --to 2026-07-31 --doc-type invoices
sumup reports get revenue      --from 2026-08-01 --to 2026-08-17   # PDF
sumup reports get fiscal       --from 2026-08-01 --to 2026-08-17   # KassenSichV zip

# monthly statements, --month (or --day for a single date)
sumup reports get payouts  --month 2026-07                 # Auszahlungsbericht PDF
sumup reports get fees     --month 2026-07                 # Gebührenabrechnung PDF
sumup reports get payments --month 2026-07                 # Zahlungsbericht PDF
sumup reports get payments --month 2026-07 --format xls    # same as legacy .xls
sumup reports get payouts  --day 2026-07-15

# Profit
sumup profit --from 2026-07-01 --to 2026-07-31
sumup profit --from 2026-07-01 --to 2026-07-31 --by-item -f csv -o out/marge.csv

# Umsätze and Auszahlungen (session only, no API key needed)
sumup sales list --from 2026-08-01 --to 2026-08-17 -f csv -o out/aug.csv
sumup sales movers --from 2026-08-01 --to 2026-08-17
sumup sales payouts --limit 30

# Same data via the public API (needs the secret key)
sumup transactions list --from 2026-08-01 --to 2026-08-17 -f csv
sumup transactions items --from 2026-08-01 --to 2026-08-17 -f csv
sumup payouts list --from 2026-07-01 --to 2026-07-31 --native-csv

sumup endpoints                         # what is mapped and what is verified
```

`reports get sales` is the itemised bookkeeping export: one row per line item
with `Datum, Transaktionsnummer, Zahlungsmethode, Beschreibung, Kategorie,
Artikelnummer, Preis (brutto), Preis (netto), Steuer, Steuersatz`. Column
headers follow `--locale`, so pass `--locale en-GB` for English.

All ten Download Center reports are wired up. Output type is detected from the
response, so PDFs, legacy `.xls` and zips are written as bytes while CSVs get a
UTF-8 BOM for Excel. Pass `-o` or a file is named automatically under `out/`.

There are deliberately two routes to sales and payouts. The `sales` group uses
the dashboard session and works today with no key at all. The `transactions`
and `payouts` groups use the documented public API, which is stabler and
suitable for cron, but needs a `sup_sk_` secret key.

CSV output is semicolon-separated with a UTF-8 BOM, so Excel on a Swiss locale
opens it with umlauts and emoji intact and no import dialog.

## How profit is calculated

`sumup profit` combines two reports, because neither has both sides:

| Source | Contributes |
|---|---|
| `item_report_v1` | revenue, and Gewinn = net-of-VAT revenue minus cost price |
| transactions export | the card fees SumUp charges |

VAT needs no subtraction: SumUp already computes Gewinn on the **net** price.

Three traps, all found by reconciling against SumUp's own figures:

1. **The transactions report lists every card payment twice**, once as
   `Zahlung` and once as `Auszahlung`, carrying the same fee. Summing blindly
   doubles the fees. Only `Zahlung` rows count.
2. **That report covers card payments only.** Cash never appears in it, so
   total revenue comes from the item report and no fee applies to cash.
3. **Items without a cost price report a blank Gewinn.** They are surfaced as
   `revenueWithoutCost` rather than being counted as pure profit or pure loss.

The result is an operating contribution, **not** a final Nettogewinn: it is
before rent, wages, and anything in the Ausgaben module.

## Editing products

Use the CSV round trip. It is SumUp's own bulk-edit mechanism, so it needs no
reverse-engineered write endpoint:

```bash
sumup catalog native-export -o out/sumup.csv   # 47 columns, 687 variant rows
# edit prices, cost prices, SKUs, stock, categories in Excel or a script
sumup catalog validate out/sumup.csv           # catch problems before SumUp does
```

Then upload it, either with **Importieren** on the Artikel page or with `sumup
catalog import` (below). Never touch the `Item id (Do not change)` or
`Variant id (Do not change)` columns; that is how SumUp matches rows back to
records.

### Booking a delivery

The common case is not a free-form edit, it is a supplier invoice: n cartons
arrived, raise the stock, change nothing else. That is one command.

```bash
sumup catalog restock --sku 1-0004=48 --sku 1-0014=48 \
                      --sku 1-0008=48 --sku 1-0002=48 \
                      -o out/lieferung-1808.csv
```

```
base: live export, 646 items
  1-0004    Coca-Cola Zero 0.5L PET             34 + 48 -> 82
  1-0014    Valser Kohlensäure 0.5L PET         14 + 48 -> 62
  1-0008    Evian 0.50L PET                     26 + 48 -> 74
  1-0002    Coca-Cola Zero 0.33L DOSE            7 + 48 -> 55
```

Four things it does on purpose:

- **Only the Quantity cell moves.** An item that already exists is never
  re-priced on a restock, even when the supplier's net price has drifted. Cost
  and selling price are carried across unchanged.
- **Stock is read live**, so the delivery lands on top of what the catalogue
  says now rather than on an export from last week. `--base <file>` overrides
  that when you already have a fresh export in hand.
- **The output is a partial file**, header plus only the touched rows. SumUp
  matches by `Item id`, so the other 680-odd variants stay out of the
  transaction entirely and nothing can be clobbered by a stale column.
- **Untouched bytes stay untouched.** Rows are spliced, not re-serialised, so
  SumUp's own quoting survives, including the trailing-space item names it
  quotes and a plain CSV writer would not. Output is LF, no BOM, exactly what
  the exporter emits.

Anything it cannot book safely is reported and skipped rather than guessed at:
a SKU that is not in the catalogue, a SKU sitting on more than one row (which
really happens: two different products typed with the same SKU), or an item with
inventory tracking off.
`--dry-run` shows the table without writing, `--set` treats the numbers as the
resulting stock instead of as a delivery, and the result is run through
`validate` before it is written.

### Uploading it

```bash
sumup catalog import out/lieferung.csv --dry-run   # open the flow, upload nothing
sumup catalog import out/lieferung.csv --yes       # actually import
```

There is still no import endpoint to call, so this drives the dashboard's own
dialog in a browser: **Weitere Optionen** in the toolbar, the **Import** entry
in that menu, the file input behind it, then `SELECTORS.IMPORT.CONTINUE_BUTTON`.
SumUp ships those `data-selector` attributes itself, which survive translation
and class-name churn, so the flow is driven by them rather than by button
labels. Note that every product row also has an "Aktionen" button; matching on
that text hits a row menu instead of the toolbar.

Three things worth knowing:

- **It needs a visible window** unless the profile runs on a real Chrome or
  Edge, since Cloudflare will not let a headless Brave through the auth bounce.
  `--headless` is there for the browsers that manage it.
- **Without `--yes` it degrades to a dry run.** An import mutates a live
  catalogue, so silence is not consent. The file is validated before the browser
  is even started.
- **The dialog says nothing on success**, so the command reads the catalogue
  back afterwards and checks it now says what the file said. That check is the
  actual confirmation; `--no-verify` turns it off.

Verified end to end on 2026-08-18 by importing a one-row file, reading the
change back from the live catalogue, and importing the original value again.

The direct per-item write API is still **not** enabled. The read endpoints were
mapped from real traffic, but the write shape was never captured, and both the
CLI and the MCP tool refuse rather than firing a guessed `PUT` at a live
646-item catalog.

To enable direct writes, save one product in the dashboard while capturing
traffic, then run `sumup discover` on the capture and fill in
`src/core/session/endpoints.ts`. Writes would then still be dry-run by default,
needing `--yes` (CLI) or `confirm: true` (MCP).

## Re-mapping the API when SumUp changes it

1. Log in at me.sumup.com, DevTools → Network → tick **Preserve log**
2. Click through the screens you care about
3. Right-click the request list → **Save all as HAR with content**

```bash
sumup discover capture.har --catalog-only
```

It groups traffic by method and path template, collapsing ids, and reports
query parameters, request body keys and response shape. A HAR contains a live
session token; `.gitignore` already excludes `*.har`.

Sample payloads from the 2026-08-17 mapping are in `captures/` (gitignored).

## MCP server

```json
{
  "mcpServers": {
    "sumup": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/sumup-cli/src/mcp/server.ts"]
    }
  }
}
```

17 tools:

| Tool | Needs |
|---|---|
| `sumup_status`, `sumup_endpoints` | nothing |
| `sumup_catalog_export`, `sumup_catalog_native_export` | session |
| `sumup_catalog_item`, `sumup_catalog_stock`, `sumup_catalog_categories` | session |
| `sumup_catalog_restock` | session, or none with `base_file` |
| `sumup_catalog_import` | signed-in browser profile, plus session to verify |
| `sumup_sales_list`, `sumup_payouts_session` | session |
| `sumup_me`, `sumup_transactions_list`, `sumup_transaction_get` | secret key |
| `sumup_sales_by_product`, `sumup_payouts_list` | secret key |
| `sumup_catalog_update_product` | refuses, see Editing products |

`sumup_catalog_stock` with `low: true` pairs well with `sumup_sales_list` for
restocking decisions, and `sumup_catalog_restock` turns the resulting order into
an import file once it arrives.

## Full API map

[`docs/api-map.md`](docs/api-map.md) documents the whole surface discovered by
walking every dashboard page: roughly 60 endpoints across catalog, sales,
payouts, cash management, customers, members, expenses, online store,
invoicing and payment links, plus the unit conventions and the known gaps.

## Notes

- Node 20 or newer, uses built-in `fetch`.
- The official `@sumup/sdk` is deliberately not used: it is still marked subject
  to breaking changes, and the internal half needs a custom HTTP layer anyway,
  so both halves share one client in `src/core/http.ts` with retry and
  rate-limit backoff.
- Never commit `.env`, `.session-cookie.txt`, `*.har`, or `captures/`. A HAR
  file and a session cookie both contain a live token for your account.

## Contributing

Issues and pull requests are welcome, particularly for endpoints this has not
mapped, other locales, and dashboard changes that break a selector. If SumUp
moves something, `sumup discover` on a fresh HAR is the fastest way to find out
what, and `src/core/session/endpoints.ts` is where the answer belongs.

## Licence

MIT, see [LICENSE](LICENSE).
