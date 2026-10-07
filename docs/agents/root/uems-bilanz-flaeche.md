# UEMS - Energiebilanz je Anlage im Portal (AP-13 IP-8 = AP-10 IP-14; Konzept Auswerten a1 §6.9)

Konzept: AP-13 §4.8 (B1), §5.5, Kasten E7 = A, Referenzfälle O5–O8 (`frontend/portal/src/test/oberflaechenFaelle.json`);
Regeln AP-10 §4.3–§4.7, §5.2, §5.6. Look and Feel seit Konzept Auswerten a1 §6.9 (`data/vp-auswerten-konzept-a1`):
Antwortsatz, Zwei-Teile-Balken, dieselben Wörter wie Verbrauch und Bewertung. Die Route: `uems-bilanz-lesemodell.md`,
die Herkunft: `uems-bilanzwert-herkunft-routen.md`.

## Was wo steht

| Was | Wo |
|---|---|
| Ort | Anlage › Verlauf › Reiter „Energiebilanz“ direkt nach „Messwerte“ — `#/anlage/{id}/energiebilanz?periode=&am=` (`nav.ts` `AnlagenSub`, `ebenenNav.ts` `SUB_BEREICH` + `anlageBereiche`) |
| Rein | `frontend/portal/src/anlageEnergiebilanz.ts` - `energiebilanzBild` (je Tag Antwortsatz, drei Kartenzeilen, Balken-Anteile, Unterzähler nach Menge; darunter die vier Zeilen der Route mit Herkunft; Live, Vorschlag, Abschnitte), `mitEnergiebilanz`/`hatHauptzaehler` (Reiter), `zeitraumAus`/`energiebilanzHash`, `darf`/`standortDerAnlage` |
| Render + Laden | `pages/EnergiebilanzSection.tsx` (+ `.css`, Präfix `vp-bil-`), Fuß `components/EnergiebilanzFuss.tsx`, Chunk `SUB_CHUNK.energiebilanz` |
| Reiter-Fakt | `useAnlageSurface`: nur für eine Anlage auf einer Ebene (`anlageAufEbene`) ein `GET …/bilanz?periode=tag` (heute) → `surface.energiebilanz` |
| Tests | `anlageEnergiebilanz.test.ts` (O5–O8, Antwort, Anteile, Leerzustand, Stellungswechsel, Rechte) · `components/EnergiebilanzFuss.test.tsx` · `ebenenNav.test.ts` (Reiter nur mit Fakt) · `copy.test.ts` (Welt Oberflächen, Chart-Liste) · `e2e/energiebilanz.spec.ts` (`ENERGIEBILANZ_BILDER=<Ordner>`) |
| Wege hierher | Reiter des Verlaufs · Baustein „Energiebilanz“ der Übersicht (je Anlage) · Anlagen-Tabelle der Standort-Übersicht je Zeile (`AnlagenTabelle` `energiebilanz`, nur mit Hauptzähler und nur, wenn der Standort misst — früher auf „Standort › Anlagen“, das im Aufbau aufgegangen ist) |
| Bühne | `e2e/startansicht.html?ansicht=bilanz&an=AN-2` · `&bilanz=ohne-hz` · `&rest=vorschlag` · `&live=veraltet` · `&person=CB` (Leser) |

## Quelle je Zeile (nichts wird gerechnet)

| Zeile | Zahl | Herkunft |
|---|---|---|
| Bezug laut Hauptzähler | `werte.zufluss.menge`, wenn nur der Hauptzähler hineinzählt und nichts hinaus | - |
| Verbrauch in der Anlage | sonst Zufluss − Abfluss über `uemsBewertung.nenner` (der Nenner der Bewertung, AP-16) | Unterzeile „was hineinkommt (…) minus was hinausgeht (…)“ |
| durch n Zähler erfasst | `werte.zugeordnet.menge`; mit Lücke `anzeige` WÖRTLICH („mindestens 1.055 kWh (MS-14 fehlt)“) | Unterzähler = `eingaenge[]` mit Name aus `terme[]`/Register, Anteil über `uemsBewertung.prozent` |
| ohne eigenen Zähler | `rest.menge`, negativ mit `rest.kundensatz` + Hilfe-Satz, ohne Zahl „—“ mit „(… fehlt)“ | „Woraus gerechnet“: Herkunft aus `rest.herkunft.satz` (Fassung, Verteilung, berechnet am, Version, Auslöser, Eingänge) |
| Live | nur mit `live.wert` („jetzt 1,6 kW ohne eigenen Zähler · Stand 10:15“); ohne Zahl keine Zeile | - |

Anteile und Balken: jede Prozentzahl kommt aus dem Zwilling der Bewertung (`uemsBewertung.prozent`, eine Stelle) gegen
dasselbe Ganze, mit dem die Bewertung „x % der Anlage“ nennt; der Zwei-Teile-Balken trägt diese Werte als `flex`-Anteile
und hat kein Etikett. Kein Balken, sobald der Rest fehlt oder negativ ist.

