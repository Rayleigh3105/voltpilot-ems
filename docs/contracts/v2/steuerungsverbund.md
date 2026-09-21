# Steuerungsverbund-Vertrag: Anteile, Zweischritt und Dokument-Prüfung (UEMS AP-15 IP-2)

Kundenwort: **Gemeinsame Steuerung**. „Steuerungsverbund“ und „Verbund“ stehen nur in Vertrags- und Code-Namen, nie
auf einer Kundenfläche (Sprach-Wächter, Konzept S1).

Eine Gemeinsame Steuerung sind die steuernden Boxen EINER Anlage an EINEM Netzanschluss. Jede Box hält ihre harte
Grenze mit dem, was sie selbst misst und gespeichert hat (G1) — dafür bekommt sie je Richtung einen **Anteil**: die
Leistung, die sie an ihrem eigenen Messpunkt nie überschreitet, gespeichert und ohne Ablauf. Dieser Vertrag legt fest,
wie die Anteile gerechnet, geändert und von der Box geprüft werden. Die eine Wahrheit sind die Vektoren in
[`verbund-anteil-vectors.json`](./verbund-anteil-vectors.json); Stand: Konzept AP-15, entschieden am 21.09.2026 (alle
Kästen = Empfehlung, E1 = A, E2 = A).

## 1. Die Regeln

| Regel | Inhalt | Vektor-Gruppe |
|---|---|---|
| **G2** | Je Richtung `verteilbar = Grenze − Vorbehalt`; `Summe der Anteile ≤ verteilbar`. Ist `verteilbar < 0`: `vorbehalt_ueber_grenze`. | `anteile` |
| **G3 / E2 = A** | Jeder Anteil ≥ Geräte-Rückfall der Box und ≤ ihrer Nennleistung. Passt die Summe der Rückfälle nicht in `verteilbar`: `auslegung_passt_nicht` — in **beiden** Richtungen eine Ablehnung, keine Warnung. | `anteile` |
| **G4** | Der Rest nach den Rückfällen geht zuerst an die mitsteuernden Boxen (`steuert_mit`) bis zur Nennleistung, anteilig nach Bedarf (Nennleistung − Rückfall); was bleibt, an die führende (`fuehrt`) bis zu ihrer Nennleistung; was auch dann bleibt, bleibt ungenutzt. | `anteile` |
| **Abrunden** | Gerechnet wird in ganzen Zehntel-kW. Jeder anteilige Zuschlag wird **abgerundet, nie aufgerundet**; der Rundungsrest bleibt ungenutzt und wandert nicht weiter — auch nicht an die führende Box. Eigener Vektor „Abrunden, nie Aufrunden“: aufgerundet läge die Summe bei 100,1 kW über 100 kW verteilbar. | `anteile` |
| **Rundung zur sicheren Seite** | Eingänge feiner als 0,1 kW: was die Grenze gibt (Grenze, Nennleistung), wird abgerundet; was sie belegt (Vorbehalt, Geräte-Rückfall), aufgerundet. Ob der Rückfall über der Nennleistung liegt, entscheiden die rohen Werte; die Obergrenze einer Box für die Verteilung ist max(Nennleistung abgerundet, Rückfall aufgerundet) — der Anteil ist nie kleiner als der aufgerundete Rückfall und darüber nichts (Vektor `rueckfall_gleich_nennleistung_krumm`: 22,08/22,08 kW → 22,1 kW). | `anteile` |
| **G5 Zweischritt** | Übergangsstand = je Box das Kleinere aus alt und neu; wer nur in einem Stand vorkommt, steht im anderen mit 0. Er geht an alle. Der Zielstand folgt erst nach der Quittung JEDER verengten Box (`verengte_boxen` = Übergang < alt). Ist der Übergang schon der Zielstand (reines Verengen, R23), gibt es keinen zweiten Schritt. Der Übergang passt unter `verteilbar` beider Stände. | `uebergangsstand` |
| **T4, G5, Y1 Dokument-Prüfung** | Die Box prüft jedes Anteils-Dokument in dieser Reihenfolge: Mandant und Anlage = ihre Identität (`fremde_anlage`) · die eigene Kennung steht in BEIDEN Richtungen der Tabelle — unbekannt ist keine Null (`box_fehlt_im_dokument`) · Epoche und Revision steigen nur: kleinere Epoche oder gleiche Epoche mit kleinerer Revision (`revision_aelter`) · je Richtung Summe ≤ `verteilbar` des Dokuments, exakt ohne Rundung (`summe_ueber_verteilbar`). Dieselbe Revision noch einmal (gespeichertes Dokument nach Wiederverbindung) wird angenommen. Eine neue Epoche setzt nur das Scharfschalten. | `dokument_pruefen` |

