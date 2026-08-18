# sumup-cli

[English](README.md) · **Deutsch**

CLI und MCP-Server für SumUp: Artikelkatalog, Lagerbestand, Umsätze,
Auszahlungen und Massenbearbeitung von Artikeln, samt allem, was die offizielle
API gar nicht hergibt.

Ein TypeScript-Kern, zwei dünne Hüllen darum:

- `src/cli/` Kommandozeile, für Skripte und Cron
- `src/mcp/` MCP-Server, für den Einsatz in Claude und anderen MCP-Clients

Gebaut und geprüft gegen ein echtes Schweizer Kiosk-Konto mit rund 650 Artikeln.

> **Nicht mit SumUp verbunden.** Die Hälfte der Funktionen hängt an der
> undokumentierten internen API hinter dem Händler-Dashboard, die SumUp
> jederzeit und ohne Ankündigung ändern oder abschalten kann. Das Werkzeug liest
> dein eigenes Konto mit deinen eigenen Zugangsdaten, und es bearbeitet auf
> Zuruf auch deinen Live-Katalog. Halte einen Export bereit, bevor du etwas in
> Masse änderst. MIT-Lizenz, keine Gewährleistung.

## Die zwei Hälften

SumUp hat eine dokumentierte öffentliche API und eine undokumentierte interne,
und was man braucht, liegt auf beiden Seiten.

| Was | Wo | Anmeldung | Stabilität |
|---|---|---|---|
| Händlerprofil, Transaktionen, Positionen, Auszahlungen | `api.sumup.com` | Geheimer Schlüssel `sup_sk_*` | Dokumentiert und versioniert |
| Katalog: Artikel, Preise, Selbstkosten, SKU, Bestand, Kategorien, Steuern | `me.sumup.com/api/proxy` | Browser-Session-Cookie | Keine Kompatibilitätszusage |

In der öffentlichen API gibt es überhaupt keinen Endpunkt für Artikel oder
Bestand. Deshalb reitet die Katalog-Hälfte auf einer angemeldeten
Dashboard-Session.

### Zwei Dinge, die je eine Stunde kosten, wenn man sie vergisst

1. **Jeder interne Aufruf braucht `accept-version: 4.0.0`.** Ohne den Header
   antwortet die Gegenstelle mit `404`, was nach einem falschen Pfad aussieht,
   es aber nicht ist.
2. **Die Anmeldung läuft über das Session-Cookie am gleichnamigen
   Next.js-Proxy**, nicht über ein Bearer-Token an `api.sumup.com`.

Beides steckt in [`src/core/session/endpoints.ts`](src/core/session/endpoints.ts),
wo jeder Pfad seinen Status (`verified` / `unverified`) und das Datum der letzten
erfolgreichen Beobachtung festhält.

## Eigenheiten der Daten

- **Beträge in Minor Units.** `value: 290` sind CHF 2.90, `cost_price.value: 144`
  sind CHF 1.44.
- **`tax_rate` ist Prozent mal 1000.** `8100` heisst 8.1 Prozent, `2600` heisst
  2.6 Prozent.
- **Die Marge rechnet auf dem Netto-, nicht auf dem Bruttopreis.** SumUp selbst
  weist für einen Artikel mit 2.90 brutto / 2.68 netto / 1.44 Kosten CHF 1.24
  Gewinn und 46.3 Prozent Marge aus. Dieses Werkzeug rechnet genauso.
- **SKU und Bestand fehlen in der Artikelliste.** Die Artikelsuche hat Preise,
  aber weder SKU noch Bestand; die Inventarsuche hat SKU und Bestand, aber keine
  Preise. `catalog export` fügt beides über die `variant_id` zusammen.
- **Bestände werden negativ.** SumUp lässt den Zähler unter null fallen, was
  schlicht heisst, dass über ein leeres Regal hinaus kassiert wurde. Das sind
  Daten, kein Fehler.
- **Eine Zeile je Variante, nicht je Artikel.** Ein Artikel mit zwei Varianten
  wird zu zwei Zeilen, die Zeilenzahl liegt also immer mindestens bei der
  Artikelzahl.

## Einrichtung

```bash
npm install
```

### Katalogzugriff (Session)

```bash
sumup auth capture --login    # öffnet einmal einen Browser, du meldest dich an
sumup auth capture            # danach headless, holt ein frisches Token
```

