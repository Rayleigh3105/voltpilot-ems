# Energiemanagement: Überprüfung, Wiedervorlage, Vergleich, Verzeichnis-Zeile, Prüfsumme (UEMS AP-19)

Stand 24.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap19-fundament` §4.2–4.9, §5.8, §7 R1–R3, R7–R14, §8 IP-2;
Entscheide E1–E10 = A, W1–W15 übernommen (24.09.2026).

Die Abnahme des Captains: **„Die erforderlichen Entscheidungen und Nachweise sind auffindbar; die Verantwortung des
Kunden bleibt ausdrücklich erkennbar.“** VoltPilot hält fest, der Kunde entscheidet, und jede Zeile sagt, wo das
Original liegt. Am 12.02.2029 ist die Überprüfung der Energiepolitik D-0001 **seit 64 Tagen fällig**, die Bezugsbasis
BB-0002 **seit 457 Tagen** — und stünde im Betrachtungsumfang nur Strom, hieße es „**Gas** gehört zum Anwendungsbereich,
aber nicht zum Betrachtungsumfang“. Ein Urteil fällt keine dieser Regeln.

| Datei | Rolle |
|---|---|
| [`energiemanagement.schema.json`](./energiemanagement.schema.json) | die Form der Vektor-Datei (geschlossen; nur die Schlüsselwörter beider Schema-Läufer) |
| [`energiemanagement-vectors.json`](./energiemanagement-vectors.json) | 104 Fälle mit Handrechnung (`rechnung`), Startwerte, Vokabulare, Wörter, Kennzeichen-Muster, die Kundensätze als Schablonen |
| [`bericht.md`](./bericht.md) §2 A1/A6 | die kanonische Form und die Prüfsumme — hier aufgerufen (`BerichtRegeln.kanonisch`, `uemsBericht.kanonisch`), nie nachgebaut |
| [`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) 1.10 | `dokumente[]`, `audits[]`, `feststellungen[]`, `managementbewertungen[]`, `energiemanagement.einstellung` — ihre Prüfsummen und Fristen sind genau das, was die Operationen rechnen |
| `services/api/.../uems/EnergiemanagementRegeln.java` | der Java-Zwilling (rein) |
| `frontend/portal/src/energiemanagement.ts` | der TS-Zwilling (rein; eigene Satz-Schablonen, Grenz-, Verantwortungs- und Leer-Satz aus dem Glossar) |
| `services/optimization/voltpilot_optimization/energiemanagement.py` | die Python-Referenz — `ueberpruefung`, `zeile`, `vergleich_anwendungsbereich`, `vz` aus `k_faelle.py` |

> **Wer anruft:** noch niemand. `ueberpruefung` rufen die Dokument-Routen (IP-7, Überprüfung beim Abruf), das Auditprogramm,
> die Feststellung und die Managementbewertung; `wiedervorlage` der Leser `GET /api/v1/energiemanagement/wiedervorlage` (IP-21,
> `EnergiemanagementWiedervorlageService`: er sammelt die fertigen Fristen der `WiedervorlageQuelle`n — DK5, IA4, FS1,
> AP-16 S5, AP-17 F5, AP-12 E7, `faellig[]` des Übersichts-Lesers von AP-18 samt Messbedarf; MG7 dockt mit IP-23 an);
> `anwendungsbereich_vergleich` der Leser `…/dokumente/{id}/vergleich` (IP-7); `verzeichnis_zeile` jede Quelle des
> Verzeichnisses `GET /api/v1/energiemanagement/verzeichnis` (IP-8: `DokumentVerzeichnis`, `AufgabenVerzeichnis`, `VerzeichnisBestand`); `pruefsumme` jeder Schreibweg, der eine Kopie festhält (Fassung, Audit-Abschluss, Wirksamkeit, Stand).

## 1. Vokabulare, Startwerte, Wörter (geschlossen, in `energiemanagement-vectors.json`)

Die Wörter aus §4.2 stehen **wörtlich** in `vokabulare` — IP-5 legt sie als CHECK bzw. `energiemanagement_vokabular()` an.
Wo §4.2 ein Wort mit Zusatz nennt, ist der Zusatz eine Pflicht des Schreibwegs, nicht Teil des Worts:
`bekanntmachung_weg` `weiterer` („mit Wortlaut“), `feststellung_eintrag` `ursache_aussage` („Person, Tag — Aussage von“),
`aufgabe` `weitere` („mit Wortlaut“).

