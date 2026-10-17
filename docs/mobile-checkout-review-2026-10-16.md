# Mobile Checkout: Architekturprüfung und Testplan

Stand: 16. Oktober 2026. Prüfung des lokalen Checkout-Codes auf `dev`
(`e3a4e2a`) einschließlich der noch unveröffentlichten Mobile-Preview-Änderungen.
Diese Bewertung enthält keine neue Live-Vinted-Prüfung. Die unten genannten
Live-Ergebnisse stammen aus der bereits dokumentierten Desktop-Untersuchung.

Nachtrag: Die anschließend ausdrücklich freigegebene neue Server-Prüfung vom
16. Oktober ist im [Token-Machbarkeitsbericht](checkout-token-feasibility-2026-10-16.md)
dokumentiert: geschützter Account-Lesezugriff erfolgreich, erster Checkout-POST
mit HTTP 403 abgelehnt. Kein Payment und kein Retry.

Umsetzungsstand vom 17. Oktober: Handshake, Verzicht auf automatischen
Server-Fallback, Mobile-Auto-Payment-Sperre, Vordergrund-Tabs und separate
Preview-Pakete sind implementiert und lokal geprüft. Mehrgeräte-Kopplung und
vollständige Wiederaufnahme nach iOS-Unterbrechungen bleiben offen. Die
folgenden Befunde dokumentieren den Ausgangszustand; aktuelle Änderungen und
REA-Evidence stehen im [Rekonstruktionsbericht](checkout-rea-2026-10-17.md).

## Empfehlung

Den Checkout weiter in der Vinted-Browsersitzung des Nutzers ausführen:

- Android: Firefox mit der Vintrack-Extension.
- iPhone: Safari mit einer Safari Web Extension, zunächst lokal über Xcode;
  TestFlight erst mit Apple-Developer-Mitgliedschaft und passender Signierung.
- Ein gemeinsamer Checkout-Kern; Unterschiede bei Berechtigungen, Tabs,
  Lebenszyklus und Verpackung über Plattformadapter behandeln.
- Zuerst Checkout vorbereiten und in Vinted zur Zahlungsbestätigung öffnen.
  Automatisches Bezahlen separat und je Plattform freigeben.

Die vorhandene Request-basierte Vorbereitung im Vinted-Tab muss dafür nicht
durch Klick-Automation ersetzt werden. Ändern sollten wir die Koordination:
mehrere gekoppelte Geräte unterstützen, den ausführenden Browser ausdrücklich
bestimmen und einen begonnenen Versuch nach Unterbrechungen wiederfinden.

Das ist eine technische Empfehlung, noch kein Nachweis für mobile
Ende-zu-Ende-Funktion. Insbesondere Safari-Laufzeit, Store-Berechtigungen und
Zahlungsübergaben müssen auf echten Geräten geprüft werden.

## Was bereits existiert

Der sichtbare Vintrack-Handoff lädt das Ziel und prüft Anmeldung,
Monitor-Zugehörigkeit, verknüpften Account, Checkout-Einstellungen und Einwilligung.
GET, Link-Vorschau und versteckte beziehungsweise vorgerenderte Seiten sollen
keine Checkout-Mutation auslösen.

Die Extension prüft den tatsächlich im Vinted-Tab angemeldeten Account vor der
ersten Mutation. Sie bereitet Transaktion und Checkout vor, übernimmt angebotene
Liefer- und Zahlungsoptionen und öffnet den Vinted-Checkout. Sie speichert lokal
einen Versuch vor der Mutation und das Ergebnis vor der Navigation.

Optionales Auto-Checkout hat zusätzliche Einwilligung, Betragsgrenze und einen
dauerhaften serverseitigen Zahlungs-Claim. Nach einem unklaren Extension-Ergebnis
wechselt der Client bereits heute nicht automatisch zu einem zweiten Executor.
Diese Eigenschaften sollten erhalten bleiben.

Die Mobile-Previews enthalten Android-/Safari-Manifeste, ein anpassbares Popup
und die Aktivierung des Vinted-Tabs auf Mobile. Sie sind noch nicht auf einem
Handy Ende zu Ende geprüft und nicht als mobile Veröffentlichung anzusehen.

