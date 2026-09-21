# Gemeinsame Steuerung — Deckungsblatt NW-4 und NW-6 (AP-15 IP-30)

Je Matrixzeile mit NW-4/NW-6 und je Stichwort der §8-Zelle: welcher Test es beweist und was er zeigt.
`T/` = `services/api/src/test/java/com/voltpilot/api/`, `O/` = `services/optimization/tests/`.
**Neu** = mit IP-30 dazugekommen. Box-Seite (NW-2, Go) und Simulator (NW-3) sind nicht Teil dieses Blatts.

## NW-4 — Planer- und API-Tests

| Zeile · Stichwort | Test | Was er zeigt |
|---|---|---|
| A3/R6 Cloud weg | `O/test_plan_je_box.py::test_zyklus_r1_zwei_dokumente_zweimal_veroeffentlicht`, `::test_p1_laufnummer_je_anlage_aufsteigend` | ein Lauf → zwei Dokumente, eine `plan_id`, Laufnummer steigt je Anlage (nach der Rückkehr: nächster Lauf, neue Nummer) |
| A3 Anteile ohne Ablauf | `T/uems/SteuerungsverbundAnteilDienstTest#a10HaengenderZweischritt…` **neu** | drei Tage später mit neuem Dienst steht der Übergang noch; kein Zeitablauf. Retained ohne Ablauf: `VerbundAnteilePublisher` (`setRetained(true)`, kein Ablauf) — kein eigener Test |
| A5/R7 einseitig stumm (Planer) | `O/test_planlauf_anteile.py::test_r7_stumme_box_ihr_ungenutzter_anteil_geht_an_niemanden`, `::test_r7_stumme_box_verbraucher_bekommen_nichts_und_bezug_ist_reserviert`, `::test_y4_nach_90_s_ohne_herzschlag_stumm`; `O/test_plan_je_box.py::test_zyklus_unbestaetigtes_mitglied_nur_die_fuehrende_einmal_vermerkt` | der Anteil der stummen Box bleibt reserviert, die andere Box bekommt weiter ihren Plan |
| A5/R7 einseitig stumm (Zweischritt) | `T/uems/SteuerungsverbundAnteilDienstTest#a5EinseitigStummDieVerengteBoxQuittiertNichtDieAndereWirdNieErweitert` **neu** | E-4 soll enger werden (Bezug 77 → 47), quittiert nicht: E-1 quittiert, bleibt bei 0 kW, kein Zielstand, keine zweite Änderung |
| A6/R8 alter Partner-Wert | `O/test_eingang_je_box.py::test_r8_veraltet_an_der_eigenen_box_heisst_unbekannt_nie_der_partnerwert`, `::test_r8_der_juengere_speicherstand_der_fremden_box_wird_nie_genommen`, `::test_r8_gleicher_zeitstempel…`; im Lauf `O/test_planlauf_anteile.py::test_b5_box_ohne_bekannten_anteil_wird_stumm_und_ohne_kommando_geplant` | Wert älter als seine Frist = unbekannt für DIESE Box, nie der Wert der anderen |
| A9/R11 fehlende Plan-Quittung | `T/uems/PlanZustellungApiTest#r11VeroeffentlichtGegenAngenommenJeBox`, `#alteBoxOhneQuittungBehaeltAngenommenLeer` | veröffentlicht ≠ angenommen je Box sichtbar. Anteile unberührt: der Plan-Weg schreibt keine Anteils-Tabelle (`PlanResultListener` ≠ `VerbundAnteileResultListener`), das Plan-Dokument trägt nur `gemeinsame_steuerung.rolle`, keinen Anteil (`publisher_v2.py`) — kein eigener Test |
| A10/R12 hängender Zweischritt | `T/uems/SteuerungsverbundAnteilDienstTest#r12Zweischritt…`, `T/uems/SteuerungsverbundZweischrittTest#r12ZweischrittNieUeber100…` | ohne Quittung der Verengten bleibt 10/60 |
| A10 über Neustart, alte Quittung | `T/uems/SteuerungsverbundAnteilDienstTest#a10HaengenderZweischrittUeberstehtDenNeustartUndEineAlteQuittungZaehltNicht` **neu** | neuer Dienst ohne Gedächtnis, +3 Tage: Übergang steht; späte Quittung der alten Revision 2 zählt nicht; erneut zugestellt wird Revision 3; erst deren Quittung → Zielstand |
| A18 Epoche nach Rückspielen | `T/uems/SteuerungsverbundAnteilDienstTest#a18Rueckspielen…`, `T/uems/SteuerungsverbundZweischrittTest#a18EinStandUeberDemGesendeten…` | höherer Stand = zurückgespielt, nur neue Epoche mit Herzschlag-Anteilen |
| A18 alte Epoche als Quittung | `T/uems/SteuerungsverbundAnteilDienstTest#epocheNachRueckspielenEineQuittungDerAltenEpocheIstKeineQuittung` **neu** | eine verspätete Quittung (Epoche 1, Revision 9) nach dem Neu-Scharfschalten (Epoche 2) ist keine Quittung; neu zugestellt wird Epoche 2 — **deckte ein Loch auf, geheilt** |
| A11/R13 zwei Befehlsquellen | Box: NW-2. Cloud „ein Gerät — eine Box“: `T/uems/PushJeBoxTest#disjunktUndVollstaendigUeberAlleKleinenWelten`, `T/uems/RegistryPushJeBoxApiTest#a1JedeBoxBekommtGenauIhreQuellen…`, `O/test_plan_je_box.py::test_r1_zwei_boxen_zwei_dokumente_eine_plan_id` (jede Entität genau einmal), `T/uems/GemeinsameSteuerungKeinVerbundApiTest#t6…` | keine Entität in zwei Pushes oder zwei Plan-Dokumenten; Steuerquelle wechselt scharf nur als Änderung |
| A12/R14 Box ohne Fähigkeit | `T/uems/GemeinsameSteuerungApiTest#heuteKommtDieAnlageBisS1UndScharfschaltenSagtFaehigkeitFehlt`, `T/uems/SteuerungsverbundScharfschaltenTest`, `O/test_plan_je_box.py::test_load_verbund_box_ohne_faehigkeit_wird_als_belegt_gerechnet`, `T/chargers/LadeparkJeBoxApiTest#r14UnscharfBleibtDie422` | 409 `faehigkeit_fehlt`, belegt gerechnet, kein Dokument, 422 bleibt |
| A14/R17 Box-Tausch | `T/uems/GemeinsameSteuerungApiTest#mitgliedBestaetigenNurDiePlattformUndNurEinmal`, `O/test_plan_je_box.py::test_belegte_box_bekommt_kein_dokument…[unbestaetigt]` | nur der Schritt „Betreiber bestätigt“; **Befund**: kein Weg vom Box-Tausch (`DatenquelleRegeln` „Box tauschen“) in den Verbund |

