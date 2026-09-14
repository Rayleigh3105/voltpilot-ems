# UEMS-Kennzahl-Tabellen: Berechnung als Fassungen, Werte als Versionen (AP-11 IP-4)

Neu angelegt am 14.09.2026. Migration
`services/api/src/main/resources/db/migration/V20260915003000__uems_kennzahl.sql`, Beweis
`UemsKennzahlMigrationTest` (Testcontainers). Die Regeln sind der Vertrag `docs/contracts/v2/kennzahl.md` +
`kennzahl-vectors.json` (siehe `uems-kennzahl-vertrag.md`); die Tabellen sagen dieselbe zeitlose Hälfte als
Constraint, und der Test spielt die Vektoren gegen die Datenbank. Muster: `uems-bezugsgroessen-tabellen.md`
(Vokabular-Funktion, Kennzeichen-Verlauf, append-only) und die Formel-Fassung (`V20260912210000`).

## Was es gibt — und was (noch) nicht

- `kennzahl`: Kennzeichen (KZ-…), Name, `rechenform`, `geltung_art` + GENAU EINE Verweis-Spalte
  (`unternehmen_id` · `standort_id` · `ort_id` mit `ort_art` · `prozess_id` · `kostenstelle_id` · `messstelle_id`),
  Verantwortlicher als Akteur-Schnappschuss (`verantwortlich_sub/_name`, kein FK bis AP-03 IP-2), `zweck`, `archiviert_am`.
- `kennzahl_kennzeichen_verlauf`: jedes je getragene Kennzeichen (Trigger, SECURITY DEFINER); seit
  `V20260915020000` bleibt es beim Löschen als Grabstein (`kennzahl_id` NULL).
- `kennzahl_fassung`: die Berechnung — Spalten ZEILENGLEICH zu `messstelle_formel_fassung` (`kennzahl_id` statt
  `messstelle_id`, `rechenform` statt `formel_typ`, ohne `rest_hauptzaehler_id`) plus `komplement`, `faktor`, `einheit`.
- `kennzahl_eingang`: die Eingänge je Fassung (`rolle`, `art`, genau ein Verweis).
- `kennzahl_wert` + `kennzahl_wert_eingang`: Wert je Periode × Version und was er von jedem Eingang las.
- `kennzahl_aenderung`: das Protokoll.
- Routen und Lesemodell der Definition: `uems-kennzahl-schreibwege.md` (IP-5). Kein Rechenlauf und kein Ereignis
  `kennzahl_neu_gebildet` (IP-6), kein Lesemodell der Werte (IP-7).

## ⚠ Werte: append-only für JEDE Rolle — Nachziehen ist eine neue Zeile

- Trigger `kennzahl_wert_append_only` / `kennzahl_wert_eingang_append_only` lehnen JEDES UPDATE und JEDES DELETE
  ab — auch die Verwaltungsrolle MIT Recht und den Eigentümer. Anders als `messreihe_periode_version` gibt es
  kein UPDATE für das Nachziehen: eine vorläufige Version zieht als WEITERE ZEILE derselben Nummer nach; der
  aktuelle Wert ist die neueste Zeile (höchste `version`, dann jüngstes `berechnet_am`). **Der Leseweg (IP-7)
  muss genau so ordnen.**
- Versionsfolge je Periode (`kennzahl_wert_version_folgt`): ohne frühere Zahl keine Version (NULL, ohne Zahl,
  K8) oder 1; neueste vorläufig → nur dieselbe Nummer mit demselben Anlass; neueste endgültig → nur n + 1 mit
  `anlass_art` (`eingang` · `definition`) und Beleg; nie ein `berechnet_am` vor der neuesten Zeile. Eine
  endgültige Version ist genau EINE Zeile (`uq_kennzahl_wert_endgueltig`). Sperren je Kennzahl ist Sache des Laufs.
- CHECKs aus Q2/Q3/Q7: Zahl ⇔ nicht „keine Werte", ohne Zahl immer `grund`, Richtung ⇔ „unvollständig", Zahl nur
  mit `zaehler` und `nenner` ≠ 0, ohne Version weder Zahl noch vorläufig/endgültig.
- **Der eine Ausgang ist das Offboarding:** `uems_kennzahlwerte_des_kundenbereichs_entfernen(tenant)` (nur die
  Verwaltungsrolle darf ausführen) setzt für GENAU diesen Kundenbereich und nur im Aufruf die Kennzeichnung
  `uems.kennzahlwerte_entfernen`, die der Trigger erkennt, und nimmt sie zurück. Keine Sicherheitsgrenze — die
  sind die Rechte (App nur SELECT, Verwaltungsrolle SELECT + INSERT, niemand DELETE).
- Geschrieben werden Werte von der Verwaltungsrolle (Muster `BerechnetePeriodenLauf`); `created_at` setzt die DB.

## ⚠ Fassungen und Definition