| Gruppe | Schlüssel | Quelle |
|---|---|---|
| Dokument | `dokument_art` (zwölf, keine Art „sonstiges“, G5) · `dokument_klasse` · `dokument_zustand` · `dokument_bezug` · `fassung_form` · `fassung_status` · `dokument_eintrag` · `bekanntmachung_weg` | §4.2 Vokabulare |
| Personen, Aufgaben | `aufgabe` (zehn) · `person_zustand` · `aufgabe_zustand` | §4.2 Vokabulare und Zustände |
| Audit, Feststellung | `audit_zustand` · `audit_eintrag` · `feststellung_quelle` · `feststellung_zustand` · `feststellung_eintrag` · `wirksamkeit_ergebnis` | §4.2 |
| Managementbewertung | `managementbewertung_zustand` (`entwurf · freigegeben`, der Stand Nr. n ist AP-12) · `beschluss_art` · `folge_art` (MG6: Energieziel, Maßnahme, Dokument-Fassung, Aufgabe, Audit) | §4.2 Zustände, MG5, MG6 |
| Leser | `wiedervorlage_art` · `verzeichnis_ort` (drei der vier Stufen von G1 — „bei Ihnen, nicht in VoltPilot“ hat keine Zeile) · `verzeichnis_gruppe` (elf, VZ3) | §4.2, k_faelle `GRUPPEN` |
| Operation | `ueberpruefung_art` · `ueberpruefung_grund` | dieser Vertrag (§2) |

`dokument_art_klasse` ordnet jede Art `vorgabe` (mit Überprüfung) oder `nachweis` (Auslegung, Kompetenz — ohne) zu;
`leitungs_pflicht` nennt die drei Arten, deren Freigabe die Leitung entscheidet (DK3: Energiepolitik, Anwendungsbereich,
Bestellung). `kennzeichen_muster`: `D-nnnn` ohne Jahr (`^D-[0-9]{4,13}$`, Muster BB-), `AU-JJJJ-nnnn`, `F-JJJJ-nnnn`
(`[0-9]{4,9}` wie Maßnahme und Abweichung) und die Kennung eines Beschlusses `BR-JJJJ-nnnn/Bn` (die Herkunft
`managementbewertung` der Maßnahme). `woerter` trägt die Kundenwörter von Dokument-Art, Aufgabe, Verzeichnis-Gruppe und Ort.
Die geweiteten fremden Vokabulare (`massnahme_herkunft`, `bericht.vorlage`, `bericht.quelle_art`, Rolle `einsicht`) stehen
in ihren eigenen Verträgen.

**Startwerte** (ohne Norm-Herleitung, je Unternehmen in der Einstellung; Referenzdatei 1.10 `energiemanagement.einstellung`):
Überprüfung 12 Monate (1–60) · Audit-Rhythmus 12 Monate · Managementbewertung 12 Monate · Frist einer Feststellung 90 Tage ·
Vorschau 30 Tage · Wortlaut höchstens 20 000 Zeichen · Begründung 10–500 Zeichen · Eintrag höchstens 2 000 Zeichen.

## 2. Operation `ueberpruefung` (DK5, IA4, MG7, FS1)

Die vier AP-19-Fristen, **beim Abruf** abgeleitet (kein Läufer, kein gespeicherter Zustand „fällig“). Der Tag des Abrufs
ist der Eingang `abruf` — nie eine Uhr im Zwilling (Quelltext-Probe in allen drei Tests).

| `art` | Eingang | fällig am | ohne Frist (`grund`) |
|---|---|---|---|
| `dokument` (DK5) | `dokument_art`, `monate`, `fassungen[]` (`nr`, `freigegeben_am`), `geprueft_bleibt[]` (`fassung`, `am`) | gültig ist die freigegebene Fassung mit der höchsten Nr. bis zum Abruf (DK4); Basis = jüngere von ihrer Freigabe und ihrem letzten „geprüft, bleibt“; + `monate` | `nachweis` (Art ohne Überprüfung) · `keine_fassung` |
| `internes_audit` (IA4) | `monate` (Rhythmus), `tage[]` (Durchführungstage) | letzter Durchführungstag bis zum Abruf + Rhythmus | `kein_audit` — kein erfundener Beginn |
| `managementbewertung` (MG7) | `monate` (Rhythmus), `tage[]` (Sitzungstage) | letzte Sitzung bis zum Abruf + Rhythmus | `keine_managementbewertung` |
| `feststellung` (FS1) | `festgestellt_am`, `frist` (Tag oder `null`), `frist_tage`, `zustand`, `abruf` | `frist`, sonst `festgestellt_am` + `frist_tage` (Vorgabe 90) | `abgeschlossen` — nur offene haben eine Frist |

