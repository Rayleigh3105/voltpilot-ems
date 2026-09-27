# Prüfumgebung Ahrenberg (AP-20 IP-13, E5, PD1, PD2)

Die Bühne für den Pilot-Auditdurchlauf PA-1 (IP-14): die Welt der Referenzdatei 1.10 im Kundenbereich
Ahrenberg eines lokalen Stapels, dazu ein befristetes Konto mit der Rolle „Einsicht“ für die Fachperson.
Die Umgebung für die Fachperson erreichbar machen (Adresse, Portal, Zugangsweg) ist Hand des Betreibers.

## Seed-Weg: der Welt-Aufbau der Abnahme, nicht ein gehobener SQL-Seed

- `infra/local/seed/ahrenberg.sql` bleibt Fassung 1.4 (Standorte, Orte, Anlagen, Personen, Zuweisungen;
  `DevSeedGuardTest` unverändert). Darauf baut `AhrenbergWelt` (Testquellen, aus
  `UemsEnergiemanagementAbnahmeTest` herausgelöst) im Ziel `SEED` die Welt 1.10 über dieselben Routen und
  direkten Stände wie die Abnahme — Prüfsummen, „entschieden von“ und Beschlüsse entstehen im Produkt,
  nichts ist abgeschrieben. Ziel `NEU` ist unverändert die Abnahme (eigener Kundenbereich, Kürzel als Subject).
- Ein SQL-Seed 1.10 hätte Prüfsummen, Abzüge und Kopien von Hand erfinden müssen (§8.5 „gelesen, nicht
  ausprobiert“ — geprüft: nicht ohne Umbau).
- `SEED` legt nur an, was 1.4 nicht trägt: MS-20, BZ-1, Geräte an AN-1, das Konto von Robert Falk
  (Subject `…08a6`, ohne Realm-Login) und `zugriffe_1_10`. Es stellt beim Aufbau auch die Uhr von
  `ZugriffKontextLader` (die Zuweisungen des Seeds beginnen am 01.10.2026), danach steht alles auf der Bühne.
- Idempotent (`PruefumgebungAhrenberg`): steht `feststellung_wirksamkeit`, geschieht nichts; ein halber Aufbau
  (Robert Falk da, Wirksamkeit nicht) bricht ab — dann abräumen und neu aufbauen.
- ⚠ Im laufenden Stapel vergibt der Geräte-Bestand der drei Boxen GR-1 … GR-6, bevor die Welt kommt. `SEED` nimmt
  die Nummer der Referenz nur, wenn sie frei ist, sonst `uems_geraet_kennzeichen` (Testcontainers kennt das nicht).
- ⚠ `demo-seed` startet erst bei gesunder api (`service_healthy`) und endet bei einem SQL-Fehler mit Exit-Code ≠ 0.
  Vorher wartete er nur auf `ort_zuordnung`, lief in die laufende Flyway-Kette und meldete trotzdem Erfolg.

## Bühnen-Uhr — eine Zeitachse

- Das Verzeichnis lässt jede Zeile nach „heute“ weg; die Welt läuft bis 30.04.2029. `PruefumgebungUhr`
  (Hauptquellen) stellt beim Start die sieben Uhren der Abnahme UND die der Zuweisungen (`ZugriffBuehnenUhr`) auf
  `voltpilot.pruefumgebung.buehnen-uhr` und lässt sie in echter Zeit weiterlaufen (Versatz, nicht fest) — nur mit
  Profil `local` UND gesetzter Eigenschaft (`docker-compose.pruefumgebung.yml`). Produktion setzt beides nie.
- ⚠ Falle: `KennzahlService` misst die Sichtbarkeit an den Zuweisungen zu SEINEM „jetzt“. Mit echter Uhr für die
  Zuweisungen und Bühnen-Uhr für die Leser war die echte Frist auf der Bühne längst vorbei → `KennzahlAbgelehnt`
  (500) im Verzeichnis (über `EnergiezielService.liste`). Darum zählt die Frist auf der Bühne: letzter Tag =
  Bühnen-Heute + Tage; weil die Bühne in echter Zeit läuft, endet der Zugang nach genau so vielen echten Tagen.