## Konkrete Befunde

### 1. Die Browser-Kopplung unterstützt aktuell nur einen dauerhaften Link pro Nutzer

`Manager.CreateBrowserLink` entfernt den bisherigen Redis-Link, bevor es einen
neuen anlegt. Die dauerhafte Tabelle `vinted_browser_links` verwendet `userId`
als Primärschlüssel; `SaveBrowserLink` ersetzt bei Konflikt den Token-Hash.
Reguläres Neukoppeln am Handy ersetzt damit die PC-Kopplung.

Auch `vinted_sessions` hat nur einen Datensatz pro Nutzer. Browser-Sync und
Checkout dürfen daher nicht voraussetzen, dass ein serverseitig vorhandener
Account eine Anmeldung im aktuellen Handy-Browser beweist.

**Vor einer allgemeinen Mobile-Beta:** separat widerrufbare Geräte-Links mit
eigenem Token und Geräte-ID einführen. Den gemeinsamen verknüpften
Vinted-Account beibehalten, Browser-/Sitzungsherkunft ausdrücklich zuordnen und
fremde Accounts nicht still übernehmen. Bestehende Kopplungen migrieren.
Mehrere Geräte dürfen sich beim Koppeln nicht gegenseitig abmelden. Für
serverseitige Account-Aktionen muss die verwendete Sitzung eindeutig bleiben;
Cookies verschiedener Geräte dürfen nicht zu einer Sitzung vermischt werden.

Quellen im Code: `apps/vinted-service/internal/session/session.go:473`,
`apps/vinted-service/internal/session/postgres.go:250`,
`apps/control-center/prisma/schema.prisma:883` und `:913`.

### 2. Langsame Extension-Erkennung wählt den Server-Checkout

`hasCheckoutExtension` beendet die Erkennung nach 750 ms. Ein Timeout, eine
nicht konfigurierte Extension und eine tatsächlich fehlende Extension werden
alle als `0` behandelt. Anschließend startet `startCheckout` den Server-Pfad.

Mit dem unveränderten TypeScript-Client in einer isolierten VM und ausschließlich
synthetischem `window`, Extension-Bridge und `fetch` reproduziert:

| Zeitpunkt der READY-Antwort | Beobachteter Ablauf |
| --- | --- |
| 10 ms | Ziel-GET → Extension-Prepare → Checkout-History-POST |
| 900 ms | Ziel-GET → Server-Prepare-POST → Server-Navigation |

Der History-POST im ersten Fall ist keine zweite Checkout-Vorbereitung. Der
zweite Fall belegt die falsche Pfadwahl bei verspäteter Antwort; er misst keine
reale Handy-Startzeit.

**Änderung:** Handshake mit korreliertem Request und getrennten Zuständen für
bereit, Berechtigung fehlt, nicht verbunden und nicht beantwortet. Begrenzte
Wiederholungen dürfen nur die nicht mutierende Erkennung betreffen. Bei
unklarem Browserstatus Hilfe zum Öffnen/Koppeln anbieten. Ein längerer Timeout
allein löst die falsche Gleichsetzung nicht. Server-Ausführung darf nicht allein
aus einem ausgebliebenen Ping folgen.

Quelle: `apps/control-center/src/lib/open-checkout.ts:19` und `:286`.

### 3. Auto-Checkout benötigt die Ausgangsseite nach dem mobilen Tab-Wechsel

Der Client sendet zuerst `readinessOnly`. Die Mobile-Preview aktiviert dabei
bereits Vinted. Erst nach dessen Antwort fordert die nun im Hintergrund liegende
Vintrack-Seite den Zahlungs-Claim an und sendet den eigentlichen Kaufauftrag.

Das ist eine durch Code belegte Abhängigkeit. Ein tatsächliches Einfrieren
wurde hier nicht auf einem iPhone beobachtet. Apple verlangt auf iOS aber
nicht persistente Extension-Hintergründe; weder eine versteckte Webseite noch
eine Background-Promise ist eine verlässliche dauerhafte Jobverwaltung.