Die Scharfschalt-Ablehnung zur Auslegung ist `auslegung_passt_nicht` für jedes Urteil außer `passt` — auch für
`vorbehalt_ueber_grenze`, das ein Sonderfall ist (`verteilbar < 0 ≤ Summe der Rückfälle`); das Urteil selbst bleibt
als Grund erhalten (Feld `ablehnung` je Vektor).

Eingang je Richtung und Box: `nenn_kw` und `rueckfall_kw` meinen **dieselbe Menge** — alles hinter dem Abgang (dem
eigenen Messpunkt) der Box in dieser Richtung. `nenn_kw` = Nennleistung der gesteuerten Geräte + Höchstwert des
Ungeregelten hinter dem Abgang; `rueckfall_kw` = Summe der Geräte-Rückfälle (`unbekannt` und `laeuft_frei` zählen
mit Nennleistung) + derselbe Höchstwert (G3, B3). Das Ungeregelte steht also in BEIDEN Summen, sonst läge der
Rückfall zu Unrecht über der Nennleistung (Vektor `ungeregeltes_hinter_dem_abgang`); was nicht hinter einem Abgang
einer Box liegt, gehört in den Vorbehalt. Wie der Wert je Gerät entsteht, legt IP-6 (Katalog) fest; dieser Vertrag rechnet ab der Summe je Box. Mitglied ist nur, wer
`fuehrt` oder `steuert_mit`; eine Lese-Box als Mitglied, eine doppelte Box, ein negativer Eingang und ein Rückfall über
der Nennleistung (roh verglichen) sind Eingabefehler, kein Urteil (Vektoren mit `"fehler": true`). „Genau eine Box führt“ prüft das
Verbund-Objekt (IP-4), nicht diese Rechnung.

## 2. Geschlossene Vokabulare

| Vokabular | Wörter | Zwilling (Java `SteuerungsverbundVokabular`) |
|---|---|---|
| `rolle` | `fuehrt` · `steuert_mit` · `liest` | `Rolle` |
| `stufe` | `S0 erklaert` · `S1 beobachtet` · `S2 geprueft` · `S3 anteile_aktiv` · `angehalten` | `Stufe` |
| `grenzart` | `einspeisung` · `bezug` · `netzbetreiber_vorgabe` | `Grenzart` |
| `geraete_rueckfall` | `haelt_letzten_wert` · `faellt_auf_wert` · `laeuft_frei` · `unbekannt` | `GeraeteRueckfall` |
| `auslegung_urteil` | `passt` · `auslegung_passt_nicht` · `vorbehalt_ueber_grenze` | `AuslegungUrteil` |
| `ablehnung` (Scharfschalten) | `box_nicht_in_anlage` · `kein_netzanschluss` · `grenze_fehlt` · `faehigkeit_fehlt` · `nachweis_fehlt` · `auslegung_passt_nicht` · `fuehrende_box_misst_nicht` · `vorgabe_signal_nicht_an_jeder_box` | `Ablehnung` |
| `dokument_urteil` / `dokument_ablehnung` | `angenommen` · `abgelehnt` / `fremde_anlage` · `box_fehlt_im_dokument` · `revision_aelter` · `summe_ueber_verteilbar` | `DokumentUrteil` / `DokumentAblehnung` |

