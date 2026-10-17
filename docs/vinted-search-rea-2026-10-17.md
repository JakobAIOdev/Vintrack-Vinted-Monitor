# Vinted-Suche und Vintrack: REA-Untersuchung vom 17.10.2026

Auf `codex/vinted-search-speed` sind drei konkrete Verbesserungen implementiert:
Verkäufer-Cache-I/O blockiert den Suchzyklus nicht mehr, Redis respektiert die
vorgesehenen Context-Deadlines, und Discovery verarbeitet die neueste Seite vor
älteren Folgeseiten. Ein schnellerer öffentlicher Vinted-Index ist mit den
verfügbaren Daten **nicht nachgewiesen**. Es gibt keine gemessene Aussage
„Upload bis Alert jetzt X Sekunden schneller“.

## Was REA tatsächlich untersucht hat

REA 6.5.0 wurde über die CLI ausgeführt. Der Skill allein stellt hier keine
verbundene MCP-Instanz bereit; `doctor --client codex --json` meldete eine
fehlende Registrierung. Für die Offline-HAR-Auswertung war keine Änderung
der Codex-Konfiguration und kein nativer Disassembler erforderlich.
Die aktuelle iOS-App wurde nicht gestartet oder dekompiliert.

Original: `Vinted Ios.har`, 6.687.169 Bytes, 79 Einträge vom **30.03.2026**.
SHA-256: `9fa7421ee865755a7d5be57befed7a780b68f1cbdd30c0bda6081b9b37557943`.
Die erfasste App meldet Vinted iOS 26.11.1, Build 30221, FR-Host.

REA lehnte das Original wegen eines ungültigen Cookie-`expires`-Datums ab.
Deshalb erzeugt `scripts/vinted-rea-har-projection.py` eine abgeleitete,
streng reduzierte HAR: keine Cookies, Zugangsdaten, Request-Bodies oder
Such-/Homepage-Sitzungs-IDs; nur erlaubte Suchparameter und Header.
Antwortinhalte werden auf öffentliche Item-ID, `content_source` und
`promoted` reduziert. Uninteressante URLs und Inhalte werden entfernt.
Eintragsreihenfolge und aufgezeichnete HTTP-Zeiten bleiben erhalten.
Die Größenangaben stammen weiter vom Original, nicht von den reduzierten Bodies.
Das Original wurde nicht verändert oder für Requests wiederverwendet.

Die [gespeicherte Evidence](vinted-search-rea-evidence-2026-10-17.json) enthält
das vollständige REA-Ergebnis für die ausgewählten Originalordinale
20, 22, 43 und 60, einschließlich Grenzen der Aussagekraft.
Evidence-ID:
`ev_619b2ba12a85d002c290819a4d0e06d2e25ed43c4ba967475919fac43f279b50`.
REA klassifiziert dies als `observed`, `historical-reference`,
Runtime-Zuordnung `unknown`: Beobachtet ist der Mitschnittinhalt, keine heutige
Ausführung und keine bestätigte Serverarchitektur.

| Originalordinal (ab 0) | Route auf www.vinted.fr | Ergebnis | HTTP-Zeit |
| --- | --- | --- | ---: |
| 20 | `/api/v2/homepage` | 200, Konfigurationsantwort | 75,101 ms |
| 22 | `/api/v2/homepage/all` | 200, 10 Items, `vinted_picks` | 202,407 ms |
| 43 | `/api/v2/catalog/items` | 200, 24 Items, davon 17 beworben | 750,462 ms |
| 60 | `/api/v2/catalog/items` | 200, 24 Items, davon 19 beworben | 680,569 ms |

Beide Suchrequests verwenden `order=relevance`, `catalog_ids=1907`,
`per_page=24`, `page=1`, `currency=EUR`; der zweite zusätzlich `brand_ids=12`.
Die Homepage-Auswahl ist weder gleich gefiltert noch chronologisch vollständig.
Ihre kürzere HTTP-Zeit belegt keine frühere Verfügbarkeit derselben neuen Items.
Der Mitschnitt enthält keine parallele `svc-catalogue`-Baseline, keine
`newest_first`-Suche und keine verifizierten Veröffentlichungszeitpunkte.

## Vergleich mit unserer Suche

| Eigenschaft | iOS im historischen HAR | Aktueller Worker im Repository |
| --- | --- | --- |
| Katalog | `www.vinted.fr/api/v2/catalog/items` | `api.<region>/svc-catalogue/items` |
| Sortierung | Relevanz, viele beworbene Items | `newest_first` |
| Filter | Kategorie, optional Marke | Suchtext und strukturierte Attribute |
| Ergebnisfenster | 24 Items | standardmäßig 20, über `VINTED_PER_PAGE` konfigurierbar |
| Abfrageabstand | zwei unterschiedliche Suchen, kein Pollversuch | standardmäßig 1500 ms plus 0–100 ms Jitter, zyklusbezogen |
| Mehrere Suchbegriffe | nicht untersucht | Round-robin: N Alternativen benötigen ungefähr N Pollintervalle |
| Zusätzliche Erkennung | personalisierte Homepage | vorhandene gemeinsame Discovery ohne Suchtext, lokal gefiltert |

