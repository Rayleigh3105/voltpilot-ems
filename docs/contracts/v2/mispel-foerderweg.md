# MiSpeL-Förderweg je Einspeisestelle (MP-5)

Stand 04.10.2026 · Vertrag 1.3 · Quelle: BNetzA-Festlegung zur Marktintegration von Speichern und
Ladepunkten („MiSpeL“, Az. 618-25-02, Beschluss 01.10.2026) — Tenor, Anlage 1, Anlage 2; EEG §§ 19, 21a, 21b,
51, 51b. Konzept: MiSpeL-Fundament § 5.1, Entscheid E2 = B, Bauplan § 8 Zeile MP-5; Fassung 1.1 = MP-12b
(AW-Differenzierung, § 7), additiv: jedes Feld von 1.0 bleibt, wie es war; Fassung 1.2 = MP-17 (Vormerken zum
nächsten Monatsersten, § 5; Partner der Direktvermarktung, § 4), additiv: Felder `vormerkung`, `direktvermarkter`,
`bilanzkreis_gesondert`, Route `DELETE …/foerderweg/vormerkung`; Fassung 1.3 = MP-27 (Pauschaloption vormerken mit
offenem Termin, § 5a), additiv: Felder `pauschal_vormerkung`, `pauschaloption_ab`, Route `PUT …/foerderweg/pauschal-vormerkung`,
`DELETE …/vormerkung` nimmt ohne datierte Vormerkung die Pauschal-Vormerkung zurück. MP-27b (Umsetzen der
Pauschal-Vormerkung, § 5a) ändert an der Schnittstelle nichts: Spalte `umgesetzt_in`, Läufer, Fassung 1.3 bleibt.

Der Förderweg ist **ein Stammdatum je Einspeisestelle**, aus dem Netzladen, Exportwert, Marktwertbasis,
Box-Klemme und Portaltexte folgen. Er ersetzt die Bedeutung des Schalters `site.netzladen_erlaubt`
(E2 = B; ein dritter Schalterwert und ein freier Netzlade-Schalter neben dem Förderweg sind verworfen).
Die Einspeisestelle ist die Anlage (`site`): an ihr hängen Schalter, Plan und Box.

| Datei | Rolle |
|---|---|
| [`mispel-foerderweg-vectors.json`](./mispel-foerderweg-vectors.json) | die Wahrheit: Werte, Bestands-Übernahme, Netzladen danach, 25 Fälle mit Fundstelle |
| `services/api/src/main/resources/db/migration/V20261002141500__mispel_site_foerderweg.sql` | Tabelle `site_foerderweg` (Fassungen, RLS + FORCE), beginnt leer |
| `services/api/src/main/resources/db/migration/V20261002173500__mispel_foerderweg_aw_regel.sql` | Spalte `aw_regel` (1.1, § 7), leer für jede vorhandene Fassung |
| `services/api/src/main/resources/db/migration/V20261002231500__mispel_foerderweg_partner.sql` | Spalten `direktvermarkter`, `bilanzkreis_gesondert` (1.2, § 4), leer für jede vorhandene Fassung |
| `services/api/src/main/resources/db/migration/V20261004131500__mispel_pauschal_vormerkung.sql` | Tabelle `site_pauschal_vormerkung` (1.3, § 5a, RLS + FORCE), beginnt leer, keine Fassung |
| `services/api/src/main/resources/db/migration/V20261004171500__mispel_pauschal_vormerkung_umgesetzt.sql` | Spalte `umgesetzt_in` (MP-27b, § 5a): die Fassung, die aus der Vormerkung wurde; leer für jede vorhandene Zeile |
| `services/api/.../mispel/PauschalVormerkungService.java` | Pauschaloption vormerken mit offenem Termin: Voraussetzungen 2–4 der Anlage 2 (§ 5a); `umsetzen` (MP-27b) |
| `services/api/.../mispel/PauschalVormerkungLaeufer.java` | macht aus der Vormerkung eine Fassung, sobald `pauschaloption-ab` gesetzt ist (§ 5a, MP-27b) |
| `services/api/.../mispel/FoerderwegRegeln.java` | die reinen Regeln (ohne Spring, Datenbank, Uhr) |
| `services/api/.../mispel/FoerderwegService.java` | lesen am Tag, setzen als Fassung, Spiegel, alter Schalter |
| `services/api/.../web/SiteFoerderwegController.java` | `GET`/`PUT /api/v1/sites/{siteId}/foerderweg`, `DELETE …/foerderweg/vormerkung` |
| `services/api/.../mispel/FoerderwegSpiegelLaeufer.java` | legt die Spiegel am Tag einer vorgemerkten Fassung um (§ 5) |
| `frontend/portal/src/mispelFoerderweg.ts` · `components/FoerderwegDialog.tsx` | die Fläche: Zeile „Förderweg“ und Dialog „Förderweg ändern“ (MP-17, BK-17 Variante A) |
| `…/mispel/FoerderwegRegelnTest.java` · `…/mispel/FoerderwegApiTest.java` · `…/uems/FoerderwegMigrationTest.java` | Vektoren rein · Routen · Migration auf befüllter DB |

