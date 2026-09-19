# Betriebsabfragen

Lesende SQL-Blätter, die der **Betreiber** gegen eine laufende Datenbank fährt, um eine
Entscheidung zu treffen. Kein Blatt legt etwas an, kein Blatt ändert etwas: jedes läuft in
`BEGIN TRANSACTION READ ONLY`, und genau das erzwingt die Sperre — nicht die Disziplin des Lesers.

| Datei | Wann | Gegen welches Schema |
|---|---|---|
| [`bestand-vor-uems.sql`](bestand-vor-uems.sql) | vor Tor G1, also VOR der Zusammenführung `uems` → `main` | `main` |
| [`bestand-nach-rollout.sql`](bestand-nach-rollout.sql) | auf der Kopie der Generalprobe und am Rollout-Tag vor dem Öffnen des Portals | `uems` |
| [`pilot-tagesblick.sql`](pilot-tagesblick.sql) | täglich ab dem Rollout-Tag | `uems` |
| [`katalog-zaehler-einheiten-nutzung.sql`](katalog-zaehler-einheiten-nutzung.sql) | einmalig, Befund PR 726 | beide |

Die ersten drei gehören zu AP-14 „Erste Produktfreigabe“ (Konzept entschieden am 18.09.2026,
E1 = B: **kein Freigabe-Tor**). Geprüft werden sie von
`services/api/src/test/java/com/voltpilot/api/uems/BetriebsabfragenBlaetterTest.java`.

## Wie man ein Blatt fährt

```bash
psql "$VP_DB_URL" -v ON_ERROR_STOP=1 -f tools/betriebsabfragen/bestand-vor-uems.sql
```

- **Rolle mit `BYPASSRLS`** (oder Superuser). Jede Mandanten-Tabelle trägt
  `FORCE ROW LEVEL SECURITY`; ohne `BYPASSRLS` liefert das Blatt einen **scheinbar leeren Befund**.
  Den Kopf `SET LOCAL row_security = off` darf nur eine solche Rolle setzen.
- **`READ ONLY`** — der Kopf jedes Blatts öffnet die Transaktion lesend. Ein Schreibversuch
  scheitert mit `cannot execute … in a read-only transaction`.
- **120 s je Abfrage** (`statement_timeout`), **2 s je Sperre** (`lock_timeout`). Eine Abfrage, die
  in die Zeit läuft, ist ein Befund, keine Aufforderung, die Grenze zu heben.
- Das Ergebnis in eine **datierte Datei** schreiben (`psql -o`); in der Datenbank bleibt nichts.

**Neu fahren, wenn das Blatt älter ist als sieben Tage oder `main` dazwischen ausgerollt wurde**
(Regel A4). Ein Blatt von vorletzter Woche beschreibt einen Bestand, den es nicht mehr gibt.

Niemand außer dem Betreiber fährt ein Blatt gegen Produktion. Crew und Werkzeugketten haben
keinen Produktionszugang; sie sehen das Blatt nur als Datei und als Ergebnis von Teil A–C.

## Was teilbar ist und was nicht

Das Vorher-Blatt ist in vier Teile geschnitten:

| Teil | Inhalt | Wohin |
|---|---|---|
| **A** Ausgangszustand (Q01–Q05) | nur Zählungen und Klassen | teilbar — gehört in den Konzept-Ordner, die Crew liest sie |
| **B** Boxen, Edges, Messlast (Q06–Q10) | nur Zählungen und Klassen | teilbar |
| **C** Migrationen und Wartungsfenster (Q11–Q15) | nur Zählungen, Größen und Zeiten | teilbar |
| **D** Einzelfälle (Q16–Q18) | interne Kennungen (UUID) | **bleibt beim Betreiber** |

„Teilbar“ ist keine Absicht, sondern eine geprüfte Eigenschaft: der Test liest die
**Ergebnis-Metadaten** jeder Abfrage aus Teil A–C und lässt keine Spalte vom Typ `uuid` und keine
Spalte durch, deren Name auf eine Kennung deutet (`…_id`, `…_name`, `serial`, `email`, `…_ref`,
`…_sub`). Wer eine Abfrage in Teil A–C um eine solche Spalte erweitert, macht den Test rot — zu
Recht: dann wäre Teil A–C nicht mehr das, was der Betreiber herausgibt. Zwei Abfragen sind
deshalb gegenüber dem Konzeptentwurf berichtigt: **Q04** zählt die Akteure, statt sie zu nennen
(der Name eines Akteurs ist der Name einer Person), und **Q14** nennt die Hypertabelle als
`tabelle` statt als `hypertable_name`.

Das **Pilot-Blatt** ist nicht teilbar: seine Eingabe IST eine Liste interner Kennungen, und seine
Zeilen tragen sie. Es bleibt beim Betreiber, wie Teil D.

