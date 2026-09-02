# Erlöse: EIN Bezugspreis je Karte (Release-Notiz zu Captain-Entscheid E7)

**Wirksam mit dem Deploy dieser Änderung. Kein Schema, keine Migration, kein
neuer Endpunkt - reiner Lesepfad.** Betroffen sind
`GET /api/v1/earnings` und `GET /api/v1/sites/{id}/earnings` und damit die
Erlöse-Seite, der Geld-Held des Cockpits und das Portfolio.

## Was sich ändert

Der **Wert des Eigenverbrauchs** wird ab jetzt mit **derselben Preiskomposition
bewertet wie die Stromkosten derselben Karte** - dem Bezugspreis der Anlage
(`SlotEconomics.importPriceCtSql`, die eine Preiswahrheit, mit der auch der
Optimierer plant): fester Tarif = der Festpreis, sonst
`(Börsenpreis + Σ Preisblatt-Komponenten) × (1 + USt)`, ersatzweise der
Standard-Komponentensatz (`OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS`, Vorgabe AN)
und - wenn zu einer Anlage gar keine Preisangaben vorliegen - der nackte
Börsenpreis.

Bis hierher hatte diese eine Zeile ihre **eigene** Komposition (dynamisch =
Börsenpreis + Aufschlag, fest = Festpreis, sonst gar kein Wert) und kannte
weder Preisblatt noch Umsatzsteuer noch den Standard-Satz. Auf ein und
derselben Karte war damit dieselbe Kilowattstunde als Bezug ~30 ct und als
vermiedener Bezug ~15 ct wert; eine Anlage ohne hinterlegten Stromtarif zeigte
gar keinen Eigenverbrauchs-Wert, während ihre Stromkosten voll bewertet wurden.
Ihr Netto-Ergebnis war dadurch systematisch zu niedrig.

## Was Kundinnen und Kunden sehen

| Anlage | vorher | nachher |
|---|---|---|
| **fester Tarif** (Festpreis hinterlegt) | Festpreis | **unverändert** |
| **dynamisch + Aufschlag, kein Preisblatt** | Börsenpreis + Aufschlag | **unverändert** |
| **dynamisch oder ohne Tarif, Preisblatt gepflegt** | Börsenpreis + Aufschlag bzw. gar nichts | `(Börsenpreis + Komponenten) × USt` - **höher** |
| **ohne Tarif, Standard-Satz aktiv** | gar kein Wert | Standard-Komposition - **erstmals ein Wert** |
| **gar keine Preisangaben** | gar kein Wert | Börsenpreis, ausgewiesen als „zu Börsenpreisen" |

**Wert des Eigenverbrauchs, Gesamtertrag und Netto-Ergebnis steigen** für
Anlagen mit gepflegtem Preisblatt, für Anlagen auf dem Standard-Satz und für
Anlagen ohne Stromtarif. Historische Zeiträume werden dabei mitbewertet - die
Erlöse-Seite rechnet seit jeher jeden Zeitraum mit dem AKTUELL gepflegten
Tarif/Preisblatt (Historik-Semantik, keine Preisblatt-Historie).

## Was sich NICHT ändert

* **`savedEur`** (Speicher-/Steuerungs-Ersparnis) samt seiner Dreiteilung,
  `baselineEur` und `actualEur`: sie bewerten den vermiedenen Bezug seit Stufe 3
  des strukturierten Bezugspreises ohnehin mit genau dieser Komposition.
* **Einspeise-Erlös und Marktprämie**: die Export-Seite ist unberührt.
* Die beiden Identitäten der Karte gelten weiter exakt - jetzt über **einen**
  Preis: `Netto = Einspeise-Erlös + Wert des Eigenverbrauchs − Stromkosten` und
  `Stromkosten − Einspeise-Erlös = actual`.
* `tarifPriced` bleibt der Ehrlichkeits-Schalter: es beschreibt ab jetzt beide
  Seiten - „bewertet zu Ihrem Stromtarif" gegen „zu Börsenpreisen".

## Rücknahme

Es gibt keinen Schalter für diese Entscheidung (sie beseitigt eine
Doppeldeutigkeit, sie ist keine Option). Der einzige verwandte Hebel bleibt der
Not-Aus des Standard-Komponentensatzes,
`OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS=false` - er nimmt Anlagen ohne
Preisangaben auf den nackten Börsenpreis zurück, und zwar auf beiden Seiten der
Karte gleichzeitig.

## Belege

`services/api` `PortalApiTest`:
`eigenverbrauchsWertIsValuedAtTheSameImportCompositionUnderBothFlags` (die
Komposition gegen echtes Postgres, Flag AUS und AN),
`savedEurValuesAvoidedImportAtTheStructuredSupplyPrice` (Preisblatt-Vektor),
`earningsExposeGesamtertragEnergyAndSeriesForTheMoneyView` (Anlage ohne Tarif),
`siteEarningsAnswerOneAnlageWithItsReconcilingComposition` (beide Identitäten +
„ein Preis je Karte"). Konzept: `vp-erloese-seite-konzept-e2` §2.3 (Befund B5),
§4a/§5 (Entscheid E7, Paket P8).