Das Zugriffstoken des Dashboards lebt etwa **15 Minuten**. Das Laden des
Dashboards tauscht das langlebige Refresh-Cookie gegen ein neues Token, weshalb
der headless-Refresh so lange weiterläuft, wie SumUp das Profil angemeldet
lässt. Das Cookie landet in `~/.sumup-cli/session-cookie.txt` mit Modus 600.

`sumup auth status` sagt auf die Sekunde genau, wie lange es noch gilt.

Ob der headless-Refresh klappt, hängt am Browser des Profils. Ein echter Chrome
oder Edge kommt durch, **Brave** nicht: Cloudflare hält dort die
Anmelde-Umleitung fest, weshalb `auth capture` bei jedem abgelaufenen Token
`--login` und ein sichtbares Fenster braucht. So oder so wird auch ein
angemeldetes Profil über auth.sumup.com umgeleitet, um sein Refresh-Cookie zu
tauschen. Der Code wartet deshalb, bis diese Umleitung durch ist, statt die URL
direkt nach der Navigation zu lesen und fälschlich auf „nicht angemeldet" zu
schliessen.

`playwright-core` ist bewusst gewählt: es bringt keine Browser mit, sondern
nutzt einen bereits vorhandenen Chromium-Build, statt 150 MB nachzuladen. Zeigt
`SUMUP_CHROMIUM_PATH` auf eine Binärdatei, wird die genommen.

### Zugriff auf die öffentliche API (Schlüssel)

Der Schlüssel, den SumUp standardmässig anzeigt, ist ein **öffentlicher**
(`sup_pk_*`), und die eigene Dokumentation rät davon ab. Er liefert 401 auf
`/v0.1/me`. Gebraucht wird ein **geheimer** Schlüssel:

me.sumup.com → Profil → For Developers → Toolkit → API Keys → **Create**

Sofort kopieren, SumUp speichert ihn nicht. Dann:

```bash
sumup auth login --api-key sup_sk_xxxxx
```

## Verwendung

```bash
sumup auth status                       # Zugangsdaten, Ablauf, Zustand der Endpunkte

# Katalog (nur Session, kein API-Schlüssel nötig)
sumup catalog export -f csv -o out/inventar.csv    # eine Zeile je Variante, Preis/Kosten/Marge/Bestand
sumup catalog export -f csv --all-columns
sumup catalog native-export -o out/sumup.csv       # SumUps eigene 47-Spalten-CSV
sumup catalog validate out/sumup.csv               # bearbeitete Datei vor dem Import prüfen
sumup catalog restock --sku 1-0004=48 --sku 1-0008=48 -o out/lieferung.csv
                                                   # Lieferung buchen, nur Bestand
sumup catalog import out/lieferung.csv --yes       # über das Dashboard hochladen
sumup catalog categories
sumup catalog stock --low               # auf oder unter der Meldemenge
sumup catalog stock --negative          # unter null verkauft
sumup catalog taxes
sumup catalog item <item_id>            # vollständige Rohdaten

# Berichte aus dem Download Center, alle zehn (nur Session)
sumup reports list

# Zeitraum-Berichte, --from / --to
sumup reports get sales        --from 2026-08-01 --to 2026-08-17 -o out/verkaeufe.csv
sumup reports get transactions --from 2026-08-01 --to 2026-08-17 -o out/transaktionen.csv
sumup reports get cashbook     --from 2026-08-01 --to 2026-08-17 -o out/kassenbuch.csv
sumup reports get items        --from 2026-08-01 --to 2026-08-17 -o out/artikel.csv
sumup reports get invoicing    --from 2026-07-01 --to 2026-07-31 --doc-type invoices
sumup reports get revenue      --from 2026-08-01 --to 2026-08-17   # PDF
sumup reports get fiscal       --from 2026-08-01 --to 2026-08-17   # KassenSichV-ZIP

# Monatsabschlüsse, --month (oder --day für einen einzelnen Tag)
sumup reports get payouts  --month 2026-07                 # Auszahlungsbericht PDF
sumup reports get fees     --month 2026-07                 # Gebührenabrechnung PDF
sumup reports get payments --month 2026-07                 # Zahlungsbericht PDF
sumup reports get payments --month 2026-07 --format xls    # wie die alte .xls
sumup reports get payouts  --day 2026-07-15

# Marge
sumup profit --from 2026-07-01 --to 2026-07-31
sumup profit --from 2026-07-01 --to 2026-07-31 --by-item -f csv -o out/marge.csv

# Umsätze und Auszahlungen (nur Session, kein API-Schlüssel nötig)
sumup sales list --from 2026-08-01 --to 2026-08-17 -f csv -o out/aug.csv
sumup sales movers --from 2026-08-01 --to 2026-08-17
sumup sales payouts --limit 30

# Dieselben Daten über die öffentliche API (braucht den geheimen Schlüssel)
sumup transactions list --from 2026-08-01 --to 2026-08-17 -f csv
sumup transactions items --from 2026-08-01 --to 2026-08-17 -f csv
sumup payouts list --from 2026-07-01 --to 2026-07-31 --native-csv

sumup endpoints                         # was gemappt und was verifiziert ist
```

