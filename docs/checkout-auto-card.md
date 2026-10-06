# Optionaler Karten-Auto-Checkout

Stand: 6. Oktober 2026, Branch `feature/checkout-handoff`.

Unter Account kann der Nutzer „Card saved in Vinted“ wählen und Auto-Checkout
explizit einschalten. Die separate Kartenwarnung (Version 2) erklärt, dass ein
Klick auf einen Dashboard- oder Benachrichtigungs-Kauf-Link die gespeicherte Karte
sofort belasten kann. Ein bestehendes PayPal-Opt-in (Version 1) gilt nicht für
Karten. Ein Wechsel der Zahlart schaltet den Auto-Modus aus und verlangt eine
erneute Zustimmung mit EUR-Gesamtlimit. Zusätzlich bleibt das
[allgemeine Risiko-Overlay](checkout-risk-warning.md) verpflichtend.

Karten sind in den unterstützten Vinted-Regionen auswählbar. Maßgeblich ist die
aktuelle Checkout-Antwort: Auto-Checkout startet nur mit aktivierter Kartenmethode,
eindeutig ausgewählter, nicht als abgelaufen markierter gespeicherter Karte,
bestätigter Lieferung, frischer Checksumme und positivem EUR-Gesamtbetrag inklusive
Versand und Gebühren innerhalb des Limits. Andere Währungen, Wallet-Abzüge,
fehlende Daten, eine unerwartet gewechselte Karte oder erforderliche, nicht
vorhandene Adyen-Protect-Signale bleiben beim manuellen Checkout. Bei mehreren
gespeicherten Karten muss die gewünschte Karte bereits in Vinted ausgewählt sein.

Die Extension benötigt Version **0.3.1**, Prepare-Protokoll **6**. PayPal bleibt
mit Protokoll 5 kompatibel. Alte Extensions werden bei Karten-Auto-Checkout vor
Bereitschaftsprüfung, Serverfreigabe oder Vinted-Mutation zum Update aufgefordert.
Chrome, Firefox, Compose, `.env.example` und Dashboard-Fallback sind auf 0.3.2
gesetzt. Vor Release muss eine gesetzte GitHub-Variable
`BROWSER_EXTENSION_LATEST_VERSION` ebenfalls 0.3.2 sein; der Workflow prüft dies.

## Requests und Zahlungsbestätigung

Nach dem bestehenden Vorbereitungsablauf wird genau einmal
`POST /api/v2/purchases/{purchase_id}/checkout/payment` mit der aktuellen
Checksumme und Browser-Informationen gesendet. Kartenfelder werden nicht
hinzugefügt: Die Kartenreferenz wird in Vinteds Checkout gewählt. Vintrack
erfasst weder Kartennummern noch CVVs.

Die gemeinsame Redis-Sperre und der lokale Extension-Checkpoint gelten weiterhin
pro Nutzer, Vinted-Identität, Region und Artikel, unabhängig von der Zahlart.
Ein Wechsel auf PayPal, Neustart oder Ablauf des Vorbereitungscaches erlaubt
keinen neuen automatischen Zahlungsversuch. Payment-Requests werden weder nach
Netzwerkfehlern noch nach Authentifizierungsfehlern wiederholt.

Nur `payment.status: success` ohne Fehler oder weitere Aktion wird als von
Vinted bestätigte Kartenzahlung angezeigt. `pending`/`preparing`, `failure`,
3-D-Secure-/SCA-/CVV-Aktionen und unbekannte Antworten bleiben getrennte Zustände.
Eine erfolgreiche HTTP-Antwort allein bestätigt keinen Kauf.

Nach einem gesendeten Karten-Payment-Request wird ausschließlich der vorhandene
Vinted-Checkout mit `after_payment_redirect=true` geöffnet. Vinteds eigener
Checkout liest daraufhin die bestehende Zahlung per GET und zeigt sein natives
Ergebnis bzw. seine Bank-/CVV-Bestätigung. Vintrack implementiert keinen eigenen
Bank-SDK-Dialog, folgt keinen externen Karten-Redirects und speichert keine
Bank-Aktionsdaten. Bei einem unklaren Ergebnis muss der Nutzer Vinted prüfen;
es wird kein neuer Payment-Request gesendet. Ein weiterer manueller Schritt kann
bei Bankbestätigungen weiterhin nötig sein.

## Beobachtete Quelle und Testgrenze

Das öffentlich ausgelieferte
[Vinted-Checkout-Bundle](https://marketplace-web-assets.vinted.com/_next/static/chunks/36m0sy627sdj1.js)
wurde ohne Authentifizierung über Scrapling gelesen (HTTP 200). Beobachtet:

- Native Kartenmethode `credit_card`; gewählte Kartenreferenz unter
  `selected_payment_method.credit_card.external_code`, Ablaufstatus `expired`.
- Zahlungsstatus `success`, `pending`, `failure`, `preparing`.
- Aktionen `native_adyen_card_3ds`, `native_adyen_payment_3ds`,
  `sca_required`, `sca_challenge`, `sca_blocked`, `payrails_cvv_resubmission`.
- Der Rückkehrpfad `after_payment_redirect=true` lädt
  `getSingleCheckoutPayment` und verwendet den nativen Payment-Handler.

Synthetische Service-/Extension-Tests prüfen direkte Bestätigung, Bank-/CVV-Aktionen,
unbekannte Antworten, verlorene Responses, fehlende/abgelaufene/gewechselte Karten,
EUR-Limit, Wallet-Abzüge, zusätzliche Signalanforderungen, neue Zustimmung und
Wiederholungssperren einschließlich Zahlartwechsel. Browser-E2E prüft
Protokollkompatibilität und gemeinsame Freigabe auf Desktop und Mobil.

**Kein echter Karten-Payment-Request und kein Kauf wurden für diese Änderung
ausgeführt.** Reale Kartenabbuchung und Wiederaufnahme einer echten Bankbestätigung
sind noch nicht live bestätigt. Keine neue Schema- oder Env-Anforderung.
