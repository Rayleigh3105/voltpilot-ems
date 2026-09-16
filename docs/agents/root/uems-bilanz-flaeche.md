# UEMS — Energiebilanz je Anlage im Portal (AP-13 IP-8 = AP-10 IP-14)

Konzept: AP-13 §4.8 (B1/B2), §5.5, Kasten E7 = A, Referenzfälle O5–O8 (`frontend/portal/src/test/oberflaechenFaelle.json`);
Regeln AP-10 §4.3–§4.7, §5.2, §5.6. Die Route: `uems-bilanz-lesemodell.md`, die Herkunft: `uems-bilanzwert-herkunft-routen.md`.

## Was wo steht

| Was | Wo |
|---|---|
| Ort | Anlage › Verlauf › Reiter „Energiebilanz“ direkt nach „Messwerte“ — `#/anlage/{id}/energiebilanz?periode=&am=` (`nav.ts` `AnlagenSub`, `ebenenNav.ts` `SUB_BEREICH` + `anlageBereiche`) |
| Rein | `frontend/portal/src/anlageEnergiebilanz.ts` — `energiebilanzBild` (Zeilen, Teile, Herkunft, Live, Vorschlag, Abschnitte), `mitEnergiebilanz`/`hatHauptzaehler` (Reiter), `zeitraumAus`/`energiebilanzHash`, `darf`/`standortDerAnlage` |
| Render + Laden | `pages/EnergiebilanzSection.tsx` (+ `.css`), Chunk `SUB_CHUNK.energiebilanz` |
| Reiter-Fakt | `useAnlageSurface`: nur für eine Anlage auf einer Ebene (`anlageAufEbene`) ein `GET …/bilanz?periode=tag` (heute) → `surface.energiebilanz` |
| Tests | `anlageEnergiebilanz.test.ts` (O5–O8, B2, Leerzustand, Stellungswechsel, Rechte) · `ebenenNav.test.ts` (Reiter nur mit Fakt) · `copy.test.ts` (Welt Oberflächen, Chart-Liste) · `e2e/energiebilanz.spec.ts` (`ENERGIEBILANZ_BILDER=<Ordner>`) |
| Wege hierher | Reiter des Verlaufs · Baustein „Energiebilanz“ der Übersicht (je Anlage) · „Standort › Anlagen“ je Zeile (`AnlagenTabelle` `energiebilanz`, nur mit Hauptzähler, nur `nurAnlagen`) |
| Bühne | `e2e/startansicht.html?ansicht=bilanz&an=AN-2` · `&bilanz=ohne-hz` · `&rest=vorschlag` · `&live=veraltet` · `&person=CB` (Leser) |

## Quelle je Zeile (nichts wird gerechnet)

| Zeile | Zahl | Herkunft |
|---|---|---|
| Zufluss · Abfluss · Zugeordnet | `werte.<rolle>.menge`; mit Lücke `anzeige` WÖRTLICH („mindestens 1.055 kWh (MS-14 fehlt)“) | Teile = `eingaenge[]` mit Name aus `terme[]`, Anteil-Wort, Version; „gemessen/berechnet“ aus dem Register (`art`) |
| Nicht zugeordnet | `rest.menge`, negativ mit `rest.kundensatz` + Hilfe-Satz, ohne Zahl „— keine Werte (… fehlt)“ | Herkunfts-Karte aus `rest.herkunft.satz` (Fassung, Verteilung, berechnet am, Version, Auslöser, Eingänge) |
| Live | `live.wert` kW mit `live.stand`; `null` = Strich + Satz je `fehlende[].grund` | — |

Balken (B2): `MiniShareBar` je Unterzähler, Länge = kWh ÷ Zufluss (Zeichnung), kein Balken bei „keine Werte“, nie eine Prozentzahl.

## Fallen

- ⚠ **Bestandsschutz:** ohne `surface.energiebilanz` bleibt der Verlauf zeichengleich. Der Reiter hat bewusst KEINEN `VERLAUF_TABS`-Eintrag (er hängt an keiner Ansicht der Projektion, `GELD_UNTERSEITEN` bleibt unberührt). Ein Lesezeichen ohne Hauptzähler zeigt den Leerzustand Z4, ohne aktiven Reiter.
- ⚠ **„nicht zugeordnet“ steht immer** (0 kWh, negativ, ohne Zahl). Das Kennzeichen `nicht zugeordnet` am Rest wird nicht wiederholt — es ist das Wort der Zeile.
- ⚠ **Leere Summe:** hat KEIN Eingang einen Wert, liefert der Zwilling Menge 0 und „mindestens 0 kWh (… fehlt)“ — die Fläche zeigt den Strich (`mit_werten = 0`), nie eine 0.
- ⚠ **Herkunfts-Art nicht aus der Route:** `BilanzEingang` trägt keine Art; das Wort „gemessen“ kommt aus `GET /messstellen?anlage=` (heute). Fehlt die Zeile, steht kein Wort (Befund an AP-10: Art je Eingang).
- ⚠ **Zone ohne Herkunft:** die Route liefert nur `zeitzone` → „Zeiten in Europe/Berlin“ ohne Klammer (Befund an AP-10: `zeitzone_herkunft`).
- ⚠ **Auslöser:** die Werkstatt-Form `correction MS-17 2026-10-18 Version 2` wird übersetzt („korrigiert: MS-17 (18.10.2026)“); `umschlagGelesen` der Bilanz setzt heute keinen Auslöser (Version = höchste Eingangs-Version).
- ⚠ **Rechte fragen, nicht raten:** „Rest anlegen“ = `messstelle.formel`, „Stellung eintragen“ = `messstelle.bearbeiten` (→ Standort › Messstellen), je am Standort der Anlage aus `/funktionen`; Selbstauskunft noch unterwegs = kein Knopf, nicht abrufbar = Knopf, die Route antwortet.
- ⚠ **Stellungswechsel:** Abschnitte untereinander, Tage kompakt (ohne Teile, Eingänge in der Herkunft) — keine Zahl über die Tage.
- ⚠ **Zweite Tablist:** das `ZeitSegment` ist `role="tablist"` — eine Reiter-Messung einer Spec auf der Anlagen-Seite schließt `.vp-seg` aus (Falle aus IP-7).
- ⚠ **Bühne:** `test/bilanzFixtures.ts` rechnet Summe/Rest/Herkunft/Live mit den Zwillingen; Halle 1 trägt seit IP-8 alle O6-Terme (Oktober), Halle 2 den 04.11.2026 (O7); die Live-Momentaufnahme O8 steht eine Minute vor der Uhr der Bühne. Die Rechte `messstelle.*` ergänzt die Bühne für KA/EM (die Berichts-Fixture stellt sie nicht).

## Anschluss an die Gesamtwert-Karte

Der Chip „berechnet · Zustand“ in `GesamtwertKarten` öffnet dieselben Tages- und Monatswerte wie der Menüpunkt; dort ist die Herkunft der gewählten gespeicherten Zahl erreichbar. Der Zustand am Chip stammt nur aus dem Live-Wert (`vollständig`/`unvollständig`), nie aus einer geratenen Periodenlage. Das befristete Kennzeichen „vorläufig (Geräte-Verdichtung)“ bleibt entfallen, weil AP-10 IP-10 es aus Live- und Verlauf-Antwort entfernt hat.

## Nicht gebaut

Zeitraum-Übergabe aus dem Übersichts-Baustein (der Sprung landet auf dem letzten gebildeten Monat).
