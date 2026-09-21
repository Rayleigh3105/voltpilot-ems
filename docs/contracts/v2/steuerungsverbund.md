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
einer Box liegt, gehört in den Vorbehalt. Wie der Wert je Gerät entsteht, legt IP-6 fest (§1a); dieser Vertrag rechnet ab der Summe je Box. Mitglied ist nur, wer
`fuehrt` oder `steuert_mit`; eine Lese-Box als Mitglied, eine doppelte Box, ein negativer Eingang und ein Rückfall über
der Nennleistung (roh verglichen) sind Eingabefehler, kein Urteil (Vektoren mit `"fehler": true`). „Genau eine Box führt“ prüft das
Verbund-Objekt (IP-4), nicht diese Rechnung.

### 1a. Der Geräte-Rückfall je Komponente (IP-6)

`rueckfall_kw` einer Box ist die Summe über ihre Komponenten in dieser Richtung (plus Ungeregeltes, oben). Den
Summanden je Komponente macht EINE Regel (Java `uems/GeraeteRueckfallRegel`, Eingänge über
`uems/GeraeteRueckfallDienst`):

1. der **am Gerät hinterlegte Wert** der Komponente (`komponente_geraete_rueckfall`, je Richtung eine wirksame
   Angabe mit wer/wann; eine neue hebt die alte auf) — z. B. K-1 `faellt_auf_wert` 40 kW nach 60 s. Er zählt nur,
   solange derselbe Einbau die Komponente speist, an dem er eingetragen wurde: nach einem Tausch steckt er im alten
   Gerät, und es gilt wieder 2./3., bis der Wert am neuen Gerät eingetragen ist;
2. sonst der **Katalog-Eintrag** der Familie (`families[].rueckfall_ohne_box` im Messpunktkatalog; mehrere
   Katalog-Familien einer Komponente, die Verschiedenes sagen, gelten als keiner);
3. sonst `unbekannt`.

Gezählt wird zur sicheren Seite: nur `faellt_auf_wert` mit einer Zahl zählt weniger als die Nennleistung, höchstens
aber die Nennleistung. `unbekannt`, `laeuft_frei` und `haelt_letzten_wert` zählen mit der Nennleistung — der letzte
Wert kann alles bis zur Nennleistung gewesen sein, denn die führende Box regelt gegen die ganze Grenze (R4: K-1 hält
83 kW). Die Nennleistung der Komponente bringt der Aufrufer mit (IP-7). Eine Angabe ist keine Bestätigung am
Prüfstand; die trägt nur der Betreiber ein (NW-7).

## 2. Geschlossene Vokabulare

| Vokabular | Wörter | Zwilling (Java `SteuerungsverbundVokabular`) |
|---|---|---|
| `rolle` | `fuehrt` · `steuert_mit` · `liest` | `Rolle` |
| `stufe` | `S0 erklaert` · `S1 beobachtet` · `S2 geprueft` · `S3 anteile_aktiv` · `angehalten` | `Stufe` |
| `grenzart` | `einspeisung` · `bezug` · `netzbetreiber_vorgabe` | `Grenzart` |
| `geraete_rueckfall` | `haelt_letzten_wert` · `faellt_auf_wert` · `laeuft_frei` · `unbekannt` | `GeraeteRueckfall` |
| `auslegung_urteil` | `passt` · `auslegung_passt_nicht` · `vorbehalt_ueber_grenze` | `AuslegungUrteil` |
| `ablehnung` (Scharfschalten) | `box_nicht_in_anlage` · `kein_netzanschluss` · `grenze_fehlt` · `faehigkeit_fehlt` · `nachweis_fehlt` · `auslegung_passt_nicht` · `fuehrende_box_misst_nicht` · `vorgabe_signal_nicht_an_jeder_box` · `mitsteuernde_box_misst_nicht` (IP-4, B3) | `Ablehnung` |
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
- **Die Prüfungen beim Scharfschalten** (T5, I1, G6) samt Routen und Stufen stehen in §6 (IP-5); T1, T2, B1/B3 und T6
  am Verbund-Objekt in §5 (IP-4). Hier stehen nur ihre Wörter.
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

## 5. Das Verbund-Objekt (IP-4)

Datenhaltung in `V20260921140000` (`steuerungsverbund`, `steuerungsverbund_mitglied`, `steuerungsverbund_aenderung`;
RLS mit `FORCE`, Rechte eng, Offboarding in `TenantRepository.offboard`), Regeln in `uems/SteuerungsverbundRegeln`
(rein), Vektoren in [`steuerungsverbund-objekt-vectors.json`](./steuerungsverbund-objekt-vectors.json) — eine eigene
Datei, weil nur die api diese Regeln rechnet; die Anteile oben behalten ihre drei Zwillinge. Lese- und Schreibwege:
`uems/SteuerungsverbundRepository`; Routen, Rechte und Stufenwechsel als Ablauf stehen in §6 (IP-5).