`reports get sales` ist der buchhalterische Positions-Export: eine Zeile je
Position mit `Datum, Transaktionsnummer, Zahlungsmethode, Beschreibung,
Kategorie, Artikelnummer, Preis (brutto), Preis (netto), Steuer, Steuersatz`.
Die Spaltenüberschriften folgen `--locale`, für Englisch also `--locale en-GB`.

Alle zehn Berichte des Download Centers sind angebunden. Der Ausgabetyp wird aus
der Antwort erkannt, PDFs, alte `.xls` und ZIPs werden binär geschrieben,
CSVs bekommen ein UTF-8-BOM für Excel. Mit `-o` bestimmst du den Namen, sonst
landet die Datei automatisch unter `out/`.

Zu Umsätzen und Auszahlungen führen bewusst zwei Wege. Die Gruppe `sales` nutzt
die Dashboard-Session und funktioniert ganz ohne Schlüssel. Die Gruppen
`transactions` und `payouts` nutzen die dokumentierte öffentliche API, die
stabiler und für Cron geeignet ist, aber einen `sup_sk_`-Schlüssel braucht.

Die CSV-Ausgabe ist semikolongetrennt mit UTF-8-BOM, damit Excel in einer
Schweizer Spracheinstellung sie ohne Import-Dialog und mit intakten Umlauten und
Emoji öffnet.

## Wie die Marge berechnet wird

`sumup profit` kombiniert zwei Berichte, weil keiner beide Seiten hat:

| Quelle | Liefert |
|---|---|
| `item_report_v1` | Umsatz, und Gewinn = Netto-Umsatz minus Selbstkosten |
| Transaktions-Export | die Kartengebühren, die SumUp einbehält |

Die MwSt muss nicht abgezogen werden: SumUp rechnet den Gewinn bereits auf dem
**Netto**-Preis.

Drei Fallen, alle beim Abgleich mit SumUps eigenen Zahlen gefunden:

1. **Der Transaktionsbericht führt jede Kartenzahlung doppelt**, einmal als
   `Zahlung` und einmal als `Auszahlung`, jeweils mit derselben Gebühr. Blindes
   Summieren verdoppelt die Gebühren. Nur `Zahlung`-Zeilen zählen.
2. **Dieser Bericht deckt nur Kartenzahlungen ab.** Bargeld taucht darin nie
   auf, der Gesamtumsatz kommt deshalb aus dem Artikelbericht, und auf Bargeld
   fällt keine Gebühr an.
3. **Artikel ohne Selbstkosten melden einen leeren Gewinn.** Sie werden als
   `revenueWithoutCost` ausgewiesen, statt als reiner Gewinn oder reiner
   Verlust durchzurutschen.

Das Ergebnis ist ein Deckungsbeitrag, **kein** Nettogewinn: es steht vor Miete,
Löhnen und allem aus dem Ausgaben-Modul.

## Artikel bearbeiten

Über den CSV-Rundlauf. Das ist SumUps eigener Weg zur Massenbearbeitung und
braucht keinen rückentwickelten Schreib-Endpunkt:

```bash
sumup catalog native-export -o out/sumup.csv   # 47 Spalten, eine Zeile je Variante
# Preise, Selbstkosten, SKU, Bestand, Kategorien in Excel oder per Skript ändern
sumup catalog validate out/sumup.csv           # Probleme finden, bevor SumUp sie findet
```

Danach hochladen, entweder mit **Importieren** auf der Artikel-Seite oder mit
`sumup catalog import` (siehe unten). Die Spalten `Item id (Do not change)` und
`Variant id (Do not change)` niemals anfassen: darüber ordnet SumUp die Zeilen
wieder den Datensätzen zu.