Monate addiert wie `LocalDate.plusMonths` (Monatsende geklemmt: 31.01. + 1 = 28.02.; 29.02.2028 + 12 = 28.02.2029).
Ausgang: `faellig_am`, `basis`, `fassung` (nur Dokument), `tage` = Abruf − fällig am in Kalendertagen (positiv = fällig,
**0 am Fälligkeitstag**, negativ = noch nicht) und `satz` — die Lage in den Wörtern der Wiedervorlage:
„seit n Tagen fällig“ · „heute fällig“ · „fällig in n Tagen“. Ohne Frist sind alle fünf `null` und `grund` sagt warum.
Ablehnungen: `dokument_art` (nicht in der Liste), `ueberpruefung_monate` (Vorgabe ohne Monate oder außerhalb 1–60),
`rhythmus_monate` (< 1), `frist_tage` (< 1), `feststellung_zustand`, `ueberpruefung_art` (die Wiedervorlage rechnet
keine fremde Frist nach, WV2 — Bezugsbasis und Bewertung haben ihre eigenen Regeln).

## 3. Operation `wiedervorlage` (WV1–WV3)

Eingang `abruf`, `vorschau_tage` (Startwert 30) und `zeilen[]` mit `art` (`wiedervorlage_art`), `kennzeichen`, `titel`,
`faellig_am`, `verantwortlich`. Jede Zeile kommt **fertig** aus der Regel ihres Objekts (WV2) — die Operation rechnet nur
`tage` und `satz` wie §2, dann:

- **fällig** = `tage` ≥ 0, **Vorschau** = fällig in höchstens `vorschau_tage` Tagen (genau 30 ist Vorschau, 31 nicht);
  alles Spätere steht in `nicht_in_liste` (Kennzeichen, sortiert).
- **Reihenfolge:** am längsten fällig zuerst — nach `faellig_am`, bei gleichem Tag nach `kennzeichen`
  (BB-0004 vor BW-2027-0001, beide 24.11.2028); bei gleichem Tag und Kennzeichen bleibt die Reihenfolge des Eingangs.
- Ausgang `faellig[]`, `vorschau[]`, `anzahl_faellig`, `anzahl_vorschau` (der Baustein WV5: „8 fällig · 1 in den nächsten
  30 Tagen“), `nicht_in_liste[]`. Ablehnungen `vorschau_tage` (< 0), `wiedervorlage_art`.

R12 am 12.02.2029: BB-0002 457 · BB-0005 450 · BB-0003 344 · VB-2028-0001 315 · BB-0004 80 · BW-2027-0001 80 · D-0001 64 ·
D-0002 64, Vorschau M-2029-0001 in 16 Tagen. Die Zeilen (Kennzeichen, Titel, fällig am, Satz) sind **wörtlich** die
Eingabe `wiedervorlage` im Stand BR-2029-0001 Nr. 1 der Referenzdatei (`test_energiemanagement.py`).

## 4. Operation `anwendungsbereich_vergleich` (DK7)

Eingang `anwendungsbereich` und `betrachtungsumfang` (AP-16 U1), je `standorte[]` und `traeger[]` (Namen des
Träger-Vokabulars des Betrachtungsumfangs). Ausgang: `standorte_nur_im_anwendungsbereich`,
`standorte_nur_im_betrachtungsumfang`, `traeger_nur_im_anwendungsbereich`, `traeger_nur_im_betrachtungsumfang` (je in der
Reihenfolge ihres Eingangs) und `deckungsgleich`. Die Reihenfolge der Eingänge zählt nicht. Kein Urteilswort — die Seite
sagt es mit `anwendungsbereich_deckungsgleich` bzw. je Unterschied `anwendungsbereich_unterschied` (§6).

## 5. Operation `verzeichnis_zeile` (VZ2, G1)

