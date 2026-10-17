# Checkout-Rekonstruktion mit REA

Stand: 17. Oktober 2026. Umsetzung auf Basis von `origin/dev` (`34a347b`).
Verwendet: [REA](https://github.com/morluto/rea), CLI `rea-agents@6.5.0` und der
lokale Skill `reverse-engineer-anything` Version 42. Der MCP-Server war in dieser
Sitzung nicht verbunden; die statische Analyse lief über den unterstützten CLI.
Keine Codex-Konfiguration geändert und keine nativen Analyse-Engines installiert.

## Ergebnis für Vintrack

Die heute öffentlich ausgelieferte Artikelseite enthält weiterhin den
bekannten Checkout-Build und die Konversationsvariante, auf der Vintrack
aufbaut. Der bestehende Ablauf bleibt deshalb die Grundlage:

1. Tatsächlichen Account im Vinted-Browser prüfen.
2. Kauftransaktion anlegen und deren ausdrücklich ausgewiesene ID verwenden.
3. Checkout mit dieser Transaktion bauen.
4. Angebotene Liefer- und Zahlungsoptionen übernehmen und Antwort prüfen.
5. Normalen Oneclick zur nativen Vinted-Bestätigung öffnen.

Die Rekonstruktion belegt keine serverseitige Akzeptanz. Der freigegebene
[Server-Test vom 16. Oktober](checkout-token-feasibility-2026-10-16.md) endete
bereits beim Transaktions-POST mit HTTP 403. Dessen genaue Ursache ist offen.
Ein dauerhaft autonomer Checkout mit einem einzigen hinterlegten Token ist
damit weiterhin **nicht nachgewiesen**.

Die heutige Artikelseite enthält außerdem einen zweiten Kaufstart über einen
Messaging-Gateway-Endpunkt. Feature-Flags wählen im ausgelieferten Code zwischen
beiden Varianten. Welche Variante für den freigegebenen Account aktiv ist und
ob sie den früheren 403 erklärt, ist nicht beobachtet. Vintrack probiert bei
einer Ablehnung deshalb keinen zweiten mutierenden Endpunkt aus.

## Quellen und Evidence

Die öffentliche Artikelseite wurde einmal anonym mit Scrapling ausschließlich
auf `script[src]` gelesen: HTTP 200, 76 Script-URLs. Anschließend wurden diese
öffentlichen statischen Dateien ohne Cookies oder Authentifizierungsheader
bytegenau gespeichert: insgesamt 5.377.836 Bytes, maximal zwei gleichzeitige
Downloads. Die Rohbyte-Snapshots stammen aus gewöhnlichen HTTPS-GETs; die
Scrapling-Textextraktion ist nicht Grundlage ihrer SHA-256-Werte.

REA analysierte drei ausgewählte Dateien aus diesem Inventar. Die übrigen 73
Dateien wurden nicht semantisch analysiert; gezielte Textstellen in einer
weiteren Datei sind unten ausdrücklich als ergänzende manuelle Prüfung markiert.
Zwei zuvor am 5. Oktober dokumentierte Checkout-Bundles wurden separat erneut
heruntergeladen und analysiert. Sie sind noch abrufbar, stehen aber nicht in
der heutigen Artikelseiten-Inventarliste. Daraus folgt weder, dass sie heute auf
einer Checkout-Seite geladen werden, noch dass ihr Vertrag unverändert gilt.

| Kennung | Inhalt und Grenze |
| --- | --- |
| `ev_f274821f08d33aade3713cc3ed461ee12bc12c070385d1730300ec5cee625b09` | Heutiges Inventar, drei ausgewählte JS-Dateien; 43.430 AST-Knoten, keine Parse-Fehler. Statische Gesamt- und Semantikabdeckung teilweise, 11.119 ausgewiesene semantische Unknowns; keine Node-Limit-Trunkierung. |
| `ev_6c8e137d384f802ce12d3c5d7f721d7be6b42fab9f02aa70618138795b485a6a` | Zusammenfassende Projektion dieser Analyse. |
| `ev_e88339bee67a69877564e83bb797e1be220ba50803e9a5fe6b0d44eb67acfd6d` | Eingehender Trace des Literals `/purchases/checkout/build`; ein Seed, vier Knoten, drei Beziehungen. Belegt Syntax und statische Zuordnung, keine ausgeführte Anfrage. |
| `ev_48062a74ea1e19852129ca8fa88f53c45ed3abe6805a988080b0470fec7c5b8f` | Zwei historische Bundles, 58.989 AST-Knoten, keine Parse-Fehler. Semantik teilweise und am Default-Limit von 20.000 Knoten pro Datei abgeschnitten. |

Vollständige Evidence-JSONs und Rohdateien bleiben lokal unter
`/Users/jakob/.codex/artifacts/vintrack/rea-checkout-2026-10-17`.
Das Repository enthält nur diesen Befund und das
[kompakte Quellenverzeichnis](checkout-rea-evidence-2026-10-17.json), keine
kopierten Vinted-Bundles und keine Account-/Zahlungsdaten.

## Befund-Ledger

| Frage | Beleg und Einordnung | Status / Konsequenz |
| --- | --- | --- |
| Wie wird die bisherige Kauftransaktion begonnen? | Heutiges `305ffp0abeebw.js`, `legacyCreateConversation`, Zeichenpositionen ca. 50.250–50.900: POST `/conversations`, numerische Artikel-/Verkäufer-ID; Ergebnis aus `conversation.transaction.id`. REA-Parent plus gezielte Quellprüfung. | Statisch beantwortet. Request-Typen angeglichen; generische Suche nach beliebigem `id` entfernt. |
| Wie wird der Checkout gebaut? | Heutiges `43f4fu--kqzgy.js`, REA-Trace, Zeile 1 Spalten 966–1048: POST `/purchases/checkout/build`, `purchase_items` mit numerischer ID und Typ. | Statisch beantwortet; vorhandener Build passt. |
| Wie werden Vorgaben aktualisiert? | Dieselbe heutige Datei, Anfang des Moduls `623681`: PUT `/purchases/{id}/checkout`, `components` mit payment/shipping-Feldern. | Statisch beantwortet; vorhandener Komponenten-Ansatz passt. Keine Zusage, dass jede Option angeboten wird. |
| Gibt es einen neueren Kaufstart? | Heutiges `305ffp0abeebw.js`: `newCreateConversation`, `/messaging/main/inquiries`, `item_ids` und `receiver_id`; separate `transaction_id`. Ergänzende manuelle Prüfung von `1i6revhf7x0bc.js`, ca. 75.400–79.000, zeigt Feature-Flag-Auswahl im Kaufbutton. | Zwei statische Varianten belegt; aktive Account-Variante offen. Kein blinder Endpoint-Fallback implementiert. |
| Was passiert beim Bezahlen? | Historisches `36m0sy627sdj1.js` enthält Checksumme, Zahlungsaktionen einschließlich Redirect und SCA. Der heutige Item-Scope enthält keinen vollständig untersuchten aktuellen Zahlungsablauf. | Teilweise beantwortet. Kein neuer Payment-Vertrag, keine Provider-/3DS-Akzeptanz behauptet; mobile automatische Zahlung technisch gesperrt. |
| Reicht ein Server-Token? | Separater autorisierter Live-Befund: geschützter Account-Lesezugriff ja, erster Checkout-POST 403. Die heutigen statischen Dateien erklären die Ablehnung nicht. | Offen. Kein automatischer Wechsel zum Server bei fehlender Extension. |
| Funktioniert Mobile Ende zu Ende? | Lokale Fixtures, Browser-Emulation, Manifest-/Paketprüfung. Keine echte Android-/Safari-Extension-Laufzeit. | Noch offen. Android-/Safari-Pakete bleiben unveröffentlichte Previews. |

Die Positionen der ergänzenden Quellprüfung sind nullbasierte Zeichenpositionen
im gespeicherten UTF-8-Text, keine über Versionen stabilen Funktionsadressen.
Die Hashes im Quellenverzeichnis identifizieren die konkrete Datei.

## Implementierte Änderungen

- Browser-Handshake mit korreliertem Request, bis zu drei Sekunden Wartezeit
  und ausschließlich nicht mutierenden Ping-Wiederholungen. Fehlende,
  ungekoppelte und veraltete Extension werden unterschieden. Keine automatische
  Server-Vorbereitung wegen eines ausgebliebenen Pings.
- Android Firefox und Safari erhalten eigene Preview-Manifeste und Packaging.
  Mobile aktiviert Vinted im Vordergrund; verworfene Tabs müssen vor dem Start
  wieder erreichbar sein. Safari verwendet keinen Refresh aus dem
  Extension-Netzwerk als Ersatz für den Vinted-Tab.
- Mobile meldet `automaticPayment=false`. Dashboard und Extension stoppen
  diesen Modus vor Zahlungs-Claim und Checkout-Mutation; eine bestehende
  Desktop-Auto-Payment-Einstellung hebt das nicht auf.
- Browser- und Server-Checkout senden numerische IDs. Eine fehlende oder
  ungültige ausdrücklich zugeordnete Transaktions-ID beendet die Vorbereitung
  vor dem Build. Kein Ersatz durch Konversations-, Artikel- oder sonstige ID.
- Account-Validierung benötigt geschützten Lesezugriff und ein passendes
  Profil. Öffentliche Profildaten oder JWT-Inhalt allein gelten nicht mehr als
  gesunde Anmeldung. Neue Browser-/Account-Daten übernehmen keinen fremden
  Cookie-/CSRF-Kontext; Refresh-Verantwortung bleibt eindeutig.
- Account-Refresh erfolgt nur nach Authentifizierungsfehlern, ein Refresh-POST
  wird bei unklarem Ausgang nicht wiederholt. Fehler unterscheiden Status und
  Checkout-Phase ohne private Upstream-Antworten oder Token-Präfixe zu loggen.

Die Umsetzung verwendet eigene Vintrack-Implementierungen und synthetische
Antworten; Vinteds fremder Anwendungscode wird nicht in Vintrack eingebettet.
Keine Datenbankmigration und keine neuen Umgebungsvariablen erforderlich.
Die Extension-Version und ihre Anzeige-Defaults sind auf `0.4.1` angehoben.
Falls die GitHub-Variable `BROWSER_EXTENSION_LATEST_VERSION` gesetzt ist, muss
der Nutzer sie vor seiner späteren Veröffentlichung ebenfalls auf `0.4.1`
setzen. Der Release-Workflow prüft diese Übereinstimmung; es wurde keine
GitHub-Variable geändert und kein Release gestartet.

## Lokale Validierung und verbleibende Arbeit

Die genauen Testkommandos und Ergebnisse stehen in der
[Mobile-Anleitung](mobile-checkout.md). Es wurden heute ausschließlich
öffentliche Dateien gelesen und lokale Tests ausgeführt. Kein Account-Link
geändert, kein neuer echter Checkout-/Payment-Request, kein Deployment und
keine Store-Veröffentlichung.

Vor einer Mobile-Beta bleiben mehrere unabhängig widerrufbare Geräte-Links,
eine vollständige Wiederaufnahme über iOS-Unterbrechungen und echte Läufe auf
beiden Handys erforderlich. Aktuell ersetzt eine neue Browserkopplung die
bisherige; dafür wurde in diesem Paket keine Migration gebaut. Bestehende
lokale Replay-Sperren sind keine plattformübergreifende Jobverwaltung.

Der nächste Lauf sollte zuerst den tatsächlich vom nativen Kaufbutton gewählten
Endpunkt passiv erfassen und anschließend einen autorisierten Prepare-Test
vor Zahlung durchführen. Ein 403 wird nicht durch alternative Identitäten,
Proxies oder wiederholte mutierende Requests umgangen. Heute wurden auf Wunsch
des Nutzers keine weiteren echten Checkout-Versuche durchgeführt.