### Eine Lieferung buchen

Der Normalfall ist keine freie Bearbeitung, sondern eine Lieferantenrechnung: n
Harasse sind angekommen, Bestand rauf, sonst nichts. Das ist ein Befehl.

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

Vier Dinge tut der Befehl mit Absicht:

- **Nur die Zelle Quantity wandert.** Ein bestehender Artikel wird bei einer
  Nachlieferung nie neu bepreist, auch dann nicht, wenn der Nettopreis des
  Lieferanten inzwischen gestiegen ist. Selbstkosten und Verkaufspreis werden
  unverändert übernommen.
- **Der Bestand wird live gelesen**, damit die Lieferung auf dem aufsetzt, was
  der Katalog jetzt sagt, und nicht auf einem Export von letzter Woche. `--base
  <datei>` übersteuert das, wenn du bereits einen frischen Export hast.
- **Die Ausgabe ist eine Teildatei**, Kopfzeile plus ausschliesslich die
  geänderten Zeilen. SumUp ordnet über die `Item id` zu, die übrigen gut 680
  Varianten bleiben also ganz aus dem Vorgang heraus, und keine veraltete Spalte
  kann etwas überschreiben.
- **Unberührte Bytes bleiben unberührt.** Zeilen werden gespleisst, nicht neu
  serialisiert. So überlebt SumUps eigene Anführungszeichen-Logik, samt der
  Artikelnamen mit Leerzeichen am Ende, die SumUp quotet und ein normaler
  CSV-Writer nicht. Die Ausgabe ist LF, ohne BOM, exakt so, wie der Export sie
  liefert.

Was sich nicht sicher buchen lässt, wird gemeldet und übersprungen statt
geraten: eine SKU, die es im Katalog nicht gibt, eine SKU auf mehr als einer
Zeile (kommt wirklich vor, wenn zwei Produkte dieselbe SKU eingetippt bekamen),
oder ein Artikel ohne Bestandsführung. `--dry-run` zeigt die Tabelle, ohne zu
schreiben, `--set` versteht die Zahlen als Endbestand statt als Liefermenge, und
das Ergebnis läuft vor dem Schreiben durch `validate`.

### Und hochladen

```bash
sumup catalog import out/lieferung.csv --dry-run   # Ablauf öffnen, nichts hochladen
sumup catalog import out/lieferung.csv --yes       # wirklich importieren
```

Einen Import-Endpunkt zum Aufrufen gibt es weiterhin nicht, deshalb steuert der
Befehl den Dialog des Dashboards im Browser: **Weitere Optionen** in der
Werkzeugleiste, darin der Eintrag **Import**, dahinter das Datei-Feld, dann
`SELECTORS.IMPORT.CONTINUE_BUTTON`. Diese `data-selector`-Attribute vergibt
SumUp selbst, sie überleben Übersetzungen und wechselnde Klassennamen, weshalb
der Ablauf an ihnen hängt und nicht an Beschriftungen. Zu beachten: jede
Produktzeile hat ebenfalls eine Schaltfläche „Aktionen", ein Textabgleich darauf
trifft das Zeilenmenü statt die Werkzeugleiste.

Drei Dinge, die man wissen sollte:

- **Es braucht ein sichtbares Fenster**, ausser das Profil läuft auf einem
  echten Chrome oder Edge, denn Cloudflare lässt ein headless laufendes Brave
  nicht durch die Anmelde-Umleitung. `--headless` ist für die Browser da, die es
  schaffen.
- **Ohne `--yes` bleibt es beim Trockenlauf.** Ein Import verändert einen
  Live-Katalog, Schweigen gilt hier nicht als Zustimmung. Die Datei wird
  geprüft, bevor der Browser überhaupt startet.
- **Der Dialog meldet bei Erfolg gar nichts**, deshalb liest der Befehl den
  Katalog danach zurück und prüft, ob dort jetzt steht, was die Datei sagte.
  Dieser Abgleich ist die eigentliche Bestätigung, `--no-verify` schaltet ihn
  ab.

Am 18.08.2026 durchgängig geprüft: eine einzeilige Datei importiert, die
Änderung aus dem Live-Katalog zurückgelesen, den ursprünglichen Wert wieder
importiert.