> **Wer anruft (Stand MP-17):** die Routen, `PUT /api/v1/sites/{id}` (alter Schalter, § 6), der
> Optimierer (`inputs.load_foerderwege`, § 5) und das Portal: Anlage › Einstellungen, Zeile „Förderweg“ mit dem
> Dialog „Förderweg ändern“ (MP-17 nach dem abgestimmten Bedienkonzept BK-17, Variante A). Die Box bekommt
> den Förderweg seit MP-14 über den Plan (Feld `foerderweg`, § 5).

## 1. Die fünf Werte (Begriffe aus EEG und Festlegung)

| `foerderweg` | Begriff | Rechtsgrundlage | Netzladen | `plant_kind` |
|---|---|---|---|---|
| `einspeiseverguetung` | Einspeisevergütung | § 19 Abs. 1 Nr. 2 EEG; Speicher nur in der Ausschließlichkeitsoption förderfähig (§ 19 Abs. 3a) | ausgeschlossen | `eigenverbrauch` |
| `marktpraemie_ausschliesslichkeit` | Marktprämie mit Ausschließlichkeitsoption | § 19 Abs. 3 S. 1 Nr. 1, Abs. 3a EEG; A1 S. 11 | ausgeschlossen | `direktvermarktung` |
| `marktpraemie_abgrenzung` | Marktprämie mit Abgrenzungsoption | § 19 Abs. 3b EEG; Tenor Ziff. 3, Anlage 1 | Einstellung des Kunden | `direktvermarktung` |
| `marktpraemie_pauschal` | Marktprämie mit Pauschaloption | § 19 Abs. 3c EEG; Tenor Ziff. 4, Anlage 2 | Einstellung des Kunden | `direktvermarktung` |
| `ungefoerdert` | ungeförderte Direktvermarktung | § 21a EEG; Tenor Ziff. 1 S. 2, Ziff. 2 S. 2 | Einstellung des Kunden | bleibt |

„Förderweg“ ist das Produktwort für Veräußerungsform und Option zusammen (Bauplan § 8.5); jede Antwort
trägt daneben `begriff` und `rechtsgrundlage`. **Formelsatz** (`A1`, `A2`, `A3`, `A4`, `A5`, `A5-Variante`, `A10`, `A11` —
die des Vertrags [MP-4](./mispel-abgrenzung.md), E5 = B; A2–A4 für Ladepunkte seit MP-32): Pflicht in der Abgrenzungsoption; wahlfrei in der
ungeförderten Direktvermarktung, weil die Umlageprivilegien ohne marktprämiengeförderte EE-Anlage ebenfalls
nach Anlage 1 bestimmt werden (Tenor Ziff. 1 S. 2, z. B. reiner Speicher mit A10/A11); sonst leer. Die
Pauschaloption trägt keinen Formelsatz der Anlage 1 (ihre P-Formelsätze kommen mit MP-24).

## 2. Bestand: die Übernahme ohne Zeile

Die Migration legt `site_foerderweg` **leer** an und ändert keine Bestandszeile. Eine Anlage ohne Fassung
hat den Förderweg, den ihre heutigen Schalter bedeuten (`FoerderwegRegeln.ausBestand`, Vektoren `bestand`):

| `netzladen_erlaubt` | `plant_kind` | Förderweg (Bestand) |
|---|---|---|
| `true` | beliebig | `ungefoerdert` (der Händler-Modus, W6) |
| `false` | `direktvermarktung` | `marktpraemie_ausschliesslichkeit` (der EEG-Modus) |
| `false` | `eigenverbrauch` | `einspeiseverguetung` |

Optimierer und Box lesen bis MP-10/MP-14 weiter `site.netzladen_erlaubt` und `site.plant_kind` — für
jede Bestandsanlage also bitgenau dasselbe. Die Antwort nennt `quelle: "bestand"` und `gueltig_ab: null`.
Ohne Fassung gibt es keine Geschichte: der Bestand gilt für jeden Tag, so wie die Schalter heute stehen.

## 3. Fassungen und Regeln

