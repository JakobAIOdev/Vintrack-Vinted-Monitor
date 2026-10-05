# Checkout handoff: Machbarkeit und nächster Test

Stand: 5. Oktober 2026. Die ursprüngliche Untersuchung umfasste lokalen Code
und öffentliche, anonyme GET-Aufrufe. Anschließend gab der Nutzer einen
Testaccount und einen konkreten Artikel für einen Test bis vor Kaufbestätigung
frei. Der Login wartet auf einen E-Mail-Verifizierungscode. Es wurde weiterhin
kein echter Checkout angelegt und keine Zahlung ausgelöst. Die Akzeptanz der
bestehenden privaten Vinted-Endpunkte ist damit nicht live bestätigt.

## Implementiert auf `codex/checkout-handoff`

- Item-Karten starten den Handoff direkt, ohne den bisherigen Zwischendialog.
- Monitor-Notifications in Telegram und Discord erhalten einen Checkout-Link
  für verknüpfte Accounts mit aktuellem Feature-/Rollenzugriff.
- `/checkout/{monitorId}/{itemId}` startet den Checkout automatisch im sichtbaren
  Browser und öffnet Vinted ohne weiteren Start-Button. GET/HTML-Vorschauen und
  Next-Prefetches legen keinen Checkout an; versteckte oder vorgerenderte Tabs
  warten auf Aktivierung. Nach einem Login wird dasselbe Ziel automatisch
  fortgesetzt. Nur Fehler und bereits geöffnete Checkouts zeigen eine manuelle
  Wiederholungsaktion. Fehlgeschlagene Versuche werden nicht automatisch wiederholt.
- Die authentifizierte Dashboard-API lädt Seller und Account aus eigenen
  Datensätzen, prüft Monitor-Besitz und erlaubt nur die Checkout-URL der
  verknüpften Vinted-Region.
- Extension 0.2.2 prüft die tatsächliche Browser-Account-ID und stoppt vor
  Zahlung. Alte Extensions bzw. Browser ohne kompatible Extension verwenden
  `/api/items/checkout/prepare` im Service.
- Beide Wege fragen Vinted nach gespeicherten Komponenten, ohne PayPal,
  Versandart oder Abholpunkt zu erzwingen. `checkout_prepared` bedeutet eine
  vorbereitete Checkout-Seite, nicht bewiesene Vollständigkeit aller Angaben.
- Service-Sperren und Checkpoints sowie Extension-Checkpoints verhindern
  wiederholte Starts innerhalb desselben Wegs. Laufzeit und Wiederverwendung
  sind begrenzt; keine automatischen Regionswechsel oder Payment-Requests.
- Keine Schema-/Umgebungsänderung; die Extension muss aktualisiert werden,
  damit der neue Browser-Flow verwendet wird.

Die nachfolgenden Abschnitte dokumentieren den Ausgangsbefund. Die privaten
Vinted-Endpunkte und die Annahme, dass leere Komponenten gespeicherte Werte
übernehmen, bleiben live zu verifizieren. Desktop/mobile Browser-Tests nutzen
ausschließlich synthetische Antworten und keine echten Vinted-Accounts.

### Validierung der Implementierung

- `apps/control-center`: `npm run lint`, `npm run build` und
  `npm run test:unit` (29 Tests) erfolgreich.
- Playwright: zuletzt `checkout.spec.ts`, Desktop Chromium und Mobile Chrome
  (10 Tests) erfolgreich; Auth-Grenzen zusätzlich im vorherigen Lauf geprüft.
  Externe Checkout-Antworten sind
  vollständig abgefangen. Der lokale PostgreSQL-Server war nicht erreichbar;
  die neuen Ownership-/Feature-API-Tests verwenden isolierte Test-Doubles.
  Eine echte Datenbank-/Vinted-Integration ist dadurch nicht bestätigt.
- `apps/vinted-service` und `apps/worker`: `go test ./...` erfolgreich.
  Die Checkout-Cache-Tests starten eine eigene kurzlebige Redis-Instanz über
  einen Unix-Socket; sie verwenden keine konfigurierte Anwendungsdatenbank.
