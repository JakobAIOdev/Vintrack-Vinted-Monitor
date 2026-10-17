# Dev vor Main-Merge geprüft — 17.10.2026

Geprüft wurden die Änderungen von `dev` gegen den frisch geladenen
`origin/main` (`8477591`), einschließlich Checkout/Extension und der
Suchbeschleunigung aus `9f44255`. Der aktuelle Main-Stand wurde mit
`83a8776` konfliktfrei in `dev` integriert. Die Release-Version bleibt 2.7.3.

## Review

Keine offenen Merge-Blocker im geprüften Code gefunden. Kontrolliert wurden:

- Cache-Queue und Memory-Fast-Path, Fristen, Shutdown und unveränderte
  Verkäufer-/Länderfilter; Discovery-Baseline, Duplikate, Pagination und 429.
- Checkout-Accountprüfung, explizite Transaktions-IDs, Browser-Herkunftsprüfung,
  fehlende/veraltete Extensions ohne automatischen Executor-Wechsel,
  Replay-Schutz und bereinigte Fehlermeldungen.
- Session-Kontextwechsel, Refresh nur bei Authentifizierungsfehlern und
  kein Wiederholen eines möglicherweise bereits ausgeführten Refreshs.
- Extension-Version 0.4.1 in beiden Manifesten und den beworbenen Defaults.

Es gibt gegenüber Main keine neue Prisma-Migration oder erforderliche neue
Produktionsvariable. Die Cache-Queue-Worker und bestehenden Fristen bleiben
begrenzt. Neue Items vor Vinteds Suchindex zu erkennen ist weiterhin nicht
nachgewiesen; diese Prüfung ist keine Produktions-Latenzmessung.

## Bei der Prüfung behoben

1. Native Firefox-Tests prüfen einen Tab erst nach beobachtetem
   Navigationsabschluss, statt eine sofort aktualisierte URL vorauszusetzen.
2. Die Onboarding-Fixture stellt synthetische Proxy-Health für die sieben
   Starterregionen bereit. Der Frankreich-Importtest hatte zuvor nur eine
   deutsche Fixture und scheiterte korrekt an der Regionalprüfung.
   Der Test prüft jetzt zusätzlich die gespeicherte Region und Proxyquelle.
3. Modal-Tests tolerieren maximal einen CSS-Pixel Differenz während der
   Öffnungsanimation. Sie prüfen weiterhin Position und beide Abmessungen.
4. `npm run test:types` prüft Anwendungs- und Test-TypeScript mit einer
   separaten Konfiguration für Node-Tests: ES2020, `.ts`-Imports und keine
   Root-Dateien aus wechselnden Next-E2E-Buildverzeichnissen. Window-Fixtures
   und Header-Testdaten sind korrekt typisiert. Nexts Build blendet
   Testdatei-Diagnosen aus; die zusätzliche Prüfung ist daher jetzt in CI und
   `scripts/test-all.sh` enthalten. Sie wurde auch ohne generierte
   `next-env.d.ts`-Deklarationen geprüft.
5. Die bisher ausgelassene Account-Automations-Suite gehört jetzt zum
   regulären Dashboard-E2E-Lauf. Ihre Screenshots landen standardmäßig in
   den Testartefakten; `E2E_UPDATE_DOC_SCREENSHOTS=true` aktualisiert bewusst
   die Dokumentationsbilder.

## Verifikation

Für Integration und Browser wurde ausschließlich eine temporäre lokale
PostgreSQL-/Redis-Umgebung verwendet, mit getrennten Datenbanken für Worker,
Account-Service und Dashboard. Die Migrationen wurden in allen drei leeren
Datenbanken erfolgreich angewendet. Kein vorhandener Anwendungsdatenbestand,
kein echtes Vinted-Konto und kein externer Zahlungsvorgang wurde verändert.
Die nativen Browser-Tests verwenden lokale HTTPS-Fixtures, einen Testproxy,
eigene Browserprofile und synthetische Cookies.

| Prüfung | Ergebnis |
| --- | --- |
| Worker `go test -count=1 ./...`, `go vet ./...` | Erfolgreich |
| Worker `go test -race -count=1 ./...` mit PostgreSQL-/Redis-Integration | Erfolgreich |
| Neue Worker-Queue-/Discovery-/Fristtests mit Race-Detector, 10 Wiederholungen | Erfolgreich |
| Account-Service Tests, `go vet`, vollständiger Race-Lauf inklusive Session-/Automations-Integration | Erfolgreich |
| Frontend `npm run test:unit` | 250 bestanden |
| Frontend `npm run test:types`, Lint | Erfolgreich |
| Frontend `npm run build` | Erfolgreich |
| Prisma-Validierung und Migrationen | Erfolgreich |
| Öffentliche E2E inkl. Checkout auf Desktop/Mobile sowie SEO-Varianten | 112 bestanden |
| Dashboard-E2E inkl. Account-Automationen auf Desktop/Mobile | 139 bestanden, 11 absichtlich übersprungen |
| Own-Proxy-E2E | 10 bestanden |
| Onboarding-E2E | 5 bestanden |
| Native Extension-Prüfung Chromium und Firefox | Erfolgreich |
| Extension-Manifest-/Laufzeitprüfungen und Paketbau | Erfolgreich |
| Firefox-Paketlint | 0 Fehler, 0 Warnungen |
| Konfigurations-Unit-Tests | 4 bestanden |
| Python-Tests | 7 bestanden |
| Produktions-/Entwicklungs-Compose-Konfiguration, `git diff --check` | Erfolgreich |

Die elf absichtlich übersprungenen Dashboard-Fälle vermeiden überwiegend
doppelte globale Mutationen im mobilen Projekt; die entsprechenden
Desktop-Prüfungen werden ausgeführt. Die lokalen Dienste werden nach der
Verifikation entfernt. Reale Vinted-Erreichbarkeit und Produktionslast sind
durch diese lokalen Tests nicht abgedeckt. Vorhandene ungetrackte
Untersuchungsdateien bleiben außerhalb des Commits.
