# UEMS-Ergebnis-Zustand und Kennzeichen als Vertrag (AP-08 IP-8)

Angelegt am 13.09.2026. „2.304 kWh“ allein ist eine Behauptung — erst mit Zustand, Verlauf und
Kennzeichen sagt die Zahl, wie belastbar sie ist. Dieses Paket legt dafür EINEN Vertrag an, den
Java und TypeScript per Pfad lesen: [`docs/contracts/v2/ergebnis-zustand.md`](../../contracts/v2/ergebnis-zustand.md)
mit `ergebnis-zustand-vectors.json` und Schema.

| Sprache | Modul | Test |
|---|---|---|
| Java | `services/api/.../uems/ErgebnisZustand` | `ErgebnisZustandVectorsTest` (rein, kein Testcontainers) |
| TypeScript | `frontend/portal/src/uemsErgebnis.ts` | `uemsErgebnis.test.ts` + Abschnitt IP-8 in `copy.test.ts` |

## Das geschlossene Vokabular

- **Vier Zustandswörter, kein fünftes:** vollständig · unvollständig · keine Werte · mit
  Ersatzwert. Je Wort steht fest, ob eine Zahl dasteht (Pflicht · erlaubt · **verboten** bei
  „keine Werte“ — unbekannt ist keine Null) und was die Kennzeichen sagen müssen (vollständig und
  keine Werte tragen keinen Fehlbestand, unvollständig mindestens einen). Nicht verwechseln mit
  `zustand` vorläufig/endgültig der Speicherklassen.
- **Die Kennzeichen-Liste ist die Inventur** aller Sätze, die `VerbrauchRegeln` ⟷ `verbrauch.py`
  heute sprechen: 17 Muster mit Platzhaltern, Wort, Rang, Fehlbestand. Ein Satz ist genau dann ein
  Kennzeichen, wenn er auf genau EIN Muster passt — auch eine gut gemeinte Korrektur („mit
  Ableseständen“) ist ein unbekannter Satz. Die übrigen Vokabular-Wörter (nachgeliefert,
  korrigiert (Version n), vorläufig/endgültig, Ablesezeitraum, mit Ersatzwert (Methode …)) sind
  `kennzeichen_vorgesehen`: ihren Wortlaut legt das erzeugende Paket fest.
- **Die Reihenfolge ist Vertrag:** der Rang steigt nie (Anteil 10 → Rand 20–22 → Strecke 30 →
  Neustart 40 → Werte 50 → Integration 60), die Sätze der Gerätegrenze stehen in fester Folge.
  In Rang 30 wird die zeitliche Folge NICHT an HH:MM geprüft (ein Monat hat zwei Tage 09:12).

## Die Fallen

1. **Gerechnet ungerundet, gerundet nur angezeigt (E11).** `zahl(wert, einheit, ebene)` — die
   EBENE bestimmt die Stellen, nie die Fläche: kWh Viertelstunde/Stunde 1, Tag/Monat/Jahr 0; kW 1;
   % 0; m³ 1. Kaufmännisch, Tausenderpunkt, geschütztes Leerzeichen U+00A0, Minus U+2212, kein Wert
   „—“. TS rundet den Dezimaltext (`dez.ts`), nie den Binärbruch. Export bleibt ungerundet mit
   Punkt. Eine Rundungsdifferenz wird genannt (`rundungsdifferenz`), nie in einen Teil gedrückt.
   Die alten Portal-Helfer (`energyLabel` ≥ 1 000 kWh → MWh, `fmtNum`) sind NICHT E11 — die
   Sprachregel dafür in `frontend/portal/AGENTS.md` bringt IP-20.
2. **Sommerzeit in der Zone des STANDORTS (E10).** `raster(tag, zone, schritt)`: eine
   Beschriftung, die am Tag zweimal vorkommt, trägt MESZ/MEZ (Normalzeit UTC+01:00) bzw. ihren
   Offset; die fehlende Stunde erscheint nicht; `von` ist ISO-8601 mit Offset (Export).
   `tagesdauer` sagt „25 Stunden (Zeitumstellung)“ / „23 Stunden (Zeitumstellung)“ — die
   Stundenzahl kommt aus `BezugsPeriode.stundenDesTages` → `VerbrauchRegeln.stunden`, nie neu
   gezählt. Die letzte Stunde heißt „23:00–00:00“ (keine 24:00-Sonderregel).
3. **Sprechen prüft keine Werte.** Die Sprech-Funktionen liegen im Rechenweg der Verdichtung; ein
   ungewöhnlicher Wert (`Wertebereich 65536.000`) wird gesprochen, nie mit einer Ausnahme
   bezahlt. Ob jeder Satz passt, beweisen die Vektor-Tests. `satz(ergebnis)` dagegen spricht nur
   ein gültiges Ergebnis — die Fläche fragt vorher `pruefe`.
4. **Ein neuer Satz in der Verbrauchsregel macht beide Zwillinge rot**, weil sie jede
   Kennzeichen-Erwartung von `verbrauch-vectors.json` gegen die Liste prüfen. Dann: Muster in
   Vektor-Datei + `ErgebnisZustand` + `uemsErgebnis.ts` ergänzen, danach `VerbrauchRegeln` den
   neuen Sprecher anrufen lassen. `ErgebnisZustandVectorsTest` wacht zusätzlich, dass
   `VerbrauchRegeln` in keiner Zeichenkette mehr ein Satzstück trägt.

## Befunde (benannt, nicht umformuliert)

Block `befunde` der Vektor-Datei: „Zuwachs 337.600“ (Punkt, ohne Einheit — liest sich als 337 600),
„mit Ablesestände“ (Dativ), „Rechteck-Halten ≤ 2 × Kadenz“ (Methodenwort; der DB-CHECK prüft nur
den Anfang), sechs Satzformen ohne Vokabular-Wort, Kennzeichen-Uhrzeiten fest in Europe/Berlin
ohne MESZ/MEZ, `BilanzAbleitung.zahlDe` mit Leerzeichen-Tausendern, F17 „1 240 m³“ gegen E11
„m³ 1 Nachkommastelle“, E10 „23 Stunden“ gelesen wie F14. Eine Umformulierung ist eine neue
Fassung von `verbrauch-vectors.json` (+ Python-Zwilling, gespeicherte Zeilen) — nicht still.
