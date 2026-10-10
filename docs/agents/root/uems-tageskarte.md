# UEMS-Fläche: Tages- und Monatskarte je Messstelle (AP-08 IP-11)

Die erste Portal-Fläche, auf der ein Kunde liest, **wie belastbar** seine Verbrauchszahl ist. Sie
zeigt drei Dinge nebeneinander, nie nur das erste: die Menge, ihren Zustand samt Herkunft
(„vollständig (Menge aus Zählerständen)“) und die Abdeckung des Verlaufs („Verlauf 85 %“) — dass
beides zugleich stimmt, ist E1. Dazu sagt die Karte IMMER, ob die Zahl feststeht: „vorläufig“ oder
„endgültig“ (ergebnis-zustand 1.7, Captain 14.09.2026 „Ja, immer zeigen“ — wer abrechnet, muss wissen,
ob sie sich noch ändern kann). Keine Route, kein Backend, keine Rechnung: gelesen und AUFGERUFEN.

| Teil | Datei |
|---|---|
| Ableitung (rein): Anfragen, Karte, Liste, Titel | `frontend/portal/src/uemsWerteKarte.ts` · `uemsWerteKarte.test.ts` (F8/F13/F14/F16 gegen `verbrauch-vectors.json` und die Sätze von `ergebnis-zustand-vectors.json`) |
| Darstellung | `src/components/WerteKarte.tsx` (+ `.css`); Zeit-Leiste, Zone, Karte und Liste als EINE Sektion `src/components/WerteSektion.tsx` (AP-13 IP-3); Dialog `src/components/WerteDialog.tsx` = `Modal` um dieselbe Sektion |
| Wirte | die Messstellen-Seite (AP-04 IP-8) trägt die Sektion als Abschnitt „Werte“ direkt unter dem Kopf (AP-13 IP-3, E9 = A) — sie öffnet KEINEN Dialog; `GesamtwertKarten` (Zeilenmenü „Tages- und Monatswerte“) öffnet dieselbe Sektion im `WerteDialog`. Einstiege ins Register: „Letzter Wert“ und Zeilenmenü „Werte“ am Rechner, die ganze Karte am Telefon (`MessstellenPage` `onWerte`) |
| Daten | `api.messstelleWerte(kennzeichen, raster, von, bis)` → `GET /api/v1/messstellen/{kennzeichen}/werte` (IP-9, `uems-werte-je-messstelle.md`) |
| Vertrag (additiv 1.6) | `mengen_herkunft` + Familie `herkunft`: `ErgebnisZustand.zustandMitHerkunft` ⟷ `uemsErgebnis.zustandMitHerkunft`; `teile` (nur TS) zerlegt `satz` |
| Vertrag (additiv 1.7) | Kennzeichen `vorlaeufig`/`endgueltig` (Rang 90) + Block `fassung` + Familie `fassung`: `ErgebnisZustand.fassung` ⟷ `uemsErgebnis.fassung` |
| 375 px + Bilder | `e2e/tageskarte.spec.ts` (+ Bühne `tageskarte.html/.tsx`, Antworten `src/test/werteKarteFixtures.ts`); `TAGESKARTE_BILDER=<Ordner>` legt Bilder ab. Die Sektion an der Seite: `e2e/messstelle-seite.spec.ts` (O14, O13-Einstieg, Version; Bühne `?wirt=1` = Register mit Adresse) |
| Versionen am Wert (IP-18) | Ableitung `src/uemsWertVersionen.ts` · `uemsWertVersionen.test.ts` (F21, F10 gegen `verbrauch-vectors.json` und `korrektur-vorschlag-vectors.json`); Darstellung `src/components/WertVersionen.tsx` (+ `.css`); Antworten `src/test/wertVersionenFixtures.ts`; Route `api.messstelleWerteVersionen` → `…/werte/versionen` (`uems-versionen-lesen.md`) |

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
5. **Zeitraum-Wahl = EIN Bedienelement** (Änderungswunsch zur Vorschau): Tag|Monat, Pfeile und
   `VpDatePicker` in einem Rahmen `.vp-wk-zeitwahl`, Teile ohne eigene Ränder — ein Kasten, oben
   Tag|Monat je halbe Breite, darunter ‹ Datum › (Captain 14.09.2026: Variante B; die einzeilige Leiste
   passte „September 2026“ bei 375 px nur ohne Kalender-Symbol und ist verworfen). Umschalten behält den
   Zeitraum (Tag → SEIN Monat, nicht der heutige). Der E2E-Test meldet auch ein abgeschnittenes Datum
   (`.vp-picker-wert` mit Auslassungspunkten) als Querlauf.