## Fallen

- ⚠ **Bestandsschutz:** ohne `surface.energiebilanz` bleibt der Verlauf zeichengleich. Der Reiter hat bewusst KEINEN `VERLAUF_TABS`-Eintrag (er hängt an keiner Ansicht der Projektion, `GELD_UNTERSEITEN` bleibt unberührt). Ein Lesezeichen ohne Hauptzähler zeigt den Leerzustand Z4, ohne aktiven Reiter.
- ⚠ **„ohne eigenen Zähler“ steht immer** (0 kWh, negativ, ohne Zahl). Das Kennzeichen `nicht zugeordnet` am Rest wird nicht wiederholt; „berechnet (Differenz)“ steht nur in „Woraus gerechnet“.
- ⚠ **Fingerabdruck-Wächter:** die vier Knöpfe (‹ › · Erneut versuchen · Als eigene Messstelle führen) behalten Markup und Klassen `vp-eb-schritt`/`vp-eb-knopf` (`migration.test.ts`); der Rest der Fläche heißt `vp-bil-*`, weil `vp-eb-*` auch der Reiter „Energie“ benutzt (`EnergieBuehne.css`).
- ⚠ **Ein Eingang ist immer eine Messstelle:** Unterzähler springen über `sprungziel({art:'messstelle'})`, auch mit Kennzeichen wie `AZ-2`/`HZ-1` (der Text-Sprung `kennzeichenSprung` kennt nur `MS-`/`KZ-`).
- ⚠ **Leere Summe:** hat KEIN Eingang einen Wert, liefert der Zwilling Menge 0 und „mindestens 0 kWh (… fehlt)“ — die Fläche zeigt den Strich (`mit_werten = 0`), nie eine 0.
- ⚠ **Herkunfts-Art nicht aus der Route:** `BilanzEingang` trägt keine Art; das Wort „gemessen“ kommt aus `GET /messstellen?anlage=` (heute). Fehlt die Zeile, steht kein Wort (Befund an AP-10: Art je Eingang).
- ⚠ **Zone einmal am Fuß:** die Route liefert nur `zeitzone`; der Fuß nennt sie mit dem Standort der Anlage aus `GET /standorte?stichtag=` („Zeiten: Europe/Berlin (Werk Ahrenberg)“).
- ⚠ **Auslöser:** die Werkstatt-Form `correction MS-17 2026-10-18 Version 2` wird übersetzt („korrigiert: MS-17 (18.10.2026)“); `umschlagGelesen` der Bilanz setzt heute keinen Auslöser (Version = höchste Eingangs-Version).
- ⚠ **Rechte fragen, nicht raten:** „Als eigene Messstelle führen“ (E18, `POST …/bilanz/rest`) = `messstelle.formel`, „Stellung eintragen“ und das Menü ⋯ „Zähler zuordnen“ = `messstelle.bearbeiten` (→ Standort › Messstellen), je am Standort der Anlage aus `/funktionen`; Selbstauskunft noch unterwegs = kein Knopf, nicht abrufbar = Knopf, die Route antwortet.
- ⚠ **Stellungswechsel:** statt eines Antwortsatzes der Satz, dass jeder Tag für sich steht; Abschnitte untereinander, je Tag eine aufklappbare Zeile mit den drei Zahlen und „Woraus gerechnet“, keine Zahl über die Tage.
- ⚠ **Zweite Tablist:** das `ZeitSegment` ist `role="tablist"` — eine Reiter-Messung einer Spec auf der Anlagen-Seite schließt `.vp-seg` aus (Falle aus IP-7).
- ⚠ **Bühne:** `test/bilanzFixtures.ts` rechnet Summe/Rest/Herkunft/Live mit den Zwillingen; Halle 1 trägt seit IP-8 alle O6-Terme (Oktober), Halle 2 den 04.11.2026 (O7); die Live-Momentaufnahme O8 steht eine Minute vor der Uhr der Bühne. Die Rechte `messstelle.*` ergänzt die Bühne für KA/EM (die Berichts-Fixture stellt sie nicht).

## Anschluss an die Gesamtwert-Karte

Der Chip „berechnet · Zustand“ in `GesamtwertKarten` öffnet dieselben Tages- und Monatswerte wie der Menüpunkt; dort ist die Herkunft der gewählten gespeicherten Zahl erreichbar. Der Zustand am Chip stammt nur aus dem Live-Wert (`vollständig`/`unvollständig`), nie aus einer geratenen Periodenlage. Das befristete Kennzeichen „vorläufig (Geräte-Verdichtung)“ bleibt entfallen, weil AP-10 IP-10 es aus Live- und Verlauf-Antwort entfernt hat.

## Nicht gebaut

Zeitraum-Übergabe aus dem Übersichts-Baustein (der Sprung landet auf dem letzten gebildeten Monat).