- Extension: `node scripts/validate-extension.mjs`, 32 Tests erfolgreich.
- [Checkout-Vorschau mit synthetischem Account](screenshots/checkout-handoff.png).
  Erneut exportierbar mit `E2E_CHECKOUT_SCREENSHOT=true` beim Checkout-E2E-Test.

### Noch nicht bestätigt: ausschließlich finale Kaufbestätigung

Der automatische Link-Aufruf beseitigt den zusätzlichen Vintrack-Klick. Er
beweist nicht, dass Vinted bereits Versand und Zahlungsmethode vollständig
gewählt hat. Die vorhandenen Request-Beispiele zeigen ein Build sowie leere
Komponenten und eine optionale Pickup-Auswahl, aber keine Vollständigkeit der
finalen Checkout-Ansicht. Der anonyme GET auf `/checkout` lieferte am
5. Oktober HTTP 307; die Authentifizierungsgrenze wurde nicht überschritten.
Ein Testaccount und ein konkreter Artikel wurden inzwischen freigegeben. Der
Login wartet auf einen E-Mail-Verifizierungscode, den der Nutzer bislang nicht
erhalten hat. Der angegebene Artikel trägt sowohl in der vorhandenen
Chrome-Sitzung als auch in der getrennten Sitzung das Label „Entfernt!“. Vor weiterer
Implementierung zur vollständigen Auswahl sind sanitierte echte
Checkout-Antworten nötig. Es wurde weiterhin kein echter Checkout angelegt.

## Ergebnis

Vintrack besitzt bereits einen Checkout-Button auf Item-Karten und einen
Browser-Flow, der vor der Zahlung endet. Das ist die passende Grundlage für
einen Desktop-Prototyp. Noch nicht bewiesen ist das gewünschte Ergebnis:
Nach einem Klick sind Versand und Zahlungsmethode vollständig ausgewählt und
der Nutzer muss auf Vinted nur noch den verbindlichen Kauf bestätigen.

Ein Checkout-Link ist kein Login-Link. Eine serverseitig verknüpfte
Vinted-Sitzung meldet den Browser, der einen Link öffnet, nicht bei Vinted an.
Für Notification-Links müssen deshalb Desktop-Browser, mobile Browser und
Telegram-/Discord-In-App-Browser getrennt geprüft werden.

## Bestehende Implementierung

| Teil | Befund | Quellcode |
| --- | --- | --- |
| Item-Karten | Einkaufswagen für verknüpfte Accounts mit vorhandener Seller-ID; zusätzlicher Bestätigungsdialog | `apps/control-center/src/components/monitors/item-card.tsx`, `handleBuy`, `runBuy` |
| Browser-Aufruf | Dashboard fordert über `postMessage` die Extension zum Checkout auf | `apps/control-center/src/lib/vintrack-extension.ts`, `runBrowserBuyViaExtension` |
| Browser-Checkout | Buy-Konversation erstellen, Checkout bauen, Komponenten aktualisieren, optional Versandkontakt setzen; anschließend Checkout-URL öffnen | `apps/vintrack-browser-sync-extension/page-bridge.js`, `runBrowserBuy`; `background.js`, `handleBrowserBuy` |
| Browser-Zahlung | Browser-Flow ruft keinen Checkout-Payment-Endpunkt auf. `payment_method`, `shipping_address` und `shipping_pickup_details` sind leere Objekte | `apps/vintrack-browser-sync-extension/page-bridge.js` |
| Bereitschaft | `checkout_ready` wird nach erfolgreichen Requests zurückgegeben, ohne vollständige Versand-/Zahlungsauswahl zu prüfen. UI fordert zur Wahl der Zahlungsmethode auf | `page-bridge.js`; `item-card.tsx` |
| Service-Experiment | `/api/items/buy` führt zusätzlich `createPurchasePayment` aus und bevorzugt eine Payment-URL. Für den gewünschten Handoff endet dieser Flow zu spät | `apps/vinted-service/internal/api/server.go`, `handleOneClickBuy`; `internal/vinted/client.go`, `doOneClickBuy` |
| Feature | `checkout_links` hängt von `vinted_account` ab | `apps/control-center/src/lib/features.ts` |
| Telegram | Aktuell nur Links zu Vinted, Seller und Dashboard; Compact nur zu Vinted | `apps/worker/internal/telegram/telegram.go`, `itemKeyboard`, `compactItemKeyboard` |
| Discord | Item-/Dashboard-/Seller-Links im Rich-Embed, Item-Link im Compact-Embed; kein Checkout-Handoff | `apps/worker/internal/discord/webhook.go` |
| Tests | Bestehende Service-Tests enthalten keinen Checkout-Flow-Test; Extension-Tests prüfen hauptsächlich Session-Lifecycle, nicht die Vollständigkeit eines Checkouts | `apps/vinted-service/internal/vinted/client_test.go`; `apps/vintrack-browser-sync-extension/scripts/` |

