# UEMS-Oberflächen: Energiebilanz und Verteilung (AP-13 IP-7–IP-10, IP-14)

Vertrag: AP-10 E9/F8, AP-13 E3/E7/E8, Q1–Q5. Quelle jeder UEMS-Fläche sind Messstellen,
Bilanz- bzw. Energie-Routen; das Bestands-Cockpit behält seine Zahlen. Quelle im Flächenkopf, Zone im Zeitkopf.

| Fläche | Zuständige Ableitung und Vertrag |
|---|---|
| Unternehmens-/Standort-Übersicht | `uebersichtBausteine.ts` → `uemsBilanz.ebene`; [Übersichts-Bausteine](uems-uebersicht-bausteine.md) |
| Anlage › Verlauf › Energiebilanz | `anlageEnergiebilanz.ts`, `pages/EnergiebilanzSection.tsx`; [Bilanz-Fläche](uems-bilanz-flaeche.md) |
| Standort › Gebäude | `gebaeudeKarte.ts`, `components/GebaeudeKarte.tsx` → `uemsBilanz.gebaeude`; [Gebäude-Karte](uems-gebaeude-karte.md) |
| Unternehmen › Messstellen › Kostenstellen/Prozesse | `kostenstellenUebersicht.ts`, `pages/KostenstellenSection.tsx`; [Kostenstellen-Übersicht](uems-kostenstellen-flaeche.md) |

„x von y Systemen“ kommt aus dem Zwilling. Fehlende Anlagen bleiben mit Grund sichtbar; ein unbekannter
Wert ist keine Null. Der Rest gehört zur Anlage; es gibt keinen Gebäude-Rest und keine Summe über Kostenstellen.
„Nicht verteilt“ erscheint einmal, Speicher-Anteile bleiben getrennt. Live ist kW, die Periodenmenge kWh.
Kein Flussdiagramm aus Rollup- und Messstellenzahlen mischen.

Die Balkenbreite `menge / zufluss` in `teilBild` ist ausschließlich Zeichnungsgeometrie für `MiniShareBar`:
Die Beschriftung bleibt die gelieferte Menge, keine neue Prozentzahl. Diese einzelne Operation und die SVG-Geometrie
sind im [Q5-Wächter](uems-oberflaechen-werte-verlauf.md#wächter-q5) benannt; jede neue Mengenrechnung wird rot.
Der Energiebilanz-Reiter erscheint nur mit Hauptzähler-Fakt. Ohne Messfunktion erscheinen keine neuen
Standortseiten oder leeren Bausteine. `useUebersichtBausteine` lädt und zeigt erst, wenn die bestehende
`ebenenNav.misst`-Ableitung die Ebene freigibt; Gebäude allein reichen nicht. Die Prüfung gilt auch für
Messstellen- und Kennzahlen-Bausteine; unbekannt und Entwurf geben nichts frei. Siehe [O18 und die IP-7-Release-Note](uems-oberflaechen-ebenen.md).