7. **Die Fassung steht IMMER, im Kopf neben dem Titel** (`data-testid="werte-fassung"`), in beiden
   Fällen — getrennt von Zustand und Verlauf, weil sie etwas anderes sagt (feststehend ≠ vollständig).
   Sie gilt JE PERIODE und kommt aus `fassung` der Route für GENAU die gezeigte Periode: der Oktober
   ist vorläufig, obwohl der 25.10. darin endgültig ist — nie aus Tagen oder Monat abgeleitet. Nur ein
   gesprochener Schritt spricht sie; `null` (keine Quelle) zeigt nichts, nie „endgültig“ als Vorgabe.
   Die Zeilen tragen sie nicht (wie die Herkunft). Captain 14.09.2026 zur Vorschau: Variante A, der
   Kopf („Finde A gut.“). ⚠ **Nicht aus Symmetrie in die Abzeichen-Reihe schieben:** „vorläufig“ ist
   keine Aussage über die Vollständigkeit, sondern über die Haltbarkeit der Zahl — als viertes
   Abzeichen neben „Verlauf 85 %“ (gleiche Reihe, gleiche Farben) sähe es aus wie dieselbe Kategorie
   (Variante B, verworfen). `e2e/tageskarte.spec.ts` prüft den Ort.
6. **375 px:** der Messstellen-Name steht im Körper, nicht im Modal-Kopf (dort schneidet `.dhead`
   ab); `.dbody` hat `overflow-x: hidden`, ein Querlauf wäre dort UNSICHTBAR abgeschnitten — der
   E2E-Test prüft darum jedes Element-Rechteck, nicht nur `scrollWidth`.

8. **Versionen am Wert (AP-08 IP-18): der Einstieg sitzt UNTEN in der Karte, die Historie in einem
   GESTAPELTEN `Modal`** (`data-testid="werte-versionen"` → `versionen-dialog`), neben — nicht in — dem
   Dialog der Tageswerte gerendert (React-Ereignisse blubbern durch Portale). Gefragt wird NUR bei
   `versionen >= 2` und nur mit `von`/`bis` des Schritts, unverändert und kodiert (das `+` des Versatzes).
   Neueste Version zuerst; je Version vorher → danach über `anzeige` (also `menge`/`teile`, E11), die
   Entscheidungen mit wer · wann (`zeitText` in der Zone der Historie) · warum in „…“. ⚠ **Nie „geändert“:**
   die erste Fassung eines Vorgangs ist sein Anfang — Ersatzwert „eingetragen von …“, Korrektur
   „vorgeschlagen von …“ (Anfangs-Status der Vokabulare), Version 1 der Periode ist „Original“ ohne
   Entscheidung. ⚠ Fehlt das „warum“, steht ein ehrlicher Satz, kursiv abgesetzt (`OHNE_GRUND`,
   `OHNE_GRUND_FREIGABE`) — nie Art, Methode oder der Vorschlags-Satz als Ersatz; der steht unter
   `angelegt` als das, was er ist. ⚠ Der alte Wert wird **nie durchgestrichen**: er ist nicht falsch, er
   stand vorher da (F10: dieselbe Menge, nur der Verlauf wuchs). Ort: gestapelter Dialog statt
   aufklappbar in der Karte (Vorschau zeigte beide; die Historie von F21 ist bei 375 px ~1 300 px hoch —
   in der Karte würden Karten in einer Karte und die Stundenliste rückte ~1 100 px nach unten).

9. **Die ANZAHL der Lücken steht im Abzeichen des Verlaufs** (`data-testid="werte-verlauf"`, „Verlauf 85 % · 1 Lücke“;
   Captain 15.09.2026: „drei Lücken“ ist eine Aussage, ein blasses Feld keine). Gezählt wird jedes Ereignis der Art
   `data_gap` EINMAL (Kennung), das die Route an den Schritt hängt — die Fläche zählt, sie rechnet nichts
   (`uemsWerteKarte.luecken`). Nur die Karte, nie die Zeilen; nur ein gesprochener Schritt (wie die Fassung); und nie
   bei Verlauf 100 %: dort ist jede genannte Lücke nachgeliefert — der Lücken-Melder schließt sie mit
   `nachgeliefert_am` und löscht sie nie, die Route liefert das Feld aber nicht mit (F9). Eine Lücke über die
   Tagesgrenze ist an JEDEM der beiden Tage eine (F20). ⚠ **Nicht als eigenes Abzeichen:** neben „vollständig (Menge
   aus Zählerständen)“ läse „1 Lücke“ sich wie ein Widerspruch — die Lücke sagt etwas über den Verlauf, nicht über
   die Menge (E1). Ohne Lücke bleibt das Abzeichen „Verlauf 100 %“ und die Karte Pixel für Pixel, wie sie war.