## `bestand-vor-uems.sql` — Abfrage → Entscheidung

| Abfrage | Frage | Entscheidung, die an ihrem Ergebnis hängt | Auffällig, wenn |
|---|---|---|---|
| **Q01** Flyway-Stand | Welcher Migrationsstand liegt in Produktion, gibt es fehlgeschlagene Zeilen? | Tor G1: die Generalprobe setzt auf GENAU diesem Stand auf; ein fehlgeschlagener Eintrag sperrt das Ausrollen | fehlgeschlagen > 0 · höchste Version ≠ `20260916203000` |
| **Q02** Kundenbereiche nach Anlagenzahl | Wie viele haben keine, eine, mehrere Anlagen? | E10 (Betreuungs-Reihenfolge: Ein-Anlagen-Kunden zuerst) · Wahl der Pilotkunden P1/P2 | Klasse „6 und mehr“ groß → „alles in einem Zug“ (N4) wiegt schwerer |
| **Q03** Stand der halben Übernahme | Wie weit ist der Standort-Läufer gekommen, der seit dem 11.09.2026 läuft? | W3: der Plan setzt auf diesem Bild auf; Lage c/f sind einzeln zu erklären (Q16) · Lage d = so viele Kundenbereiche sehen am Rollout-Tag die Vorschlags-Karte (E1 = B) | Lage c > 0 · Lage f > 0 · ein Kundenbereich ohne Unternehmen |
| **Q04** Ortsprotokoll nach Wort und Akteur | Wer hat bisher geschrieben, gibt es `rolle_gesetzt`/`rolle_entzogen`? | Prämisse von V0: mit solchen Zeilen wäre die unberichtigte Migration GESCHEITERT — die Generalprobe muss mit ihnen bestehen · Dauer des einen UPDATE über jede Zeile ohne Person | `zeilen_einer_person` > 0 bei angelegt/verschoben · `zeilen_fremder_automat` > 0 |
| **Q05** Helfer-Bestand | Wie viele berechnete Messstellen und Formel-Terme gibt es? | Umfang der Rückfüllung „Fassung 1 gilt seit Beginn“ · Prämisse von `V20260913143000` (nicht geprüfter Rest aus ist/D §0) · zusammen mit der H-4-Abfrage fahren | — |
| **Q06** Boxen nach Zustand, Boxen je Anlage | Wie viele Anlagen haben mehr als eine Box? | Pilotfall P3 echt oder nur im Simulator · Zahl der Anlagen, deren Registry-Push sich mit Datenquellen ändert (X3) | — |
| **Q07** Boxen je Edge-Stand | Welche (core, palette)-Paare laufen im Feld? | E4 · NW-3: jedes Paar mit ≥ 1 Box ist ein ausgeliefertes Image, gegen das geprüft wird · älteste unterstützte Version | viele Boxen „(keine Meldung)“ |
| **Q08** Freie Register gegen das neue Box-Budget | Welche Bestandsboxen lehnte eine Box mit PR 936 ab? | Tor GA: Klasse c muss 0 sein oder jeder Kunde vorher umgestellt; Klasse b geht in IP-17 | Klasse c > 0 |
| **Q09** Messlast der Bestandsboxen | Wie nah sind sie an 120 und 600 Samples/min? | E6 · Wahl der Pilot-Boxen (eine Box, die warnt, trägt keinen Messkunden-Piloten) | Klasse d > 0 |
| **Q10** Katalogstand der Mess-Auswahlen | Was hängt in `pending_edge`? | Tor GB: vor dem Heben von `RUNTIME_VERSION` leer oder erklärt (X4) | alte `catalog_version` mit offenen Zeilen |
| **Q11** Offene Befehls-Perioden ohne Box | Wie viele „laufen für immer“? | Release-Notiz: die Zahl der Anweisungen, die mit `V20260913200000` enden; 0 = nichts zu sagen | — |
| **Q12** Registry-Zustand | Trägt er, was `V20260915040000` annimmt? | keine — Absicherung der Generalprobe | — |
| **Q13** Laufende Handeingriffe und Pausen | Was endet in den nächsten drei Stunden? | Lage des Wartungsfensters (D4): kein Fenster, in dem ein Handeingriff ausläuft, ohne dass der Kunde es weiß | `endet_in_3h` > 0 zur geplanten Zeit |
| **Q14** Größe der Datenbank, Hypertables, Arbeitslisten | Wie groß ist sie, was hat die Rückrechnung geschrieben? | W5: Alarm-Schwelle aus der echten Belegung · L6: Zahl der 100-Messstellen-Kunden · Dauer von Sicherung und Wiederherstellung (E2) | offene Arbeit im sechsstelligen Bereich |
| **Q15** WAL-Archiv | Gibt es den Rückweg überhaupt? | E2, Tor G1: ohne laufendes Archiv kein Wiederherstellungspunkt | letzte Archivierung älter als 1 h · Fehler steigen |
| **Q16** Anlagen ohne Standort und ohne Vorschlag (Teil D) | Wen hat der Läufer nicht erreicht? | je Zeile vor G1 klären; bleibt sie nach einem api-Start stehen, ist es ein Bau-Fehler | jede Zeile |
| **Q17** Boxen aus Q08 b/c (Teil D) | Wen muss man vor Release A ansprechen? | Kundenliste für GA | — |
| **Q18** Anlagen mit mehreren Boxen (Teil D) | Kandidaten für P3 | Pilotwahl | — |