Die direkte Schreib-API je Artikel ist weiterhin **nicht** freigeschaltet. Die
Lese-Endpunkte wurden aus echtem Verkehr gemappt, die Form eines Schreibaufrufs
aber nie aufgezeichnet, und sowohl die CLI als auch das MCP-Werkzeug verweigern
den Dienst, statt ein geratenes `PUT` auf einen Live-Katalog loszulassen.

Wer direkte Schreibzugriffe will, speichert im Dashboard einen Artikel, während
der Verkehr aufgezeichnet wird, lässt `sumup discover` darüber laufen und trägt
das Ergebnis in `src/core/session/endpoints.ts` ein. Schreibzugriffe wären dann
immer noch standardmässig Trockenläufe und bräuchten `--yes` (CLI) oder
`confirm: true` (MCP).

## Die API neu kartieren, wenn SumUp sie ändert

1. Auf me.sumup.com anmelden, DevTools → Network → **Preserve log** ankreuzen
2. Durch die Bildschirme klicken, die dich interessieren
3. Rechtsklick auf die Anfrageliste → **Save all as HAR with content**

```bash
sumup discover capture.har --catalog-only
```

Das gruppiert den Verkehr nach Methode und Pfadmuster, fasst IDs zusammen und
listet Query-Parameter, Schlüssel im Anfragekörper und die Form der Antwort. Ein
HAR enthält ein gültiges Session-Token; `.gitignore` schliesst `*.har` bereits
aus.

## MCP-Server

```json
{
  "mcpServers": {
    "sumup": {
      "command": "npx",
      "args": ["tsx", "/absoluter/pfad/zu/sumup-cli/src/mcp/server.ts"]
    }
  }
}
```

17 Werkzeuge:

| Werkzeug | Braucht |
|---|---|
| `sumup_status`, `sumup_endpoints` | nichts |
| `sumup_catalog_export`, `sumup_catalog_native_export` | Session |
| `sumup_catalog_item`, `sumup_catalog_stock`, `sumup_catalog_categories` | Session |
| `sumup_catalog_restock` | Session, oder gar nichts mit `base_file` |
| `sumup_catalog_import` | angemeldetes Browser-Profil, plus Session zum Prüfen |
| `sumup_sales_list`, `sumup_payouts_session` | Session |
| `sumup_me`, `sumup_transactions_list`, `sumup_transaction_get` | geheimer Schlüssel |
| `sumup_sales_by_product`, `sumup_payouts_list` | geheimer Schlüssel |
| `sumup_catalog_update_product` | verweigert, siehe Artikel bearbeiten |

`sumup_catalog_stock` mit `low: true` ergänzt sich gut mit `sumup_sales_list`,
wenn es um Nachbestellungen geht, und `sumup_catalog_restock` macht aus der
Bestellung eine Importdatei, sobald sie geliefert ist.

## Vollständige API-Karte

[`docs/api-map.md`](docs/api-map.md) dokumentiert die gesamte Oberfläche, die
beim Durchgehen aller Dashboard-Seiten gefunden wurde: rund 60 Endpunkte quer
über Katalog, Umsätze, Auszahlungen, Kassenverwaltung, Kunden, Mitarbeitende,
Ausgaben, Onlineshop, Rechnungen und Zahlungslinks, dazu die Konventionen der
Einheiten und die bekannten Lücken.

## Hinweise

- Node 20 oder neuer, nutzt das eingebaute `fetch`.
- Das offizielle `@sumup/sdk` wird bewusst nicht verwendet: es ist weiterhin als
  „subject to breaking changes" gekennzeichnet, und die interne Hälfte braucht
  ohnehin eine eigene HTTP-Schicht. Beide Hälften teilen sich deshalb einen
  Client in `src/core/http.ts` mit Wiederholung und Rate-Limit-Backoff.
- `.env`, `.session-cookie.txt`, `*.har` und `captures/` niemals einchecken. Ein
  HAR und ein Session-Cookie enthalten beide ein gültiges Token für dein Konto.

## Mitwirken

Issues und Pull Requests sind willkommen, besonders für noch nicht gemappte
Endpunkte, andere Sprachen und Dashboard-Änderungen, die einen Selektor
zerschiessen. Wenn SumUp etwas verschiebt, findet `sumup discover` auf einem
frischen HAR am schnellsten heraus, was, und
`src/core/session/endpoints.ts` ist der Ort für die Antwort.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
