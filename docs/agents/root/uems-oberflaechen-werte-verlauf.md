# UEMS-Oberflächen: Werte, Verlauf und Vergleich (AP-13 IP-3–IP-6, IP-14)

Vertrag: [Werte je Messstelle](uems-werte-je-messstelle.md),
[Ergebnis-Zustand](../../contracts/v2/ergebnis-zustand.md), AP-13 E5/E6/E9/E11/E12, Q1–Q5.
Die Fläche liest die Messstellen-Werte-Route; Bestandsverläufe behalten Rollups, Berlin-Zeit und ihre Abzeichen.

| Ort | Reine Ableitung | Details |
|---|---|---|
| Messstellen-Seite › Werte; derselbe Inhalt im Werte-Dialog | `uemsWerteKarte.ts`, `uemsOberflaechen.ts`; Wirt `components/WerteSektion.tsx` | [Werte-Karte](uems-tageskarte.md) |
| Tag · Woche · Monat · Jahr; Schritt-Karte, Lücken und Marker | `uemsVerlauf.ts`; `components/MessstellenVerlauf.tsx` | [Verlauf](uems-verlauf-messstelle.md) |
| aus · Vorperiode · Vorjahr, bis drei passende Reihen | `uemsVergleich.ts`; `components/WerteVergleich.tsx` | [Vergleich](uems-vergleich-messstelle.md) |
| Grund statt fehlender Zahl, Auskunft und Frist | `uemsOberflaechen.auskunft`, `uemsWerteKarte.grundDes` | [Gründe](uems-werte-gruende.md) |

Die Zone steht einmal im Kopf aus `zeitzone`/`zeitzone_herkunft`, nie aus dem Browser. Zeitraum, Version und
Vergleich reisen im Hash; Raster kommt aus der Route. Eine Woche wird nicht zur Menge aufsummiert.
`null` bleibt Lücke, ein gespeicherter Tag wird nicht aus dem Diagramm nachgerechnet. Das Δ liefert ausschließlich
`uemsBericht.vergleich`; zwischen verschiedenen Messstellen gibt es kein Δ. Quellenbindung und Versionsnummer
gehören zum angezeigten Zeitraum, nicht zum heutigen Zustand. Marker-Sätze kommen aus dem Ereignisvokabular.

## Wächter Q5

`src/uemsKeineRechnung.test.ts` prüft zwölf Ableitungen mit dem TypeScript-Syntaxbaum (`test/oberflaechenArithmetik.ts`).
`test/oberflaechenArithmetik.json` hält geprüfte Laufzeitimporte und einzelne erlaubte Operationen je Funktion fest:
Kalender, Textpositionen, Reihenfolge und Zeichnungsgeometrie. Die Liste ist kein automatisch erneuerter Snapshot.
Neue Rechenhelfer, Operatoren, numerische Umwandlungen und dynamische Importe werden rot — auch mit Aliasnamen.
Fachwerte bilden nur die Zwillinge `uemsErgebnis`, `uemsBilanz`, `uemsBericht` und ihre Vertragsmodule.
Eine `Number(menge)` für die SVG-Höhe darf nicht zur Summe oder zum fachlichen Anteil werden.
Die Mutationsproben ergänzen absichtlich Summe, Δ, Prozent, BigInt und importierte Helfer; der echte Dateieingriff
und sein roter Lauf gehören in den Prüfnachweis. Bestandsschutz: [Ebenen und Abschluss](uems-oberflaechen-ebenen.md).