Eingang: `gruppe`, `art`, `kennzeichen`, `titel`, `nr`, `entschieden_von`, `eingetragen_von`, `tag`, `pruefsumme`, `ort`,
`ablage`. Ausgang: dieselben Felder ohne `ablage`, dazu `gruppe_wort` und `ort_satz` = das Wort des Orts, bei
„Wortlaut in VoltPilot, Original bei Ihnen“ und „Geführt in Ihrem System“ mit „: <Ablage>“. Die Ablage ist dort Pflicht
(KS1, `ablage_fehlt`); was VoltPilot führt, hat keine (`ablage_unerwartet`). Unbekannte Gruppe/Ort werden abgelehnt.
Die Operation füllt keine Person nach: Zeilen, deren Quelle Person oder Tag nicht trägt (Kennzahl-Fassungen der
Referenzdatei), bleiben `null` — nie eine Zahl über das Ganze, nie „fehlt“ (G4).

## 6. Operation `pruefsumme` — die kanonische Zahlform des Baus

**Festgelegt: der Bau nimmt die kanonische Form von [`bericht.md`](./bericht.md) A1** — Schlüssel nach UTF-16 sortiert,
kein Leerraum, Zeichenketten wie `JSON.stringify`, Zahlen in Dezimalschreibweise **ohne Exponent und ohne nachgestellte
Nullen** — und die Prüfsumme A6 (`sha256:` + SHA-256 hex über die UTF-8-Bytes). Eine Kopie, deren Quelle `-5.0` trägt,
wird mit `-5` gehasht. Der Konzept-Katalog (`k_faelle.pz`) rechnete über `json.dumps` und schrieb `-5.0`/`-3.0`: für den
Stand BR-2029-0001 Nr. 1 ergäbe das `sha256:7db218a7…` (6 009 Bytes); gültig ist `sha256:0a52c97d…` (6 005 Bytes) — so
steht es in der Referenzdatei 1.10, so rechnen alle Zwillinge und alle Kopien seit 1.8. Grund: jede bestehende Prüfsumme
(Berichte, Bewertungen, Bezugsbasen, Maßnahmen) nutzt diese Form; eine zweite hieße, dass derselbe Stand zwei Prüfsummen hat.

Die Zwillinge rufen die Form, sie bauen sie nicht nach: Java `BerichtRegeln.kanonisch`/`pruefsumme`, TS
`uemsBericht.kanonisch` (SHA-256 reicht der Aufrufer herein: `crypto.subtle` im Browser, `node:crypto` im Test), Python
`energiemanagement.kanonisch` (Referenz, byte-gleich). Die Kopien der Referenzdatei als Vektoren:

| Kopie | Felder | Prüfsumme |
|---|---|---|
| Dokument-Fassung (DK2) | `nr`, `form`, `wortlaut`, `verweis`, `anwendungsbereich` — `verweis` mit `bezeichnung`, `ablage`, `kennung`, `adresse`, `fassungsangabe`, `datum`, `sha256`; `anwendungsbereich` mit `standorte`, `traeger`, `ausschluesse` | D-0001/1 `163ae836…`, D-0002/1 `583a847c…`, D-0004/1 `bd330fe4…` |
| Abschluss eines internen Audits (IA3) | `kennzeichen`, `hinweise`, `feststellungen`, `bericht` | AU-2029-0001 `27a580b9…` |
| Wirksamkeit Stand Nr. n (FS4) | die `kopie` des Stands (Feststellung, Einträge, Maßnahmen mit Zustand, Aufgabe, Tag) | F-2029-0001/1 |
| Stand einer Managementbewertung (MG7, AP-12 A1) | der Abzug (Eingaben zum Datenstand, Sitzung, Beschlüsse) | BR-2029-0001/1 `0a52c97d…` |

Dazu ein Randfall mit dem erwarteten Text (`-5.0 → -5`, `0.0`/`-0.0 → 0`, `1.5E-7 → 0.00000015`, `1E+21` ausgeschrieben,
Schlüssel `Z < a < ä < é`, Steuerzeichen-Escapes).

## 7. Kundensätze (§5.8) — Operation `satz`