`url_builder.go`, `query.go`, `engine.go` und `discovery.go` sind die
Quellen für die Worker-Spalte. Discovery bleibt separat über Worker-Policy
steuerbar; der Branch aktiviert sie nicht. Aktuelle Deployment-Einstellungen
konnten nicht gelesen werden: PostgreSQL-MCP meldete
`ECONNREFUSED 127.0.0.1:5435`. Alte Telemetrie ist keine heutige Baseline.

Ein öffentlicher GET zur aktuellen DE-Route wurde am 17.10.2026 um
09:34:18 Europe/Berlin mit passenden Regionalheadern und TLS-Profil
`chrome_146` ausgeführt, ohne Account-Credentials oder Cookie-Sitzung.
Ergebnis: **403**, HTTP/2, 94 ms, JSON `FORBIDDEN / Access denied.`,
48 Bytes, keine Redirects, vollständig, `Cf-Cache-Status: DYNAMIC`,
`Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`.
Danach wurde dieser Live-Pfad beendet. Dies misst eine Ablehnung und liefert
keinen erfolgreichen Fetch-Benchmark; normales Session-Bootstrap-Verhalten
bleibt damit ungetestet. Die Probe ist ebenfalls in der Evidence-Datei enthalten.

## Wie neue Items früher auffindbar sein könnten

Es sind zwei verschiedene Wartezeiten zu unterscheiden: Vinted muss ein Item
an einem Auslieferungspfad sichtbar machen; anschließend muss Vintrack es
abfragen, verarbeiten und zustellen.