## Bedienen

`infra/local/pruefumgebung/ahrenberg.sh aufbauen | einsicht <email> <tage> [vorname] [nachname] | abraeumen`
(JDK 21 als `JAVA_HOME`). Eigenes Compose-Projekt `voltpilot-pruefumgebung`; bricht ab, wenn ein anderer
Stapel die festen `container_name` belegt. `einsicht` vergibt als Jonas Wendlinger über `POST /api/v1/benutzer`
(der Portal-Weg, PD2) und gibt das einmalige Startpasswort aus. Portal: `frontend/portal`, `npm run dev`.

## Nachweise

`PruefumgebungAhrenbergTest` (Testcontainers): Seed + Welt + Bühnen-Uhr + Einladung wie im Stapel; die vier
Nachweise mit „entschieden von“ und den Prüfsummen der Abnahme, Verzeichnis gleich dem des Kundenadministrators,
jeder schreibende Weg abgelehnt und der Kundenbereich byte-gleich, Zugang nach dem letzten Tag (Bühne) weg.
`PruefumgebungAhrenbergAufbau` ist ein Werkzeug (nur mit `-Dpruefumgebung.jdbc`, sonst übersprungen).

## Demo-Umgebung (dasselbe Aufbauen, das ganze Produkt)

`infra/local/demo/demo.sh start|stop|status|zuruecksetzen` fährt `ahrenberg.sh aufbauen` im eigenen Projekt
`voltpilot-demo` (`PRUEFUMGEBUNG_PROJEKT`, `PRUEFUMGEBUNG_COMPOSE_ZUSATZ`) und legt Live-Strecke, Sammler, Optimierer
und das gebaute Portal auf `http://localhost:5173` dazu · [README](../../../infra/local/demo/README.md).
- ⚠ Das Tuning von `TS_TUNE_MEMORY=1GB` setzt `max_connections = 25` — neben der Live-Strecke bekam der Welt-Aufbau
  keine Verbindung mehr; das Overlay setzt 200 über die Kommandozeile (gilt auch für ein bestehendes Volume).
- ⚠ Alle Bezugsbasis-Fassungen der Welt 1.10 tragen `grundlage = NULL`; der Reiter „Bezugsbasis“ einer Kennzahl und der
  Bericht BR-2029-0001 (Managementbewertung) brachten am 27.09.2026 das ganze Portal auf die Fehlerseite (gemeldet).
- Rundgang (`demo.sh rundgang`, `DemoRundgangAufbau`): Login `rundgang` sieht jede UEMS-Fläche. ⚠ Ohne „Messen &
  Auswerten“ an einem Standort blendet das Portal alle UEMS-Reiter aus, und die Welt 1.10 legt die Funktion nicht an.
- Berichtsstände der Welt entstehen über Anlegen, Entwurf und Freigabe an ihren Tagen (früher Stummel `{bericht, nr}`
  direkt in `bericht_stand` → Fehlergrenze im Portal). Nr. 2 folgt einer Neubildung wie nach der Kaskade
  (`BerichtAbzugBildung.bilden` mit `TenantContext`). Die erste Bewertung steht am 01.12.2026. ⚠ Die Rangliste liest
  die Fassung des Betrachtungsumfangs, die „heute“ gilt; Umfang und Kriterien lasen das in echter Zeit —
  `PruefumgebungUhr` stellt sie jetzt mit. Gilt am Tag keine Fassung, ist `POST /berichte` (energetische Bewertung)
  422 `keine_quellen` „Am … gilt kein Betrachtungsumfang — erst den Umfang festlegen.“ (vorher 500).
