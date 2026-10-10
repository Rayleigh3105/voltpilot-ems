# UEMS-Quellenbindung: welche Messstelle ab wann aus welchem Messkanal liest

Neu am 11.09.2026 (AP-04 IP-13). Tabelle `messstelle_quelle` (Migration `V20260911250000`),
Routen `POST /api/v1/messstellen/{id}/quellen`, `GET …/quellen?stichtag=`, `GET …/quellen/{qid}`,
`PUT …/quellen/{qid}/beenden` (in `web/MessstelleController`), Arbeit in
`uems/MessstelleQuelleService`, Lesen/Schreiben in `uems/MessstelleQuelleRepository`, Gerät zum
Zeitpunkt aus `GeraetRepository.speisungAm`. Regeln NUR aus `uems/MessstelleRegeln`
(`bindungPruefen`, `beendenPruefen`, `rueckwirkung`) ⟷ TS `uemsMessstelle.ts`, Fälle in
`docs/contracts/v2/messstelle-vectors.json` (Familien `bindung`, `beenden`, `rueckwirkung`).
Beweis: `uems/MessstelleQuelleApiTest` (MS-06-Zeitstrahl wie die Referenzdatei, 409/422/400,
Lücke, Archiv, Zaun, OpenAPI), `uems/UemsMessstelleQuelleMigrationTest` (Zaun, Exklusionen,
CHECKs, „nur einmal beendet“, Offboarding), `MessstelleRegelnVectorsTest`,
`MessstelleSchnittstelleVertragTest`, `MessstelleZuordnungApiTest` (Hauptzähler mit Quelle).

## ⚠ Die Fallen

- **Der Messkanal ist Komponente + Gerät + Kanalname — das Gerät wählt nie der Kunde.** Gespeichert
  wird der Einbau (`geraet_id`), der die Komponente zu `gueltig_ab` speist (`geraet_komponente`);
  die Quelle muss GANZ in dieser Speisung liegen, sonst 422 `kein_geraet_zum_zeitpunkt` mit dem
  ersten Zeitpunkt ohne Gerät (vor dem Einbau = `gueltig_ab`; offen über einen Ausbau = dessen
  Ende). Seit `V20260911240000` bekommt jede neue Komponente ihr Gerät zur Commit-Zeit — der Fall
  trifft praktisch nur Zeitpunkte VOR dem Beginn der Speisung.
- **Nie überschrieben, nur einmal beendet** (Regel 2): die App-Rolle hat kein DELETE und nur
  `UPDATE (gueltig_bis, endstand, endstand_einheit)`; der Trigger `messstelle_quelle_pruefen` lässt
  `gueltig_bis` genau einmal von offen auf einen Zeitpunkt gehen — auch für die Admin-Rolle.
  Eine angekündigte Quelle lässt sich deshalb nicht zurücknehmen (nur begrenzen); das Archivieren
  lehnt 409 ab, solange eine Quelle erst nach dem Archivzeitpunkt beginnt oder später endet.
- **Die drei Verbote stehen an der Datenbankgrenze** (Exklusion, `tenant_id` vorn): EINE führende
  je (Messstelle, Größe, Richtung) und Zeitpunkt; derselbe Vergleichs-Messwert nie zweimal zugleich;
  ein Messwert (Komponente + Kanal) führt je Zeitpunkt nur EINE Messstelle (`messstelle_id WITH <>`
  — btree_gist kann das auf uuid). Verliert der Schreibweg ein Rennen (23P01), urteilt er neu.
- **Regel 2 im POST:** eine neue OFFENE führende Quelle nach dem Beginn der laufenden beendet diese
  genau zu ihrem Beginn — dieselbe Transaktion, `endstand_vorgaenger` landet am Vorgänger, EIN
  Protokolleintrag `quelle_gebunden` (mit `beendet`). `endstand_vorgaenger` ohne Vorgänger ist 400.
- **MS-06: die sieben Minuten 10:40–10:47 sind KEINE Bindungslücke** (Vertrag §9 Nr. 2,
  Referenzdatei 1.1: Z-5b ab 10:40) — sie sind die Werte-Lücke der Beobachtung (IP-15). Eine Lücke
  im Zeitstrahl entsteht nur durch ausdrückliches Beenden (MS-07).