**Änderung:** Der Handoff muss vor dem Verlassen der Ausgangsseite einen
vollständigen, validierten Auftrag dauerhaft annehmen. Nach Aktivierung von
Vinted soll dessen Vorbereitung nicht von weiteren JavaScript-Schritten im
Vintrack-Tab abhängen. Persistierter Zustand und Wiederaufnahme sind trotzdem
erforderlich; das bloße Verschieben in `background.js` genügt nicht.

Beim späteren Auto-Payment muss der serverseitige Claim weiter vor jeder
Zahlungsabgabe liegen. Bei unklarem Ausgang wird geprüft beziehungsweise zur
manuellen Fortsetzung übergeben, nicht erneut bezahlt.

Quellen: `apps/control-center/src/lib/open-checkout.ts:147`,
`apps/vintrack-browser-sync-extension/background.js:1358`;
[Apple: Lebenszyklus von Safari-Erweiterungen](https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari).

### 4. Die Preview übernimmt vorhandene Auto-Payment-Einstellungen

Der aktuelle Handshake meldet eine Protokollnummer. Eine ausdrückliche
Plattformfreigabe für mobile Zahlungen fehlt. Der mobile Build verwendet den
bisherigen Auto-Checkout-Code und bestehende Account-Einstellungen weiter.
Die Dokumentation bittet zwar, Auto-Payment für Gerätetests auszuschalten;
das ist keine technische Sperre.

**Änderung:** Fähigkeiten wie `prepareCheckout`, `autoPay` und
`resumableCheckout` getrennt melden und prüfen. In der ersten Mobile-Beta
`autoPay=false` durchsetzen, bevor ein Zahlungs-Claim oder eine Mutation
gestartet wird. Vorhandene Desktop-Einstellungen dürfen diese Sperre nicht
übergehen. Nutzer erhalten eine klare Möglichkeit zur manuellen Bestätigung.

Quellen: `apps/control-center/src/lib/open-checkout.ts:33` und `:147`,
`apps/vintrack-browser-sync-extension/background.js:1520`.

### 5. Die Wiederaufnahme ist lokal und teilweise zeitlich begrenzt

Der normale Prepare-Versuch bleibt lokal zehn Minuten gespeichert;
Auto-Payment-Versuche werden länger behalten. Zwei Geräte teilen diese lokale
Liste nicht. Der vorhandene serverseitige Auto-Payment-Claim schützt einen
anderen Bereich und sollte erhalten bleiben.

**Änderung:** Geräteübergreifende Versuchs-ID mit eindeutigem Executor und
Status ergänzen. Beispielzustände: angenommen, vorbereitet, Nutzeraktion
erforderlich, Ergebnis unklar, abgeschlossen. Ein bestehender Checkout wird
wieder geöffnet; ein verschwundenes Ergebnis wird nicht durch erneutes
Absenden ersetzt. Ablaufzeiten dürfen eine unklare Zahlung nicht freigeben.
Das verhindert automatische Doppelversuche, garantiert aber keine universelle
„exactly once“-Ausführung bei einem externen Zahlungsanbieter.

Quellen: `apps/vintrack-browser-sync-extension/background.js:1430`, `:1471`,
`apps/vinted-service/internal/api/checkout.go:113` und
`apps/vinted-service/internal/session/checkout.go`.

## Vergleich der möglichen Ansätze

### Ergänzung: einmal Token hinterlegen

Der Nutzer erinnert an ältere Bots mit einmaliger Token-Eingabe. Das ist eine
plausible Bedienoberfläche für serverseitige Sitzungsverwaltung; welche Art von
Token diese Bots verwendeten und welche zusätzlichen Sitzungsdaten sie selbst
erzeugten, ist ohne konkretes Produkt nicht bekannt.

Unser Service akzeptiert bereits Access-/Refresh-Token und Sitzungskontext.
Ein Access-Token hat eine ausgewertete Ablaufzeit; für nicht browsergebundene
Sitzungen existiert serverseitiges Refresh. Browsergebundene Sitzungen verwenden
diesen Refresh-Pfad ausdrücklich nicht. Ein vorhandener Codepfad ist noch kein
aktueller Live-Nachweis für langfristigen Checkout-Betrieb.