| Regel | Datenbank | Regel-Urteil |
|---|---|---|
| **T1** Mitglied nur mit Heimat in der Anlage | zusammengesetzter Fremdschlüssel `(device_id, site_id, tenant_id)` → `device` und `(steuerungsverbund_id, site_id, tenant_id)` → `steuerungsverbund` (23503) | `box_nicht_in_anlage` je Box |
| **T2 / W3** genau ein Netzanschluss | der Verbund speichert keinen; `anlage_netzanschluss` hält höchstens einen je Tag | keiner: `kein_netzanschluss`; mehrere: Eingabefehler (gekuppelter Fall außerhalb des Umfangs) |
| **genau eine führt** | Exklusion: höchstens eine `fuehrt` je Verbund und Zeitpunkt (23P01) | keine: `fuehrende_box_misst_nicht`; zwei: Eingabefehler |
| **B1** Messpunkt der führenden Box | Pflicht (CHECK) und Datenquelle DIESER Anlage (Fremdschlüssel auf `data_source (id, site_id, tenant_id)`) | nicht dieser Anlage oder nicht von ihr gelesen: `fuehrende_box_misst_nicht` |
| **B3** Messpunkt einer mitsteuernden Box | wahlfrei (ohne: Summe ihrer Geräteleistungen), sonst derselbe Fremdschlüssel | nicht dieser Anlage oder nicht von ihr gelesen: `mitsteuernde_box_misst_nicht` |
| **Kein Doppel-Lesen** (§3.3) | Exklusion: ein Messpunkt je Zeitpunkt bei höchstens einem Mitglied; eine Box höchstens einmal | Eingabefehler |
| **T6** Lesen macht kein Mitglied | `rolle` nur `fuehrt`/`steuert_mit` (CHECK); eine Zuständigkeit legt keine Zeile an | `istMitglied` nur mit Heimat UND Rolle (R21) |
| **G2/G3** | — (keine Anteile gespeichert) | je übergebener Richtung `SteuerungsverbundAnteile.anteile` mit genau den Mitgliedern des Verbunds: `auslegung_passt_nicht` mit Richtung |

Die Befunde stehen in der Reihenfolge des Vokabulars `ablehnung`, je Wort in der Reihenfolge der Mitglieder; das
erste Wort ist die Antwort einer Route. Mitgliedschaften sind minutengenau und halboffen `[gueltig_ab, gueltig_bis)`,
beendet oder aufgehoben, nie gelöscht und nie umgehängt (Box, Rolle, Messpunkt ändern = neues Intervall). Gesendet und
quittiert (Epoche, Revision) steigen nur, und quittiert wird nie über das Gesendete hinaus (CHECK + Schreibweg).
Eine Anlage ohne Gemeinsame Steuerung hat keine Zeile — sie merkt nichts (I6).

## 6. Routen, Rechte und Stufen (IP-5)

`uems/GemeinsameSteuerungService` über `web/GemeinsameSteuerungController` (Kunde) und
`web/AdminGemeinsameSteuerungController` (Betreiber); Schemas `GemeinsameSteuerung*` in
[`openapi.yaml`](../openapi.yaml). Mandant aus Anmeldung bzw. Umschalter `X-Tenant-Id`, Anlage aus dem Pfad — ein
anderes Feld im Körper ist 400 `anfrage_ungueltig`; eine fremde Anlage ist 404 `nicht_gefunden`, nie 403.

| Route | Recht | Übergang |
|---|---|---|
| `GET /api/v1/sites/{siteId}/gemeinsame-steuerung` | lesend, keine eigene Kennung | ohne Verbund `nicht_eingerichtet` und sonst nichts (I6); mit: Stufe, Epoche, Mitglieder, `naechster_schritt`, `fehlt` |
| `PUT …/gemeinsame-steuerung` | `funktion.steuern_einrichten` | einrichten/ändern (Kundenadministrator, I5): gewünschter Stand der Mitglieder → S0/S1 |
| `POST …/anhalten` | `steuerung.starten_beenden` | `anteile_aktiv` → `angehalten`; die Anteile bleiben in Kraft |
| `POST …/fortsetzen` | `steuerung.starten_beenden` | `angehalten` → `anteile_aktiv`, dieselbe Epoche, I1 erneut geprüft — nur wenn das jüngste Anhalten von einem Kundenkonto kam, sonst 409 `vom_betreiber_angehalten` |
| `POST …/aufloesen` | `steuerung.starten_beenden` | alle Mitglieder enden; nur ohne je scharf gewesen zu sein (`epoche = 0`) |
| `POST /api/v1/admin/sites/{siteId}/gemeinsame-steuerung/scharfschalten` | `plattform.betrieb` (nur Plattform-Rolle, I4/W9) | I1 vollständig → neue Epoche (G5), `anteile_aktiv`, Mitglieder bestätigt |
| `POST /api/v1/admin/…/fortsetzen` | `plattform.betrieb` | wie oben, hebt jedes Anhalten auf — auch das des Betreibers |
| `POST /api/v1/admin/…/mitglieder/{boxId}/bestaetigen` | `plattform.betrieb` | `bestaetigt_am` (V20260921180000) nach dem Box-Tausch (R17) |

