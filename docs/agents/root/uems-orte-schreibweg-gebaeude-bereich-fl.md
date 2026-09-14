# UEMS-Gebäude/Bereich-Schreibrouten und Ortsbaum je Standort

Neu angelegt am 11.09.2026 (AP-02 IP-5). Routen `web/OrtController`:
`GET /api/v1/standorte/{id}/orte?stichtag=` (Ortsbaum), `POST /api/v1/standorte/{id}/orte`,
`PUT /api/v1/orte/{id}`, `PUT /api/v1/orte/{id}/flaeche`. Arbeit `uems/OrtService`, reine
Ableitung des Baums `uems/OrtsbaumLesemodell` (Zeilen → Antwort, ohne Spring/Uhr). Beweise:
`OrtsbaumLesemodellTest` (jeder `stand_am`-Fall der Vektor-Datei für den Baum JEDES Standorts,
ohne DB), `OrtSchnittstelleVertragTest` (Codes, Nutzung und Formen ≡ `openapi.yaml`, ohne DB),
`OrtApiTest` (Keycloak + Timescale, Bestand = Referenzunternehmen Fassung 1.1: A3, A4, A10,
A14, A16, Bereich unter Bereich, Protokoll).

## Was es gibt — und was (noch) nicht

- **Keine zweite Regel-Logik.** Jede Prüfung ist `OrtsbaumAbleitung` gegen DENSELBEN Baum, den
  das Lesemodell zeigt (`StandortLesemodell.baum(StandortLesemodellService.zeilen())`, Schlüssel =
  UUIDs wie im Lesemodell): Anlegen = `eintrag` mit dem NEUEN Knoten ohne Intervall
  (Kennzeichen `"neu"`) → `ziel_art_unzulaessig` 400 · `ziel_gab_es_noch_nicht` 422 ·
  `ziel_archiviert` 409; Name = `nameBelegt` am ersten Tag UND heute; Fläche = `flaecheEintrag`
  (seit IP-5 im Vertrag, Familie `flaeche/eintrag`); Abzeichen = `rueckwirkung`. Code und Satz
  sind die des Vertrags; die DB-FK „Bereich unter Bereich“ ist nur die Rückwand.
- **Dieselben Bausteine wie der Standort (IP-4):** Form `OrtFelder` (Name, Nutzung, Notiz,
  Baujahr), Kurzzeichen `OrtKurzzeichen` (Belegung `ort_kurzzeichen` über Standorte UND Orte,
  nie wiederverwendet), Protokoll `OrtProtokoll` (GENAU EIN Eintrag je Vorgang — auch „angelegt
  + erste Fläche“ ist einer; Bearbeiten ohne Änderung schreibt keinen), Anfrage `OrtAnfrage`,
  Fehlerform `OrtAbgelehntHandler` (der `OrtController` steht in dessen `assignableTypes`).
- `messstellenZahl` ist ein benannter Platzhalter (`null`, nie 0) bis AP-04 IP-7.
- NICHT hier: Verschieben (IP-12), Archivieren/Wiederherstellen/Löschen von Orten (IP-15, `uems-ort-archivieren.md`),
  Portal-Flächen (IP-7/IP-8), Messstelle → Ort (AP-04 IP-7), Rechte-Annotation (AP-03).

## ⚠ Die Fallen

- **Die Zeitzone ist die des STANDORTS** (E9, A16): „gültig ab“ fehlend = heute dort, der
  Eintragstag für „rückwirkend“ ebenso. Tests stellen die Uhr mit `OrtService.uhrStellen`.
- **Fläche: `gültig ab` = Beginn einer Fläche ist eine KORREKTUR** (§4.2): die alte Zeile wird
  aufgehoben (bleibt lesbar), nie umgeschrieben. `OrtService.anwenden` übersetzt nur das Urteil
  in Zeilen — erst beenden/aufheben, dann eintragen (das Überlappungsverbot sieht jeden
  Zwischenstand).
- **Ganze Zahlen sind streng** (`OrtAnfrage`, für jede Ortsstruktur-Route): `3100.5` oder
  `"3100"` ist 400, nie still gerundet — an `m2`/`flaecheM2` als `flaeche_ungueltig` mit dem
  Satz aus §5.10.
- **Kennzeichen im Baum sind UUIDs**; für „Diesen Namen gibt es hier schon: Halle 1 (G-1) …“
  reicht der Dienst `nameBelegtSatz` eine Kopie des Knotens mit dem Kurzzeichen.
- **Alle Orte-Schreibvorgänge eines Kundenbereichs laufen nacheinander** (`SELECT … FROM
  unternehmen FOR UPDATE`): die Namensregel ist eine Aussage über einen TAG, kein Index.
- **jsonb ordnet Schlüssel selbst** (kürzere zuerst) — Tests prüfen `alt`/`neu` ohne Reihenfolge.
- Nach einem Rebase über eine neue Katalogversion: `./mvnw clean test` — sonst liegen zwei
  Kataloge in `target/classes` und der Kontext startet nicht.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='OrtsbaumAbleitungVectorsTest,OrtsbaumLesemodellTest,OrtSchnittstelleVertragTest')  # rein
(cd services/api && ./mvnw test -Dtest=OrtApiTest)      # Testcontainers, ~50 s
(cd frontend/portal && npx vitest run src/uemsOrtsbaum.test.ts)
```