Q08 schätzt nur die Untergrenze aus freien Registern. Die
[Budget-Prüfung](../budgetpruefung/README.md) urteilt vor Edge-Release A exakt über den vollständigen
heutigen Publisher-Plan und den gemeinsamen Java-Vertrag.

**Ohne SQL, aber vor G1:** Konten je Kundenbereich über 1 000 (Keycloak) → N5 · Alter des
Basis-Backups ([`tools/backup/vp-db-backup-check.sh`](../backup/vp-db-backup-check.sh)) → E2 ·
Aufbewahrung im Ereignis-Bus ≥ Fenster + Rückweg + Reserve → D5 · zwei bekannte Kunden mit reiner
Verbrauchsanlage und Tarif am Portal → W7.

## `bestand-nach-rollout.sql` — Abfrage → Entscheidung

| Abfrage | Frage | Entscheidung |
|---|---|---|
| **Z01** Migrationen und ihre Dauer | Alle SQL-Migrationen angewandt, keine gescheitert — welche dauerte am längsten? | Länge des Wartungsfensters (D4: gemessene Summe × 3, mindestens 30 min) |
| **Z02** `ort_aenderung_art_chk` | Trägt der CHECK die Zwölfer-Liste? | Go/No-Go: fehlt `rolle_gesetzt`, scheitert jede Rollen-Zuordnung still |
| **Z03** Funktions-Läufer | Was hat er aus dem Bestand abgeleitet? | die Vorschau für den Betreiber (B6), BEVOR das Urteil gilt — der Läufer betrachtet eine Teilnahme nie wieder |
| **Z04** Anlagen ohne Teilnahme | Gibt es den Halb-Zustand noch? | N2: nur Anlagen ohne Standort dürfen hier stehen; alles andere ist der Halb-Zustand, den AP-14 IP-3 beendet |
| **Z05** Rechte-Läufer | Hat er jeden Kundenbereich erreicht? | N5: `ohne_stichtag` muss erklärt sein und der Generalprobe entsprechen (D8) |
| **Z06** Registry-Schlüssel, Befehlsverlauf | Ist der Schlüssel gewechselt, der Verlauf geschlossen? | Go/No-Go (D8): beide Werte entsprechen der Generalprobe |
| **Z07** Arbeitslisten | Stehen sie nach dem ersten Lauf, oder laufen sie auf? | Nachlauf M-6; wachsen sie nach 24 h: Läufer per gitops-Wert aus (P6) |
| **Z08** Unversehrtheit der Flyway-Historie | `geloescht_markiert`, `fehlgeschlagen`, `sql_erfolgreich`, `versionen_geloescht` (nur Zählungen) | **`geloescht_markiert > 0`: NICHT das neue Image einfach wieder ausrollen. API/Writer anhalten, Befund sichern, geübter Rückweg auf den Wiederherstellungspunkt vor Portalöffnung.** Fehlgeschlagene Einträge ebenfalls untersuchen; SQL-Zahl mit eingefrorenem Release und Vorher-Blatt abgleichen. |

Z01 zählt `angewandt` ausschließlich für erfolgreiche Zeilen mit `type = 'SQL'`.
Ein erfolgreicher `DELETE`-Marker ist keine angewandte Migration. Z08 erkennt ihn auch,
wenn `fehlgeschlagen = 0` ist. Zusätzlich den kanonischen Fingerabdruck aus
`installed_rank, version, type, checksum, success, description, script` nach Migration
und vor Portalöffnung vergleichen: keine unerwarteten Änderungen oder weiteren Zeilen.
Keine automatische Entfernung von Markern; nach Portalöffnung gilt der vereinbarte Vorwärtsweg.

## `pilot-tagesblick.sql` — Abfrage → Entscheidung

Der Aufruf braucht die **Betreiber-Liste**: die internen Kennungen der betreuten Kundenbereiche.
Der Betreiber führt sie selbst; sie steht **in keiner Tabelle**, und sie ist ein **Parameter**,
kein Tor — es gibt keinen Zustand „Pilot“ (E1 = B).