**Stufen.** Einrichten und jede Strukturänderung setzen S0 `erklaert`, bei vollständiger Struktur S1 `beobachtet`
(I3) — Struktur sind `box_nicht_in_anlage`, `kein_netzanschluss`, `grenze_fehlt`, `fuehrende_box_misst_nicht`,
`mitsteuernde_box_misst_nicht`. S2 `geprueft` setzt IP-21. Ändern und Auflösen bei `anteile_aktiv` sind 409
`erst_anhalten`; Auflösen nach einem Scharfschalten ist 409 `anteile_in_kraft` (Rücknahme nur im Zweischritt, IP-7).
Weitere Übergangs-Gründe: `nicht_eingerichtet`, `nicht_aktiv`, `nicht_angehalten`, `vom_betreiber_angehalten`,
`bereits_aktiv`, `kein_mitglied`, `bereits_bestaetigt`. **Wer angehalten hat** steht im Protokoll (jüngster
Stufenwechsel nach `angehalten`, `actor_art`): nur nach einem Anhalten mit `actor_art = kunde` setzt ein Kundenkonto
fort; hat die Plattform angehalten (`voltpilot` — am Umschalter über die Kundenroute zählt genauso), zeigt `GET`
`naechster_schritt = vom_betreiber_angehalten`, und nur die Plattform setzt fort (W9/I5). Kein Wort des
Ablehnungs-Vokabulars. `zustand = aufgeloest` heißt: der Verbund hat keine wirksamen Mitglieder mehr.

**Scharfschalten (I1).** `uems/SteuerungsverbundScharfschalten` (rein) ergänzt das Urteil des Verbund-Objekts um: beide
Grenzen wirksam (`AnlageGrenzen`, W1), Fähigkeit und Sprungprobe je Mitglied, Auslegung bekannt, G6, Box angemeldet.
Abgelehnt wird mit dem ersten Wort in Vokabular-Reihenfolge; `fehlt` nennt alle Befunde. Die Tatsachen ohne heutige
Quelle liefert die Naht `uems/SteuerungsverbundNachweise` — in IP-5 antwortet sie „fehlt“, eine Anlage kommt
darum höchstens bis S1 und wird nicht scharf:

| Methode | heute | füllt |
|---|---|---|
| `faehigkeit` | `BoxFaehigkeiten.kann(box, "steuerungsverbund_anteil")` — das Wort ist noch nicht in `EdgeSupports.NAMES` → nein | IP-17 |
| `sprungprobe` | nein | IP-21 |
| `auslegung` | leer → `auslegung_passt_nicht` (unbekannt ist nicht „passt“) | IP-7 (mit den Rückfällen aus IP-6) |
| `verbraucher14a`, `vorgabeSignal` | unbekannt → `vorgabe_signal_nicht_an_jeder_box` | offen: kein Paket in §8 nennt den Träger |

**G6.** Scharf nur, wenn an jeder Box mit steuerbaren Verbrauchern nach § 14a das Signal anliegt; „alle solchen
Verbraucher hängen an der Box mit dem Signal“ ist dieselbe Bedingung. Unbekannte Verbraucher zählen als vorhanden,
ein unbekanntes Signal als nicht anliegend (R18).

**Z1 (W2).** `warnung_fuehrung` mit dem Wort `fuehrende_box_ist_nicht_speicher_box`, nur an einer Anlage OHNE
Gemeinsame Steuerung, deren führende Box (`LeadDeviceService`) nicht die Box des primären Speichers ist. Kein
Kundensatz — die Flächen kommen mit IP-23/IP-24.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='SteuerungsverbundAnteilVectorsTest,SteuerungsverbundRegelnVectorsTest')
(cd services/api && ./mvnw test -Dtest='SteuerungsverbundScharfschaltenTest,GemeinsameSteuerungSchnittstelleVertragTest')
(cd services/api && ./mvnw test -Dtest='SteuerungsverbundMigrationTest,GemeinsameSteuerungApiTest')   # Testcontainers
(cd services/optimization && PYTHONPATH=. python -m pytest tests/test_steuerungsverbund_referenz.py)
```
