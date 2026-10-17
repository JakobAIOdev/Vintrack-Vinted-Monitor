# Token-Checkout: tatsächlicher Nachweis am 16. Oktober 2026

## Ergebnis

Mit der frisch synchronisierten Sitzung des ausdrücklich freigegebenen
Hauptaccounts funktioniert ein geschützter Lesezugriff vom Produktionsserver.
Die anschließend einmalig getestete Checkout-Vorbereitung scheitert dagegen
bereits beim ersten Vinted-POST mit HTTP 403. Ein Checkout-Link wurde nicht
zurückgegeben. Es gab keinen Payment-Request, keinen Kauf und keinen Retry.

Damit ist „einmal Token hinterlegen, anschließend dauerhaft automatisch kaufen“
für unsere aktuelle Integration weiterhin **nicht nachgewiesen**. Dass der
Server angemeldet lesen kann, reicht als Beleg für Checkout nicht aus.

Ein einzelner abgelehnter Versuch beweist keine allgemeine Unmöglichkeit.
Insbesondere ist die genaue Ursache der 403-Antwort mit der derzeitigen
Fehlerdiagnose nicht bestimmt. Sie darf nicht ohne weitere Evidenz als
DataDome-, CSRF-, IP- oder Tokenproblem bezeichnet werden.

## Freigabe und Ausgangszustand

Der Nutzer gab seinen Hauptbrowser-Account und den Artikel
`10403165777` (Zara Polo Size XL, `www.vinted.de`) für Konto-Prüfung und eine
Checkout-Vorbereitung ohne Zahlung frei. Nach Feststellung verschiedener
Account-IDs genehmigte er zusätzlich die Umstellung der Vintrack-Verknüpfung
von `@jakob_aio` auf `@jakob-aio` und das Aktivieren von Oneclick für den Test.
Den Risiko-/Haftungsdialog bestätigte der Nutzer selbst.

Zu Beginn war Vinted im Hauptbrowser ausgeloggt. Vintrack hatte noch den alten
Account mit einer Sitzung vom 5. Oktober gespeichert. Nach der Nutzeranmeldung
wurde die bestehende Extension-Verbindung regulär neu verbunden; sie meldete
den Hauptaccount am 16. Oktober um 21:01 Uhr deutscher Ortszeit erfolgreich.

Für den Test liefen die bestehenden Produktionsdienste von Version 2.7.3,
Revision `84775918524e5c2a23ea249a0968da07a37f105c`. Es wurde keine neue
Anwendungsversion hochgeladen, gestartet oder deployt.

## Live-Beobachtungen

| Prüfung | Ergebnis | Aussagegrenze |
| --- | --- | --- |
| Anmeldung im Hauptbrowser | Angemeldetes Profil und freigegebener Artikel sichtbar | Browser-Anmeldung allein beweist keinen Server-Zugriff. |
| Synchronisierung | Hauptaccount auf DE aktiv, Account-ID stimmt mit Browser-Profil überein | Kein Beleg für spätere automatische Erneuerung. |
| Gespeicherte Sitzung | Browsergebunden, kein Refresh-Token gespeichert | Dieser konkrete Account kann aktuell nicht durch einen gespeicherten Refresh-Token dauerhaft serverseitig erneuert werden. |
| Geschützter Server-Lesezugriff | `GET /api/messages/inbox?page=1&per_page=1`: HTTP 200, rund 250 ms, erwartete Antwortstruktur | Nachrichteninhalte wurden nicht ausgegeben oder gespeichert. Dies ist kein Checkout-Nachweis. |
| Einmaliger Server-Prepare-Aufruf | Vintrack HTTP 502 / `checkout_failed`, rund 102 ms, kein Checkout-Link | API abstrahiert die genaue Vinted-Fehlerursache. |
| Korrespondierender Vinted-Schritt | `POST /api/v2/conversations` mit Kauf-Initiator: HTTP 403 am 16.10. um 21:02:57 deutscher Ortszeit | Es wurde kein neuer Versuch zum Auslesen der Fehlerantwort gestartet. |

Der interne Prepare-Endpoint wurde mit dem freigegebenen Account, Artikel,
dem auf der Artikelseite sichtbaren Verkäufer und normalen Vorgaben
`shipping=home`, `payment=wallet` aufgerufen. Das entspricht den aktuellen
Standardvorgaben nach dem Account-Wechsel. `autoCheckout` war nicht enthalten.
Die bestehenden Feature- und Einwilligungsprüfungen waren aktiv; es wurde kein
Checkout-Guard umgangen. Ein Monitor-Item oder eine Test-Monitor-Zeile wurde
nicht angelegt.

Nach der ausdrücklichen 403-Ablehnung wurde gestoppt. Es gab insbesondere keinen
automatischen Wechsel auf Browser-Ausführung, keine Proxy-/Profilwechsel und
keinen erneuten Checkout-Aufruf. Der erste fehlgeschlagene Schritt lieferte
keine Transaktions-ID an unseren Service zurück. Daraus wird keine weitergehende
Garantie über Vinteds interne Verarbeitung abgeleitet.

Das für den Test aktivierte Oneclick-Modul wird anschließend wieder auf den
vorherigen Zustand „aus“ gesetzt. Auto-Payment bleibt aus. Die ausdrücklich
genehmigte Verbindung zu `@jakob-aio` bleibt bestehen.

## Zusätzliche lokale Prüfungen