Jede Fassung gilt ab einem Tag (gesetzliche Zeit, A1 S. 33) bis zum Tag vor der nächsten; dieselbe
Anlage hat je Tag höchstens eine wirksame Fassung, eine Korrektur desselben Tages hebt die alte auf
(`aufgehoben_am`). Vor die späteste Fassung wird nichts eingeschoben (`foerderweg_rueckwirkend`). Die
erste Fassung einer Anlage misst sich am Bestand. Geprüft in dieser Reihenfolge (Code § 4):

1. **Form:** Formelsatz bekannt, Pflicht/verboten nach § 1; Netzladen nur, wo der Weg es zulässt.
2. **Vormerken nur zum nächsten Monatsersten:** `gueltig_ab` ≤ heute oder genau der erste Tag des folgenden
   Monats (§ 5, 1.2); an einer Vormerkung keine Angabe `netzladen` (`netzladen_bei_vormerkung`).
3. **Wirkung der Festlegung:** Abgrenzung, Pauschal und jeder Formelsatz frühestens ab 01.10.2026 (Tenor Ziff. 8).
4. **Pauschaloption** erst ab dem Monatsersten nach der EU-Genehmigung (Tenor S. 3 Ziff. 9b): der Tag steht
   in `voltpilot.mispel.pauschaloption-ab` (leer = noch keine Genehmigung = abgelehnt).
5. **Übergangszeit:** bis 30.09.2027 nur mit `einverstaendnis: true` — die Angabe des Kunden, dass Netz- und
   Messstellenbetreiber einverstanden sind (Tenor S. 3 Ziff. 9a; das Paket dafür baut MP-19).
6. **Wechsel nur zum Monatsersten:** ein anderer Förderweg als vorher gilt ab dem ersten Kalendertag eines
   Monats (§ 21b Abs. 1 S. 2 EEG; A1 S. 103 mit Fn. 56; Tenor Ziff. 5 S. 2). Ausnahme: die **erstmalige
   Zuordnung** neu in Betrieb genommener Anlagen (`erstmalige_zuordnung: true`, nur solange die Anlage keine
   Fassung hat) — sie ist eine bestimmungsrelevante Änderung im Monat (Rumpfmonat, A1 S. 103; MP-21).
7. **Bindung des Formelsatzes:** die Wahl zwischen vereinfachtem und umfangreicherem Formelsatz (A3 statt A4,
   A5-Variante statt A5, A10 statt A1, A11 statt A1 bis A4 — `vereinfacht_statt` der Vektoren) ist verbindlich und erst mit Wirkung für ein folgendes Kalenderjahr
   änderbar (A1 S. 24, Abschn. 3.2.3) — also nur mit `gueltig_ab` = 01.01. Ausnahme: eine Änderung des
   Messkonzepts, die einen anderen Formelsatz erzwingt oder erst ermöglicht (`messkonzept_geaendert: true`,
   A1 S. 103 mit Fn. 55). Andere Wechsel (A1 → A5, A10 → A11, A2 → A3 wenn der Speicher zum Ladepunkt kommt)
   sind keine Wahl, sondern eine andere Fallkonstellation (A1 S. 102). A10 ist für Ladepunkte nicht anwendbar
   (A1 S. 95), A11 als Abwandlung zu A4 scheidet aus (A1 S. 99) — beides prüft die Regel noch nicht gegen die
   Zählerrollen (wie das Gebot der Bestnutzung, unten). `formelsatz_gebunden_bis` in der Antwort = 31.12. des Jahres von `am`.
8. **Unverändert:** dieselbe Fassung noch einmal ist 409.

Nach dem Eintrag hält der Schreibweg die **Spiegel** an der Anlage nach: `netzladen_erlaubt` = aus, wo der
Weg Netzladen ausschließt, sonst die Angabe `netzladen` (ohne sie die bisherige Einstellung); `plant_kind`
= der Wert der Tabelle in § 1 (bei `ungefoerdert` unverändert).

## 4. Die Schnittstelle

`GET /api/v1/sites/{siteId}/foerderweg[?am=JJJJ-MM-TT]` (Leseweg der Anlage) →
`{site_id, am, quelle, foerderweg, begriff, rechtsgrundlage, formelsatz, formelsatz_gebunden_bis,
einverstaendnis, gueltig_ab, netzladen: {moeglich, heute}, fassungen[], aw_regel, vormerkung}` (`aw_regel` auch je
Fassung, 1.1; `vormerkung` = `{id, foerderweg, begriff, rechtsgrundlage, formelsatz, einverstaendnis, gueltig_ab,
aw_regel}` oder `null`, immer bezogen auf heute, 1.2; `pauschal_vormerkung` und `pauschaloption_ab`, 1.3, § 5a). `quelle` ∈ `fassung` · `bestand` ·
`unbekannt` (ein Tag vor der ersten Fassung einer Anlage, die schon eine hat — die Schalter sind dann
Spiegel und sagen über die Zeit davor nichts; eine nur vorgemerkte Fassung zählt dafür nicht, bis zu ihrem Tag
gilt der Bestand, 1.2). `netzladen.heute` ist `site.netzladen_erlaubt` heute.