```bash
psql "$VP_DB_URL" -v ON_ERROR_STOP=1 \
     -v betreiber_liste='11111111-1111-1111-1111-111111111111,2222…' \
     -f tools/betriebsabfragen/pilot-tagesblick.sql
```

| Abfrage | Frage | Entscheidung |
|---|---|---|
| **T01a** Eingang je Quelle | Wie alt ist der jüngste Eingang, Box für Box und Reihe für Reihe? | Ansprache am selben Tag; ein Befund der Stufe 1 („ein Messwert geht verloren“) beginnt hier |
| **T01b** Rohwerte der letzten 24 h | Wie viele Werte sind je Eingangsweg angekommen? | stimmt der Eingang mit dem, was die Box liefern soll (Kadenz × Kanäle) |
| **T02** Offene Lücken | Wie viele Einheiten haben eine offene Lücke, wie alt ist die älteste? | steht die Lücke (Befund) oder wandert sie (Nachlieferung läuft) |
| **T03** Arbeitslisten-Alter | Wie lang und wie alt sind die drei Arbeitslisten? | P6: wachsen sie nach 24 h, Läufer per gitops-Wert aus, niemanden weiter ansprechen |
| **T04** Letzter Lauf je Läufer | Wann ist jeder Läufer zuletzt gelaufen? | steht ein Läufer, erklärt das jeden Rückstand aus T03 auf einen Schlag |

### Lücken — was der Bau heute nicht protokolliert

Das Blatt nimmt genau die Läufer und Arbeitslisten, die es im Bau gibt. Was fehlt, steht hier,
statt geraten zu werden; die Metriken dazu baut **AP-14 IP-9** in einem eigenen Paket.

- **Ein Läufer-Stand je Kundenbereich existiert nicht.** `messreihe_viertelstunde_lauf`,
  `messreihe_tag_lauf` und `messreihe_luecke_lauf` haben je Schlüssel EINE Zeile, ohne
  `tenant_id`. T04 ist deshalb die einzige Abfrage des Blatts, die die Betreiber-Liste nicht
  kennt — bewusst: eine Zahl je Kundenbereich gäbe es hier nur erfunden.
- **Die übrigen Läufer schreiben gar keinen Lauf-Stand:** Endgültigkeit, Ersatzwert,
  Korrektur-Kaskade, Übergabe, Struktur-Änderung, Ablauf, Zeilentext-Aufbewahrung und die drei
  Start-Läufer (Bestandsübernahme, Funktion-Bestand, Zugriff-Bestand). Ihr letzter Lauf steht
  heute nur im Log der api. `bezugsgroesse_kanallauf` ist trotz des Namens kein Läufer-Stand,
  sondern der Zeiger je Kanalbindung.
- **Kein Trend.** Das Blatt zeigt den Stand eines Tages; den Vergleich zweier Tage macht der
  Betreiber von Hand, bis ein Dashboard die Sicht ersetzt (P5).
- **T01b liest die Rohwert-Hypertabelle über `received_at`, nicht über `time`** — damit eine
  Nachlieferung mitzählt. Die Abfrage fasst deshalb jeden Abschnitt an, in dem noch nachgeliefert
  wird; bei wachsendem Bestand ist sie die erste, die an die 120 s stößt.

## Der Test

`BetriebsabfragenBlaetterTest` (Testcontainers, ohne Docker übersprungen) baut in EINEM Container
zwei Wegwerf-Datenbanken:

- `bestand_main` mit **genau** dem Migrationssatz von `main`
  ([`services/api/src/test/resources/migration/main-migrations.txt`](../../services/api/src/test/resources/migration/main-migrations.txt),
  dieselbe Liste, die `UemsProduktionsreihenfolgeMigrationTest` fährt) — darauf läuft das
  Vorher-Blatt;
- `uems` mit dem vollen Satz — darauf laufen Nachher- und Pilot-Blatt.

Beide bekommen die vorhandene Entwicklungs-Saat (`db/dev`), damit keine Abfrage nur auf leeren
Tabellen „läuft“; für die Messdaten-Kette des Pilot-Blatts kommen eine Handvoll Zeilen dazu. Die
Blätter werden aus **diesen Dateien** gelesen, nie in den Test kopiert.

Festgehalten ist die **Ergebnisform je Abfrage** — Spaltenname und -typ, in der Reihenfolge des
`SELECT` — in
[`services/api/src/test/resources/betriebsabfragen/ergebnisformen.txt`](../../services/api/src/test/resources/betriebsabfragen/ergebnisformen.txt).
Eine spätere Migration, die eine Abfrage bricht oder still umbaut, macht den Test rot. Wer ein
Blatt **bewusst** ändert, fährt den Test und kopiert die beobachtete Form aus
`services/api/target/betriebsabfragen/<blatt>.formen.txt` in die Datei.

```bash
cd services/api && ./mvnw test -Dtest=BetriebsabfragenBlaetterTest
```
