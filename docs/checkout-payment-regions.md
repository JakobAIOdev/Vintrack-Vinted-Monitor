# Regionale Zahlarten für Oneclick

Stand: 5. Oktober 2026. Implementiert auf `codex/checkout-handoff`.

Die Auswahl unter Account orientiert sich an der verknüpften Vinted-Domain,
nicht an der Region des Monitors oder Verkäufers. Guthaben, gespeicherte Karte,
Google Pay und Vinteds gespeicherte Zahlart bilden die gemeinsame Vorauswahl.
Zusätzliche regionale Vorgaben:

| Region | Zusätzliche Zahlarten | Primärquelle |
| --- | --- | --- |
| DE | PayPal, Tink, Klarna | [Vinted DE](https://www.vinted.de/help/3/94-payment-methods) |
| AT | PayPal | [Vinted AT](https://www.vinted.at/help/94-payment-methods) |
| BE | PayPal, Bancontact Pay | [Vinted BE](https://www.vinted.be/help/94-payment-methods) |
| NL | iDEAL / Wero | [Vinted NL](https://www.vinted.nl/help/15/750-modtagelse-af-en-refundering) |
| PL | BLIK, Przelewy24 | [Vinted PL](https://www.vinted.pl/help/5/94-zahlungsmethoden-auf-vinted) |

[Vinted FR](https://www.vinted.fr/help/5/94) und
[Vinted UK](https://www.vinted.co.uk/help/5/94) dokumentieren die gemeinsamen
Optionen, ohne PayPal. Weitere von Vintrack unterstützte Domains verwenden
vorerst die gemeinsame Vorauswahl; zusätzliche lokale Anbieter sind dort
nicht vollständig untersucht. Maßgeblich bleibt das Angebot im tatsächlichen
Checkout. Apple Pay wird weggelassen: Die Vinted-Hilfe nennt ausschließlich die
iOS-App, Google Pay dagegen auch die Website.

## Recherche

Anonyme Scrapling-GETs auf die regionalen Hilfeseiten lieferten HTTP 200,
aber nur die Seitennavigation, keinen Artikeltext. Der Versuch mit Scrapling
Browser-Rendering war mit einem Toolfehler nicht auswertbar. Die primären
Artikeltexte für DE, BE, FR, UK und PL wurden deshalb über Web-Quellen geprüft.
AT wurde im regulären Chrome-Browser gerendert und bestätigte ausdrücklich
PayPal, Karten, Geldbeutel sowie Apple/Google Pay. NL dokumentiert iDEAL/Wero
auch in den aktuellen Rückerstattungsinformationen. Keine Anmeldung,
Checkout-Mutation oder Zahlung war für diese Recherche nötig.

## Verhalten und Grenzen

- Speichern prüft die Zahlart serverseitig gegen die aktuelle verknüpfte Domain.
  Vom Client gelieferte Domains, Card-IDs oder Zahlungsdaten werden abgelehnt.
- Vorgaben bleiben an Account und Domain gebunden. Eine inzwischen regional
  unzulässige Zahlart wird beim Lesen zu Wallet; die Versandwahl bleibt erhalten.
- Der Kaufklick liest keine Hilfeseiten. Die Regionstabelle ist lokal und fügt
  keine Netzwerkabfrage zur bisherigen Oneclick-Vorbereitung hinzu.
- Service und Extension wählen nur Angebote aus der jeweiligen Checkout-Antwort.
  Sie übernehmen den von Vinted zurückgegebenen `payment_method`-Wert. Eine
  boolesche `read_only`-Markierung verhindert automatische Auswahl. Für PayPal
  bleibt der bereits live beobachtete `MANGOPAY_PAYPAL`-Fallback bestehen.
- Falls das Build die Zahlart schon anbietet, erfolgt ihre Wahl zusammen mit
  dem Versand im ersten Update. Sonst höchstens ein zusätzliches Update, sofern
  die Antwort sie anbietet und sie noch nicht gewählt wurde.
- Karte: vorhandene Auswahl oder genau eine gespeicherte Karte. Bei mehreren
  Karten ohne Auswahl bzw. mehreren Provider-Varianten ohne passende Auswahl
  bleibt der Checkout zur Prüfung offen. Keine erfundenen Karten- oder Method-IDs.
- `checkout_prepared` setzt die bestätigte gewünschte Zahlart voraus; fehlende
  oder unbekannte Optionen ergeben `checkout_review_required`. Wallet bleibt
  konservativ zur Prüfung offen. Normaler Oneclick sendet keinen Payment-Request.
  Der separate, ausdrücklich aktivierte [PayPal-Auto-Checkout](checkout-auto-paypal.md)
  kann nach dem Kaufklick einen Payment-Request senden.
- Extension 0.2.4 / Prepare-Protokoll 3 verarbeitet die neuen Zahlarten. Bei
  alten Erweiterungen erscheint für neue Vorgaben eine Update-Aufforderung vor
  jeder Mutation. Die ursprünglichen Vorgaben bleiben mit Protokoll 2 kompatibel.
- PayPal/Hauszustellung DE ist aus dem vorherigen Live-Test bestätigt. Neue
  Provider sind mit synthetischen Antworten getestet; ihre vollständige
  regionale Live-Vorauswahl ist noch nicht bestätigt.

Keine Schema- oder Env-Änderung erforderlich.

## Validierung

- Control Center: 36 Unit-Tests, 14 Desktop/Mobile-E2E-Tests, ESLint und
  Produktionsbuild erfolgreich.
- Extension: 41 Tests erfolgreich; Chrome-/Firefox-Pakete 0.2.4 gebaut.
- Vinted-Service und Worker: `go test ./...` erfolgreich.
- Lokale Docker-Images für Control Center und Vinted-Service gebaut und
  gestartet. Account-UI mit verknüpfter DE-Region geprüft: regionale Optionen
  sichtbar, vorhandene PayPal-/Hauszustellungswahl erhalten. Keine Vorgabe
  verändert und kein neuer Live-Checkout oder Payment gestartet.
- [Screenshot der Account-Einstellungen](screenshots/checkout-payment-regions.png).