`PUT /api/v1/sites/{siteId}/foerderweg` (Recht `anlage.verwalten`, wie der alte Schalter) mit
`{foerderweg, formelsatz, einverstaendnis, gueltig_ab, netzladen, erstmalige_zuordnung,
messkonzept_geaendert, aw_regel, direktvermarkter, bilanzkreis_gesondert}` → die Ansicht am Tag `gueltig_ab`. Eine fremde Anlage ist 404, nie 403.

**Partner der Direktvermarktung (1.2, MP-17):** `direktvermarkter` (Name des eigenen Direktvermarkters, 1–200 Zeichen
ohne Leerraum am Rand, sonst 400 `anfrage_ungueltig` mit `feld`) und `bilanzkreis_gesondert` (die ganze Einspeisung
in einem gesonderten Bilanzkreis, § 20 S. 2 EEG — Angabe des Kunden). Beide wahlfrei (`null` = nicht erhoben), nur an
einem Weg der Direktvermarktung (an der Einspeisevergütung 422 `partner_passt_nicht`), je Fassung gespeichert und in
der Antwort (oben, je Fassung, in der Vormerkung). Nachtragen ist kein Wechsel des Förderwegs (kein Monatserster).
Ein VoltPilot-Partner ist noch nicht wählbar (E8 = D: erst nach der Wahl aus den Angeboten, MP-43/MP-20).

`DELETE /api/v1/sites/{siteId}/foerderweg/vormerkung` (Recht `anlage.verwalten`, 1.2) nimmt die Vormerkung zurück
(`aufgehoben_am`, sie bleibt lesbar) → die Ansicht heute; ohne datierte Vormerkung die Pauschal-Vormerkung mit offenem
Termin (1.3, § 5a); ohne beide 404 `keine_vormerkung` mit `heute`.

`PUT /api/v1/sites/{siteId}/foerderweg/pauschal-vormerkung` (Recht `anlage.verwalten`, 1.3, § 5a) mit
`{ein_betreiber, steckersolar_kwp, steckersolar_direktvermarktung, direktvermarkter, bilanzkreis_gesondert}` → die
Ansicht heute; streng gelesen wie `PUT …/foerderweg`.

| Code | Status | Fakten (immer mit `fundstelle`) |
|---|---|---|
| `anfrage_ungueltig` | 400 | `feld` |
| `foerderweg_ungueltig` | 400 | `foerderweg` |
| `formelsatz_ungueltig` · `formelsatz_fehlt` · `formelsatz_passt_nicht` | 422 | `formelsatz` bzw. `foerderweg` |
| `aw_regel_ungueltig` · `aw_regel_passt_nicht` (1.1, § 7) | 422 | `aw_regel` bzw. `foerderweg` |
| `netzladen_ausgeschlossen` | 422 (Route) · 409 (alter Schalter) | `foerderweg` |
| `gueltig_ab_in_zukunft` | 422 | `heute`, `naechster_monatserster` (1.2) |
| `netzladen_bei_vormerkung` (1.2) | 422 | `gueltig_ab` |
| `partner_passt_nicht` (1.2) | 422 | `foerderweg` |
| `foerderweg_rueckwirkend` | 409 | `letzte_fassung_ab` |
| `vor_der_festlegung` | 422 | `frueheste` |
| `pauschaloption_noch_nicht_anwendbar` | 422 | `anwendbar_ab` |
| `einverstaendnis_fehlt` | 422 | `bis` |
| `erstmalige_zuordnung_vorbei` | 409 | `letzte_fassung_ab` |
| `wechsel_nur_zum_monatsersten` | 422 | `naechster_monatserster` |
| `formelsatz_gebunden` | 422 | `formelsatz`, `gebunden_bis` |
| `foerderweg_unveraendert` | 409 | `am` |
| `voraussetzung_unbestaetigt` (1.3) | 422 | `feld` (`ein_betreiber` · `steckersolar_direktvermarktung`) |
| `ueber_30_kwp` (1.3) | 422 | `solarleistung_kwp`, `grenze_kwp` |
| `solarleistung_unbekannt` (1.3) | 422 | `grenze_kwp` |
| `vormerkung_besteht` (1.3) | 409 | `gueltig_ab` |
| `termin_steht_fest` (1.3) | 422 | `anwendbar_ab` |

## 5. Was dieser Vertrag nicht regelt — und wie die Leser später lesen

