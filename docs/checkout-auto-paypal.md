# Optionaler PayPal-Auto-Checkout

Stand: 5. Oktober 2026, Branch `feature/checkout-handoff`.

Unter Account kann ein Nutzer PayPal-Auto-Checkout einschalten, die Warnung
bestätigen und ein maximales EUR-Gesamtlimit einschließlich Versand und Gebühren
festlegen. Standardmäßig ist die Option aus. Dashboard-Warenkorb und
Discord-/Telegram-Kauf-Link verwenden denselben Ablauf nach einem Klick.
Neue Monitor-Treffer lösen keinen automatischen Kauf aus.

## Ablauf und Grenzen

Die regionale Vorauswahl bleibt account- und domaingebunden. Auto-Checkout ist
vorerst auf PayPal in DE/AT/BE begrenzt. Auch dort muss die konkrete aktualisierte
Checkout-Antwort PayPal als verfügbare, aktivierte Zahlart anbieten und die
gewünschte Lieferung bestätigen. Andere Provider bleiben beim normalen Oneclick.
Es gibt keinen automatischen Wechsel auf Karte oder Wallet.

Die Vorbereitung erfolgt weiterhin per Requests. Auto-Checkout ergänzt eine
gemeinsame serverseitige Versuchssperre und genau einen Payment-POST, wenn alle
Prüfungen erfolgreich sind. Extension 0.2.6 mit Prepare-Protokoll 5 ist erforderlich;
ältere erkannte Erweiterungen werden vor einer Mutation zum Update aufgefordert.
Vor der Versuchssperre prüft die Extension ihre lokale Verbindung zum Vinted-Tab,
ohne Vinted-Account- oder Checkout-Requests. Die serverseitige Browser-Freigabe
liest nur die verknüpfte Sitzung und Redis; sie führt keinen Vinted-Warmup oder
Token-Refresh aus. Ein bereits geladener, unerreichbarer Tab wird höchstens
750 ms geprüft statt 20 Sekunden lang abgefragt. Fehlerantworten behalten ihre
Request-ID, damit ein Verbindungsabbruch sofort angezeigt werden kann. Das
Speichern der Historie verzögert die Fertigmeldung nicht mehr. Neu geladene Tabs
und die eigentlichen Vinted-Requests können weiterhin zusätzliche Zeit benötigen;
die Änderung ist keine garantierte Live-Latenz.

Der Service-Fallback verwendet dieselben Preisprüfungen und Versuchssperren.
Der rein serverseitige Zugriff war zuvor bei dieser DE-Sitzung durch einen
Vinted-Sicherheitscheck blockiert; er ist noch kein live bestätigter Ersatz.

Prüfungen gegen die jüngste Checkout-Antwort:

- Positiver EUR-Gesamtbetrag aus `pay_button_v2.total.price`, innerhalb des Limits.
- `order_summary_v2.deductions` muss vorhanden und auswertbar sein. Jeder
  Wallet-Abzug muss exakt null sein. Auch anteilig angewendetes Wallet-Guthaben,
  unbekannte Abzüge oder eine Währungsumrechnung erfordern manuelle Prüfung.
- Bestätigte Lieferung, gewähltes PayPal, angebotene aktivierte PayPal-Methode
  und frische Checksumme. Fehlende Kontaktinformationen bleiben manuell.

Der Payment-Request verwendet Vinteds vorhandenen Checkout-Endpunkt
`POST /api/v2/purchases/{purchase_id}/checkout/payment` mit der aktuellen
Checksumme und Browser-Informationen. Er folgt selbst keinen HTTP-Redirects.
Nur Vinteds `action.type: redirect` mit `action.parameters.url` auf einer
freigegebenen HTTPS-PayPal-Checkout-URL wird unmittelbar geöffnet. SCA, Fehler,
Timeouts, andere Aktionen oder fremde Hosts werden nicht automatisch wiederholt.
Ein PayPal-Fenster oder eine Reservierung des Artikels ist nicht garantiert.
Der Warntext weist ausdrücklich darauf hin, dass ein echter Zahlungsrequest
gesendet wird und Wallet-Guthaben grundsätzlich ohne PayPal bestätigen kann.

