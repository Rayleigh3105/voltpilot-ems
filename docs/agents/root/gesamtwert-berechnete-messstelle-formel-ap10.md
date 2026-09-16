# Summenwert / berechnete Messstelle (UEMS AP-10, Formel-Typ „gewichtete Summe")

Der Summenwert IST eine Messstelle mit `art = berechnet`, deren
**Formel** eine **gewichtete Summe** ihrer **Terme** ist — die im Messstellen-Vertrag
reservierte AP-10-Stelle, kein zweites Modell. Gesamtweg und fertiger Kunden-Assistent: [H-0 bis H-11](uems-summenwerte-abschluss.md).

**Vertrag + Zwillinge:** `docs/contracts/v2/messstelle-formel.md` mit den geteilten Vektoren
`messstelle-formel-vectors.json` (Familien `groesse` · `zyklus` · `summe`), dem Java-Zwilling
`services/api/.../uems/MessstelleFormelRegeln.java` und dem TS-Zwilling
`frontend/portal/src/uemsMessstelleFormel.ts`. Beide stützen sich auf `MessstelleRegeln`s
Größen-Katalog (erweitern statt duplizieren).

**Datenmodell:** `messstelle_formel_term` (`V20260912093000`) — ein Term je Zeile, RLS/FORCE wie
alle UEMS-Tabellen: `eingang_art` (`messkanal` = `entity_id` + `point_key` wie IP-13, ODER
`messstelle` = `quell_messstelle_id` als Baustein), `position`, `vorzeichen`, `faktor`. Trigger
`messstelle_formel_term_nur_berechnet`; CHECKs binden ENTWEDER Messkanal ODER Messstelle und nie
sich selbst; `→ messstelle` RESTRICT, `→ measurement_point` CASCADE.

**Ableitung (`formelGroesse`):** die Hauptgröße kommt aus den Termen (alle dieselbe
Vertrags-Größe, sonst `groessen_gemischt`); Richtung = gemeinsame Richtung bei allen `+`, sonst
`richtungslos`. ⚠ Ein Kanal OHNE Vertrags-Richtung (`generator-power` im Katalog `direction:
null`) ist KEIN Term — ES SEI DENN, der Messkanal-Term
trägt den AP-08-Haken `gilt_als_erzeugung` (Migration `V20260914100000`, Vertrag
`messstelle-formel.md` §2.2, Regeln `MessstelleFormelRegeln.erzeugungsHakenErlaubt`/
`richtungMitErzeugungsHaken` + TS-Zwilling + Vektoren `cases.haken`). Der Haken macht den
richtungslosen Kanal als Term zulässig und lässt ihn als `Erzeugung` zählen — nur an einem Kanal
OHNE Katalog-Richtung (der Server lehnt ihn auf einem gerichteten Kanal ab).
`import_export` ist eine eigene Katalog-Richtung und als vorzeichenbehafteter
Netzwert zulässig; dort ist der Erzeugungs-Haken gesperrt (H-4/W1). So bleibt der
Ankerfall `PV1+PV2+PV3+Gen-Port` eine reine `Erzeugung`-Summe statt zu `richtungslos` zu
degradieren.

**Berechnung (Cloud, `MessstelleFormelService`):** Live-Wert aus den frischesten Samples
(`device_measurement_sample`), Verlauf je 15-min-Bucket aus `device_measurement_rollup_15m`; die
lesende Box wird zur Rechenzeit über `device_measurement_selection` aufgelöst (Term speichert kein
Gerät). ⚠ **`null` statt Teilsumme:** fehlt/veraltet EIN Pflicht-Term → Ergebnis `null`
(„unvollständig", der fehlende Term wird genannt), nie eine stille reduzierte Summe. Der
Edge-Vertrag bleibt unangetastet.

⚠ Der Formel-Stand geht in `MessstelleService.darstellung`/`lebenszyklus` ein (das generische
`GET /api/v1/messstellen/{id}` zeigt eine fertige berechnete Messstelle ehrlich als `aktiv`, nicht
mehr `entwurf`); das Register (IP-4) batcht die Formel noch nicht und lässt sie dort Entwurf.

**Seit AP-10 IP-3 (Fassungen je Tag):** die Terme gehören zu einer Fassung
(`messstelle_formel_fassung`, Fassung 1 ohne ersten Tag), gerechnet wird mit der Fassung des Tages,
`GET …/formel?am=` und `POST …/formel/fassungen` kommen dazu, das Anlegen trägt das Recht
`messstelle.formel` — Details und Fallen in `uems-formel-fassungen-je-tag.md`.

**Seit AP-10 IP-10 (Periodenwerte):** Viertelstunde, Tag, Monat und Jahr einer berechneten Messstelle mit Menge
stehen in der Speicherklasse (Spur `berechnet`, gerechnet vom Stundenlauf nach den gemessenen) und werden über
`GET …/{kennzeichen}/werte` gelesen; Live-Wert und Verlauf bleiben der schnelle Blick aus den Geräte-Verdichtungen,
jetzt ohne befristetes Kennzeichen — `uems-berechnete-periodenwerte.md`.

**Endpunkte:** `POST /api/v1/messstellen/berechnet`, `GET …/{id}/formel|wert|verlauf`
(`MessstelleFormelController`). Prüfen: `MessstelleFormelRegelnVectorsTest` (rein),
`MessstelleFormelTermMigrationTest` + `MessstelleFormelApiTest` (DB), `uemsMessstelleFormel.test.ts`.