Die Reihenfolge ist Teil des Vertrags; beide Zwillinge vergleichen sie wörtlich. `fuehrende_box_misst_nicht` ist
B1/W2 (der Netzzähler hat genau eine zuständige Box, und das ist die führende); `vorgabe_signal_nicht_an_jeder_box`
ist G6 (Zuordnung Z3): scharf nur, wenn das Signal des Netzbetreibers an jeder Box mit steuerbaren Verbrauchern nach
§ 14a anliegt oder alle solchen Verbraucher an der Box mit dem Signal hängen (R18). Die Stufe S4
`zuteilung_auf_zeit` gibt es im gebauten System nicht (E1 = A); sie steht unter `nicht_gebaut`, und beide Zwillinge
prüfen, dass sie sie nicht kennen.

## 3. Was dieser Vertrag nicht enthält

- **Zusage-Prüfung** der Zuteilung auf Zeit (§4.8, R16, A19): mit E1 = A entworfen, nicht gebaut. Sie kommt als eigene
  Vektor-Gruppe mit IP-33, falls der Captain nach dem Pilot so entscheidet.
- **Die Prüfungen beim Scharfschalten** (T1, T2, T5, I1, B1, G6) samt Routen und Stufen: IP-4/IP-5. Hier stehen nur
  ihre Wörter.
- **MQTT**: Topic, Schema und Quittung des Anteils-Dokuments (`mqtt-verbund-anteile.md`, IP-10/IP-17) übernehmen die
  Wörter aus `dokument_ablehnung` als Grund der Quittung; Topic- und Payload-Identität prüft dort die Box zusätzlich.
- **Der Go-Zwilling** der Box: IP-17 fährt dieselbe Datei als dritter Zwilling (NW-1 in Go).

## 4. Zwillinge und Herkunft der Zahlen

| Gruppe | Java (`services/api`, rein) | Python-Referenz (`services/optimization/tests`) |
|---|---|---|
| `anteile` | `uems/SteuerungsverbundAnteile.anteile` | `test_steuerungsverbund_referenz.anteile` |
| `uebergangsstand` | `…uebergangsstand` | `…uebergangsstand` |
| `dokument_pruefen` | `…dokumentPruefen` | `…dokument_pruefen` |
| `vokabulare` | `uems/SteuerungsverbundVokabular` | `…VOKABULARE`-Tupel |

Die Python-Referenz ist der Rechenkern aus dem Konzept (`k_faelle.py`: `anteile`, `uebergangsstand`) als Testmodul,
ohne Berichts-Erzeugung; beide Seiten rechnen mit exakten Dezimalzahlen (Java `BigDecimal`, Python `Decimal`) — ein
`float` machte aus 24,6 kW beim Aufrunden 24,7 kW.

Vektoren der Referenzwelt (Ahrenberg, Fälle R1, R2, R3, R12) tragen einen Block `quelle`: je Feld ein JSON-Zeiger in
[`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) 1.5 (`netzanschluss_grenzen`,
`gemeinsame_steuerungen[V-1].auslegung`, `abnahmefaelle_ap15`). `geraete_rueckfaelle: <richtung>` heißt: Σ Nennleistung
und Σ Rückfall der Mitglieder = Σ über die Geräte-Rückfälle dieser Richtung. Beide Zwillinge prüfen jeden Zeiger —
ändert eine spätere Fassung der Referenzdatei eine dieser Zahlen, wird dieser Test rot, nicht still falsch. Vektoren
mit `hinweis: konstruiert` nutzen die Kennungen `B-1 …` und sind keine Tatsache der Referenzwelt; R23 und die
Bezugsfälle mit 480/510 kW Ungeregeltem sind Varianten des Konzepts (Eingang des Falls, kein Zustand der Welt).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest=SteuerungsverbundAnteilVectorsTest)
(cd services/optimization && PYTHONPATH=. python -m pytest tests/test_steuerungsverbund_referenz.py)
```
