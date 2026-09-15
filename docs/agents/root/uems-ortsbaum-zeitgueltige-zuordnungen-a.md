# UEMS-Ortsbaum: zeitgültige Zuordnungen als Vertrag mit Vektoren

Neu angelegt am 11.09.2026 (AP-02 IP-1, das erste Bau-Paket der Ortsstruktur des Programms
Unternehmens-Energiemanagement — vor den Migrationen IP-2a/IP-2b, die dieselben Regeln als
Datenbank-Constraints spiegeln).

Die Prosa-Wahrheit ist das AP-02-Konzept (§4.3 Zuordnungs- und Gültigkeitsregeln, §4.4 „Stand
am“, §4.5 Invarianten; Entscheide E1, E2, E3, E9, E11, E12 vom 10.09.2026). Das Glossar
(`docs/fachmodell/glossar.md`, Eintrag „Zuordnung“ — erzeugt aus
`docs/fachmodell/tools/fachmodell.py`) verweist hierher. Die ABLEITUNG lebt als Vertrag:

- **[`docs/contracts/v2/ortsbaum-vectors.json`](../../contracts/v2/ortsbaum-vectors.json)** —
  104 Fälle in acht Familien (`stand_am`, `ueberlappung` liste/eintrag, `rueckwirkend`,
  `messstelle_standort`, `verschieben` folgen, `archiv` archivieren/wiederherstellen/löschen,
  `zeitraum_teilung`, `flaeche` am_tag/zeitraum), dazu Vokabular, Regel-Konstanten und benannte
  Ahrenberg-`szenarien`; ein Fall nennt ein Szenario plus optional eine `ueberlagerung` (gleiches
  Kennzeichen ersetzt, neues kommt dazu).
- **[`docs/contracts/v2/ortsbaum.schema.json`](../../contracts/v2/ortsbaum.schema.json)** — JSON
  Schema 2020-12 für Baum, Eingänge, Ergebnisse und die Vektor-Datei selbst.
- **Zwillinge:** Java `services/api/.../uems/OrtsbaumAbleitung` (+ `OrtsbaumAbleitungVectorsTest`)
  und TS `frontend/portal/src/uemsOrtsbaum.ts` (+ `uemsOrtsbaum.test.ts`). Beide fahren dieselbe
  Datei; **wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.** Beide Tests
  vergleichen generisch (Java: Records → Jackson `SNAKE_CASE`; TS: camelCase → snake_case); ein
  Schlüssel, den der Vertrag für eine Zeile nicht nennt, muss im Ergebnis null bzw. abwesend sein.

## Wer anruft

Das Standort-Lesemodell (IP-3) und das Ortsbaum-Lesemodell (IP-5) für „Stand am“, die
Standort-Schreibrouten (IP-4) für Namensregel, Archivieren und Wiederherstellen, die
Gebäude/Bereich-Schreibrouten (IP-5) für `eintrag`, `nameBelegt` und `flaecheEintrag`
(`uems-orte-schreibweg-gebaeude-bereich-fl.md`), das Verschieben von Gebäude/Bereich (IP-12) für `eintrag` und
`verschiebenFolgen` (`uems-ort-verschieben.md`). Die Portal-Flächen rufen den TS-Zwilling noch
nicht.

**Fläche ab einem Tag** (Familie `flaeche/eintrag`, seit IP-5): dieselbe Mechanik wie eine
Zuordnung — die laufende endet am Vortag, die neue erbt deren Ende, in einer Lücke endet sie am
Vortag der nächsten; `gültig ab` = Beginn einer Fläche ist eine KORREKTUR (§4.2, die alte bleibt
aufgehoben lesbar); Gründe `flaeche_ungueltig` → `gab_es_noch_nicht` → `archiviert` →
`gleiche_flaeche`. Die Sätze setzen m² mit geschütztem Leerzeichen („3 400 m²“, §5.10).

## Die Fakten, die man ohne Nachlesen braucht

1. **`bis` ist der LETZTE gültige Tag, einschließlich** („Werk Ahrenberg bis 28.02.2027 · Werk
   Ahrenberg Nord ab 01.03.2027“). §4.5 Regel 2 schreibt „[gültig ab, gültig bis)“ — halboffen
   sind nur die ZEITPUNKTE [ab 00:00, bis+1 00:00) in der Zeitzone des Standorts. Für IP-2b heißt
   das `daterange(ab, bis, '[]')` im Exklusions-Constraint; der Fall
   `bis-ist-der-letzte-tag-darum-ueberlappt-das` pinnt die Falle.