Der Companion in der Extension stellt diesen experimentellen Flow nicht bereit.
Der Dashboard-Aufruf ist jedoch vorhanden. Die Privacy-Dokumentation sagt
ausdrücklich, dass der Companion Checkout nicht automatisiert; bei einer
Erweiterung des Companion muss diese Produktbeschreibung überprüft werden.

## Endpoint-Kandidaten aus dem Code

Diese Pfade sind Implementierungsbefunde, keine neu bestätigten API-Verträge:

1. `POST /api/v2/conversations` mit `initiator: "buy"`, Item und Seller liefert
   laut Parser eine Transaction-ID. Das erzeugt Account-Zustand und ist kein
   rein lesender Aufruf.
2. `POST /api/v2/purchases/checkout/build` erhält
   `purchase_items: [{ id: transactionId, type: "transaction" }]`. Der Code
   erwartet eine Purchase-ID und Checkout-Daten.
3. `PUT /api/v2/purchases/{purchaseId}/checkout` aktualisiert Komponenten für
   Zahlungsmethode, Adresse und Versand. Welche konkreten Werte vollständig
   benötigt werden, muss am aktuellen Vinted-Flow festgestellt werden.
4. Optionaler Versandkontakt:
   `POST /api/v2/shipping_orders/{shippingOrderId}/shipping_contact`. Der
   vorhandene Code setzt `save_for_later: true`; für einen reinen Handoff sollte
   das dauerhafte Speichern von Kontaktdaten separat bewertet werden.
5. Aktuell konstruierter Fallback-Link:
   `https://{domain}/checkout?purchase_id={purchaseId}&order_id={transactionId}&order_type=transaction`.
   Bevorzugt wird eine von Vinted gelieferte, auf den erwarteten Host validierte
   Checkout-URL. Die Fallback-Form ist nicht live verifiziert.
6. `POST /api/v2/purchases/{purchaseId}/checkout/payment` gehört nicht in den
   vorgeschlagenen Prepare-Flow. Die Zahlung bestätigt der Nutzer auf Vinted.

## Öffentliche Live-Evidenz

Zieldomain: `www.vinted.de`. Ziel: öffentliche Frontend-Erreichbarkeit und
Login-Anforderung des Checkout-Einstiegs. Authentifizierung für die Homepage:
nein; für den Checkout: erwartet.

| Aufruf | Beobachtung |
| --- | --- |
| Scrapling `GET https://www.vinted.de/` | HTTP 200; HTML-Auszug mit Titel und öffentlich referenzierten Next.js-Assets. Keine explizite Impersonation, keine persistente Sitzung |
| TLS Fetch `GET https://www.vinted.de/checkout` | HTTP 200 **nach** Weiterleitungen auf `/member/signup/select_type?ref_url=%2Fcheckout` und `/member/register/select_type?ref_url=%2Fcheckout`; Login-/Registrierungsseite statt Checkout |
| Transport des zweiten Aufrufs | `chrome_146`, HTTP/2, 877 ms; `text/html; charset=utf-8`; `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`; `X-Page-Id: register-select-type` |
| Antwortgrenze | Zweite Antwort auf 524288 Bytes begrenzt und abgeschnitten; Body nicht inline ausgegeben. Für den beobachteten Redirect genügt die Metadaten-Evidenz |

Keine persistente Scrapling- oder TLS-Cookie-Sitzung wurde geöffnet. Keine
Tokens, Cookies oder authentifizierten Payloads wurden verwendet oder hier
gespeichert. An der Login-Grenze wurde die Untersuchung dieses Flows beendet.
Keine Aussage zur Rate-Limit-Schwelle lässt sich aus diesen beiden Aufrufen
ableiten.

