# Bericht: Abzug, Datenstand, Freigabe und Revision (UEMS AP-12)

Stand 15.09.2026 · Vertrag 1.1 · Konzept `data/vp-uems-ap12-berichte` §4, §5.8, §7, §8 IP-1/IP-3/IP-6, Entscheide
E1–E15 und W1–W11 vom 14.09.2026. **1.1 (AP-12 IP-6, additiv):** der Abzug des Unternehmens trägt `standorte`
(`$defs/standort_abschnitt`) und `kostenstellen` (`$defs/kostenstelle`); Fälle, Prüfungen und Abzüge der Vektoren sind
unverändert.

Die Abnahme des Captains: **„Ein freigegebener Bericht lässt sich trotz späterer Korrekturen und abgelaufener Rohdaten
erklären.“** — Monatsbericht Werk Ahrenberg Oktober 2026: Berichtsstand Nr. 1 (10.11.2026, Datenstand 08:55) nennt
**6 100 kWh in Version 1** für MS-12; die Korrektur K-2026-0007 (12.11.2026) macht daraus 6 040 kWh in Version 2 und stößt
die Revision an; Nr. 2 (16.11.2026) nennt 6 040. Nr. 1 ändert sich nie — auch nicht, wenn am 29.01.2027 die Rohwerte und am
31.10.2036 die Zeilen der Speicherklasse weg sind: ihr Abzug ist Text mit Prüfsumme `sha256:b113527d…` (B1, B16).

