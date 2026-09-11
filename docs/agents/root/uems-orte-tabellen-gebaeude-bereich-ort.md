# UEMS-Orte-Tabellen: Gebäude, Bereich, Ort-Zuordnung, Bezugsfläche

Neu angelegt am 11.09.2026 (AP-02 IP-2b — die zweite Hälfte der Ortsstruktur-Tabellen, nach
`uems-ortsstruktur-tabellen-unternehmen-st.md`). Migration
`services/api/src/main/resources/db/migration/V20260911110000__uems_gebaeude_bereich_flaeche.sql`,
Repositories im Paket `com.voltpilot.api.uems` (`OrtRepository`, `OrtZuordnungRepository`,
`FlaecheRepository`), Beweis `UemsOrteMigrationTest` (Testcontainers; spielt die Tabelle
`erlaubte_eltern` und die Familie `ueberlappung` aus `docs/contracts/v2/ortsbaum-vectors.json`
gegen die Datenbank). Prosa-Wahrheit: AP-02-Konzept §4.1 (G, B), §4.3, §4.5.

## Was es gibt — und was (noch) nicht

- `ort` = Gebäude UND Bereich (`art`), der Standort ist KEIN `ort` (eigene Tabelle). Woran ein
  Ort hängt, steht nie am Ort, sondern je Tag in `ort_zuordnung` (genau einer von
  `eltern_standort_id` / `eltern_ort_id`). `flaeche_gueltigkeit` hängt an einem Standort ODER
  einem Ort; „nicht erhoben“ ist KEINE Zeile (m² ist ganzzahlig > 0, nie NULL, nie 0).
- Alle drei Tabellen sind nach der Migration LEER (kein Backfill). Kein Endpunkt, kein
  Read-Model, keine Fläche — Schreibrouten und Ortsbaum zum Stichtag sind IP-5, Verschieben
  IP-12, Löschen ohne Historie IP-15. `ort_aenderung` brauchte KEIN Weiten (kennt
  `gebaeude`/`bereich` und `flaeche_geaendert` schon).

## ⚠ Die Fallen

- **Die Art-Regel steht in Fremdschlüsseln, nicht in einem Trigger.** Zwei berechnete Spalten
  (`eltern_art` = `gebaeude`, `kind_art` = `bereich`, beide nur wenn `eltern_ort_id` gesetzt)
  und zwei FKs gegen `ort (id, tenant_id, art)`: „Bereich unter Bereich“ und „Gebäude unter
  Gebäude/Bereich“ scheitern mit 23503 an `ort_zuordnung_eltern_ist_gebaeude_fk` bzw.
  `ort_zuordnung_unter_gebaeude_nur_bereich_fk`. Nebeneffekt: hängt ein Bereich an einem
  Gebäude, lässt sich die Art beider nicht mehr ändern — auch nicht als Eigentümer (die
  App-Rolle darf `art` ohnehin nie ändern). Wer die Art eines Gebäudes MIT Baujahr ändert,
  trifft zuerst `ort_baujahr_nur_am_gebaeude` (CHECK vor FK).
- **Die Fläche braucht ZWEI Exklusions-Constraints** (`flaeche_standort_…`, `flaeche_ort_…`),
  je mit `WHERE … IS NOT NULL`: ein `coalesce(standort_id, ort_id)` im Schlüssel vermischte
  zwei Kennungsräume. Und sie braucht `aufgehoben_am` — sonst ist der Vektor-Fall
  `aufgehobene-zaehlen-nicht` für Flächen nicht darstellbar und eine Korrektur müsste `m2`
  umschreiben.
- **Nicht in der Datenbank, bewusst** (Kopf der Migration): „das Ziel besteht an jedem Tag des
  Intervalls“ — das Bestehen eines Standorts ist in keiner Tabelle ein Intervall, und die
  Referenz selbst ordnet AN-1 ab 12.03.2024 einem Standort zu, der erst seit 01.10.2026 im
  Portal ist; der Name eindeutig je Elternknoten (Elternknoten ist zeitgültig); ein
  Kurzzeichen, das zwischen `standort` und `ort` kollidiert; das Baujahr bis zum laufenden
  Jahr (ein CHECK muss zeitlos sein). All das prüft der Schreibweg mit `OrtsbaumAbleitung`.
- **Offboarding:** `TenantRepository.offboard` löscht `flaeche_gueltigkeit`, `ort_zuordnung`,
  `ort` VOR `anlage_standort`/`standort`/`unternehmen` — alle FKs sind `ON DELETE RESTRICT`.

## Rechte (App-Rolle)

Kein DELETE auf allen drei. `ort`: UPDATE nur `name, kurzzeichen, nutzung, baujahr, notiz,
zustand, archiviert_am, archiviert_von` (Art, Mandant, Herkunft nie). `ort_zuordnung` und
`flaeche_gueltigkeit`: UPDATE nur `gueltig_bis, aufgehoben_am` — eine andere Fläche ist ein
neues Intervall. Vokabulare: `art` `gebaeude|bereich`, `zustand` wie am Standort
(`entwurf|eingerichtet|aktiv|archiviert`, `archiviert` ⟺ `archiviert_am`), Nutzung über
`uems_nutzung_gueltig`, Kurzzeichen eindeutig je Kundenbereich über beide Arten
(`uq_ort_kurzzeichen`, `tenant_id` vorn).
