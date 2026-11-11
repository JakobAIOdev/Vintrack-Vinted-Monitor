# Karten-Auto-Checkout einrichten

## Voraussetzungen

Installiere die aktuelle [Browser-Erweiterung](browser-extension.md), verknüpfe
dein Vinted-Konto und aktiviere das [Checkout-Modul](checkout-module.md).
Speichere die gewünschte Karte direkt in Vinted. Vintrack erfasst keine
Kartennummern oder CVVs.

## Aktivieren

1. Öffne **Account → Oneclick checkout**.
2. Wähle **Card saved in Vinted** und die gewünschte Lieferung.
3. Aktiviere Auto-Checkout.
4. Lies und bestätige die separate Kartenwarnung.
5. Speichere einen maximalen Gesamtbetrag mit der passenden Währung.

Der Gesamtbetrag umfasst Versand und Gebühren. Ein Klick auf einen Dashboard-
oder Benachrichtigungs-Kauf-Link kann die gespeicherte Karte sofort belasten.
Ein bestehendes PayPal-Opt-in aktiviert keine Kartenzahlungen.

Bei mehreren gespeicherten Karten muss die gewünschte Karte bereits in Vinted
ausgewählt sein. Fehlende, abgelaufene oder nicht eindeutig ausgewählte Karten
lassen den Checkout zur manuellen Prüfung offen.

## Lieferung, Währung und Bestätigung

Vinted muss die gewünschte Lieferung, verfügbare Karte und einen positiven
Gesamtbetrag innerhalb des gespeicherten Limits bestätigen. Die Währung muss
exakt übereinstimmen. Guthabenabzüge, eine Währungsumrechnung oder fehlende
Angaben verhindern automatische Zahlung.

Für Abholpunkte und andere Währungen siehe
[Abholpunkte und Währungslimits](checkout-pickup-gbp.md).
Ein Wechsel der Zahlart deaktiviert Auto-Checkout und verlangt eine neue
Zustimmung. Änderungen an Lieferung oder Limitwährung können ebenfalls eine
neue Bestätigung verlangen.

Vinted zeigt das Zahlungsergebnis und gegebenenfalls eine Bank-, 3-D-Secure-
oder CVV-Bestätigung. Ein erfolgreicher technischer Aufruf allein bestätigt
keinen Kauf. Prüfe bei einem unklaren Ergebnis zuerst Vinted. Vintrack wiederholt
die Zahlung nicht automatisch; auch ein Browser-Neustart oder Zahlartwechsel
startet keinen neuen automatischen Versuch.