- **Der Vorzeichen-Wert bindet nur mit `anteil` (AP-08 IP-7).** Die Wirkleistung am
  Zweirichtungszähler (`sunspec.model_203.w`, Katalog `import_export`) hat keine Vertrags-Richtung:
  ohne Anteil 422 `quelle_passt_nicht` Grund `richtung` (Vektor `ms-01-nebengroesse-vorzeichen-ohne-anteil`),
  mit `anteil` positiv → Bezug, negativ → Abgabe; `kanal_bereits_fuehrend` gilt je Anteil. Alles
  Weitere in `uems-quelle-anteil.md`.
- **„rückwirkend“ gegen die Uhr des Dienstes.** `eingetragen_am` (Tabelle) und `created_at` des
  Protokolls (`MessstelleAenderungRepository.eintragen(e, eingetragenAm)`) sind das „jetzt“ des
  Schreibwegs — so hält der CHECK `gilt_ab < created_at` auch mit einer Test-Uhr in der Zukunft
  (`MessstelleQuelleService.uhrStellen`).
- **Der Beginn der Messstelle** ist Mitternacht ihres ersten Orts (`MessstelleService.beginn`,
  IP-7): keine Quelle davor (422 `zeitpunkt_vor_vorgaenger`), der Zeitstrahl beginnt dort; ohne Ort
  wird er nicht geprüft.
- **Der Hauptzähler braucht die Quelle.** `MessstelleZuordnungService.komponente` liest die
  Komponente der führenden Quelle der Hauptgröße an dem Tag (zu Beginn des Tages, sonst die erste,
  die an ihm beginnt) — erst damit sind MS-01 (Bezug) und MS-02 (Abgabe) an K-3 beide Hauptzähler.
- **`speist`** im Messkanal-Read-Model (`MesskanalDto.Speist`) nennt je Kanal die zum `?stichtag=`
  (sonst jetzt) laufenden Bindungen; ein `+` im Stichtag muss URL-kodiert sein (ein Leerzeichen wird
  wieder `+`).
- **Löschen:** `→ measurement_point`/`→ geraet` CASCADE (das heutige Löschen einer Komponente oder
  Anlage bleibt), `→ messstelle`/`→ tenant` RESTRICT; `TenantRepository.offboard` räumt
  `messstelle_quelle` zuerst ab. Der CHECK `messstelle_aenderung_art_chk` wurde geweitet, indem der
  Stand von IP-7 (`V20260911230000`) abgeschrieben wurde — wer ihn weitet, schreibt DIESEN ab.

## Additiv seit AP-04 IP-14 (Portal-Fläche „Quelle binden“)

`GET …/quellen` trägt je Bindung zwei weitere Felder (OpenAPI `MessstelleQuelle`, beide optional):

- `kanal_name` — der Anzeigename des Messwerts, dieselbe Regel wie im Messkanal-Read-Model.
- `letzter_wert` — der letzte gute Wert DIESER Bindung, in der Form von `MessstelleRegisterWert`.
  ⚠ Nur an einer Bindung, die zum Stichtag GILT (geplant und beendet bekommen `null`); `null` heißt
  „nichts bekannt“, nie eine 0. Gebildet von `MessstelleBeobachtung.letzterWert` — DERSELBEN Stelle
  wie der letzte Wert des Registers (Werte-Zug `MessstelleRegisterRepository.werte`, Einheit des
  Messkanals ohne Umrechnung, Anteil-Schnitt nach AP-08 IP-7). Die Quelle-Karte stellt die führende
  und die Vergleichsquelle nebeneinander (E3) — beide Zahlen müssen gleich entstanden sein.

Dazu trägt `MesskanalDto.Speist` (`…/messkanaele`) das Feld `anteil`: erst damit kann die Auswahl
richtig ausgrauen — EIN Vorzeichen-Kanal führt den Bezug der einen und die Abgabe der anderen
Messstelle, verboten ist nur derselbe Teil zweimal führend.

Beweis: `MessstelleQuelleApiTest#jedeLaufendeQuelleNenntIhrenEigenenLetztenWertUndIhrenAnzeigenamen`.
