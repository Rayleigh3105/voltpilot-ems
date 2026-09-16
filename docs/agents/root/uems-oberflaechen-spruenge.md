# UEMS-Oberflächen: Sprünge, Herkunft und Quelle (AP-13 IP-11–IP-14)

Vertrag: AP-13 E2/E10/E14, D1–D4, O10/O17/O18. Zuständig sind `uemsOberflaechen.ts`
(`sprungziel`, `herkunftsZeile`, `kennzeichenSprung`, `periodeSchluessel`, `cockpitWeg`) und
`components/HerkunftsZeile.tsx`. Vollständige Kantenliste: [Sprünge der Kette](uems-spruenge-kette.md).

Herkunfts- und Nachweiszeilen in Kennzahl, Bericht, Werte-Karte, Bilanz und Kostenstellen öffnen das jeweilige
Objekt mit Periode und Version des Eingangs. Die Textstücke ergeben wieder den unveränderten Ursprungssatz.
MS-/KZ-Kennzeichen sind keine UUIDs; `MessstelleSeite` löst ein Messstellen-Kennzeichen über das Register auf.
Ohne Zielseite bleibt ein Objekt Text. Ein Anlagenport oder derselbe Transport beweist keine Gerätegleichheit.

Die Register-Quelle führt zur zugeordneten Komponente; welche Box liest, sagen `boxAnQuelle.ts` und
`useBoxenAnQuellen.ts`. Pro Quelle eine Zuständigkeit, keine aus der Anlage geratene Box:
[Box an der Quelle](uems-box-an-quelle.md).

Das Cockpit bekommt ausschließlich „Messstellen dieser Anlage“, mit gefilterter Registerzählung und nur bei
vorhandenen Messstellen. `misstAnlage` verhindert bei Betriebskunden bereits den Abruf. Keine Zahl wird
ausgetauscht; der bestätigte Umstieg gehört AP-14. Die Standortseiten prüfen dasselbe Messfunktions-Lesemodell:
[Bestandsschutz](uems-oberflaechen-ebenen.md#abschluss-und-bestandsschutz-ip-14).

Nachweise: `uemsOberflaechen.test.ts`, `CockpitMessstellenWeg.test.tsx`, `MessstelleSeiteKennzeichen.test.tsx`,
`e2e/weg.spec.ts` (Ebene → Welt → Zahl → Nachweis, 375/1440 px),
`src/uemsBestandsschutz.test.tsx` und [Q5-Wächter](uems-oberflaechen-werte-verlauf.md#wächter-q5).
Bestandsaufnahmen niemals erneuern, um eine echte Abweichung zu verschlucken.