- **Vormerken zum nächsten Monatsersten (1.2, MP-17).** Ein Wechsel gilt ab einem Monatsersten (§ 21b Abs. 1 S. 2
  EEG); damit niemand am Ersten eintragen muss, lässt sich genau der nächste Monatserste vormerken — weiter
  nicht (`gueltig_ab_in_zukunft`). Die Fassung wird sofort gespeichert, die Spiegel an der Anlage aber erst an ihrem
  Tag umgelegt: Optimierer und Box lesen bis MP-14 die Spiegel, darum prüft der `FoerderwegSpiegelLaeufer`
  (`voltpilot.mispel.foerderweg-spiegel.enabled`, stündlich zur Minute 0:30 Europe/Berlin, idempotent, holt nach)
  je Anlage mit Fassung, ob Netzladen und `plant_kind` zur heute geltenden Fassung passen. Netzladen bleibt die
  Einstellung des Kunden und wird nur dort ausgeschaltet, wo der neue Weg es ausschließt; eingeschaltet wird es nie
  von selbst (darum keine Angabe `netzladen` an einer Vormerkung). Ein Plan, der vor 00:00 für die Zeit danach
  gerechnet wurde, gilt bis zum nächsten Lauf des Optimierers. Solange eine Vormerkung steht, schiebt keine Fassung
  davor ein (`foerderweg_rueckwirkend`); ändern = dieselbe Vormerkung noch einmal mit anderen Angaben (Korrektur
  desselben Tages), zurücknehmen = `DELETE …/vormerkung`.
- **Optimierer (MP-10):** liest am Berliner Tag des Laufs die späteste wirksame Fassung mit
  `gueltig_ab <= Tag` aus `site_foerderweg` (`inputs.load_foerderwege`; sie gilt für den ganzen Horizont —
  eine Vormerkung also erst ab dem ersten Lauf an ihrem Tag), ohne Fassung den Bestand nach § 2 — dieselbe Regel, dieselben Vektoren (`bestand`,
  `werte`; `test_mispel_mischbetrieb.py`). Abgrenzung mit A1, A5 oder A5-Variante plant im **Mischbetrieb**
  ([Wegweiser](../../agents/root/mispel-optimierer-mischbetrieb.md)); der Schalter `netzladen_erlaubt` bleibt
  die Einstellung des Kunden. Pauschal mit Jahreslauf (MP-25) plant mit dem **Jahreszustand** (MP-26, Export zu
  blankem Spot, Prämie und Gutschrift nach Jahresstand); Pauschal ohne Jahreslauf und jeder andere Weg fahren weiter
  über die Spiegel: Netzladen eingestellt = Händler-Modus (Export zu blankem Spot), sonst EEG-Modus.
  **Marktwertbasis (MP-12, gebaut):** Optimierer (`marktwertbasis.py`) und Erlöse (`SlotEconomics.marktwertbasisJoinSql`)
  lesen je Berliner Tag die späteste wirksame Fassung; an Tagen in `marktpraemie_abgrenzung`/`marktpraemie_pauschal`
  gilt der Jahresmarktwert Solar und Formel (24)¼ bzw. (P12)¼ (AW>0-Liste der ÜNB nach der `aw_regel` dieser
  Fassung, § 7; ohne Regel der W4-Rückfall „keine Prämie bei SP¼ < 0“, Stand vorläufig); ohne Fassung der Bestand,
  also der Monatsmarktwert. Der Mischbetrieb liest seine Prämie für grün/gelb aus derselben Reihe
  (`pricing.marktpraemie_eur_mwh`) — mit eingetragener `aw_regel` also nach der Liste.
- **Box (MP-14, gebaut):** bekommt den Förderweg des Plantags über den Plan (optionales Feld `foerderweg` in
  `mqtt-schedule.schema.json`, additiv). Die EEG-Klemme löst sich nur, wo die Spalte „Netzladen“ aus § 1 „Einstellung
  des Kunden“ sagt, und nur mit `grid_charge_allowed=true` (dem Spiegel `netzladen_erlaubt`). Einspeisevergütung und
  Ausschließlichkeitsoption klemmen auch bei einem noch nicht umgelegten Spiegel. Fehlt das Feld (alte Cloud), lädt
  die Box nur mit Sonnenstrom ([Wegweiser](../../agents/root/mispel-box-foerderweg.md)).
