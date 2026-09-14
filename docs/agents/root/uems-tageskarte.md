# UEMS-Fläche: Tages- und Monatskarte je Messstelle (AP-08 IP-11)

Die erste Portal-Fläche, auf der ein Kunde liest, **wie belastbar** seine Verbrauchszahl ist. Sie
zeigt drei Dinge nebeneinander, nie nur das erste: die Menge, ihren Zustand samt Herkunft
(„vollständig (Menge aus Zählerständen)“) und die Abdeckung des Verlaufs („Verlauf 85 %“) — dass
beides zugleich stimmt, ist E1. Keine Route, kein Backend, keine Rechnung: gelesen und AUFGERUFEN.

| Teil | Datei |
|---|---|
| Ableitung (rein): Anfragen, Karte, Liste, Titel | `frontend/portal/src/uemsWerteKarte.ts` · `uemsWerteKarte.test.ts` (F8/F13/F14/F16 gegen `verbrauch-vectors.json` und die Sätze von `ergebnis-zustand-vectors.json`) |
| Darstellung | `src/components/WerteKarte.tsx` (+ `.css`), Dialog `src/components/WerteDialog.tsx` |
| Wirt heute | `GesamtwertKarten` (Zeilenmenü „Tages- und Monatswerte“) — die Messstellen-Seite (AP-04 IP-8) ruft denselben Dialog |
| Daten | `api.messstelleWerte(kennzeichen, raster, von, bis)` → `GET /api/v1/messstellen/{kennzeichen}/werte` (IP-9, `uems-werte-je-messstelle.md`) |
| Vertrag (additiv 1.6) | `mengen_herkunft` + Familie `herkunft`: `ErgebnisZustand.zustandMitHerkunft` ⟷ `uemsErgebnis.zustandMitHerkunft`; `teile` (nur TS) zerlegt `satz` |
| 375 px + Bilder | `e2e/tageskarte.spec.ts` (+ Bühne `tageskarte.html/.tsx`, Antworten `src/test/werteKarteFixtures.ts`); `TAGESKARTE_BILDER=<Ordner>` legt Bilder ab |

## Die Fallen

1. **`null` ist ein Strich, nie 0.** Die Zahl kommt aus `menge(wert, gespeicherte Einheit, ebene)`;
   ohne Wert „—“. Ein Schritt ohne `zustand` (Route nennt `grund`, z. B. `noch_nicht_gebildet`)
   oder einer, der `pruefe` verletzt, wird **nicht gesprochen** — auch seine Zahl nicht.
2. **Kein Satz und keine Rundung in der Fläche.** Zustand, Verlauf, Kennzeichen aus `teile`, die
   Herkunft aus `zustandMitHerkunft`, der Trenner aus `TRENNER`. Ein neues Wort gehört in
   `ergebnis-zustand-vectors.json` UND beide Zwillinge — `copy.test.ts` liest den Block.
3. **Beschriftung und Tagesdauer liefert die Route** (`beschriftung` „02:00–03:00 MESZ“,
   `tagesdauer` „25 Stunden (Zeitumstellung)“) — die Fläche zählt keine Stunden und kennt keine
   Browser-Zone; der Titel liest den Kalendertag aus dem `von` der Route (Ortszeit mit Versatz).
4. **Die Herkunft steht an der Karte, nicht in jeder Zeile** (Zeilen: Wort · Verlauf). Nur mit
   Zahl, nur vollständig/unvollständig, nur `zaehlerstand`/`differenzen`.
5. **375 px:** der Messstellen-Name steht im Körper, nicht im Modal-Kopf (dort schneidet `.dhead`
   ab); `.dbody` hat `overflow-x: hidden`, ein Querlauf wäre dort UNSICHTBAR abgeschnitten — der
   E2E-Test prüft darum jedes Element-Rechteck, nicht nur `scrollWidth`.

## Offen (Befunde)

- „— 14 Viertelstunden ohne Werte“ (Report F8) liefert das Lese-Modell nicht; nicht in der Fläche gezählt.
- Kein Kundensatz für `grund` (noch nicht gebildet, Quelle teilweise, Anteil nicht gespeichert …):
  die Karte zeigt nur den Strich.
- vorläufig/endgültig (`fassung`) ist im Vokabular nur „vorgesehen“ — nicht gezeigt.
- Momentanwert-Messstellen (Mittel/Min/Max) haben keinen Satz — nur der Strich.
- Messstellen ohne Portal-Seite: nur berechnete Messstellen haben heute einen Wirt.