## Vorgeschlagene Umsetzung nach dem Live-Nachweis

Zuerst den vorhandenen Desktop-Flow vervollständigen: passenden eingeloggten
Vinted-Account und Region prüfen, gültige gespeicherte Auswahl übernehmen,
Checkout-Komponenten auf Vollständigkeit prüfen und dann die Checkout-Seite
öffnen. Leere Komponenten allein sind kein Nachweis für einen fertigen Checkout.
Es darf keine Auswahl erfunden werden, wenn für das Item Versand oder Zahlung
nicht verfügbar ist.

Für Notifications eine Vintrack-Handoff-Seite einführen, beispielsweise
`/checkout/start/{itemId}`. Sie bestimmt nach Vintrack-Login den Nutzer,
prüft dessen Account/Feature-Zugriff und lädt die Item-/Seller-Daten serverseitig.
Eine geteilte Notification darf nicht als Berechtigung für den Account des
ursprünglichen Empfängers dienen.

Die Notification selbst enthält nur diesen Einstieg, keine Account-Tokens und
keine vorab angelegte Vinted-Transaktion. GET, Link-Previews und Next.js-Prefetch
dürfen keinen Checkout erzeugen. Ein Dashboard-Button kann die Vorbereitung
direkt durch eine bewusste Nutzeraktion auslösen. Bei einem externen URL-Link
muss geprüft werden, wie dessen bewusster Aufruf erkannt wird; ohne diese
Garantie braucht die Handoff-Seite einen Start-Button. Einen externen Link mit
GET-Nebenwirkungen nur für das Versprechen "one click" einzubauen wäre falsch.

Desktop kann die vorhandene Extension verwenden. Für mobile Browser ohne
Extension wäre ein gesonderter Service-Prepare-Endpunkt nötig, der nach Build
und nötigen Komponenten-Updates endet. Ob dessen Checkout im mobilen Browser
oder in der Vinted-App übernommen wird, ist separat zu testen. Der bestehende
Payment-Flow sollte dafür nicht aufgerufen werden.

Mehrfachklicks und Reloads sollen eine laufende Vorbereitung nicht duplizieren.
Eine fehlgeschlagene Antwort oder ein Auth-Refresh darf nicht blind den gesamten
mutierenden Flow neu starten. Bei Sicherheitsprüfung, abgelaufener Sitzung,
verkauftem Artikel oder fehlenden Einstellungen folgt eine klare Übergabe an
Vinted; kein falsches Versprechen, dass nur noch ein Klick nötig sei.

## Konkreter nächster Test

Mit einem vom Nutzer benannten Account, Browser und Item zunächst den regulären
Vinted-Checkout bis vor den verbindlichen Kauf beobachten. Dafür braucht es eine
ausdrückliche Freigabe zur Checkout-Vorbereitung; die Skill-Anforderung steht in
`.agents/skills/vinted-account-api-dev/SKILL.md`, Abschnitt "Start", Punkt 4.

Erfolgskriterien:

- Der vorbereitete Link öffnet denselben Account und das korrekte Item.
- Gesamtsumme, Adresse, Versandanbieter bzw. Abholpunkt und Zahlungsmethode sind
  gültig und sichtbar; keine Pflichtauswahl fehlt.
- Nur der finale Kauf-Button muss noch gedrückt werden.
- Der Vintrack-Flow sendet keinen Request an `checkout/payment` und bestätigt
  keinen Kauf.
- Ohne gültige Auswahl wird nur "Checkout öffnen" angeboten bzw. fehlende
  Eingabe benannt.
- Anschließend separat testen: Telegram-/Discord-Link im Desktop-Browser,
  mobilen Browser und In-App-Browser. Login und weitere Zahlungsbestätigungen
  können zusätzliche Interaktion verlangen; diese Varianten nicht aus dem
  Desktop-Ergebnis ableiten.

Erst nach diesem Nachweis lässt sich die Aussage "nur noch final kaufen"
verlässlich für die getestete Account-/Region-/Versand-/Zahlungskombination
treffen. Ein universelles Versprechen für alle Accounts und Geräte ist durch
die bisherige Untersuchung nicht gedeckt.