2. **Ein neues „gültig ab“ beendet das LAUFENDE Intervall am Vortag, das neue erbt dessen Ende.**
   Vor dem ersten Intervall → abgelehnt; gleicher Beginn → abgelehnt („Ändern Sie diese“); eine
   Korrektur (`vorgang: korrektur`) ersetzt ein Intervall ab SEINEM Beginn und lässt das alte als
   `aufgehoben` lesbar. Das Ziel muss an JEDEM Tag des neuen Intervalls bestehen. Genau ein Grund,
   Reihenfolge = `gruende_eintrag`.
3. **Rückwirkend** = „gilt ab“ vor dem Eintragstag, und der Eintragstag ist der Tag AM STANDORT
   (23:30 Uhr UTC am 09.03. ist der 10.03. in Berlin). Abzeichen zählt Eintragstag − gilt ab
   („rückwirkend (37 Tage)“); der Fakt für die Revision (AP-12) ist
   `[gilt ab, min(Eintragstag − 1, gilt bis)]`.
4. **Der Standort einer Messstelle ist die Wurzel ihres Ortes AN DIESEM TAG** (Regel 7); „U“ ist
   das Unternehmen (Ort, aber kein Standort → null). Ein Zeitraum wird nur geteilt, wo der
   STANDORT wechselt; eine Lücke ist ein eigener Teil ohne Standort.
5. **Folgen-Karte (E11):** eine Messstelle steht dort, wenn ihr Standort am Umzugstag MIT dem
   Umzug ein anderer ist als OHNE ihn; es „bleiben“ die Anlagen dieser Messstellen (sofern nicht
   schon am Ziel), ihre Netzanschlüsse und ihre übrigen Messstellen. Der Ortsbaum selbst kennt
   nichts Elektrisches — die Messstelle trägt ihre Anlage.
6. **Archivieren (E12)** sperrt bei aktiver Anlage (am Standort), aktiver Messstelle im Teilbaum
   und — konservativ ergänzt — bei jeder GEPLANTEN Zuordnung hinein oder heraus; der Satz sagt
   „ist hier aktiv“, nie „liefert Daten“. Leere Kinder werden mitarchiviert, alles endet am
   Vortag. Wiederherstellen: nur das Objekt, am alten Elternknoten, Name frei unter Geschwistern
   derselben Art. Löschen (E1): nur ohne JE eine Messstelle, Anlage, Fläche oder ein Kind.
7. **Fläche (E3):** ein Standort ohne eigene Fläche summiert seine Gebäude — nur, wenn JEDES eine
   hat; die eigene Fläche wird nie nachgerechnet, Bereiche werden nie addiert, null statt 0.

## Wo der Report nicht aufging (je ein benannter Fall mit ⚠ im `why`)

A2 (Umzug gültig ab 01.02.2027 zu einem Standort, den es erst ab 20.02.2027 gibt → abgelehnt;
offen: „Standort anlegen“ mit Datum in der Vergangenheit) · A3 („15 Tage“ vs. A2s Zählung → 14) ·
A12 vs. A5/§4.4-Protokoll (Stand am 15.09.2026 hängt am Neukunden- oder Bestandsweg) · A7
(„liefert hier Daten“ → „ist hier aktiv“) · A13 vs. §5.6 (MS-08) · §4.1 vs. E1 (leerer Standort
darf gelöscht werden).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='OrtsbaumAbleitungVectorsTest')   # rein (inkl. Schema über `UemsSchemaLaeufer`)
(cd frontend/portal && npx vitest run src/uemsOrtsbaum.test.ts)
python3 docs/fachmodell/tools/build_fachmodell.py --check               # Glossar aktuell
```

Die Tests prüfen nicht nur die Fälle: sie stellen das Vokabular **in seiner Reihenfolge**, die
Tabelle der erlaubten Elternknoten, die Regel-Konstanten und die Überlappungsfreiheit JEDES
Szenarios gegen die Vektor-Datei.