## Wiederholung und Daten

Vor dem Zahlungsstart reservieren Service und Extension denselben Versuch in
Redis per `SET NX`. Der Schlüssel enthält Vintrack-Nutzer, Vinted-Identität,
Domain und Item. Er läuft nicht ab, solange Redis die Daten erhält; erneutes
Verknüpfen, Cache-Ablauf und ein anderer Browser erlauben keinen neuen
automatischen Versuch. Es gibt derzeit keinen automatischen Reset. Nach einem
unklaren Ergebnis muss der Nutzer in Vinted prüfen und manuell fortfahren.

Die Extension speichert ihren lokalen Versuch vor der ersten Mutation und hält
Auto-Versuche auch nach Neustarts vor. Der Service speichert vor dem Payment-POST
einen `payment_starting`-Checkpoint. Vorbereitungscaches und Checkout-Historie
enthalten nur den Vinted-Link, Status und sichere Hinweise. PayPal-URLs können
Zahlungstokens enthalten und werden nur im unmittelbaren Response zur Navigation
übergeben, nicht persistiert oder geloggt. Verlust von Redis-Daten beseitigt die
serverseitige Sperre; sie ist keine Garantie über einen Datenverlust hinweg.

Keine neue Schema- oder Env-Änderung. Auto-Einstellungen verwenden das vorhandene
accountgebundene JSON-Feld für Checkout-Vorgaben.

## Primäre Recherche und Live-Grenze

Der autorisierte DE-Test mit einem verfügbaren Bekleidungsartikel zeigte
Hauszustellung, ausgewähltes PayPal und 18,29 EUR Gesamtpreis. Er endete vor
„Zahlen“. Kein echter Payment-Request, keine PayPal-Zahlung und kein Kauf wurden
für diese Änderung ausgeführt. Upstream-Akzeptanz und reale Weiterleitung des
neuen Payment-Requests sind noch nicht live bestätigt.

Die Feldnamen für Gesamtpreis, Wallet-Abzüge, aktivierte Zahlarten und
Redirect-Aktionen stammen aus Vinteds öffentlich ausgeliefertem
[Checkout-Web-Bundle](https://marketplace-web-assets.vinted.com/_next/static/chunks/36m0sy627sdj1.js).
Das [weitere native Bundle](https://marketplace-web-assets.vinted.com/_next/static/chunks/0ym25ppuz24ui.js)
bestätigt die Build-/Update-Struktur. Bundles wurden ohne Authentifizierungsdaten
über Scrapling gelesen. Die [Vinted-PayPal-Hilfe](https://www.vinted.de/help/90-utiliser-paypal-sur-vinted)
beschreibt die externe PayPal-Bestätigung; die
[Zahlarten-Hilfe](https://www.vinted.de/help/3/94-payment-methods) erläutert die
automatische Anwendung des Geldbeutels. Native Responses bleiben maßgeblich.

## Validierung

Synthetische Tests prüfen gültige Redirects, unbekannte Ergebnisse, fehlerhafte
Preise, Wallet-Abzüge, Currency-Conversion, überschrittene Limits, fehlende
Checksummen, nicht verfügbare Zahlarten, abgelehnte Opt-ins, gemeinsame
Versuchssperren, Neustarts und das Vermeiden persistierter Zahlungstokens.
Browser-E2E-Tests arbeiten mit lokalen Stubs, ohne echten Vinted-Payment-Traffic.

- Control Center: 39 Unit-Tests, 22 bestandene Checkout-E2E auf Desktop/Mobil
  (2 Auth-Fälle im angemeldeten Testmodus übersprungen), ESLint und Build.
- Extension: 52 bestandene synthetische Checkout-/Lifecycle-Tests und
  Chrome-/Firefox-Pakete 0.2.6 gebaut.
- Vinted-Service: `go test ./...`.
- Lokale Account-UI: Warnung und Limit geprüft, bestehende Vorgaben nicht gespeichert
  oder verändert. [UI-Vorschau](screenshots/checkout-auto-paypal.png).
