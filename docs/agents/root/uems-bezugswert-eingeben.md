# UEMS-Bezugsgrößen-Werte: eingeben, berichtigen, freigeben (AP-09 IP-7)

Neu am 14.09.2026. `POST /api/v1/bezugsgroessen/{id}/werte` und `POST …/{id}/werte/{periode}/berichtigung`
(Controller `web/BezugsgroesseController`), Arbeit `uems/BezugswertService`, Tabellenzugriff
`uems/BezugswertRepository`, reine Prüfreihenfolge `uems/BezugsgroesseRegeln.eingeben|berichtigen` (Regel
`verwalten`, Vorgänge `eingeben`/`berichtigen` in B4/B5). Freigabe über die VORHANDENE Route
`POST /api/v1/korrekturen/{kennung}/freigeben` (`uems/KorrekturFreigabeService`, Zweig für `BK-…`). Migration
`V20260915010000__uems_bezugswert_berichtigung.sql`. Vertrag: `docs/contracts/v2/bezugsdaten.md` §12 (Block
`verwalten.eingabe`, zehn Ablehnungen mehr) und `events-vocabulary.md` („Berichtigung eines Bezugsgrößen-Werts“).
Beweise: `uems/BezugswertEingabeApiTest` (Testcontainers), `BezugsgroesseApiTest` (jeder Code als Antwort),
`BezugsdatenVectorsTest`, `BezugsgroesseSchnittstelleVertragTest`, `EreignisVokabularVectorsTest`, Writer-Zwilling.

## ⚠ Die Fallen

- **Ein offener Vorschlag ist KEINE Fassung des Werts.** `bezugsgroesse_wert` hält nur Tatsachen, in der
  Nummerierung der Regel `fassung`: die freigegebene Berichtigung ist EINE Zeile mit Urheber UND Freigeber (Vertrag
  B5 „Jonas gibt frei → Fassung 2 wirksam“, `bezugsgroesse_wert_freigeber_chk`). Bis zur Freigabe steht der Vorschlag
  im Vorgang `bezugsgroesse_berichtigung` (`BK-<Jahr>-<Nr.>`, Muster `messreihe_korrektur`) und kommt im Lesemodell als
  `vorschlag` am Wert. Der Schreibweg legt NIE eine `vorschlag`-/`abgelehnt`-Zeile in `bezugsgroesse_wert` an — eine
  solche (von Hand geschriebene) Kette bleibt `stand_offen` wie in IP-5.
- **Jede Berichtigung hat einen Vorgang**, auch bei Vier-Augen aus (Fassung 1 gleich `freigegeben`,
  `freigabe_vieraugen` false) — nur so trägt `correction` seine Pflicht-Kennung `korrektur`. Ein Erstwert hat keinen
  Vorgang und meldet nichts (F1/F4); ein offener Vorschlag meldet auch nichts.
- **`correction` mit Bezug `bezugsgroesse`:** `bezug_pflicht` von `correction` ist seitdem LEER; GENAU EINEN Bezug
  (Reihe ODER Bezugsgröße mit `fassung_alt`/`fassung_neu`) prüfen `pruefeFelder`/`pruefeRegeln` BEIDER Java-Zwillinge
  (api + timescale-writer), dann Kennung `BK-…` und Art `wert_berichtigt`. Die DB prüft nur den Rahmen
  (`messreihe_ereignis_bezug_erlaubt` kennt den Schlüssel `bezugsgroesse`). `KENNUNGEN` steht in beiden
  `MessreiheEreignisRepository` — wer einen Bezug ergänzt, ändert beide.
- **Sperr-Reihenfolge:** Berichtigen und Freigeben sperren ZUERST `unternehmen … FOR SHARE` (die Einstellung), DANN
  den Kundenbereich (`pg_advisory_xact_lock`) — dieselbe Reihenfolge, sonst warten sie im Kreis mit dem Umschalten.
- **Derselbe Betrag ist keine Ablehnung**, sondern 200 `wiederholung` (Regel `urteil`) — auch an der
  Berichtigungs-Route. Ein ANDERER Betrag an `…/werte` ist 409 `konflikt_anderer_wert` (F5), nie ein zweiter Eintrag.
- **Zahlen kommen als deutscher Text** (`BezugsdatenRegeln.zahl(text, "de", ganzzahlig)`), anders als der maschinelle
  `wert` der Stammdatum-Route (IP-6). U5: `zahl_unlesbar` trägt bei Stück/Personen/Schichten den `hinweis` „Stück sind
  ganze Zahlen.“ (`verwalten.eingabe.ganze_zahlen`), sobald der Text deutsche Nachkommastellen trägt.
- **⚠ Befund an der Regel `zahl` (IP-3, nicht in diesem Paket geändert):** sie entfernt jedes Leerzeichen und verlangt
  Tausendergruppen von GENAU drei Stellen — „48200“ (ohne Punkt) und „48 200“ sind darum im deutschen Format
  `zahl_unlesbar`, entgegen ihrem Javadoc („Leerzeichen sind immer Tausendertrenner“) und U4 („312 400“). Kein
  Vektor deckt es ab; eine Änderung trifft den TS-Zwilling und die Import-Vorschau (IP-12) und braucht einen
  Vertragsfall. Der Schreibweg ruft die Regel unverändert auf; die Tests tippen „48.200“.
- **U6-Hinweis nur mit Messstelle als Bezug:** die Stundengrenze braucht die Zahl gebundener Einheiten; ohne sie wird
  nicht geraten und kein Hinweis gegeben. Die 50-%-Regel („Abweichung vom Mittel der letzten sechs Perioden“) hat keinen
  Vertragsfall und ist NICHT gebaut.
- **Rechte:** `bezugsgroesse.eingeben` steht als Kommentar an den Routen (keine Durchsetzung, wie IP-5/IP-6); die
  Freigabe setzt `korrektur.freigeben` DURCH (IP-15). Ein `BK-…` an `…/zuruecknehmen` ist 404.

## Nicht gebaut

Ablehnen eines Vorschlags (die Tabelle kennt `abgelehnt`, eine Route fehlt — wie in IP-15), Rücknahme (C7, IP-13),
Vorschläge aus Import-Konflikten (IP-13; `import` steht schon im Ereignis-Vokabular), Stand-Werte (`wertart = stand`
→ 422 `kein_periodenwert`), Portal (IP-10).

## Prüfen

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
(cd services/api && ./mvnw test -Dtest='BezugsdatenVectorsTest,BezugsgroesseSchnittstelleVertragTest,EreignisVokabularVectorsTest')
(cd services/api && ./mvnw test -Dtest='BezugswertEingabeApiTest,BezugsgroesseApiTest')   # Docker
(cd services/timescale-writer && ./mvnw test -Dtest=EreignisVokabularZwillingTest)
(cd frontend/portal && npx vitest run src/bezugsdaten.test.ts src/uemsEreignis.test.ts)
```