- **Rechenwerk (MP-8, Läufer MP-8b):** der `MispelMonatslaufLaeufer` liest je Anlage die wirksamen Fassungen
  (`FoerderwegRepository.derAnlage`) und gibt `monatslaeufe` je Fassung einen Fallstand ab `gueltig_ab` — Formelsatz
  und `aw_regel` der Fassung in der Abgrenzungsoption, sonst keine Bestimmung nach Anlage 1; eine Änderung im Monat
  ist ein Rumpfmonat (MP-21). Ohne `aw_regel` (A1–A4) und für A5/A5-Variante überspringt er den Monat
  ([Vertrag Abgrenzung, Der Läufer](./mispel-abgrenzung.md#der-läufer-mp-8b)).
- **Gebot der Bestnutzung** (vereinfacht verboten, wenn die Zähler den genaueren Formelsatz tragen,
  A1 S. 24) prüft der Formelsatz-Vorschlag der Einrichtung (MP-17) gegen die Zählerrollen (MP-6).
- **Rumpfmonate** rechnet MP-21; **Pauschal-Umlageprivilegien für ungeförderte Solaranlagen**
  (Tenor Ziff. 2 S. 2) kommen mit der Pauschaloption (MP-24).
- `dv_konform` (W8) ist mit MP-10 aus dem Optimierer entfernt.

## 5a. Pauschaloption vormerken mit offenem Termin (1.3, MP-27)

Die Pauschaloption gilt erst ab dem Monatsersten nach der Genehmigung der EU-Kommission (Tenor S. 3 Ziff. 9 b); bis
VoltPilot den Tag in `voltpilot.mispel.pauschaloption-ab` einträgt (E7 = B), lehnt `PUT …/foerderweg` sie ab
(`pauschaloption_noch_nicht_anwendbar`), und § 5 erlaubt nur den nächsten Monatsersten. Damit ein Haushalt sich
trotzdem einrichten kann (Bedienkonzept BK-27), hält `site_pauschal_vormerkung` den Wunsch **ohne Tag**:

- **Keine Fassung.** Optimierer, Box, Spiegel-Läufer, Monats- und Jahreslauf lesen die Tabelle nicht; der Förderweg
  bleibt bis zu seinem Tag der heutige (die Ansicht zeigt `pauschal_vormerkung` neben `quelle`/`foerderweg`).
- **Nur solange der Tag offen ist:** ohne `pauschaloption-ab` oder mit einem Tag hinter dem nächsten Monatsersten
  (`termin` = dieser Tag); sonst 422 `termin_steht_fest` — dann geht die Pauschaloption als Fassung nach § 3.
  Steht eine datierte Vormerkung (§ 5), 409 `vormerkung_besteht`; gilt die Pauschaloption schon, 409
  `foerderweg_unveraendert`.
- **Voraussetzungen der Anlage 2 (Abschn. 3.1.1, S. 18–19):** Voraussetzung 2 „personenidentischer Anlagenbetreiber“
  und 4 „auch Steckersolargeräte in der Direktvermarktung“ kann VoltPilot nicht messen — der Kunde bestätigt sie
  (`ein_betreiber: true`; bei `steckersolar_kwp > 0` auch `steckersolar_direktvermarktung: true`), gespeichert mit
  Zeitpunkt (`…_bestaetigt_am`). Voraussetzung 3 (höchstens 30 kWp, Steckersolargeräte nicht mitgezählt, Fn. 14) prüft
  der Dienst gegen die Solarleistung im Aufbau (Summe `asset.pv_capacity_kwp` der PV-Assets): fehlt sie, 422
  `solarleistung_unbekannt` (unbekannt ist keine Null). Für (P1) = Pinst × 500 zählen die Steckersolargeräte mit
  (A2 S. 27); ihre Leistung ist Angabe des Kunden (`steckersolar_kwp`, 0 = keine) zusätzlich zum Aufbau.
- **Ändern** = noch einmal senden (die alte Zeile bekommt `aufgehoben_am`), **zurücknehmen** = `DELETE …/vormerkung`.

**Umsetzen (MP-27b).** Sobald VoltPilot den Tag in `pauschaloption-ab` einträgt, macht der `PauschalVormerkungLaeufer`
(`voltpilot.mispel.pauschal-vormerkung.enabled`, stündlich zur Minute 5 Europe/Berlin, idempotent, holt nach) je Anlage
mit stehender Vormerkung über `PauschalVormerkungService#umsetzen` eine Fassung `marktpraemie_pauschal` — über
`FoerderwegService#setzen`, also nach denselben Regeln wie die Route (§ 3), mit `created_by` = `pauschal-vormerkung-laeufer`:

- **Tag der Fassung** = der früheste Monatserste, der **nach heute** liegt und nicht vor `pauschaloption-ab`: ein
  Wechsel gilt nur ab dem ersten Kalendertag eines Monats (§ 21b Abs. 1 S. 2 EEG; A2 S. 52 mit Fn. 40, Tenor Ziff. 5),
  vormerken lässt sich nur der nächste (§ 5), rückwirkend nie (Optimierer, Box und Direktvermarkter haben die Tage davor
  schon nach dem alten Förderweg gefahren). Liegt der Tag hinter dem nächsten Monatsersten, wartet der Läufer; ohne Tag
  tut er nichts. Wird der Tag erst nach seinem Datum eingetragen, gilt der nächste Monatserste.
- **Rumpfjahr:** das erste Jahr in der Pauschaloption reicht vom Tag der Fassung bis 31.12. — ein Rumpfjahr (A2 S. 52,
  Abschn. 9: „erstmalige Zuordnung … oder ein Wechsel der Zuordnung … zum ersten Kalendertag eines Kalendermonats“), mit
  (P1)R, (P3)R, (P4)R nach Abschn. 9.1–9.2 (S. 53–55); der Jahreslauf liest es so ([Pauschal, Lesart Rumpfjahr-Grenzen](./mispel-pauschal.md#rechenwerk-und-jahreslauf-mp-25)).
- **Übergangszeit (Tenor S. 3 Ziff. 9a):** bis 30.09.2027 gilt die Zuordnung nur im Einverständnis mit Netz- und
  Messstellenbetreiber. Die Vormerkung trägt diese Angabe nicht; liegt der Tag der Fassung bis 30.09.2027, **wartet** die
  Vormerkung (kein Fehler) — umgesetzt wird sie zum 01.10.2027, früher nur über `PUT …/foerderweg` mit `einverstaendnis`.
- **Voraussetzung 3** (30 kWp, A2 S. 19) prüft der Läufer noch einmal gegen den Aufbau von heute.
- **AW-Regel** (§ 7) aus der MiSpeL-Fassung davor (sie gehört zur Anlage, nicht zur Wahl), sonst keine; **Partner**
  (`direktvermarkter`, `bilanzkreis_gesondert`) aus der Vormerkung; `einverstaendnis` = nein.
- **Die Vormerkung bleibt** als Zeile mit ihren Bestätigungen samt Datum (Voraussetzungen 2 und 4) stehen, wird
  aufgehoben und nennt die Fassung (`umgesetzt_in`, `V20261004171500`); aufgehoben ohne `umgesetzt_in` = zurückgenommen.
  Galt am Tag schon die Pauschaloption (vom Kunden eingetragen), wird nur verknüpft.
- **Fehler je Anlage** halten die anderen nicht auf und lassen die Vormerkung stehen: Solarleistung unbekannt oder über
  30 kWp, eine andere zum selben Tag vorgemerkte Fassung (`vormerkung_besteht`, der Läufer wählt nicht zwischen zwei
  Wünschen), jede Ablehnung nach § 3. Sie zählen am Melder `mispel_pauschal_vormerkung`
  ([Betriebsüberwachung](../../agents/root/uems-betriebsueberwachung.md)).

**Offen (bewusst):** das Einverständnis der Übergangszeit an der Vormerkung (braucht eine Frage im Portal — erst mit
abgestimmtem Bedienkonzept; bis dahin zeigt die Ansicht `termin` = `pauschaloption-ab`, auch wenn die Vormerkung bis
zum 01.10.2027 wartet) und die Bestätigungen an einer datierten Pauschal-Fassung, die der Kunde selbst einträgt.

## 6. Der alte Netzlade-Schalter (bis MP-17, W2 = B)

Das Portal bietet den Schalter seit MP-17 nur noch dort an, wo der Förderweg Netzladen zulässt; den Weg selbst
ändert der Dialog „Förderweg ändern“ über die Route aus § 4. `PUT /api/v1/sites/{id}` nimmt `netzladenErlaubt` und
`plantKind` weiter an. **Ohne Fassung** bleibt alles
wie heute — die Schalter SIND der Bestand, ein Umschalten wirkt sofort und ändert den Bestands-Förderweg
mit (keine Fassung, kein Monatserster: so verhält sich das heutige Portal). **Mit Fassung** bestimmt der
Förderweg: `netzladenErlaubt: true` bei Einspeisevergütung oder Ausschließlichkeitsoption ist 409
`netzladen_ausgeschlossen` (nichts gespeichert); wo der Weg Netzladen zulässt, ist der Schalter die
Einstellung des Kunden; `plantKind` folgt dem Förderweg (eine abweichende Angabe wird durch den Wert aus
§ 1 ersetzt).

## 7. Die AW-Differenzierung (Fassung 1.1, MP-12b)

Die Marktprämie der Abgrenzungs- und der Pauschaloption gibt es nur für die Netzeinspeisung in AW>0-Zeiten:
Formel (24)¼ = WENN [ AW¼ > 0 ; 1 ; 0 ] (A1 S. 17, Abschn. 2.1.7, und S. 38; (P12)¼ A2 S. 14–15 und S. 31). „In
welchen Viertelstunden sich der anzulegende Wert nach den verschiedenen gesetzlichen Differenzierungen aufgrund
von negativen (bzw. schwach positiven) Spotmarktpreisen auf null verringert, veröffentlichen die
Übertragungsnetzbetreiber“ (A1 S. 17 Fn. 8). `aw_regel` sagt, welche dieser Veröffentlichungen für die Anlage gilt —
dasselbe Vokabular wie `eeg_aw_zeit.regel` (MP-7, Vektoren `aw_regeln`):

| `aw_regel` | Veröffentlichung der ÜNB | Rechtsgrundlage |
|---|---|---|
| `viertelstunde` | „1 Viertelstunde“ | § 51 EEG |
| `viertelstunde_2ct` | „2ct Logik“ | § 51b EEG (bestimmte Biogasanlagen, A1 S. 17 Fn. 7) |
| `stunden_1` · `stunden_2` · `stunden_3` · `stunden_4` · `stunden_6` | „1/2/3/4/6 Stunde(n)“ | § 51 EEG |

- **Der Betreiber trägt sie ein.** VoltPilot leitet sie nicht aus Inbetriebnahme, Leistung oder Energieträger ab;
  welche Fassung des § 51 EEG für eine Anlage gilt, folgt aus ihren Übergangsbestimmungen, nicht aus einer Formel.
- **Wahlfrei, nur an einer MiSpeL-Option** (`marktpraemie_abgrenzung`, `marktpraemie_pauschal`). Ohne Regel
  (`null`) rechnen Optimierer und Erlöse den W4-Rückfall „AW¼ = 0 bei SP¼ < 0“, und die Marktprämie ist
  vorläufig (`SiteAggregate.marktpraemieVorlaeufig`). An einem anderen Förderweg ist sie 422
  `aw_regel_passt_nicht` — dort rechnet keine Formel (24)/(P12).
- **Eine Regel je Einspeisestelle.** Mehrere Anlagen hinter derselben Einspeisestelle gelten für die
  Förderzahlung als eine Anlage „mit einem anzulegenden Wert und einheitlichen AW>0-Zeiten“ (A1 S. 7 Fn. 1;
  A2 S. 5 Fn. 1; § 24 Abs. 1 EEG). **Offen:** A5/A5-Variante mit zwei geförderten Anlagen a und b und
  „ggf. unterschiedlichen AW>0-Zeiten“ (A1 S. 46, Formeln (24a)/(24b); S. 51) — `aw_regel` ist dort die Regel
  der Anlage a (AWa¼); AWb¼ übergibt der Aufrufer des Rechenwerks weiter selbst (`Vorgaben.awRegelB`), bis der
  Förderweg sie trägt (der Läufer überspringt A5/A5-Variante, § 5, Rechenwerk).
- **Fassungen wie jede andere Angabe** (§ 3): die Regel nachzutragen oder zu berichtigen ist kein Wechsel des
  Förderwegs und darum an keinen Monatsersten gebunden; dieselbe Regel noch einmal ist 409
  `foerderweg_unveraendert`. Soll sie schon ab dem Tag der Fassung gelten, wird dieselbe Fassung mit Regel und
  demselben `gueltig_ab` noch einmal eingetragen (Korrektur desselben Tages, § 3).
- **Bestand:** die Spalte beginnt leer; jede Fassung von 1.0 behält `null` und rechnet bitgenau wie vorher.
- **Leser:** Optimierer `marktwertbasis.load_marktwertbasis` (die Regel je MiSpeL-Tag, `MarktwertBasis.aw_regeln`),
  Erlös-SQL `SlotEconomics.AW_REGEL_SQL = fw.aw_regel`, Fahrplan-Twin `OptimizerDiagnosticsRepository.marktwertbasis`.
  Jede Viertelstunde nimmt die Liste der Regel ihres Berliner Tages; Stundenzeilen gelten für ihre vier
  Viertelstunden, die feinere Auflösung gewinnt.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='FoerderwegRegelnTest')                         # rein, kein Docker
(cd services/api && ./mvnw test -Dtest='FoerderwegApiTest,FoerderwegMigrationTest')    # Testcontainers
(cd services/api && ./mvnw test -Dtest='PauschalVormerkungApiTest')                    # 1.3 § 5a und Jahresstand (MP-27)
(cd services/api && ./mvnw test -Dtest='PauschalVormerkungLaeuferTest')                # § 5a Umsetzen (MP-27b)
(cd services/api && ./mvnw test -Dtest='MarktwertbasisErloeseTest')                    # Prüfnachweis MP-12/MP-12b
(cd services/optimization && PYTHONPATH=. uv run --no-project --with pytest python -m pytest tests/test_marktwertbasis.py)
```
