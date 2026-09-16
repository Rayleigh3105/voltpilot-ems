# UEMS-Messstellenregister: Abnahme A1–A17 (AP-04 IP-22)

Abschlusswegweiser für AP-04. Die Tabelle ist das Inventar der vorhandenen Abnahmen; sie verweist
bewusst auf die Tests der Einzelpakete, statt dieselben Szenarien ein zweites Mal aufzubauen.
`MessstellenregisterNachbarbedarfTest` hält nur die noch nicht ausführbaren Teilzusicherungen mit
zuständigem Nachbarn sichtbar. Es gibt keine neue Migration und keine Änderung an einer Vektordatei.

## Abnahme-Inventar

| Fall | Grüner Kern: Klasse · Methode | Noch offener Nachbarteil |
|---|---|---|
| A1 | `ZaehlerwechselApiTest.derZaehlerwechselVonMs06IstEinVorgang` | — |
| A2 | `AenderungsprotokollApiTest.a2DerAmZwanzigstenNachgetrageneWechselBleibtAmAchtzehntenAuffindbar`; `UemsStrukturAenderungTest.a2EinSpaeterZaehlerwechselStoesstBetroffeneBerichteAnUndAendertKeinenStand`; `zaehlerwechsel.test.ts` · A2 | — |
| A3 | `ZaehlerwechselApiTest.einAngekuendigterWechselIstErlaubtUndHeisstGeplant` | eigener Folge-Schnitt: Korrektur braucht neue Rechte für sechs Zeitachsen und einen autorisierten Schreibweg |
| A4 | `QuelleEinstellungApiTest.aVierWandlerwechselAnGrZweiDokumentiertUndKeinGespeicherterWertAendertSich`; `messstellen.test.ts` · `A4: …` | — |
| A5 | `QuelleEinstellungApiTest.aFuenfAngewendeterWandlerfaktorWirktNurAbGueltigkeitsbeginnUndDieBoxBekommtNichts`; `geraetEinstellungen.test.ts` · `A5: …` | AP-06/Edge: Zustellung an die Box |
| A6 | `ZaehlerwechselApiTest.a6ControllerWechseltVierKartenUndBindungenAtomarMitEigenenEndstaenden` | — |
| A7 | `DatenquelleApiTest.a7EdgeWechselLaesstMessstellenGebundenUndTraegtDieBoxJeMesszeit` | — |
| A8 | `MessstelleQuelleApiTest.jedeLaufendeQuelleNenntIhrenEigenenLetztenWertUndIhrenAnzeigenamen`; `quelleBinden.test.ts` · `A8 — MS-01 …` | — |
| A9 | `MessstelleVorschlagApiTest.a9AchtVorschlaegeNieEinAttributKanalUndDieUebernahmeAbVerlaufsbeginn` | — |
| A10 | `MessstelleQuelleApiTest.diePassungLehntJeGrundAbUndDerVorzeichenWertBindetNurMitAnteil`; `uemsWerteKarte.test.ts` und `WerteSektion.test.tsx` · `A10: …` | — |
| A11 | `MessstelleZuordnungApiTest.a11FremdanlageZyklusUndDieUnterzaehlerDerGeaendertenMessstelle` | — |
| A12 | `MessstelleApiTest.a12ArchiviertesKennzeichenBleibtBelegtUndMs0022BleibtVorgeschlagen` | — |
| A13 | `MessstelleQuelleApiTest.archivierenBeendetDieOffenenQuellenZumArchivzeitpunkt`; `MessstelleZuordnungApiTest.archivierenBeendetDieZuordnungenAmVortagUndNichtsLiegtVorDemBeginn`; `MessstelleApiTest.a13ArchivierenLaesstDenFreigegebenenJuniBerichtByteGleich` | — |
| A14 | `RechtMatrixApiTest.jeMatrixZeileDerGruppenEinsBisDreiUrteilenDieAchtPersonen`; `rollenRechte.test.tsx` · `messstelle.bearbeiten` | — |
| A15 | `ZaehlerwechselApiTest.jedeAblehnungNenntGrundUndZeitpunktUndSchreibtNichts` | — |
| A16 | `UemsZaehlerbruecheTest.a16DieWechsellueckeBleibtBisZumTagesurteilSichtbar` | — |
| A17 | `MessstelleRegisterApiTest.a17DerStandAmVorUndNachDemZaehlerwechsel`; `messstellen.test.ts` · `A17: …` | — |

## Die zwei sichtbaren Nachbarbedarfe

Die deaktivierten Methoden in `MessstellenregisterNachbarbedarfTest` sind absichtlich keine
Ersatzimplementierung. Sie benennen die noch fehlende Kopplung und werden erst aktiviert, wenn der
jeweilige Nachbar den echten Schreib-/Leseweg liefert:

- A3 Korrektur eines angekündigten Wechsels,
- A5 Edge-Zustellung (AP-06).

A2 nutzt den vorhandenen AP-12-Strukturpfad: Entwürfe werden neu gebildet, freigegebene Stände
bleiben byte-gleich und erhalten nur einen Revisions-Anstoß. A13 ändert den Archivweg nicht; der
Test friert den Juni-Bericht vor dem Archivieren ein und vergleicht danach seine UTF-8-Bytes und
Prüfsumme.

Die grünen Nachbarabnahmen A4, A7, A10 und A16 ersetzen ihre früheren Platzhalter: Einstellungsfakten
stehen im Register, Gas bietet keinen Katalog-Quellenweg, und die Wechsellücke bleibt bis zum Tagesurteil sichtbar.

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