Vor einer größeren Mobile-Implementierung ist deshalb ein begrenzter
Machbarkeitsnachweis des Server-Pfads sinnvoll: Anmeldung, genehmigte
Checkout-Vorbereitung und Wiederholung nach regulärem Token-Refresh getrennt
bewerten; Zahlung anschließend separat. Dafür keine bestehende
Produktionskopplung umstellen. Der bisherige HTTP-409-Test belegt das Scheitern
dieses Versuchs, aber keine allgemeine Unmöglichkeit. Ein erfolgreicher Nachweis
könnte einen browserunabhängigen mobilen Einstieg ermöglichen. Bankfreigaben
bleiben davon getrennt.

Vinteds dokumentierte Pro Integrations API ist nur für freigeschaltete
Pro-Unternehmen zugänglich; in der geprüften Dokumentation ist kein
Käufer-Checkout-Endpunkt beschrieben. Sie ist damit kein belegter Ersatz für
diesen Ansatz. [Offizielle API-Dokumentation](https://pro-docs.svc.vinted.com/).

| Ansatz | Nutzen und Grenzen | Entscheidung |
| --- | --- | --- |
| Firefox Android + Safari iPhone | Nutzt den vorhandenen Checkout-Kern und die echte lokale Browsersitzung. Installation, Berechtigungen und Mobile-Lebenszyklus bleiben zu lösen. | Empfohlener erster Weg. |
| Nur Server-Requests | Könnte beliebige Handy-Browser bedienen. Der bestehende Versuch vom 5. Oktober endete jedoch mit `vinted_security_check`/HTTP 409 und ohne Checkout-Link. | Kein belegter Ersatz; nicht zum automatischen Mobile-Fallback machen. |
| Eigene App mit WebView | Kann eine eigene Vinted-Anmeldung und einen kontrollierten Vordergrund anbieten. Neue Sitzungsverwaltung, Login-, Zahlungs- und Redirect-Integration wären erforderlich. | Spätere Alternative, wenn Browser-/Extension-Einrichtung zu viele Nutzer verliert; zuerst begrenzter Funktionsnachweis. |
| App oder PWA als Einstieg in den Systembrowser | Kann Notifications und Einstieg verbessern. Übernimmt dadurch nicht automatisch Vinted-Zugang oder Extension-Fähigkeiten. | Ergänzung zur empfohlenen Lösung. |
| Handy steuert eine PC-Extension | Wiederverwendung des Desktop-Pfads, aber ein laufender erreichbarer PC wird benötigt. Sitzungs- und Zahlungsübergabe aufs Handy bleiben offen. | Allenfalls eigener Power-User-Modus. |
| Gehosteter Browser pro Nutzer | Zusätzliche persistente Browser, Sitzungen, Betriebskosten und Wiederherstellung. Erfolgreicher mobiler Zahlungsablauf nicht belegt. | Derzeit keine Grundlage für den Hauptpfad. |

Der Server-only-Befund ist ein einzelner dokumentierter Test, keine Aussage,
dass dieser Weg grundsätzlich nie funktionieren kann. Eine belastbare,
unterstützte Checkout-Integration würde die Bewertung ändern; sie ist im
Projekt bislang nicht nachgewiesen. Der ältere iOS-Recon betrifft öffentliche
Katalogdaten und belegt keinen nativen Checkout- oder Payment-Vertrag.

Androids offizielle Dokumentation unterscheidet ausdrücklich zwischen WebViews
mit eigenem Sitzungsbereich und Custom Tabs, die Browser-Sitzungen verwenden.
Die gemeinsame Sitzung allein belegt noch keine Extension-Ausführung in einem
Custom Tab. Deshalb sind die tatsächlichen Telegram-/Discord-Einstiege separat
zu testen.
[Android: WebView und Custom Tabs](https://developer.android.com/develop/ui/views/layout/webapps/in-app-browsing-embedded-web).

## Plattformen und Nutzerablauf

Android zunächst auf Firefox konzentrieren. Chrome auf Smartphones unterstützt
laut Google keine Web-Store-Erweiterungen. Firefox Android unterstützt
Erweiterungen, hat aber eigene API- und Berechtigungsgrenzen. Unser Event-Page-
Build passt zur fehlenden Background-Service-Worker-Unterstützung; erfolgreiche
Manifest-Prüfung ersetzt trotzdem keinen Installations- und Gerätetest.
[Google](https://support.google.com/chrome_webstore/answer/1698338?hl=en),
[Mozilla](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/).

Auf dem iPhone Safari verwenden. Firefox für iOS führt Firefox-Add-ons nicht
aus. Der vorhandene Preview-Build zielt auf Safari/iOS 18 oder neuer; das bleibt
eine zu prüfende Mindestversion, keine bereits verifizierte Supportzusage.
[Mozilla: Firefox für iOS](https://support.mozilla.org/en-US/kb/add-ons-firefox-ios).

Apple bietet neben lokalem Xcode-Packaging inzwischen das Hochladen der
Extension-Ressourcen in App Store Connect und die anschließende TestFlight-
Verteilung an. Dafür sind eine Apple-Developer-Mitgliedschaft und passende
Teamrechte erforderlich. Das Verpacken in der Cloud ersetzt die Debugging-
und Laufzeitprüfung auf einem iPhone nicht.
[Apple: App Store Connect Packaging](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect).

Gewünschter Nutzerablauf: Extension einmal installieren und freigeben, Vintrack
und Vinted im unterstützten Browser anmelden, dieses Gerät koppeln und den
Einrichtungstest bestehen. Anschließend öffnet der Alert-Link dort den
vorbereiteten Checkout. Anmeldung nur in der nativen Vinted-App genügt nicht.
Ungeeignete eingebettete Browser erhalten eine verständliche Browser-Übergabe.
Universal-/App-Links, Custom Tabs und Home-Screen-Starts sind eigene Testfälle;
deren Verhalten wird nicht aus der Browsermarke abgeleitet.

„Oneclick“ sollte dabei präzise Checkout-Vorbereitung bedeuten. 3-D Secure,
PayPal-Freigaben, fehlende Adressen oder Vinteds Sicherheitsprüfung können
weitere Nutzeraktionen erfordern. Automatisches Bezahlen bleibt ein separater
Modus mit eigener Gerätefreigabe.

## Umsetzung in drei Paketen

1. **Gemeinsame Grundlage:** mehrere Geräte koppeln und gezielt widerrufen;
   Capability-Handshake; klare Browser-Erkennung ohne stillen Server-Start;
   Mobile-Auto-Payment-Sperre; serverseitige Versuchszuordnung und Status.
   Bestehende Desktop-Kopplungen und globale Zahlungs-Claims erhalten.
2. **Mobile Prepare-Beta:** ein vor dem Tab-Wechsel vollständig angenommener
   Auftrag; Vinted im Vordergrund; Wiederaufnahme und klare Fehlerzustände;
   Einrichtungshilfe. Beide Plattformen entwickeln, Android als ersten
   vollständigen Funktionsnachweis nutzen und Safari früh auf dem Gerät prüfen.
   Keine öffentliche Freigabe allein aufgrund von Desktop-Tests.
3. **Zahlungsübergaben und begrenzte Beta:** reale Ein- und Rücksprungpfade
   prüfen, dann Plattform für Plattform freigeben. Auto-Payment erst nach
   separatem Nachweis für Karte/PayPal, Unterbrechungen und globalen Replay-Schutz.

Für Änderungen weiterhin ausschließlich Commit/Push nach `dev`; Deployments
und Store-Veröffentlichungen erfolgen durch den Nutzer.

## Testplan und Freigabekriterien

| Ebene | Fälle | Erwartung |
| --- | --- | --- |
| Lokale Fixtures | READY nach 0/750/900/3000 ms, fehlende Rechte, ungekoppelt, alte Protokolle | Richtiger Status; kein automatisch gewählter zweiter Executor. |
| Mehrere Geräte | PC koppeln, Handy hinzufügen, ein Gerät widerrufen; gleichzeitiger Start auf beiden Geräten | Andere Kopplung bleibt gültig; ein Versuch wird übernommen; keine doppelte Zahlung. |
| Account und Consent | Falscher Account/Region, abgelaufene Sitzung, anderer Browser, geänderte Vorgaben, fehlende Einwilligung | Keine Mutation vor gültiger Freigabe; keine Credentials zwischen Sitzungen mischen. |
| Mobile-Beta-Sperre | Desktop-Auto-Payment bereits aktiviert; direkter Bridge-Aufruf; fehlende Capability | Kein Zahlungs-Claim und kein Payment-Request auf nicht freigegebenem Mobile-Executor. |
| Tabs | Vinted offen, geschlossen, ladend, verworfen, alter Content-Script-Empfänger | Vordergrund und Bridge bereit vor Mutation; verständliche Wiederherstellung. |
| Unterbrechung | Vintrack nach Übergabe verborgen, Hintergrund neu gestartet, Vinted geschlossen, Display gesperrt, Netzwechsel, Antwortverlust nach POST | Status bleibt nachvollziehbar; unklarer Auftrag wird nicht blind wiederholt. |
| Einstieg | Dashboard, Telegram, Discord, Browser-Link, Custom Tab, nativer Vinted-App-Link | Unterstützter Browser oder klare Übergabe; Link-Preview bleibt ohne Mutation. |
| Vorbereitung | Hauszustellung, gespeicherte Abholstelle, fehlende Adresse, unzulässige/fehlende Zahlart, verkaufter Artikel, 401/429/Challenge | Vinted-Daten bestimmen Optionen; keine erfundenen Raten oder Endlosschleifen. |
| Spätere Zahlung | PayPal-Rückkehr/Abbruch, gespeicherte Karte, 3DS/CVV, App-Wechsel, doppelter Tap | Native Bestätigung und Statusprüfung; keine erneute Zahlung bei unklarem Ausgang. |

Zuerst synthetische Antworten und Fehler injizieren. Playwright mit iPhone-
Viewport oder WebKit beweist Layout und Client-Verhalten, aber weder Safari-
Extension-APIs noch iOS-Suspension. Danach Android per `adb`/`web-ext`, iPhone
per lokal signierter App oder TestFlight testen. Mindestens älteste freizugebende
und aktuelle verfügbare Betriebssystem-/Browser-Version abdecken, einschließlich
eines echten Handys je Plattform; Emulatoren ergänzen diese Läufe.

Reale Prepare-Tests benötigen einen ausdrücklich freigegebenen Account und
Artikel und enden zunächst vor Zahlung. Echte Zahlungstests brauchen eine
eigene Freigabe für Artikel und Budget. Keine Lasttests gegen reale Accounts.

Freigabe erst, wenn alle relevanten Account-, Unterbrechungs- und Replay-Fälle
bestanden sind, bestehende Desktop-Verbindungen erhalten bleiben und beide
Geräte einen vollständigen Alert-zu-Checkout-Lauf zeigen. Danach kleine Beta
mit getrennten Zahlen für Android/Safari, warm/kalt, Erfolgen, notwendigen
Nutzeraktionen und unklaren Ergebnissen. Zeit bis sichtbarer Checkout und
Fehlerphase messen; Cookies, Tokens und vollständige Zahlungsdaten nicht loggen.
Konkrete Latenzziele anhand dieser Messungen setzen.

## In dieser Prüfung tatsächlich ausgeführt

- 91 Extension-Tests erfolgreich (`checkout.test.mjs`, `session-refresh.test.mjs`).
- 48 Control-Center-Checkout-Unit-Tests erfolgreich (`checkout*.test.mts`).
- `go test ./...` in `apps/vinted-service` erfolgreich.
- Mobile-Preview-Pakete neu gebaut; Android-Preview mit `web-ext@10` geprüft:
  keine Fehler, Notices oder Warnungen.
- Den verspäteten READY-Fall mit dem vorhandenen Client-Code und
  ausschließlich synthetischen Antworten reproduziert.

Auf diesem Host fehlt weiterhin `adb`; aktiv sind nur Xcode Command Line Tools.
Safari-Packager/-Converter sind lokal nicht verfügbar. Daher wurden in dieser
Prüfung keine iOS-App kompiliert, keine Extension auf einem Handy ausgeführt und
keine echten Checkout-/Payment-Requests gesendet. Anwendungscode wurde für
diese Bewertung nicht geändert.

Weitere Grundlagen: [Mobile-Preview-Anleitung](mobile-checkout.md) und
[bestehender Checkout-Live-Nachweis](checkout-handoff-recon.md).