Die vollständige Go-Suite lief mit `go test ./... -count=1 -json` ohne Fehler;
399 erfolgreiche Test-/Subtest-Ereignisse, 12 übersprungene Integrationstests.
Zusätzlich wurden acht temporäre Diagnosetests über Go-Overlays ausgeführt,
ausschließlich mit synthetischen Tokens/Antworten und isoliertem lokalem Redis:

| Szenario | Beobachtetes Verhalten |
| --- | --- |
| Nur Access-Token, Homepage liefert Kontext | Lokaler Prepare-Ablauf erreicht den Review-Link, ohne Payment-Request. |
| Beide Account-Endpunkte antworten 401 | `ValidateSession` lehnt die Sitzung ab. |
| Account-Endpunkte antworten 429 oder 500 | `ValidateSession` kann über die im Token enthaltene ID trotzdem `true` liefern. |
| Access-Token ohne Refresh-Token | Refresh stoppt vor einem Request. |
| Checkout-Antwort mit synthetischer Challenge | Ein Request, kein Retry, Challenge klassifiziert. |
| Erfolgreiche simulierte Token-Rotation | Neuer Access-/Refresh-Token wird im Client übernommen. |
| Neue Account-Zugangsdaten ohne Cookie-Header | Vorheriger CSRF-/Anon-/Cookie-Kontext kann in `buildLinkedSession` erhalten bleiben; die Account-Prüfung erfolgt später. |
| Manuelle Tokens nach Browser-Kopplung | Das übernommene `BrowserLinked` bleibt gesetzt; serverseitiger Refresh wird dadurch weiterhin nicht freigegeben. |

Die Tests für die problematischen Fälle charakterisieren den damaligen Code;
ihr Erfolg bedeutet nicht, dass dieses Verhalten korrekt oder behoben ist.
Kein synthetischer Test beweist Akzeptanz durch Vinted. Die übernommenen
Sitzungsfelder sind ein untersuchenswerter Codepfad, aber keine nachgewiesene
Ursache des Live-403.

Nachtrag vom 17. Oktober: Die beschriebenen Validierungs-, Kontextübernahme-
und Refresh-Zuständigkeitsfehler sind inzwischen mit dauerhaften synthetischen
Regressionstests behoben. Account-Validierung erfordert geschützten Lesezugriff
und ein passendes Profil; neue Zugangsdaten übernehmen keinen fremden Kontext.
Siehe [REA-Umsetzung und aktuelle Grenzen](checkout-rea-2026-10-17.md).
Ein erneuter Live-Server-Test wurde dafür nicht ausgeführt.

Relevante Quellen:

- `apps/vinted-service/internal/api/server.go`: `buildLinkedSession`,
  `serverSideTokenRefreshAllowed`, `handleExtensionSyncComplete`.
- `apps/vinted-service/internal/vinted/client.go`: `GetAccountInfo`,
  `ValidateSession`, `WarmUp`, `RefreshAccessToken`, `createBuyTransaction`.
- `apps/vinted-service/internal/api/checkout.go`: Fehlerabbildung und
  Trennung von Prepare und Auto-Payment.

## Welche Lösung ist damit sinnvoll?

Für die derzeit belegte Funktion bleibt Checkout-Vorbereitung in der lokalen
Vinted-Browsersitzung die Grundlage. Der existierende Desktop-Nachweis ist
[hier dokumentiert](checkout-handoff-recon.md); Android und iPhone haben nach
wie vor keinen echten Geräte-Ende-zu-Ende-Nachweis.

Als Produkt wäre einmaliges Verbinden mit anschließendem browserunabhängigem
Server-Betrieb angenehm: Das könnte Android und iPhone denselben Einstieg
geben. Dafür fehlen aber noch zwei entscheidende Nachweise: akzeptierter
Server-Checkout und verlässliche Sitzungserneuerung. Ein Access-Token allein
erfüllt den zweiten Punkt nicht.

Vor einer größeren Mobile-Implementierung ist ein kleiner Entwicklungsblock
sinnvoll, der die Entscheidung belastbarer macht:

1. Sitzungsidentität, bestätigte Anmeldung und bloß aus dem Token gelesene
   Identität getrennt behandeln. 429/5xx dürfen kein gültiges Auth-Ergebnis
   erzeugen.
2. Browser- und Server-Sitzungen ausdrücklich verwalten. Bei Account-Wechsel
   keinen fremden Sitzungskontext übernehmen; Refresh-Zuständigkeit eindeutig
   halten. Den Browser-Refresh-Token nicht parallel von Browser und Server
   rotieren lassen.
3. Checkout-Fehler um sichere Diagnosefelder ergänzen: Schritt, Upstream-Status
   und bekannte Fehlerklasse. Keine Antwortkörper, Tokens oder Cookies loggen.
4. Nach Nutzerdeployment und neuer Freigabe gezielt erneut prüfen. Solange
   Server-Checkout nicht belegt ist, darf er nicht aus einem Extension-Timeout
   automatisch gestartet werden.

Falls der Server-Pfad danach funktioniert, folgt eine separat freigegebene
Prüfung nach regulärer Token-Erneuerung und auf einem mobilen Browser. Falls
er weiter ausdrücklich abgelehnt wird, begrenzen wir diesen Weg und setzen die
Mobile-Extension-Beta um. Echte Zahlungstests bleiben ein eigener Schritt;
dieser Test autorisiert sie nicht.

Der [Mobile-Architekturplan](mobile-checkout-review-2026-10-16.md) bleibt für
diesen Browser-Pfad maßgeblich. Diese Runde änderte keinen Anwendungscode und
enthält noch keinen Fix für die festgestellten Diagnose-/Sitzungsprobleme.