| Datei | Rolle |
|---|---|
| [`bericht.schema.json`](./bericht.schema.json) | die Form der Vektor-Datei; unter `$defs` Abzug, Berichtsstand, Quelle, Anstoß, Vorlage |
| [`bericht-vectors.json`](./bericht-vectors.json) | 16 Fälle B1–B16, 106 Prüfungen, Vokabulare, Kundensätze, `zwillinge`, `_abweichungen`, `_nicht_geprueft`, `abzuege` |
| [`bericht-vorlagen.json`](./bericht-vorlagen.json) | vier Vorlagen, Fassung 1, feste Abschnitte (V2) |
| [`ergebnis-zustand-vectors.json`](./ergebnis-zustand-vectors.json) Block `bericht_kennzeichen` (1.10) | Wortlaut und Stelle der Kennzeichen ([`ergebnis-zustand.md`](./ergebnis-zustand.md) §8) |
| [`events-vocabulary-vectors.json`](./events-vocabulary-vectors.json) Block `reserviert` | vier Berichts-Ereignisse — reserviert, nicht angelegt |
| [`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) 1.4 | `korrekturen[]` K-2026-0007, `berichte[]` BR-2026-0001 mit Nr. 1 und Nr. 2 |
| `services/api/.../uems/BerichtRegeln.java` | der Java-Zwilling (rein) |
| `frontend/portal/src/uemsBericht.ts` | der TS-Zwilling (rein) |

> **Wer anruft:** noch niemand. Tabellen (IP-4), Vorlagen und Abzug bilden (IP-5/IP-6), Routen und Rechte (IP-7),
> Kaskaden-Naht (IP-8), Strukturänderungs-Läufer (IP-9), CSV und PDF (IP-10/IP-11), Belegschutz (IP-12) und das Portal
> (IP-13/IP-14) rufen diese Regeln an.

## 1. Das Objekt (E1, E8)

Ein **Bericht** ist ein eigenes Objekt: Vorlage × Geltung × Zeitraum, Kennung `BR-<Jahr>-<Nr.>`, genau ein gespeicherter
**Entwurf** und null bis n freigegebene **Berichtsstände** (Nr. 1, 2, …). Ein Berichtsstand ist ein **Abzug** — eine Kopie,
nie ein Verweis auf lebende Zeilen (E1). Ein zweites Anlegen derselben Vorlage × Geltung × Zeitraum ist
`409 bericht_gibt_es_schon` (V4). Archivieren verbirgt den Bericht in der Liste; seine Stände bleiben lesbar.

- **EW1** Genau ein Entwurf je Bericht; er entsteht beim Anlegen und wird von Pfad 1, Pfad 2 und beim Abruf (D4) ersetzt.
- **EW2** Die Freigabe friert genau diesen Entwurf ein; mit Stand zeigt der Entwurf den Vergleich gegen den gültigen Stand.
- **EW3** Die Bildung ist eine reine Funktion über einer `Connection`; sie liest die Lesemodelle, rechnet nichts neu und
  schreibt nur Entwurf und Quellenverzeichnis (IP-5).
- **EW4** Ein Entwurf wird nie als Datei ausgegeben und nie als Abruf protokolliert; PDF und CSV gelten Ständen.

## 2. Der Abzug (A1–A8, E2)

- **A1 Kanonischer Text.** JSON in UTF-8, Objekt-Schlüssel nach UTF-16-Codeeinheiten sortiert, kein Leerraum;
  Zeichenketten wie `JSON.stringify` (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, andere Steuerzeichen als `\u00xx` mit
  kleinen Hex-Ziffern, alles andere unverändert); Zahlen in Dezimalschreibweise ohne Exponent und ohne nachgestellte Nullen
  (`6100`, `0.1488`, `0.00000015`, −0 als `0`); `true`, `false`, `null` (`regeln.kanonisch`). Regel `kanonisch`:
  `BerichtRegeln.kanonisch` ⟷ `uemsBericht.kanonisch` sind byte-gleich — Prüfsumme und Länge je Abzug in den Vektoren, dazu
  ein Randfall mit dem erwarteten Text.
- **A2 Inhalt = was der Bericht zeigt.** Kopf, Zusammenfassung, Werte je Messstelle mit Nachweis, Tagesverlauf bzw.
  Monatswerte, Kostenstellen (Unternehmen), Kennzahlen mit Nachweis, Qualität, Quellenverzeichnis. Keine Viertelstunden,
  keine Rohwerte, keine Ereignis-Listen (nur Zählungen und Kennungen). Form: `bericht.schema.json` `$defs/abzug`.
- **A3 Nachweis je Zahl = die vorhandene Trägerform** (`MessstelleWerteDto.Wert` plus `berechnet_am`; bei berechneten
  Messstellen Formel und Formel-Fassung; bei Kennzahlen der AP-11-Nachweis). Keine zweite Trägerform.
- **A4** Korrekturen, Ersatzwerte und Ereignisse stehen als Kennung mit Kurzform im Abzug, nicht als Kopie ihrer Fassungen.
- **A5** Jede Quelle trägt Name, Kennzeichen und Ort zum Datenstand; das Portal ergänzt beim Lesen „heute: …“ nur als
  Hinweis (Kennzeichen `heute`).
- **A6 Prüfsumme** `sha256:` + SHA-256 (hex, klein) über die UTF-8-Bytes des kanonischen Texts; beim Lesen geprüft, eine
  falsche ist `500 abzug_beschaedigt` — nie still neu gerechnet. Regel `kanonisch`, Satz `abzug_beschaedigt`.
- **A7** Gespeichert als `text`, nie als `jsonb` (jsonb normalisiert und bräche die Prüfsumme).
- **A8** Größe ≈ 100 KB je Monatsbericht Standort; kein Objektspeicher nötig.
- **A9 Fassung 1.2 — additiv, gebildet, und nur für NEU gebildete Abzüge.** `$defs/abzug` kennt `tagesverlauf`
  (`$defs/tagesverlauf_reihe`: je Wert-Zeile ihre Tage mit Menge und Zustand), `$defs/kennzahl` kennt
  `ort_zum_datenstand` und `endgueltig_ab` wie `$defs/wert`. **Alles Neue ist wahlfrei:** ein Abzug nach 1.0 oder 1.1
  bleibt gültig, byte-gleich lesbar und behält seine Prüfsumme; PDF und CSV aus ihm bleiben byte-gleich (die Abnahme des
  Captains, `UemsBerichtNachDenFristenTest`). 1.0/1.1-Abzüge tragen die drei Formen nicht — das ist die Lücke, nicht die
  Null. **Die Bildung schreibt alle drei ab** (`BerichtAbzugBildung`): MS-04 wird zu ZWEI Zeilen (laden 7 900 /
  entladen 7 100, beide mit demselben Nachweis — es ist EINE gemessene Reihe), die Zusammenfassung nennt
  `speicher_laden_kwh`/`speicher_entladen_kwh` und zählt 16 Zeilen, der Tagesverlauf trägt je Wert-Zeile die
  gespeicherten Tage, und jede Kennzahl ihren Ort und ihre Endgültigkeit. Die CSV füllt damit ihre zwei Zellen
  (B14/KZ-0001: `G-2`, `2026-11-08`); ihr Mapping las beide schon immer, es fehlte nur der Abzug.

## 3. Quellen (Q1–Q6, E3)

- **Q1/Q2 Nur die Messstellen-Welt.** `quelle_art`: `messstelle` · `kostenstelle` · `bezugsgroesse` · `stammdatum` ·
  `kennzahl`. Erlöse, Übersicht, Prognosen und Optimierung sind keine Berichtsquelle.
- **Q3** Messstellen des Berichts = Messstellen der Geltung im Zeitraum (zeitgültige Zuordnung je Tag).
- **Q4** Kennzahlen des Berichts = Kennzahlen mit Geltung ⊆ Geltung des Berichts; einzeln abwählbar. Standort:
  Standort-, Gebäude-, Bereich- und Messstellen-Kennzahlen des Standorts; Unternehmen (so zitieren B3 und B4): Unternehmen,
  Prozess, Kostenstelle und Messstellen ohne Standort — Standort-Kennzahlen nur mittelbar. Die Abwahl steht je Bericht in
  `bericht_kennzahl_abwahl`; keine Zeile heißt gewählt (AP-12 IP-6).
- **Q5 Vergleichszeiträume sind Quellen** mit eigenem Zeitraum und `bezug = vergleich`; ohne Zahl steht ein Grund:
  `vor_bestehen` (der Zeitraum liegt ganz vor dem Bestehen), `quelle_beendet` (ganz nach dem Ende), `keine_werte`.
  Regeln `vergleich_grund` und `vergleich`.
- **Q6 Mittelbare Quellen** (Eingänge berechneter Messstellen, Kostenstellen und Kennzahlen) stehen mit `bezug = mittelbar`
  im Quellenverzeichnis — sie machen die Betroffenheit vollständig.

Eine **Zeile des Quellenverzeichnisses** (`$defs/quelle`): Bericht, `nr` (leer = Entwurf), `ersetzt`, Objekt (Kennzeichen),
Bezug, erster und letzter Tag **einschließlich**. In den Vektoren stehen Zeilen gleicher Gruppe zusammengefasst
(`objekte`); die Zwillinge entfalten sie.

## 4. Zeitraum, Vergleich und Vorlagen (V1–V5, E9)

- **V1** Zeiträume sind Kalendermonat und Kalenderjahr in der Zone der Geltung, halboffen (`von` = Mitternacht des ersten
  Tags, `bis` = Mitternacht nach dem letzten), Tage einschließlich. Monat: Vergleich `vormonat` und `vorjahresmonat`; Jahr:
  `vorjahr`. Regel `zeitraum`: `BezugsPeriode.spanneVon` + `TagRegeln.beginn` (TS: `spanneVon` + `mitternacht`), Name
  `KennzahlRegeln.periodeText`.
- **V2** Vier Vorlagen mit Fassungsnummer und festen Abschnitten ([`bericht-vorlagen.json`](./bericht-vorlagen.json)):

  | Vorlage | Geltung | Zeitraum | Vergleich | Abschnitte |
  |---|---|---|---|---|
  | `monatsbericht_standort` | Standort | Monat | Vormonat, Vorjahresmonat | Kopf · Zusammenfassung · Verbrauch je Messstelle · Tagesverlauf · Kennzahlen · Qualität · Quellenverzeichnis |
  | `jahresbericht_standort` | Standort | Jahr | Vorjahr | … Monatswerte statt Tagesverlauf |
  | `monatsbericht_unternehmen` | Unternehmen | Monat | Vormonat, Vorjahresmonat | Kopf · Zusammenfassung · Standorte · Prozesse und Kostenstellen · Kennzahlen · Qualität · Quellenverzeichnis |
  | `jahresbericht_unternehmen` | Unternehmen | Jahr | Vorjahr | … dazu Monatswerte |

  Regel `vorlage`; eine unbekannte ist `422 vorlage_unbekannt`.
- **V3** Der Kunde wählt Vorlage, Geltung, Zeitraum und abgewählte Kennzahlen — sonst nichts. Eine neue Vorlagen-Fassung
  ändert keinen Stand. Die Abwahl reist beim Anlegen als `kennzahlen_abgewaehlt` (Kennungen der Kennzahlen) und steht in
  `bericht_kennzahl_abwahl`, bevor der erste Entwurf entsteht.
- **V4** Ein Bericht je Vorlage × Geltung × Zeitraum. **V5** Der Entwurf eines laufenden Zeitraums ist erlaubt
  (Kennzeichen „Zeitraum läuft“), die Freigabe nicht.
- **Vergleich (Q5, DA1).** Differenz = aktuell − Vergleich; Prozent = Differenz ÷ Vergleich × 100, gespeichert auf
  `regeln.prozent_rechen_nachkommastellen` (10) Stellen, angezeigt mit einer Nachkommastelle und Vorzeichen
  („+260 kWh“, „+4,3 %“, „−3,0 %“); Vergleich 0 hat keinen Prozentwert; ohne Vergleichswert „keine Werte“ und der Grund.

## 5. Datenstand (D1–D5, E4)

- **D1** Datenstand = Zeitpunkt der Bildung des Abzugs (Systemuhr, `Instant`).
- **D2** Jede einbezogene Berechnungszeit ≤ Datenstand; bei der Freigabe zusätzlich jedes „endgültig ab“ ≤ Datenstand.
- **D3** Freigabe ≥ Datenstand und keine Änderung einer Quelle in (Datenstand, Freigabe] — sonst `409 entwurf_veraltet`.
- **D4** Aktuell, solange keine Änderung einer Quelle (Version, Fassung, rückwirkendes Protokoll) einen Zeitstempel
  > Datenstand trägt; eine Änderung GENAU zum Datenstand ist im Entwurf. Sonst wird der Entwurf neu gebildet.
- **D5** Der Kopf nennt beides: „Datenstand 12.11.2026 10:05 (MEZ) · Berichtsstand Nr. 2 · freigegeben 16.11.2026 14:20
  von Ines Kaltenbach“; der Entwurf „Entwurf · Datenstand 12.11.2026 10:05 (MEZ)“. Die Zone steht immer dabei
  (`ErgebnisZustand.zoneKurz`), an der doppelten Stunde nur einmal („25.10.2026 02:30 MEZ“).

Regeln `datenstand` (`BerichtRegeln.d2`/`d3`/`d4` ⟷ `uemsBericht.d2`/`d3`/`d4`, Funktionen über Listen von Zeitmarken) und
`kopf`.

## 6. Freigabe (F1–F6, E5)

- **F1 Voraussetzungen in dieser Reihenfolge**, jede mit Code und Kundensatz — die erste verletzte antwortet:
  1. Zeitraum zu Ende (`jetzt ≥ bis`) — sonst `422 zeitraum_nicht_zu_ende`, möglich ab `bis` + 7 Tage
     (`TagRegeln.endgueltigAb`): „Der Oktober 2026 ist noch nicht zu Ende — ein Berichtsstand ist ab dem 08.11.2026 möglich
     (7 Tage nach Monatsende).“
  2. Jeder Wert endgültig — sonst `422 werte_vorlaeufig` mit Anzahl, allen Quellen (`vorlaeufige`) und dem spätesten
     „endgültig ab“; der Satz nennt die ersten drei Quellen: „16 Werte sind noch vorläufig (endgültig ab 08.11.2026):
     MS-01 Netzbezug Halle 1, MS-02 Netzeinspeisung Halle 1, MS-03 PV-Erzeugung Dach Halle 1, … — ein Berichtsstand
     braucht endgültige Werte.“
  3. Der gesehene Entwurf ist der gespeicherte (übermittelter Datenstand = Datenstand des Entwurfs) — sonst
     `409 entwurf_veraltet`: „Der Entwurf hat sich seit dem 10.11.2026 08:57 geändert (Korrektur K-2026-0007). Laden Sie
     ihn neu und prüfen Sie die 2 Abweichungen.“
  
  Sonst ist es Berichtsstand Nr. letzte + 1 (`201`). **Das Recht prüft die Route davor** (G2): ein fremder Standort ist
  404, bevor eine Voraussetzung etwas über den Bericht verrät (`_abweichungen`). Regel `freigabe`.
- **F2** Die Freigabe liest den Entwurf mit `FOR SHARE`, kopiert den Abzug byte-gleich, setzt am vorherigen Stand
  „ersetzt durch“, erledigt dessen offene Anstöße, schreibt Ereignis und Protokoll — sie rechnet nichts (IP-7).
- **F3** Person (`actor_*`-Muster), Zeitpunkt, Darstellung, Regelwerk und Vorlagen-Fassung stehen am Stand.
- **F4** Kein Vier-Augen-Prinzip im ersten Ausbau. **F5** Dieselbe Freigabe (Bericht, Datenstand) zweimal ist dieselbe Nr.;
  ein Anstoß kann mit Begründung verworfen werden („Anstoß verworfen (…)“). **F6** Eine Freigabe wird nie zurückgenommen.

## 7. Betroffenheit und Auslöser (B1–B7, E6)

- **B1 Betroffen = Zeitraum × Quellenverzeichnis**, nie Standort-Zugehörigkeit oder Name. Je Bericht der **gültige** Stand
  (`FREIGEGEBEN`, nie ein ersetzter) vor dem Entwurf (`ENTWURF`), Berichte nach Kennung sortiert — in der Sprache der Naht
  (`BerichteNaht.Bericht`). Regel `betroffenheit`:
  - **Pfad 1** `betroffene(quellen, KorrekturKaskade.Betroffen, bindung)`: Objekte = die Messstellen der Reihen (über die
    zeitgültige Quellenbindung, die der Aufrufer liest) und `Betroffen.messstellen`, seit AP-11 IP-9 die Kennzeichen von
    `Betroffen.bezugsgroessen` und bei `berechnung_geaendert` der Anlass (die Kennzahl); Tage `ersterTag … letzterTag`.
  - **Pfad 2** `betroffene(quellen, objekte, giltAb)` (TS `betroffeneStruktur`): Objekte, die der Strukturänderungs-Läufer
    auflöst; Tage ab `gilt_ab`, offen.
- **B2** Pfad 1 ist die Korrektur-Kaskade (PR 741); **B3** Pfad 2 der Strukturänderungs-Läufer (IP-9).
- **B3 gebaut (AP-12 IP-9, `uems/StrukturAenderungLaeufer`, Flag `voltpilot.uems.berichte.struktur.enabled`):** liest
  `ort_aenderung` (`verschoben`, `korrigiert`, `flaeche_geaendert`) und `messstelle_aenderung` (`ort_zugeordnet`,
  `ort_korrigiert`, `verteilung_geaendert`) mit dem Wasserzeichen `bericht_struktur_gelesen` (eine Zeile je gelesenem
  Eintrag, in derselben Transaktion wie die Naht — nichts zweimal, nichts übersprungen), urteilt mit der Regel `struktur`,
  löst die Objekte auf (`uems/StrukturAufloesung`) und ruft `BerichteNaht.betroffene`/`entwurfNeuBilden`/`revisionAusloesen`
  (Überladungen mit `StrukturBetroffen`) in einer eigenen Transaktion je Eintrag. Die Schreibwege bleiben, wie sie sind.
  - **Objekte** (IDs, nie ein heutiges Kennzeichen): Zuordnung eines Gebäudes oder Bereichs → Messstellen und Bezugsgrößen
    des Unterbaus, nur bei einem Standortwechsel; Zuordnung einer Messstelle → sie selbst; Anlage-Umzug → keine (kein Abzug
    liest `anlage_standort`); Fläche → die Bezugsfläche des Orts und seiner Eltern, Objekt = der Ort (B9: „BZ-4“ an G-2;
    heute zitiert noch kein Bericht eine Fläche, sie ist kein Kennzahl-Eingang); Verteilung → die
    Kostenstellen des alten und des neuen Satzes und die berechneten Messstellen, deren Formel einen Anteil der Messstelle
    liest (B8: MS-20, 4100, 4200). Mittelbare Quellen stehen schon im Verzeichnis.
  - **Wer die Änderung schon kennt, ist nicht betroffen:** nur Stände und Entwürfe, deren Datenstand vor dem Eintrag
    (`created_at`) liegt.
  - **Anlass-Kennung** `<Anstoß-Art>/<Kennzeichen>/<gilt ab>/<eingetragen>/<Protokoll>-<Zeile>` (Regel `anlass`:
    „Verteilung MS-07 berichtigt, gilt ab 01.10.2026, eingetragen 20.11.2026“); ein Kennzeichen, das in keiner
    Ereignis-Kennung stehen darf, entfällt. Ohne Fassung und Status — B7 greift über die Kennung (je Protokollzeile).
  - **Bezugsgrößen liest Pfad 2 nicht:** Pfad 1 trägt Berichtigung, Rücknahme und rückwirkendes Stammdatum seit AP-11 IP-9;
    ein Anstoß aus Pfad 2 trüge eine andere Art und Kennung, `bericht_revision_anstoss_einmal` finge ihn nicht ab.
  - **Vorschau** `GET /api/v1/berichte/betroffen?objekt&gilt_ab&anlass`: dieselbe Auflösung ohne Protokollzeile und ohne
    Datenstand-Schranke — `betroffen` (gültige Stände), `zitieren` (jeder Stand, der eine Quelle des Objekts zitiert, B12),
    `berichte_vorhanden`; die Sätze der Folgen-Zeile spricht das Portal (`berichteFolgen.ts`).
- **B4 Anstoß-Arten** (`anstoss_art`): Pfad 1 aus Anlass und Status (`anstossArt`): `K-…` freigegeben →
  `korrektur_freigegeben`, zurückgenommen → `korrektur_zurueckgenommen`; `EW-…` wirksam → `ersatzwert_wirksam`,
  zurückgenommen → `ersatzwert_zurueckgenommen`. `bezugsgroesse_fassung` und `kennzahl_fassung_rueckwirkend` kommen über
  Pfad 1 seit AP-11 IP-9: jede geänderte Bezugsgröße (`Betroffen.bezugsgroessen` — Fassung ≥ 2, Rücknahme, rückwirkendes
  Stammdatum) bzw. der Status `berechnung_geaendert` (rückwirkende Fassung der Berechnung einer Kennzahl). Pfad 2 aus einer Protokollzeile (Regel `struktur`):

  | Protokoll | Art | Anstoß | sonst |
  |---|---|---|---|
  | `ort_aenderung` | `verschoben`, `korrigiert` (Anlage) | `anlage_umzug_rueckwirkend` | `nicht_rueckwirkend` |
  | `ort_aenderung` | `verschoben`, `korrigiert` (Gebäude, Bereich) | `zuordnung_rueckwirkend` | `nicht_rueckwirkend` |
  | `ort_aenderung` | `flaeche_geaendert` | `flaeche_rueckwirkend` | `nicht_rueckwirkend` |
  | `messstelle_aenderung` | `ort_zugeordnet`, `ort_korrigiert` | `zuordnung_rueckwirkend` | `nicht_rueckwirkend` |
  | `messstelle_aenderung` | `zaehler_gewechselt` | `zuordnung_rueckwirkend` | `nicht_rueckwirkend` |
  | `messstelle_aenderung` | `verteilung_geaendert` mit `korrektur` | `verteilung_rueckwirkend` | `nicht_rueckwirkend` |
  | beide | `bearbeitet` | — | `umbenennung` |
  | beide | jede andere Art | — | `keine_strukturaenderung` |

- **B5** Freigabe UND Rücknahme lösen aus; ein ersetzter Stand wird nie reaktiviert (B7 im Katalog).
- **B6 Kein Anstoß:** Umbenennung, `gilt_ab` nach dem letzten Tag (kein Schnitt), Archivieren/Beenden heute oder künftig,
  neue Vorlagen-Fassung, erste Fassung, vorläufiges Nachziehen — der Entwurf bildet sich beim nächsten Abruf neu (D4).
- **B7** Ein Anstoß ist idempotent über Stand, Art, Anlass und Fassung (IP-8).

## 8. Revision (R1–R5, E7)

- **R1** Ein Anstoß erzeugt keinen Stand; der Vergleich zweier Abzüge nennt jede Abweichung (Regel `abweichungen`): je
  Menge (Schlüssel Quelle + Mengen-Art) und je Kennzahl vorher, nachher, Version („1 → 2“; fehlt eine Seite „—“) und
  Anlass — die Korrekturen, die der neue Abzug zusätzlich nennt: an ihrer Reihe unmittelbar („K-2026-0007“), an einer
  berechneten Messstelle „K-2026-0007 (über die Formel)“, an einer Kennzahl „K-2026-0007 (über die Kennzahl)“.
- **R2** Die Revision ist die Freigabe des Entwurfs; der alte Stand trägt „ersetzt durch Nr. 2 (16.11.2026)“ und bleibt
  lesbar. **R3** Mehrere Anstöße erledigt eine Revision. **R4** Verwerfen braucht eine Begründung.
- **R5** Listen-Vermerke: „Entwurf“, „Berichtsstand Nr. n“, „Revision nötig — <Anlass>“, „Anstoß verworfen (…)“. Den Anlass
  spricht `anlass`: „Korrektur K-…“, „Ersatzwert EW-…“, sonst der Text der Strukturänderung.

## 9. Rechte (G1–G4, E12)

- **G1** Die fünf Kennungen der Rechte-Matrix, unverändert (Regel `rechte`, `regeln.kennung`): `abrufen`/`pdf` →
  `bericht.standort_abrufen`; `anlegen`/`freigeben`/`verwerfen`/`archivieren` → `bericht.standort_freigeben`; `csv` →
  `export.standort`; am Unternehmen `bericht.unternehmen` bzw. `export.unternehmen`.
- **G2** Durchgesetzt über `RechteAbleitung.darf` (Muster `KorrekturRechte`): fremder Standort 404, fehlendes Recht 403,
  Unterstützung nie eine Datei. Die 403/404-Sätze spricht die Rechte-Ableitung.
- **G3 Teilansicht (R-A4):** wer das Unternehmen nicht exportieren darf, bekommt die Namen der Standorte, deren Messwerte er
  ansehen darf (`messwerte.ansehen`), in der Folge des Kundenbereichs — „Teilansicht: Werk Ahrenberg, Werk Lindach“, im CSV
  `# teilansicht=…`; unternehmensweit keine. `BerichtRegeln.teilansicht` ⟷ `uemsBericht.teilansicht`.
- **G4** Jede Route nennt ihre Kennung (`RechteKennungenDerRoutenTest`).

**Rechte-Anmerkung (AP-12 IP-1).** Die fünf Zeilen `bericht.standort_abrufen`, `bericht.standort_freigeben`,
`bericht.unternehmen`, `export.standort` und `export.unternehmen` in [`rechte-matrix.json`](./rechte-matrix.json) sind ab
AP-12 IP-7 (Berichts-Routen) und IP-10 (Bestand-Geräte-CSV unter `export.standort`) **durchgesetzt**, nicht nur Vertrag. Die
Anmerkung steht hier und nicht in der Matrix: die Zeilen sind Konzept-Zeilen AP-03 §4.3, ihr Feld `anmerkung` gehört zum
gepinnten Fingerabdruck `konzept_tabelle.sha256`.

## 10. Regelwerk, Darstellung und Ausgabe (RW1–RW3, DA1–DA5, E10, E11)

- **RW1** Der Kopf trägt `regelwerk`: Software-Stand (Version + Git-SHA) und `schema_version` je Vertrag. **RW2** Je Zahl die
  gespeicherte Fassung (Formel, Definition, Verteilungs-Satz, Stichtag). **RW3** Keine neue Spalte an `messreihe_*`.
- **DA1** Ein Stand friert seine Darstellung ein: Zone der Geltung, `de-DE`, Mengen mit den Stellen ihrer Ebene
  (`ErgebnisZustand.zahl`), Kennzahlen wie AP-11 (`KennzahlRegeln.anzeige`, zwei Stellen), Prozent eines Vergleichs mit
  einer Nachkommastelle. Regel `anzeige`.
- **DA2** PDF aus dem Abzug, deterministisch (IP-11). **Die Datei (IP-11):** Route `GET …/staende/{nr}/pdf`, Datei
  `bericht-<Kennung>-nr<Nr.>.pdf`, Recht wie Abrufen (G1); A4, Schrift Liberation Sans eingebettet (Teilmenge); Abschnitte
  in der Folge der Vorlagen — Kopf · Zusammenfassung · Tabellen (am Standort `verbrauch_je_messstelle`, am Unternehmen
  `standorte` mit den Messstellen und `kostenstellen`) · Kennzahlen · Qualität · Quellenverzeichnis —, Zahlen nach DA1; auf
  jeder Seite der Fuß „<Kennung> · Datenstand … · Berichtsstand Nr. n · freigegeben … von …“ mit Prüfsumme und „Seite i von
  n“; ein ersetzter Stand trägt auf jeder Seite `ersetzt durch Nr. n (Datum)` schräg hinter dem Inhalt und als Zeile oben
  rechts. Erzeugungs- und Änderungsdatum = Freigabe, die Dokument-Kennung `/ID` aus der Prüfsumme; Abrufzeit, Abrufer und
  Teilansicht stehen NICHT in der Datei (nur in `bericht_abruf`) — zwei Abrufe desselben Stands sind byte-gleich, auch durch
  verschiedene Personen; ersetzt wird ein Stand genau einmal, und nur dann ändert sich seine Datei (Wasserzeichen). Die Datei
  entsteht NUR aus dem Abzug und der Freigabe des Stands (A1); ein Entwurf hat keine (EW4).
- **DA3 Berichts-CSV** in Kundenform: Kopfblock `# schlüssel=wert` in der Reihenfolge `regeln.csv_kopf` (16 Zeilen: Bericht,
  Vorlage mit Fassung, Geltung „Standort ST-1 Werk Ahrenberg“, Zeitraum „2026-10 (01.10.2026–31.10.2026)“, Stand,
  Datenstand, Freigabe am/von, Zone, `dezimal=,`, `trenner=;`, `zahlen=ungerundet`, Prüfsumme, Erzeugung am/von, Teilansicht),
  dann eine Zeile je Wert mit den 13 Spalten `regeln.csv_spalten`: Zahlen ungerundet mit Dezimalkomma, Zeitpunkte in der Zone
  mit Offset, Kennzeichen mit „ · “; eine Zelle mit `;`, `"` oder Zeilenumbruch in Anführungszeichen (verdoppelt). Regeln
  `csv_kopf` und `csv_zeile`. **Die Datei (IP-10):** UTF-8 mit BOM, Zeilenende CRLF; bei einem ersetzten Stand direkt hinter
  dem Kopf `# wasserzeichen=ersetzt durch Nr. n (Datum)` (Kennzeichen `ersetzt_durch`); dann die Spaltenzeile und je Abschnitt
  `# abschnitt=<Schlüssel der Vorlage>` mit einer Zeile je Wert — nur Abschnitte mit Werten in der Trägerform des Abzugs, in der
  Folge der Vorlagen: am Standort `verbrauch_je_messstelle` (`werte`), am Unternehmen `standorte` (`werte`) und
  `kostenstellen` (Block `summe`; ohne eine Menge ihr `grund` als Kennzeichen), an beiden `kennzahlen` (Periode = Zeitraum des
  Berichts; die Richtung steht als Kennzeichen in `kennzeichen`, keine 14. Spalte; `ort` und `endgueltig_ab` bleiben leer,
  solange der Abzug sie je Kennzahl nicht trägt). Die Datei entsteht NUR aus dem Abzug und der Freigabe des Stands (A1); zwei
  Abrufe unterscheiden sich nur in `erzeugt_am`, `erzeugt_von` und `teilansicht`. Route `GET …/staende/{nr}/csv`, Datei
  `bericht-<Kennung>-nr<Nr.>.csv`; ein Entwurf hat keine (EW4).
- **DA4** Der Bestand-Geräte-CSV bleibt Maschinenform und bekommt neun Kopfzeilen direkt hinter
  `# catalog_version_gespeichert=`: `zeitraum_von`, `zeitraum_bis`, `erzeugt_am`, `erzeugt_von`, `zeitzone="UTC"`,
  `dezimal="."`, `trenner=","`, `standort`, `unternehmen` — Text in Anführungszeichen wie jede Kopfzeile davor, leer ohne
  Objekt; jede Kopfzeile davor, die Spalten und die Zeilen bleiben Byte für Byte; Recht `export.standort` (Unterstützer 403).
  **DA5** Jeder Abruf wird protokolliert: `bericht_abruf` (Stand, Format, Person, Rolle, Zeitpunkt, Teilansicht) und die
  Meldung `bericht_abgerufen` (Kennung = die des Abrufs) in derselben Transaktion — ohne Protokoll keine Datei.

## 11. Belegschutz und Aufbewahrung (S1–S5, E13)

- **S1** Stände, ihre Quellen, Anstöße, Abrufe und Protokoll sind append-only, ohne Frist, ohne Kompression; nur das
  Offboarding räumt (IP-4).
- **S2** Harte Löschwege (Komponente, Anlage, Purge) lehnen mit `409 berichts_belege` ab, wenn ein FREIGEGEBENER Stand die
  Quelle zitiert: „Diese Komponente ist Beleg in 4 freigegebenen Berichtsständen (BR-2026-0001 Nr. 1, …). Löschen ist nicht
  möglich — beenden Sie die Bindung stattdessen.“ (IP-12). Entwürfe schützen nichts.
- **S3** Beenden, Archivieren, Abmelden, Umziehen bleiben erlaubt. **S4** Die Aufbewahrung der Messdaten bleibt, wie sie ist:
  nach zehn Jahren ist ein Wert `404 wert_nicht_mehr_gespeichert` — „Der Wert vom Oktober 2026 wird nicht mehr gespeichert
  (Aufbewahrung 10 Jahre). Der Berichtsstand Nr. 1 vom 10.11.2026 hält ihn fest.“ **S5** Die Berichts-Ereignisse sind
  unbefristet.

## 12. Ereignisse (reserviert)

Vier Arten, Bezug `bericht`, im Block `reserviert` von [`events-vocabulary-vectors.json`](./events-vocabulary-vectors.json)
(`BerichtRegeln.EREIGNISSE_RESERVIERT`): `bericht_freigegeben` (`kunde`), `bericht_revision_angestossen` (`cloud`),
`bericht_entwurf_neu_gebildet` (`cloud`), `bericht_abgerufen` (`kunde`). Angelegt mit den Berichts-Tabellen (IP-4,
`V20260915050100__uems_bericht_ereignisse.sql`): Zeitpunkt, Bezug NUR `bericht`; Pflicht `nr`/`datenstand`/`pruefsumme`,
`nr`/`anstoss_art`/`anlass_kennung` (optional `anlass_fassung`), `datenstand` (optional `anlass_kennung`), `nr`/`format`
([`events-vocabulary.md`](./events-vocabulary.md), „Berichte“).

## 13. Sprache (E14)

Kundenwörter: **Bericht**, **Berichtsvorlage**, **Entwurf** / **Berichtsentwurf**, **Berichtsstand Nr. n**, **Revision**,
**Datenstand**, **Quellenverzeichnis**, **Prüfsumme**, **Teilansicht**, **freigeben**, **abrufen**. Ein Bericht spricht über
sich nie von „Version“ (die gehört den Werten), „Ausgabe“, „Snapshot“, „Report“ oder „Freigabe zurücknehmen“
(`verbotene_woerter`); „Löschen“ steht nur im Satz über die Komponente, die ein Beleg schützt. Die Sätze stehen in
`saetze` und werden in beiden Zwillingen aus derselben Vorlage gefüllt; `copy.test.ts` liest sie gegen die Wörterbücher.

## 14. Zwillinge

| Regel | Java `BerichtRegeln` | TS `uemsBericht` | Fälle |
|---|---|---|---|
| `vorlage` | `vorlage` | `vorlage` | B1, B15 |
| `zeitraum` | `zeitraum` | `zeitraum` | B1, B6, B15 |
| `vergleich_grund`, `vergleich` | `vergleichGrund`, `vergleich` | `vergleichGrund`, `vergleich` | B1, B6, B11, B15 |
| `freigabe` | `freigabe` | `freigabe` | B1, B4, B15 |
| `datenstand` | `d2`, `d3`, `d4` | `d2`, `d3`, `d4` | B1, B2, B4, B5 |
| `betroffenheit` | `betroffene` (zwei Pfade), `anstossArt` | `betroffene`, `betroffeneStruktur`, `anstossArt` | B1, B3, B6–B9, B11 |
| `struktur` | `struktur` | `struktur` | B8–B10 |
| `abweichungen` | `abweichungen` | `abweichungen` | B2 |
| `rechte` | `kennung`, `teilansicht` (+ `RechteAbleitung.darf`) | `kennung`, `teilansicht` (+ `darf`) | B13 |
| `kanonisch` | `kanonisch`, `pruefsumme` | `kanonisch` (SHA-256 im Test über `node:crypto`) | B1, B14, B16 |
| `csv_kopf`, `csv_zeile` | `csvKopf`, `csvZeile` | `csvKopf`, `csvZeile` | B14 |
| `kopf`, `kennzeichen`, `anlass` | `kopf`, `berichtsstand` … `anstossVerworfen`, `anlass` | dieselben | B1, B2, B4, B6, B8, B10, B13, B15, B16 |
| `satz`, `anzeige` | `keineQuellen` … `abzugBeschaedigt`, `anzeige` | dieselben | B1, B6, B8, B12, B15, B16 |

Den SHA-256 rechnet das Portal nicht: der Server prüft die Prüfsumme beim Lesen eines Stands (A6). Was der Vertrag bewusst
anders sagt als der Konzeptkatalog, steht mit Grund in `_abweichungen`; was erst spätere Pakete prüfen, in `_nicht_geprueft`.

## Das Richtungspaar einer Reihe mit zwei Flüssen

Eine Messstelle wie MS-04 („Laden / Entladen“) führt EINE Größe mit zwei Flussrichtungen. Ein Bericht soll Laden und
Entladen getrennt zeigen (B1: 7 900 / 7 100 kWh), darf sie aber nicht neu rechnen (EW3) — er schreibt ab. Darum
entstehen die beiden Anteile in der **Verdichtung** und stehen neben der Netto-Menge:

- Migration `V20260918101000` legt `menge_positiv`/`menge_negativ` an `messreihe_tag` und `messreihe_periode` — nullbar,
  ohne Nachfüllung, ohne Default. Die Spalten kennen nur Vorzeichen; welches WORT ein Anteil trägt, sagt das Katalogwort
  der Richtung (`MessstelleRegeln.RICHTUNGSPAAR`: `charge_discharge` → Laden/Entladen, `import_export` → Bezug/Abgabe).
  Das ist **nicht** `ANTEIL_RICHTUNGEN`: was eine QUELLENBINDUNG mit einem Anteil belegen darf (Regel 7), bleibt
  unverändert.
- `Richtungspaar.ausTeilen` bildet sie wie den Anteil eines Vorzeichen-Werts: Σ max(0, Teil) und Σ max(0, −Teil)
  (`VerbrauchRegeln.anteilDesWerts`). Tag und Monat rechnen über ihre Viertelstunden, das Jahr summiert seine Monate;
  fehlt EINEM Teil sein Paar, fehlt es der ganzen Periode. Unbekannt ist keine Null.
- **Der Anteil entsteht JE ROHWERT, vor jeder Verdichtung** (AP-08 E15/M5). Das ist keine Feinheit: im gepackten
  Katalog trägt jeder Kanal mit zwei Richtungen `active_power` in W, also einen **Momentanwert** — die Menge entsteht
  durch Integration der Leistung. Migration `V20260918104000` legt darum `energie_positiv`/`energie_negativ` an
  `messreihe_viertelstunde`; `Richtungspaar.jeRohwert` trennt die Rohwerte mit
  `VerbrauchRegeln.anteilJeRohwert` und integriert beide Hälften mit derselben Regel, die `energie` bildet.
  Ab der Tages-Ebene wird nur noch SUMMIERT (`Richtungspaar.ausTeilen`) — dort ist die Viertelstunde schon EINE Zahl
  mit EINEM Vorzeichen. Der Beweis steht in `UemsRichtungspaarLaufTest`: eine Viertelstunde, in der der Speicher
  fünf Minuten lädt und fünf Minuten entlädt, hat BEIDE Anteile positiv — eine Summe über Viertelstunden-Vorzeichen
  behauptete dort für eine Richtung eine Null.
- **Was der Bestand sagt.** Viertelstunden von vor diesem Paket tragen ein NULL-Paar; ein Bericht zeigt das Paar dann
  als fehlend, nie als 0. Nachgerechnet wird nur über den bestehenden Rückrechnungsweg und nur aus noch vorhandenen
  Rohwerten — eine Näherung ersetzt keine Messung.

## Grenzen

Keine Tabelle, keine Migration, keine Route, kein Abzug, keine Fläche. Die Naht `BerichteNaht` behält ihre Bean `Keine` und
ihre Signatur; `KorrekturKaskade.Betroffen` bleibt unverändert.
