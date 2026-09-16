# UEMS-Messstellenregister: Abnahme A1–A17 (AP-04 IP-22)

Abschlusswegweiser für AP-04. Die Tabelle ist das Inventar der vorhandenen Abnahmen; sie verweist
bewusst auf die Tests der Einzelpakete, statt dieselben Szenarien ein zweites Mal aufzubauen.
`MessstellenregisterNachbarbedarfTest` hält nur die noch nicht ausführbaren Teilzusicherungen mit
zuständigem Nachbarn sichtbar. Es gibt keine neue Migration und keine Änderung an einer Vektordatei.

## Abnahme-Inventar

| Fall | Grüner Kern: Klasse · Methode | Noch offener Nachbarteil |
|---|---|---|
| A1 | `ZaehlerwechselApiTest.derZaehlerwechselVonMs06IstEinVorgang` | — |
| A2 | `AenderungsprotokollApiTest.a2DerAmZwanzigstenNachgetrageneWechselBleibtAmAchtzehntenAuffindbar` | AP-12: Folgen-Karte nennt Tagesberichte 18./19.11. |
| A3 | `ZaehlerwechselApiTest.einAngekuendigterWechselIstErlaubtUndHeisstGeplant` | Korrektur-Schreibweg 10:00 → 10:40 |
| A4 | `QuelleEinstellungApiTest.aVierWandlerwechselAnGrZweiDokumentiertUndKeinGespeicherterWertAendertSich` | Einstellungs-Fakt in beiden Registerzeilen |
| A5 | `QuelleEinstellungApiTest.aFuenfAngewendeterWandlerfaktorWirktNurAbGueltigkeitsbeginnUndDieBoxBekommtNichts`; `geraetEinstellungen.test.ts` · `A5: …` | AP-06/Edge: Zustellung an die Box |
| A6 | `ZaehlerwechselApiTest.a6ControllerWechseltVierKartenUndBindungenAtomarMitEigenenEndstaenden` | — |
| A7 | `DatenquelleApiTest.a7EdgeWechselLaesstMessstellenGebundenUndTraegtDieBoxJeMesszeit` | — |
| A8 | `MessstelleQuelleApiTest.jedeLaufendeQuelleNenntIhrenEigenenLetztenWertUndIhrenAnzeigenamen`; `quelleBinden.test.ts` · `A8 — MS-01 …` | — |
| A9 | `MessstelleVorschlagApiTest.a9AchtVorschlaegeNieEinAttributKanalUndDieUebernahmeAbVerlaufsbeginn` | — |
| A10 | `MessstelleQuelleApiTest.diePassungLehntJeGrundAbUndDerVorzeichenWertBindetNurMitAnteil`; `MessstelleRegisterApiTest.dieFilterSchneidenStandortOrtAnlageZustandUndOhneQuelle` | AP-13: Wertefläche bietet Gas noch einen Katalog-Quellenweg an |
| A11 | `MessstelleZuordnungApiTest.a11FremdanlageZyklusUndDieUnterzaehlerDerGeaendertenMessstelle` | — |
| A12 | `MessstelleApiTest.a12ArchiviertesKennzeichenBleibtBelegtUndMs0022BleibtVorgeschlagen` | — |
| A13 | `MessstelleQuelleApiTest.archivierenBeendetDieOffenenQuellenZumArchivzeitpunkt`; `MessstelleZuordnungApiTest.archivierenBeendetDieZuordnungenAmVortagUndNichtsLiegtVorDemBeginn` | AP-12: Juni-Bericht über den Archivweg byte-gleich |
| A14 | `RechtMatrixApiTest.jeMatrixZeileDerGruppenEinsBisDreiUrteilenDieAchtPersonen`; `rollenRechte.test.tsx` · `messstelle.bearbeiten` | — |
| A15 | `ZaehlerwechselApiTest.jedeAblehnungNenntGrundUndZeitpunktUndSchreibtNichts` | — |
| A16 | `ZaehlerwechselApiTest.derZaehlerwechselVonMs06IstEinVorgang` | AP-08: 5/2 Minuten als Viertelstunden- und Tagesurteil |
| A17 | `MessstelleRegisterApiTest.a17DerStandAmVorUndNachDemZaehlerwechsel`; `messstellen.test.ts` · `A17: …` | — |

## Die sieben sichtbaren Nachbarbedarfe

Die deaktivierten Methoden in `MessstellenregisterNachbarbedarfTest` sind absichtlich keine
Ersatzimplementierung. Sie benennen die noch fehlende Kopplung und werden erst aktiviert, wenn der
jeweilige Nachbar den echten Schreib-/Leseweg liefert:

- A2 Berichtsfolgen (AP-12), A3 Korrektur eines angekündigten Wechsels, A4 Einstellungs-Fakt im Register,
- A5 Edge-Zustellung (AP-06), A10 Gas-Quellenweg im Portal (AP-13),
- A13 Bericht-Bestandsschutz (AP-12), A16 Periodenurteil (AP-08).

Die grüne A7-Abnahme ersetzt den früher vorgesehenen AP-06/AP-07-Skip: Quellenbindungen und
Messstellenprotokoll bleiben beim Boxwechsel unverändert, die Zuständigkeit zur Messzeit bestimmt
die Herkunft.

## Prüfen

```bash
(cd services/api && ./mvnw clean test -Dtest=AenderungsprotokollApiTest,ZaehlerwechselApiTest,QuelleEinstellungApiTest,MessstelleQuelleApiTest,MessstelleVorschlagApiTest)
(cd services/api && ./mvnw clean test -Dtest=DatenquelleApiTest,MessstelleApiTest,MessstelleZuordnungApiTest,MessstelleRegisterApiTest,RechtMatrixApiTest,MessstellenregisterNachbarbedarfTest)
(cd frontend/portal && npx vitest run src/geraetEinstellungen.test.ts src/quelleBinden.test.ts src/messstellen.test.ts src/rollenRechte.test.tsx src/copy.test.ts)
bash tools/agents-md-budget.sh
```

Testcontainers-Läufe in kleinen Stapeln fahren; ein Ergebnis ohne Surefire-Zusammenfassung ist kein
Nachweis. Da keine Vektordatei geändert wird, ist für IP-22 kein zusätzlicher Vertragsleser-Lauf
ausgelöst.
