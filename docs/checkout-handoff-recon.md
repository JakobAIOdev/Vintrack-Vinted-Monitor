# Oneclick checkout: Live-Nachweis und Implementierung

Stand: 5. Oktober 2026. Branch: `codex/checkout-handoff`.

Die anschließend ergänzte regionale Zahlungsauswahl mit Extension 0.2.4 ist
in [checkout-payment-regions.md](checkout-payment-regions.md) dokumentiert.

## Live getestet

Der Nutzer gab den verknüpften Account `@jakob_aio` in seinem Hauptbrowser,
den Artikel `9041802672` und Checkout-Vorbereitung bis vor „Zahlen“ frei.
Lieferung an die vorhandene Vinted-Adresse und PayPal wurden für diesen Test
explizit ausgewählt. Es wurde keine Zahlung ausgelöst.

1. Der native Kaufen-Button öffnete den Checkout trotz des Artikellabels
   „Entfernt!“. Die frühere Annahme, der Artikel könne deshalb nicht getestet
   werden, war falsch. Das Label ist kein zuverlässiger Checkout-Status.
2. Im nativen Checkout fehlten zunächst Abholstelle und Zahlungsmethode.
   Leere Komponenten allein erfüllten das gewünschte Ergebnis nicht.
3. Im regulären Vinted-Checkout wurden Hauszustellung und PayPal gewählt.
   Beide Auswahlen blieben nach dem Neuladen erhalten. Nur „Zahlen“ blieb offen.
4. Anschließend wurde der neue Extension-Flow 0.2.2 mit denselben explizit
   freigegebenen Daten über einen einmaligen lokalen Testbutton ausgeführt.
   Er meldete `checkout_prepared` und öffnete den richtigen Artikel mit
   Hauszustellung und PayPal vorausgewählt. Kein Payment-Request wurde gesendet.
   Die temporäre Testseite ist entfernt und gehört nicht zur Implementierung.

Für den Test wurden keine Monitor-Datensätze eingefügt. Deshalb ist der komplette
Notification-Link mit einem echten Monitor-Item nicht live geprüft. Die
Handoff-Seite und Besitzprüfung sind separat mit isolierten Antworten getestet.
Die benutzte authentifizierte Checkout-Antwort wurde nur im Speicher ausgewertet;
Cookies, Tokens, Adresse, Purchase-ID und Account-ID werden hier nicht gespeichert.

## Beobachteter Vinted-Vertrag

`PUT /api/v2/purchases/{purchaseId}/checkout` erhält `components`:

```json
{
  "additional_service": {},
  "payment_method": { "card_id": null, "payment_method": "paypal" },
  "shipping_address": {},
  "shipping_pickup_options": { "pickup_type": 1 },
  "shipping_pickup_details": {}
}
```

- `pickup_type: 1` wählt im getesteten DE-Checkout Hauszustellung.
  Vinted wählt die passende Rate; es wird keine Versandrate erfunden.
- PayPal wird nur gesetzt, wenn die aktuelle Antwort unter
  `checkout.components.payment_method.pay_in_methods` den Code
  `MANGOPAY_PAYPAL` anbietet.
- Bestätigung der Auswahl:
  `selected_payment_method.pay_in_method.payment_method == "paypal"`,
  `shipping_pickup_options.selected_pickup_option == 1`, vorhandene Adresse,
  `shipping_pickup_details.pickup_details.selected_rate_uuid` und
  `pay_button_v2.payments_available == true`.
- `POST /api/v2/conversations` und
  `POST /api/v2/purchases/checkout/build` bereiten die Transaktion vor.
  Der Flow endet vor `checkout/payment`.