10. **„noch nicht gerechnet“ ist nicht „keine Werte“** (Captain 15.09.2026: nur eine der beiden Lagen löst sich von
   selbst). Es ist der Grund `noch_nicht_gebildet` der Route (Java `MessstelleWerteRegeln.OhneZahl` ⟷ TS
   `MessstelleWerteWert.grund`), KEIN Wort des Ergebnis-Vertrags. Die Karte zeigt den Strich und darunter den Satz
   `UEMS_NOCH_NICHT_GERECHNET_SATZ` im Platz `werte-grund` (derselbe wie der Kundensatz der Kennzahl); die Zeile
   trägt das Wort `UEMS_NOCH_NICHT_GERECHNET` an der Stelle des Zustands. Wort und Satz stehen NUR in `glossar.ts`.
   Kein Zustands-Abzeichen, keine Fassung, keine Lückenzahl — der Schritt wird weiter nicht gesprochen. Seit AP-13 IP-6
   spricht JEDER Grund seinen Satz unter dem Strich (`grundDes`, am noch nicht gebildeten Schritt zeichengleich dieser
   Satz); die Zeile trägt weiter nur dieses eine Wort — `uems-werte-gruende.md`.

11. **Die Zahl wohnt auf der Messstellen-Seite; der Dialog ist nur ein Rahmen (AP-13 IP-3, E9 = A).** Wer an Zeit-Leiste,
   Karte oder Liste etwas ändert, ändert `WerteSektion` — `WerteDialog` rendert nur `Modal` + Sektion, und
   `VersionenDialog` steht NEBEN dem Rahmen (`rahmen`), nie darin. Der Kopf nennt die Zone DER ANTWORT (`zeitenKopf` →
   `uemsOberflaechen.zoneSatz`, E12 = A), nie die des Browsers; den Namen des Standorts kennt nur die Seite (Register
   `ort.standort_name`) — der Dialog sagt „(Zeitzone des Standorts)“. Die Adresse `?periode=JJJJ-MM[-TT]&version=n`
   (`nav.parseMessstelleWerte`; geschrieben über `sprungziel`): ⚠ `version` fragt NUR die Karte (Stunden und Tage der
   Liste haben eigene Versionen) und gilt nur für die Periode der Adresse; jede neue Wahl zeigt die neueste und ersetzt
   die Adresse (`replaceCurrentNavigation`, kein Verlaufseintrag). Der Hinweis „Sie sehen Version n — heute die neueste“
   (früher: „— heute gilt Version m“ + „Neueste zeigen“) steht nur über einer GESPROCHENEN Karte genau dieser Version
   (`versionHinweis`), nie über einem Strich. Der Register-Einstieg öffnet den Vortag des Registers (mit „Stand am“
   diesen Tag) — nie heute, das ist noch nicht gerechnet.
   Seit AP-13 IP-4 trägt die Sektion vier Zeiträume (Tag · Woche · Monat · Jahr) und unter der Karte den Verlauf — auch im
   Dialog; Regeln und Fallen in `uems-verlauf-messstelle.md`.

## Offen (Befunde)

- „— 14 Viertelstunden ohne Werte“ (Report F8) liefert das Lese-Modell nicht; nicht in der Fläche gezählt.
- Kein Kundensatz für die übrigen `grund` (Quelle teilweise, Anteil nicht gespeichert, ohne Menge gespeichert …):
  die Karte zeigt nur den Strich. Die Kennzahl-Karte (`kennzahlKarte.grundSatz`) sagt auch zu `noch_nicht_gebildet`
  noch nichts — derselbe Satz aus `glossar.ts` passte dort.
- Lückenzahl (Falle 9): `ereignisse` der Route trägt kein `nachgeliefert_am` — eine Lücke, die nur TEILWEISE
  nachgeliefert ist, zählt als eine; zwei Lücken, von denen eine ganz nachgeliefert ist, zählen als zwei (sicher ist
  nur Verlauf 100 %). Eine berechnete Messstelle hängt keine Ereignisse an, nennt also nie eine Anzahl. „Lücke am
  Wechsel“ ist ein Kennzeichen der Gerätegrenze und zählt nur, wenn die Route dazu ein `data_gap` nennt.
- Momentanwert-Messstellen (Mittel/Min/Max) haben keinen Satz — nur der Strich.
- AP-13 IP-3: der Satz zur FRÜHEREN Version („Sie sehen Version 1 — heute gilt Version 3“) steht nicht im Konzept (§5.6/O10
  nennen nur die neueste) — gebaut aus `version`/`versionen` der Route, „gilt“ wie `GILT_JETZT`. Eine Version, die es
  nicht gibt (`version_gibt_es_nicht`), zeigt heute nur den Ladefehler der Sektion; die Sätze der Ablehnungen sind IP-6.
- Versionen: nur die Karte hat den Einstieg. Ein Tag der Monatsliste mit Versionen zeigt sein Kennzeichen,
  aber keinen eigenen Einstieg (die Stunden haben nie Versionen). `nachgezogen_am` wird nicht gezeigt.
- Befund F11-Stunde (IP-18): die Stunde eines korrigierten Tages ist `version_nicht_gebildet` und bleibt
  ein Strich ohne Wort — der Vertrag rechnet sie ab Version 2, der Lesepfad bildet sie nicht.