[Vinted beschreibt seine Suchindexierung](https://vinted.engineering/2023/09/25/search-indexing-pipeline/)
als CDC-/Flink-Pipeline aus Änderungen an Quelldaten. Der Bericht von 2023
nennt Sichtbarkeit neuer Items innerhalb einer Minute nach der damaligen
Migration. Das ist keine heutige Messung oder zugesicherte Obergrenze.
Schnelleres Polling verkürzt nur unseren Anteil der Wartezeit, nicht die
vorgelagerte Indexierung.

Für die [Homepage-Empfehlungen beschreibt Vinted eine eigene Retrieval-Pipeline](https://vinted.engineering/2023/10/09/adopting-vespa-for-recommendation-retrieval/).
Ein anderer Auslieferungspfad kann andere Sichtbarkeitszeiten haben.
Der HAR bestätigt den Pfad, aber keinen brauchbaren chronologischen
Upload-Feed oder Zeitvorsprung. Dieselbe Einschränkung gilt für hypothetisch
frühere Verkäufer-Garderoben und Item-Details.

| Kandidat | Nutzen und nächster belastbarer Schritt |
| --- | --- |
| Bestehende Discovery ohne Suchtext | Strukturell gefilterte Abfrage kann mehrere Textalternativen gemeinsam bedienen. Gegen gleichregionale kanonische Suche zunächst im Shadow-Modus vergleichen. Kein belegter anderer Index; lokale Titel-/Markenfilter bilden Vinteds Suche nicht vollständig ab. |
| Homepage / nativer iOS-Katalog | Mit regulärem aktuellem Zugriff und identischen Filtern aufnehmen. Der vorliegende Relevanz-HAR reicht nicht für eine Migration. |
| Garderoben bekannter Verkäufer | Gezielter früherer Zugriff denkbar; heutiger Endpoint, Abdeckung und First-seen-Vorsprung fehlen. Begrenzte Verkäuferliste nötig, keine marktweite Lösung. |
| Vorhandener Pre-index-Shadow-Sampler | Früh erreichbare Item-IDs wären interessant, liefern aber noch keine vollständigen kaufbaren Treffer. ID-Reihenfolge und 404 sind kein Beweis für Veröffentlichungsreihenfolge oder fehlende Items. |

Für alle Kandidaten: exakt dieselbe ID, Region und Vergleichszeitfenster
verwenden, Startbestände ausschließen, Pollabstände berücksichtigen und
positive wie negative Leads ausweisen. Fehlgeschlagene Requests zählen nicht
als Abwesenheit. `MAX(id)` und Fotozeitstempel ersetzen keine Beobachtung.
Ein sinnvoller Pilot enthält mindestens 25 exakte Paare sowie unmatched Quote
und Sichtbarkeitsintervalle; Überlappung der Intervalle bleibt unentschieden.

## Implementierte Verbesserungen und praktische Grenzen

1. **Cache-Misses außerhalb des Suchzyklus.** `enqueueItem` prüft nur den
   Arbeitsspeicher synchron. Redis-/Postgres-Lookups laufen über eine Queue
   mit 4096 Plätzen und maximal acht Vorbereitungsworkern. Vollständige
   Memory-Hits umgehen diese Queue und behalten die schnelle Verarbeitung.
   Bisher konnte jede neue Zeile im Suchzyklus auf Cache-I/O warten. Bei 20
   kalten Verkäufern entsprechen schon die vorgesehenen 90 ms je Lookup
   bis zu 1,8 s serieller Wartezeit. Diese Cache-Wartezeit entfällt jetzt im
   Pollpfad, solange die Queue Platz hat; das ist eine Codeableitung und kein
   gemessener Produktionsgewinn. Backpressure bei voller Queue bleibt bestehen.
   Länder-/Bewertungsfilter werden weiterhin vor Freigabe geprüft.

2. **Redis-Deadlines wirksam gemacht.** go-redis v9.17.3 ignorierte bei der
   bestehenden Konfiguration Context-Deadlines für Socket-I/O
   (`ContextTimeoutEnabled` standardmäßig false); der Socket-Timeout betrug
   drei Sekunden plus mögliche Retries. Der Client respektiert jetzt explizite
   Deadlines. Ein lokaler RESP-Testserver beantwortet den Handshake, hält aber
   GET offen: Der Verkäufer-Lookup beendet sich mit einer 50-ms-Deadline,
   bevor die 500-ms-Testgrenze erreicht ist. Kürzere Cache-Budgets bedeuten
   bei langsamer Infrastruktur mehr Cache-Misses; bestehende Fallbacks bleiben.
   Die Einstellung gilt für alle explizit zeitbegrenzten Worker-Redis-Operationen.

3. **Discovery liefert Seite 1 vor Backfill aus.** Zuvor wurden bis zu zwei
   ältere Seiten geladen, bevor irgendein neues Item verarbeitet wurde.
   Jetzt folgen Matching und Erkennung unmittelbar auf jede erfolgreiche
   Seite. Bei den Standardbudgets entfällt für die neueste Seite das Warten
   auf potenziell zwei weitere Requests (je 2 s, bei Free-Discovery je 3 s).
   Diese Budgets sind keine gemessenen Einsparungen; der Vorteil besteht nur
   bei aktiver Discovery und fehlender Überschneidung zur vorigen Seite.
   Anzahl und Reihenfolge der Backfill-Requests bleiben im Normalbetrieb erhalten;
   Cancellation beendet unnötige Folgerequests.

Normalen Alerts bleibt ihre bestehende Anreicherungsfrist von standardmäßig
4,5 s erhalten; strenge Filter erhalten keinen ungeprüften Fallback.
Die Frist startet vor Cache-Queueing. `enqueuedAt` enthält jetzt auch die
Vorbereitungszeit, und `seller_enrichment_metrics` erhält zusätzlich
`cacheQueueDepth` und `cacheQueueCapacity`.
Keine Schemaänderung, kein neuer Env-Schalter und kein Deployment erforderlich,
um die Codeänderung zu prüfen. Für Produktionswirkung muss der Worker mit
diesem Stand neu gebaut und ausgerollt werden.

## Reproduktion und Prüfung

Nur lokale Offline-Projektion und REA-Auswertung, ohne Requests:

```sh
python3 scripts/vinted-rea-har-projection.py 'Vinted Ios.har' /tmp/vintrack-search.har
npx -y rea-agents@6.5.0 inspect-web-network-capture /tmp/vintrack-search.har har \
  --record 20 --record 22 --record 43 --record 60 --format json
```

Die Projektion verweigert Überschreiben. Ein anderer Dateipfad kann die
REA-Evidence-ID verändern; der Inhalts-Hash und die Originalordinale dienen
dem Abgleich. Keine HAR oder Credentials ins Repository aufnehmen.

Regressionstests prüfen blockierten Backfill, Baseline, Duplikate,
Seitenbegrenzung, Fehler/429, Cancellation, Cache-Queue-Backpressure,
Memory-Hits trotz voller Queue, unveränderte strenge Gates und die
Alert-Frist trotz nicht gestarteter Cache-Worker. Projektionstests prüfen
Credential-Entfernung einschließlich verschachtelter Bodies und
Unverändertheit der Eingabe.

```sh
cd apps/worker
go test ./...
go vet ./...
go test -race ./internal/cache ./internal/scraper/...
cd ../..
python3 -B -m unittest discover -s scripts -p '*_test.py'
```

Die Tests sind deterministisch gegenüber Vinted; der Redis-Fristtest nutzt
nur einen lokalen Testserver. Datenbank-/Redis-Integrationstests mit expliziten
Integration-Env-Variablen bleiben ohne diese Variablen übersprungen.
Alle aufgeführten Prüfungen waren erfolgreich; die Python-Suite umfasst sieben Tests.