Vinted verwendet verfügbares Guthaben automatisch. Reicht es nicht aus, ist eine
weitere Zahlungsmethode nötig; Zahlungsoptionen unterscheiden sich je Account.
Quelle: [Vinted: Payment methods](https://www.vinted.com/help/3/94-payment-methods).
Der Testaccount bot keine separate Guthabenoption an. Ein vollständig mit Guthaben
bezahlbarer Checkout ist deshalb nicht live nachgewiesen. Die Wallet-Vorgabe
setzt keine andere Zahlart und wird konservativ als `checkout_review_required`
zur Prüfung in Vinted geöffnet; Vinteds bereits gespeicherte Zahlart kann dort
weiterhin sichtbar sein.

## Implementierung

- Item-Karten und Telegram-/Discord-Notifications enthalten den Checkout-Einstieg.
- `/checkout/{monitorId}/{itemId}` startet automatisch im sichtbaren Browser.
  GET, Vorschauen und Next-Prefetch legen keinen Checkout an; versteckte Tabs
  warten auf Aktivierung. Login kehrt zum gleichen Ziel zurück.
- Die API prüft Auth, Feature, Monitor-Besitz, Seller und verknüpften Account.
  Sie lädt Vorgaben serverseitig. Keine Tokens in Notification-Links.
- Account-Einstellungen bieten Hauszustellung oder Vinteds gespeicherte
  Versandwahl sowie Wallet, Wallet mit PayPal für den Restbetrag oder Vinteds
  gespeicherte Zahlart. Standard: Hauszustellung und Wallet.
- `User.checkout_preferences` speichert ausschließlich Vorgaben, gebunden an
  Account-ID und Region. Ein Account-/Regionswechsel übernimmt sie nicht.
- Migration: `20261005120000_add_checkout_preferences`; keine neue Env-Variable.
  Auf der lokalen Testdatenbank bereits angewendet und als angewendet markiert.
- Extension 0.2.2 meldet Prepare-Protokoll 2. Alte Protokolle verwenden den
  separaten Service-Prepare-Endpoint; keine Payment-Fallbacks.
- Beide Wege setzen Hauszustellung und prüfen danach die verfügbaren Zahlarten.
   PayPal wird gesetzt, sobald eine Antwort es anbietet. Bietet bereits die
   Build-Antwort PayPal an, werden Versand und Zahlung gemeinsam aktualisiert.
   Bereits ausgewähltes PayPal erfordert kein weiteres Update. Fehlende Optionen
  erzeugen einen Review-Status; keine erfundenen Zahlarten/Abholstellen.
- Mutations-Checkpoints und kurze Sperren verhindern blinde Wiederholung.
  Bei geänderten Vorgaben öffnet ein schon vorhandener Checkout zur Prüfung;
  er wird innerhalb des Wiederverwendungsfensters nicht neu erzeugt.
- Nur die beobachtete Hauszustellung mit bestätigter Zahlart erhält
  `checkout_prepared`. Abholstellen-Vollständigkeit wird nicht behauptet.

## Grenzen

Der Live-Nachweis gilt für Chrome, `www.vinted.de`, Hauszustellung und PayPal.
PayPal kann nach „Zahlen“ eine weitere Zahlungsbestätigung verlangen. Wallet bei
vollständigem Guthaben, andere Regionen, Versandkontakte, mobile Geräte und
Telegram-/Discord-In-App-Browser sind nicht live bestätigt. Ein verknüpfter
Service-Account meldet den Zielbrowser nicht automatisch bei Vinted an.

Die Browser-Steuerung darf `chrome://extensions` nicht öffnen. Der Nutzer hat
das neue Paket selbst neu geladen; anschließend zeigte Vintrack 0.2.2 als
verbunden und der Live-Test lief erfolgreich.

## Validierung

- Control Center: 31 Unit-Tests, ESLint und Produktionsbuild erfolgreich.
- Handoff-E2E: 10 Desktop-/Mobile-Tests mit synthetischen Antworten erfolgreich.
- Vinted-Service und Worker: `go test ./...` erfolgreich.
- Extension: 35 Tests und Manifest-Validierung erfolgreich.
- Live: regulärer Checkout und neuer Extension-Prepare-Flow erfolgreich;
  die serverseitige TLS-Integration wurde anschließend getestet, siehe unten.
- [Account-Vorgaben](screenshots/checkout-preferences.png).
- [Synthetische Handoff-Vorschau](screenshots/checkout-handoff.png).

Die lokalen Docker-Images für Control Center, Vinted-Service und Worker wurden
gebaut und gestartet. Die temporären Next-Dev-Server sind beendet. Kein Push
oder Produktionsdeployment wurde ausgeführt.

## Optimierung nach dem Discord-Test

Der Nutzer bestätigte den funktionierenden Discord-Link und bat um einen
schnelleren, möglichst vollständig requestbasierten Ablauf.

Ein direkter Aufruf des Service-Prepare-Endpoints mit der normal gespeicherten
verknüpften Sitzung, dem freigegebenen Artikel und Hauszustellung/PayPal endete
nach **893 ms** mit `vinted_security_check` (Vintrack HTTP 409). Es wurde kein
Checkout-Link zurückgegeben und kein Payment ausgeführt. Dieser Versuch wurde
nicht wiederholt und die Sicherheitsprüfung nicht umgangen. Server-only ist
für diese Sitzung damit aktuell kein live bestätigter Ersatz.

Extension **0.2.3** führt die Vorbereitung weiter mit HTTP-Requests in der
aktiven Vinted-Sitzung aus. Sie verwendet jede passende bereits offene
Vinted-Seite, bevorzugt eine geladene Seite und überspringt die Navigation zur
Artikelseite. Neue Versuche prüfen den Account einmal direkt vor dem ersten
POST. Vorhandene Links prüfen ihn vor der Navigation. Bei Account-Abweichung
vor jeder Mutation wird nur der eigene lokale Intent entfernt; unklare
Mutationsfehler bleiben weiterhin gegen Wiederholung gesperrt.

Die Handoff-Seite verwendet ihre bereits geladenen Ziel-Metadaten. Dadurch
entfällt der zweite GET. Bei Item-Karten laufen Metadaten-Abfrage und
Extension-Erkennung parallel. GET/Vorschauen bleiben weiterhin ohne Mutation.
Beide Prepare-Implementierungen sparen ein PayPal-Update, wenn die Build-Antwort
die Option bereits anbietet oder PayPal schon ausgewählt ist. Fehlt diese
Information, bleibt der beobachtete Ablauf mit zweitem Update erhalten.

Validierung: 39 Extension-Tests, 31 Frontend-Unit-Tests, ESLint,
Produktionsbuild, 10 Handoff-E2E-Tests (Desktop/Mobile) sowie beide Go-Suites
erfolgreich. Ein prozentualer Geschwindigkeitsgewinn wird ohne gemessene
Vorher/Nachher-Stichprobe nicht behauptet.

Nach dem manuellen Neuladen von 0.2.3 wurde derselbe freigegebene Artikel mit
Hauszustellung/PayPal ausgehend von einer offenen Vinted-Startseite getestet.
Die Vorbereitung bis zur initiierten Checkout-Navigation dauerte **4139 ms**
(gemessen im lokalen UI mit `performance.now()`, ohne finales Seitenrendern).
Ergebnis: `checkout_prepared`. Die tatsächlich geöffnete Checkout-Seite zeigte
den richtigen Artikel, Hauszustellung mit DPD CLASSIC, ausgewähltes PayPal und
den letzten Button „Zahlen“. Er wurde nicht gedrückt. Die temporäre, nur lokal
und für den freigegebenen Account zugängliche Testseite wurde entfernt.
Der Test misst die Extension-Vorbereitung; Discord-/Vintrack-Seitenladen ist
nicht Teil dieser 4139 ms. Der komplette Discord-Link wurde vom Nutzer als
funktionierend bestätigt, für den optimierten Link liegt keine separate
Live-Messung ab Discord-Klick vor.