- Exklusion `kennzahl_fassung_keine_ueberlappung` (Tage `[]`, `tenant_id` vorn, aufgehobene belegen keinen Tag);
  `kennzahl_fassung_nur_verkuerzen` — nur `gueltig_bis` kürzen und einmal aufheben, alles andere `…_unveraenderlich`.
  „Nach der jüngsten beginnen" und „rückwirkend" urteilt `MessstelleFormelRegeln.fassungEintrag`, nicht die DB.
- V4 in der DB: die Rechenform reist als Kopie in jede Fassung und jeden Eingang, gebunden per FK
  (`kennzahl_fassung_kennzahl_fk`) → nach der ersten Fassung unveränderlich; der Geltungsbereich per Trigger
  (`kennzahl_geltung_nach_erster_fassung`) mit `kennzahl_geltung_uq` als Sperre gegen das Rennen (wie Bezugsgröße).
- `komplement` nur am Anteil, `faktor` > 0 nur am Quotienten, `einheit` `%` genau am Anteil (U1).
- **Zeilengleich ist ein Test:** bekommt `messstelle_formel_fassung` eine Spalte, wird
  `dieFassungIstZeilengleichZurFormelFassung` rot — additiv nachziehen oder dort als formel-eigen benennen.

## ⚠ Eingänge

- Genau ein Verweis passend zur Art, nie die eigene Kennzahl (`kennzahl_eingang_kein_selbstverweis_chk`); der
  Kreis über mehrere Kennzahlen (K16) ist `MessstelleFormelRegeln.zyklus` am Schreibweg.
- `paar` genau in der Zusammenfassung und nur an einer Kennzahl; `zaehler`/`nenner` je Fassung höchstens einmal
  (`uq_kennzahl_eingang_rolle`). Anzahl der Eingänge und Einheiten (auch: Anteil derselben Größe) urteilt
  `KennzahlRegeln` — die Vektoren kennen einen Anteil mit Bezugsgrößen-Nenner als Einheiten-Fall.
- App-Rolle ohne UPDATE/DELETE: Eingänge sind Historie ihrer Fassung.

## ⚠ Die Vokabular-Bindung

- `kennzahl_vokabular()` ist die EINE Stelle: Zeile für Zeile `vokabulare.rechenform|eingang_art|eingang_rolle|
  periode_art|geltung_art|zustand|richtung_unsicherheit|grund_ohne_zahl|protokoll`; jeder CHECK fragt
  `kennzahl_wort(…)`. Weitet der Vertrag ein Vokabular, druckt der Test den VALUES-Block — eine NEUE Migration
  ersetzt nur die Funktion. Ein NEUER Vokabular-Block macht den Test ebenfalls rot: er muss als gespeichert oder
  ausdrücklich nicht gespeichert (`NICHT_GESPEICHERT`) entschieden werden.
- **Protokoll-Wörter = Vertrag, nicht Konzept §6.1:** nur `kennzahl_fassung_eingetragen` · `kennzahl_geaendert` ·
  `kennzahl_archiviert`. Anlegen = Fassung 1 eingetragen, Wiederherstellen = geändert. Braucht IP-5 ein weiteres
  Wort, zuerst den Vertrag weiten (und dann alle Leser von `kennzahl-vectors.json` laufen lassen).
- Literale mit Quelle: Fassungs-`herkunft` `anlage · eintrag · kopie`, Wert-`zustand` `vorlaeufig · endgueltig`,
  `anlass_art` = die Wörter von `anlass.art` der Regel `wert` (der Test sammelt sie aus den Vektoren), Akteur, Zeitzone.

## Löschwege und Offboarding

- Jeder Verweis ist `ON DELETE RESTRICT`. Eine Bezugsgröße, Messstelle oder Kennzahl, die ein Eingang liest, ist
  nicht löschbar; ein Ort mit Kennzahl scheitert in `uems_ort_loeschen` am FK `kennzahl_ort_fk` (23503 —
  `OrtService` bildet 23503 auf Historie ab). **Für IP-5:** `OrtRepository.mitBezugsgroesse()` und das Löschen
  einer Bezugsgröße (`BezugsgroesseService.schreibe`) kennen die Kennzahl noch nicht — mit den ersten
  Kennzahl-Zeilen dort ergänzen, sonst sagt die Vorschau „löschbar" und die DB lehnt ab. **Seit IP-5:** die
  Ort-Löschvorschau kennt `hat_kennzahlen`; ⚠ das Löschen einer Bezugsgröße noch nicht (siehe
  `uems-kennzahl-schreibwege.md`).
- `TenantRepository.offboard` räumt VOR den Bezugsgrößen ab: Werte über die Funktion, dann `kennzahl_eingang`,
  `kennzahl_fassung`, `kennzahl_kennzeichen_verlauf`, `kennzahl`, `kennzahl_aenderung`.