## NW-6 — Bestandsschutz

| Dokument | Test | Was er zeigt |
|---|---|---|
| Plan | `O/test_bestandsschutz_nw6.py` **neu** | Fingerabdruck vom Stand VOR AP-15 (`73e2371d6^`) festgehalten; heute gleich über Builder, `plan_je_box` ohne Stand und den ganzen Zyklus |
| Plan (Paar im Code) | `O/test_plan_je_box.py::test_nw6_ohne_scharfe_steuerung_byte_gleich_und_einmal_vermerkt`, `O/test_eingang_je_box.py::test_ein_box_anlage_liest_dieselben_eingaenge_mit_und_ohne_box` | mit/ohne AP-15-Pfad gleich |
| Registry-Push | `T/uems/RegistryPushJeBoxApiTest#eineAnlageMitEinerBoxSendetDenselbenPushWieVorher` | mit/ohne im selben Lauf gleich — **keine festgehaltenen Bytes von vor AP-15** |
| Ladepark-Dokument | `T/chargers/LadeparkJeBoxApiTest#nw6OhneScharfeGemeinsameSteuerungIstDasDokumentByteGleich` | `verbundLesen(null)` = `verbundLesen(verbund)` byte-gleich — **keine festgehaltenen Bytes von vor AP-15** |
| Zwei Boxen ohne Einrichtung (I6) | `T/uems/SteuerungsverbundAnteilDienstTest#bestandOhneVerbundKeinDokumentKeinTopic`, `T/uems/VerbundBilanzApiTest#ohneGemeinsameSteuerungKeinLaufKeineZeileKeineReihe`, `O/test_eingang_je_box.py::test_ip14_zwei_boxen_ohne_scharfen_verbund_eingang_wie_heute`, `O/test_kein_verbund.py` | kein Dokument, kein Topic, keine Bilanz, Eingang wie heute |

## Verbund-Bilanz und nachgelieferte Viertelstunden (A4)

`T/uems/VerbundBilanzApiTest#a4NachgelieferteViertelstundeWirdNachgerechnetNieGuenstigerOhneVollstaendigeDaten`
**neu**: bis IP-30 rechnete der Läufer den Vortag genau einmal; eine nach 04:37 nachgelieferte Viertelstunde fehlte
dauerhaft. Jetzt urteilt der Takt die drei Tage davor neu, soweit sie noch `unbekannt` stehen (48 h Puffer + ein
Tag Verdichtung); lückenhaft bleibt `unbekannt` (B5), ein gefälltes Urteil bleibt unberührt.
