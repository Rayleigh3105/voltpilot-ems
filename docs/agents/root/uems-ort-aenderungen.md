## UEMS-Änderungsprotokoll der Ortsstruktur: je Ort, je Standort und die Gültigkeit als Zeitraum (AP-02 IP-14, H2)

**Kein neuer Schreibweg, keine Migration.** Die Einträge schreiben die Fachwege der Ortsstruktur
(`OrtProtokoll` → `ort_aenderung`). IP-14 macht sie je Objekt lesbar und gibt AP-12 die
Zeitraum-Abfrage über die GÜLTIGKEIT:

- `GET /api/v1/orte/{id}/aenderungen` — ein Gebäude oder Bereich, nur seine eigenen Einträge
- `GET /api/v1/standorte/{id}/aenderungen` — ein Standort EINSCHLIESSLICH Gebäude, Bereiche und
  Anlagen-Zuordnungen
- `GET /api/v1/unternehmen/aenderungen?von=&bis=&achse=gueltigkeit` — was in den Zeitraum REICHT

Alle drei laufen durch das Lesemodell von AP-04 IP-21 (`AenderungsprotokollRepository`, `-Service`,
`-Controller`, `ProtokollDto`, OpenAPI `Protokoll`): dieselbe Seitenweise, dieselben Ablehnungen,
Recht `aenderungsprotokoll.lesen`, fremd 404.

### ⚠ Die dritte Achse `gueltigkeit` — die Schnittstelle für AP-12

- Die Formel ist `reicht_in_zeitraum` des Ortsbaum-Vertrags (`OrtsbaumAbleitung.rueckwirkung`):
  „gilt ab" ≤ `bis` UND (`gilt_bis` fehlt ODER ≥ `von`). `von`/`bis` sind TAGE und zählen BEIDE mit
  (`bis=2027-02-28` = der ganze Februar); ein Zeitpunkt ist 400. Die Antwort bleibt halboffen
  (`bis` = Beginn des Folgetags), wie bei den anderen Achsen.
- Warum nicht `wirkung`: der Umzug, am 10.03.2027 eingetragen und gültig ab 01.02.2027, steht auf
  `wirkung` nur im Februar — mit `gueltigkeit` auch im März. Ein freigegebener März-Bericht braucht
  dieselbe Revision.
- Die VORGABE der Route bleibt `wirkung` (IP-21, entschieden). AP-12 fragt ausdrücklich mit
  `achse=gueltigkeit`.
- `OrtAenderungenApiTest.geliefertIstGenauReichtInZeitraumDesOrtsbaumVertrags` hält SQL und Vertrag
  gleich: jeder Orts-Eintrag × sechs Zeiträume.

### ⚠ `gilt_bis` kommt aus dem JOURNAL, nicht aus den Intervall-Tabellen

Im Orts-Zweig (`STROM_ORT`): der Vortag des nächsten, SPÄTEREN „gilt ab" desselben Sachverhalts am
selben Objekt (zwei Einträge desselben Tages gelten beide):

- Zuordnung: `verschoben` · `korrigiert`, an der Anlage auch ihr `geloescht`; am Standort zählt
  jede Anlage (`neu.anlage_id`) für sich.
- Fläche: `flaeche_geaendert`. Bestehen: `angelegt` · `archiviert` · `wiederhergestellt`.
- Felder: ein `bearbeitet` endet erst, wenn EIN späterer `bearbeitet` ALLE seine Felder neu setzt.
- `neu.gueltig_bis` kürzt zusätzlich; das Löschen eines Kindes (am Elternknoten, `alt.id`) gilt nur
  an seinem Tag; eine Art ohne Sachverhalt bleibt OFFEN.

**Wer eine Art in `ort_aenderung` ergänzt, ergänzt sie dort.** Einträge der Messstellen und
Datenquellen tragen KEIN `gilt_bis` (immer `null`) und reichen nur in ihren eigenen Tag — Nacharbeit,
falls AP-12 sie über diese Route statt über seinen Läufer (AP-12 IP-9) liest.

### ⚠ Der Umfang eines Standorts (`OrtProtokollUmfang`, rein)

- seine eigenen Einträge — auch „Anlage zugeordnet“/„Anlage zieht um“ (IP-11) und das Löschen eines
  Kindes;
- ein Gebäude/Bereich mit den Einträgen aus der Zeit, in der es DORT hing: am Tag seines „gilt ab"
  ODER am Vortag (ein Umzug steht bei BEIDEN Standorten); hing es an beiden Tagen nirgends
  (archiviert), der letzte Tag davor. Der Weg hinauf ist `OrtsbaumAbleitung.pfadAm` (dafür
  paket-sichtbar);
- eine Anlage nach derselben Regel über `anlage_standort` — AUSSER den Einträgen, die ein Umzug schon
  am Standort schrieb (gleiche Anlage, gleiches `created_at` = dieselbe Transaktion): ein Umzug steht
  einmal da.

Kandidaten sind alle Orts- und Anlagen-Einträge des Kundenbereichs; das Urteil fällt in Java,
gelesen, gefiltert und geseitet wird per `id = ANY(…)` im EINEN Lesemodell.

### Kundensatz und A3

`AenderungSatz` setzt die Fläche mit Tausenderpunkt: „Bezugsfläche geändert: 3.100 m² → 3.400 m²"
(vorher „3100 m²"). A3 zählt „rückwirkend (14 Tage)“, nicht 15 — so steht es im Vertrag
(`a3-anbau-14-tage-nicht-15`).

### Portal (H2)

`components/OrtAenderungen.tsx` ist der `ProtokollDialog` mit `ortProtokollOptionen` — kein neues
Bauteil: sortiert nach dem EINTRAG (`achse=eintrag`; die Variante „nach gilt ab" gibt es nur als
Vergleichsfoto), am Standort das Objekt je Zeile außer dem Standort selbst (`ohneBezug`), und
„Seit dem Anlegen am … keine Änderung." (`anlegeSatz`). Orts-Zeilen in `uemsProtokoll.zeile`: „gilt ab
01.02.2027“ ohne Uhrzeit, Marke „rückwirkend (37 Tage)“ aus dem TS-Zwilling `rueckwirkung` — das
Urteil bleibt das gespeicherte, Messstellen-Zeilen bleiben „rückwirkend“. Einstieg:
`mitAenderungen(menueEintraege(…))` in `Ortsbaum` und `StandortKopf`, direkt hinter „Verschieben …“,
nur wo es heute ein Menü gibt (nicht in „Stand am …“). Beschriftung = `PROTOKOLL_LABEL`
(„Änderungsprotokoll“; das Mockup V1 sagte „Änderungen“).

**Tests:** `OrtAenderungenApiTest` (A2, Vertrag, A3, Standort-Vollständigkeit + Seitenweise, 404,
Anfrage + OpenAPI-Felder), `AenderungSatzTest`, `ortAenderungen.test.ts` (Wortlaut
„rückwirkend (n Tage)“, Menü-Reihenfolge), `components/OrtAenderungen.test.tsx`,
`e2e/ort-aenderungen.spec.ts` (375/1440 gemessen; `ORT_AENDERUNGEN_BILDER`, `ANSICHT_VARIANTE=b`).
