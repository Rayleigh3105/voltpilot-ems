# UEMS-Edge-Abnahme A1–A15 (AP-06 IP-20)

Abschlussinventar für AP-06. Die Einzelpakete haben die Cloud-Regeln bereits gegen echte
TimescaleDB-/Broker-Container gebaut. Dieses Paket dupliziert die Szenarien nicht: Es ergänzt den
fehlenden Offline-Simulator mit zwei eigenen Box-Identitäten und ordnet jeden Abnahmefall seinem
vorhandenen Test zu. Quelle der Simulatorwelt ist ausschließlich
`docs/contracts/v2/uems-referenzunternehmen.json`.

## Abnahme-Inventar

| Fall | Grüner Kern: Klasse · Methode | Simulator |
|---|---|---|
| A1 | `RegistryPushJeBoxApiTest.a1JedeBoxBekommtGenauIhreQuellenUndDieSchnittmengeIstLeer` | `test_a1_two_edges_configure_no_foreign_sources` |
| A2 | `StandortApiTest.a2A15AusfallAm03112026LiestNurFestgehalteneFaktenUndFremdBleibt404`; `UemsViertelstundeMengeTest.planAbnahme2EinBoxAusfallErscheintNieAlsGemessenerStillstand` | `test_a2_failure_marks_only_the_sources_of_box_halle_2_offline` |
| A3 | `UemsQuellenUebergabeTest.a3HinUndZurueckMitFakeUhrKeineDoppellesungLueckeHoechstensEinQuellentakt` | `test_a3_handover_of_dq3_never_double_reads_and_returns_to_box_halle_1` |
| A4 | `UemsDatenquelleMigrationTest.antragWasDieDatenbankDavonTraegt` · dynamischer Fall `a4-gleiche-adresse-anderes-netz-andere-box` | `test_a4_identical_controller_addresses_remain_distinct_by_box_and_network` |
| A5 | `BoxTauschApiTest.a5UebernimmtOhneDeleteUndPushAnNeueBox` | — |
| A6 | `DatenquelleBudgetTest.a6SzenarienS1BisS7` | — |
| A7 | `DataSourceStatusListenerTest.alterHerzschlagErfindetKeinenQuellstatus`; `boxUebersicht.test.ts` · `Software 2.5.0 …` | — |
| A8 | `DatenquelleApiTest.dieFamilieAntragLaeuftDurchDieSchnittstelle` · dynamische Fälle `a8-*` | — |
| A9 | `LeadDeviceServiceTest.a9EineZweiteBoxAendertDieFuehrungNicht`; `DatenquelleVorschlagApiTest.a9ZweiteBoxVorschlaegeJeBoxDieFuehrendeBleibt` | — |
| A10 | `DatenquelleApiTest.a10Budget422TraegtRechnungUndZweiAuswegeUndLaesstDenBestandUnberuehrt`; `DatenquelleBudgetTest.a10NenntTakt60UndBoxMit29FreienAnfragenOhneDenBestandZuAendern` | — |
| A11 | `DatenquellePruefungBewertungTest.a11UnreachableZaehltMitDemSatzDerFehlerklasse`; `ProbeServiceBoxTest.fragtGenauDieGenannteBoxAufIhremEigenenTopicUndGibtIhreAntwortZurueck` | — |
| A12 | `DatenquelleVorschlagApiTest.halle1WirdGenauDq1BisDq3`; `RegistryPushJeBoxApiTest.eineAnlageMitEinerBoxSendetDenselbenPushWieVorher` | — |
| A13 | `DatenquelleApiTest.a13DieSteuerquelleWechseltNicht409MitGrund` | `test_a13_control_source_cannot_change_box_and_only_one_plan_recipient_remains` |
| A14 | `ChargerApiTest.a14ChargingParkConfigurationReachesExactlyTheStationBox` | — |
| A15 | `StandortApiTest.a2A15AusfallAm03112026LiestNurFestgehalteneFaktenUndFremdBleibt404`; `KadenzRegelnTest.a15DieKadenzAlsFaktGibtDieAbdeckungOhneAufzufuellen` | — |

## Bewusste Nachbargrenze

`UemsQuellenUebergabeTest.a3QuelleAusAnlageHalle1AnBoxMitHeimatHalle2` bleibt mit seinem bereits
vorhandenen `@Disabled` sichtbar: Der Timescale-Writer schreibt noch die Anlage des Umschlags, daher
ist die anlagenübergreifende Herkunft erst mit der dort genannten AP-07-Writer-Kopplung ausführbar.
Die aktive A3-Abnahme läuft innerhalb einer Anlage und beweist den Entzug vor Freigabe sowie die
fehlende Doppel-Lesung. Der Simulator kann die beschlossene Ahrenberg-Zeitachse unabhängig davon
vollständig auflösen.

## Simulator

`tools/edge-simulator/uems_ahrenberg.py` erzeugt für Werk Ahrenberg genau zwei aktive Boxen. Jede
erhält eine stabile, eigene UUID aus ihrer Seriennummer und ausschließlich die zeitgültigen Quellen.
Ohne Broker oder Zugangsdaten lassen sich Normalstand, Wechselkante und Ausfall ausgeben:

```bash
(cd tools/edge-simulator && python3 uems_ahrenberg.py)
(cd tools/edge-simulator && python3 uems_ahrenberg.py --at 2027-04-10T07:30:00+02:00)
(cd tools/edge-simulator && python3 uems_ahrenberg.py --offline-box E-2)
```

## Prüfen

```bash
(cd tools/edge-simulator && python3 -m pytest test_edge_sim.py test_uems_ahrenberg.py -q)
(cd services/api && ./mvnw clean test -Dtest=RegistryPushJeBoxApiTest,StandortApiTest,UemsViertelstundeMengeTest,UemsQuellenUebergabeTest,UemsDatenquelleMigrationTest)
(cd services/api && ./mvnw clean test -Dtest=BoxTauschApiTest,DatenquelleApiTest,DatenquelleBudgetTest,DataSourceStatusListenerTest,DatenquelleVorschlagApiTest)
(cd services/api && ./mvnw clean test -Dtest=LeadDeviceServiceTest,DatenquellePruefungBewertungTest,ProbeServiceBoxTest,ChargerApiTest,KadenzRegelnTest)
bash tools/agents-md-budget.sh
```

Die Containerklassen werden in drei kleinen Stapeln gefahren. Ein Lauf zählt nur mit sichtbarer
Surefire-Zusammenfassung. Es gibt keine Migration und keine geänderte Vertrags-/Vektordatei.
