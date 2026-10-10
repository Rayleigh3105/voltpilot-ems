# UEMS — Herkunft im Portal-Verlauf (AP-07 IP-15)

Die Herkunfts-Karte ist ein gemeinsamer Baustein für den Komponenten-Verlauf (`BeobachteteRegister`) und den Messstellen-Verlauf (`WerteSektion` → `MessstellenVerlauf`). Ihre Fakten kommen ausschließlich aus `MeasurementHistory.meta` und `MeasurementHistory.data[].herkunft` der gebauten IP-14-Route; Geräte- und Box-Kennungen werden nur über vorhandene Read-Models in Kundennamen aufgelöst. Ohne Namen steht „Bezeichnung nicht erfasst“, niemals eine UUID.

Bestand vor diesem Paket: AP-13 zeichnete im Messstellen-Verlauf bereits Lückenflächen und Ereignismarken; AP-08 IP-16 hing Ersatzwert- und Korrektur-Einstiege an die Marker. IP-15 behält beides und ergänzt nur Herkunft, den aus `data_gap` plus Nachlieferungs-Fakten gebildeten Nachlieferungssatz sowie den Rohdaten-Hinweis.

Wichtige Grenzen:

- `rawAvailable=false` liefert weiter die Viertelstunden-/Tageswerte; der Rohwert-Knopf bleibt sichtbar, aber gesperrt und erklärt „älter als 90 Tage“.
- „nachgeliefert um …“ entsteht nur, wenn ein betroffener Wert `nachgeliefert > 0` und `letzteEingangszeit` trägt; sonst bleibt der Ereignissatz der Route unverändert.
- Im Messstellen-Verlauf kommt die Transport-Box aus der zeitgültigen Zuständigkeit der führenden Quelle, nicht aus dem Geräte-Einbau.
- Kundenwort für `abdeckung_prozent` ist im Portal „Verlauf“, wie vom `copy.test.ts` bewacht.

Abnahme: `MesswertHerkunftKarte.test.tsx`, `BeobachteteRegister.test.tsx`, `MessstellenVerlauf.test.tsx`, `WerteSektion.test.tsx`, `messstelle-seite.spec.ts` und `herkunft-verlauf.spec.ts`. Die Browserfälle messen 375 und 1440 px auf 0 px Querlauf.