`saetze` in der Vektor-Datei trägt die 40 Schablonen (`{name}` = Platzhalter); `SAETZE` ist in allen drei Zwillingen
gleich (Test). `satz(schluessel, werte)` füllt jeden Platzhalter genau aus `werte` — fehlt einer: `wert_fehlt:<name>`,
bleibt einer übrig: `wert_uebrig:<name>`, unbekannter Satz: `satz_unbekannt`. Jeder Satz-Vektor füllt die Schablone mit
den Werten des Konzepts und erwartet den Satz aus §5.8 **wörtlich** (dieselben 37 + 3 Sätze wie der Block
„Energiemanagement“ in `copy.test.ts`). Verantwortungs-Satz, Grenz-Satz und „Hier ist noch nichts festgehalten.“ haben
im Portal genau eine Quelle (`UEMS_VERANTWORTUNG`, `UEMS_NORMGRENZE`, `UEMS_NOCH_NICHTS_FESTGEHALTEN`). Die Zahlen und
Namen stellt der Aufrufer (Daten `TT.MM.JJJJ`, Zeiten `TT.MM.JJJJ, HH:MM`).

## 8. Die Vektoren

Jeder Fall trägt `name`, `regel`, `operation`, `quelle`, `rechnung`, `eingang` und `erwartet`. Je Operation:
`ueberpruefung` 30 · `wiedervorlage` 7 · `anwendungsbereich_vergleich` 5 · `verzeichnis_zeile` 11 · `pruefsumme` 7 ·
`satz` 44. Pflichtfälle aus §8 IP-2 als eigene Vektoren: „R1 D-0001 seit 64 Tagen fällig“, „R12 BB-0002 seit 457
Tagen“, „R2 nur Strom → Gas nicht im Betrachtungsumfang“. Die Erwartungen der R-Fälle stammen aus dem Konzept-Katalog
(`k_faelle.py`: `UEB_D1`, `UEB_D2`, `UEB_D1_APRIL`, `AUDIT_NAECHSTES`, `MB_NAECHSTE`, `F1_FRIST`, `KANDIDATEN`,
`FAELLIG`, `VORSCHAU`, `NICHT_IN_LISTE`, `VGL_AB`, `VGL_AB_NUR_STROM`, `VERZEICHNIS`), die Prüfsummen aus der
Referenzdatei 1.10. Ränder: 0 Tage, genau 30/31 Tage Vorschau, Monatsende und Schaltjahr, 60 und 61 Monate, ein
„geprüft, bleibt“ der abgelösten Fassung, ein Audit nach dem Abruf, Art „sonstiges“, Ablage fehlt/unerwartet.
`test_energiemanagement.py` prüft außerdem Wiedervorlage und Überprüfung im Stand BR-2029-0001 und die Startwerte gegen
die Einstellung der Referenzdatei.

## 9. Abweichungen und Grenzen

- **`ueberpruefung` umfasst auch die Frist der Feststellung (FS1).** §8 nennt DK5, IA4, MG7; NW-1 verlangt dazu die
  Feststellungs-Frist, und WV2 nennt alle vier als die AP-19-Fristen. Eine Operation, vier Arten.
- **Einzahl.** „seit 1 Tagen fällig“ — die Einzahl kennen weder `k_faelle.zeile` noch AP-18 (`ueberfaellig`); wer sie
  will, ändert beide Verträge gemeinsam (die Sätze stehen in freigegebenen Ständen).
- **Die Gegenrichtung des Vergleichs** („… gehört zum Betrachtungsumfang, aber nicht zum Anwendungsbereich“) nennt §5.8
  nicht; `anwendungsbereich_vergleich` liefert sie, den Satz ergänzt IP-7 mit Vektor, wenn die Seite ihn braucht.
- **Welche Zeilen der Aufrufer übergibt**, entscheidet er: aufgehobene Dokumente (DK8), abgesagte Audits, Sitzungen einer
  Managementbewertung im Entwurf. Die Operation filtert nur nach dem Abruf-Tag.
- Nicht in diesem Vertrag: Leitungs-Pflicht und Vier-Augen (Schreibwege IP-6/IP-7), Kalender-Abzug (.ics, IP-21: `openapi.yaml`) und
  Verzeichnis-CSV (IP-8), „Wer ist wofür verantwortlich“ (IP-10), Rechte und Zaun, Tabellen.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='EnergiemanagementVectorsTest')
(cd frontend/portal && npx vitest run src/uemsEnergiemanagement.test.ts src/copy.test.ts)
(cd services/optimization && PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python -m pytest tests/test_energiemanagement.py)
```
