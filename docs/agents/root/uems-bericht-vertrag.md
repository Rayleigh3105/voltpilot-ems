# UEMS-Bericht-Vertrag (AP-12 IP-1 bis IP-3): Vertrag, Referenzdatei 1.4, Regel-Module

Das Fundament der Berichte. Es legt den Vertrag, gegen den alle folgenden AP-12-Pakete gebaut werden, und **ändert kein
Verhalten**: keine Migration, keine Tabelle, keine Route, keine Fläche, kein Abzug. Niemand ruft die Regeln an (Tabellen
IP-4, Abzug IP-5/IP-6, Routen IP-7, Naht IP-8, Läufer IP-9, CSV/PDF IP-10/IP-11, Belegschutz IP-12, Portal IP-13 ff.).

| Was | Wo |
|---|---|
| Prosa | `docs/contracts/v2/bericht.md`; additiv `ergebnis-zustand.md` §8, `events-vocabulary.md` („Reserviert für die Berichte“) |
| Vektoren + Schema | `bericht-vectors.json` (16 Fälle B1–B16, 106 Prüfungen, Abzüge im Block `abzuege`) + `bericht.schema.json` (`$defs` abzug, stand, quelle, anstoss, vorlage, vorlagen_datei) + `bericht-vorlagen.json`; Block `bericht_kennzeichen` in `ergebnis-zustand-vectors.json` (1.10); vier `bericht_*` im Block `reserviert` von `events-vocabulary-vectors.json` |
| Referenzdatei | `uems-referenzunternehmen.json` 1.4: `korrekturen[]` K-2026-0007, `berichte[]` BR-2026-0001 mit Nr. 1 und Nr. 2, Zeitachse 10.11./12.11./16.11.2026 und 29.01.2027 |
| Java | `services/api/.../uems/BerichtRegeln` (rein); additiv `ErgebnisZustand.zoneKurz` |
| TS | `frontend/portal/src/uemsBericht.ts` (rein); additiv `uemsErgebnis.zoneKurz` |
| Glossar | Bericht, Berichtsvorlage, Berichtsstand, Revision, Datenstand, Quellenverzeichnis (`docs/fachmodell/tools/fachmodell.py` → `build_fachmodell.py`) |
| Tests (rein) | `BerichtVectorsTest` · `uemsBericht.test.ts`; Referenz-Zwillinge; `copy.test.ts` Abschnitt „AP-12 IP-3“ |

```bash
(cd services/api && ./mvnw test -Dtest='BerichtVectorsTest,UemsReferenzunternehmenVectorsTest,KennzahlVectorsTest')
(cd frontend/portal && npx vitest run src/uemsBericht.test.ts src/uemsReferenzunternehmen.test.ts src/copy.test.ts)
```

## Die Fallen

- **Die kanonische Form ist Vertrag, Byte für Byte.** Schlüssel nach UTF-16-Codeeinheiten, Zeichenketten wie
  `JSON.stringify` (Steuerzeichen `\u00xx` KLEIN — Jackson schriebe groß, deshalb eigener Schreiber in `BerichtRegeln`),
  Zahlen ohne Exponent und ohne nachgestellte Nullen. Wer den Abzug als `jsonb` ablegt oder mit einem Standard-Serializer
  schreibt, bricht die Prüfsumme `sha256:b113527d…` von Nr. 1. Den SHA-256 rechnet nur Java; der TS-Test hasht mit
  `node:crypto`.
- **Javadoc mit Backslash-u bricht javac** („Unzulässiges Unicode-Escapezeichen“) — auch im Kommentar.
- **Das Recht prüft die Route VOR F1.** `freigabe` kennt nur Zeitraum → Werte → Entwurf; ein fremder Standort muss 404 sein,
  bevor eine 422 verrät, dass es den Bericht gibt (`_abweichungen`).
- **Betroffen = Zeitraum × Quellenverzeichnis, gültiger Stand vor Entwurf, nie ein ersetzter Stand.** Die reine Regel
  bekommt die Quellenbindung (Pfad 1) bzw. die aufgelösten Objekte (Pfad 2) vom Aufrufer; Tage einschließlich wie
  `Betroffen.ersterTag/letzterTag`. Eine Verteilung trifft die VERTEILTEN Zahlen (MS-20, 4100, 4200), nicht die Messstelle.
- **`rechte-matrix.json` bleibt unberührt.** Die fünf Berichts-Zeilen sind Konzept-Zeilen; `anmerkung` gehört zum Fingerabdruck
  `konzept_tabelle.sha256`. Die Rechte-Anmerkung steht in `bericht.md` §9.
- **Referenzdatei 1.4 hat einen Diff-Test** gegen den Fingerabdruck von 1.3 (`e65be4ed…`); der 1.3-Test nimmt zuerst die
  1.4-Zusätze heraus. Wer 1.5 anlegt, macht es genauso. `KennzahlVectorsTest` und `uemsKennzahl.test.ts` prüfen seitdem
  „Fassung ≥ `referenz_stand`“, nicht Gleichheit.
- **Reservierung, dann Anlage:** die vier `bericht_*`-Ereignisse stehen seit IP-4 (`V20260915050100`) in `vokabular.arten`;
  die Reservierung bleibt als Herkunft. `KennzahlVectorsTest` überspringt sie, `BerichtVectorsTest` prüft gleiche Urheber
  (Tabellen und Ereignisse: `uems-bericht-tabellen.md`).
- **Keine TS-Frist-Klasse:** `FREIGABE_FRIST_TAGE` im TS-Zwilling ist gegen `regeln.freigabe_frist_tage` geprüft, die Java
  gegen `TagRegeln.FRIST` prüft. Der Quelltext-Wächter verbietet feste Zeitzonen und eigene Sieben-Tage-Rechnungen.

## Fassung 1.2 und das Richtungspaar (Folgepaket `vp-uems-b12-tagesverlauf-speicher`, erster Schnitt)

- **1.2 ist additiv und WAHLFREI.** `$defs/abzug.tagesverlauf` (`$defs/tagesverlauf_reihe`: je Wert-Zeile ihre Tage mit
  Menge und Zustand) und `$defs/kennzahl.ort_zum_datenstand`/`endgueltig_ab` wie an `$defs/wert`. Ein Abzug nach 1.0/1.1
  bleibt gültig, byte-gleich lesbar und behält seine Prüfsumme (`b113527d…`/`0f0feda0…`) — die Abnahme aus PR 827 rührt
  sich nicht. `BerichtRegelwerk.VERTRAEGE` nennt `bericht` = `1.2`, `BerichtRegelwerkTest` hält es gegen die
  `schema_version` der Vektor-Datei.
- **Die Bildung schreibt 1.2 ab — B1 ist vollständig, keine benannte Lücke mehr.** MS-04 wird zu ZWEI Zeilen
  (laden 7 900 / entladen 7 100 aus `messreihe_periode.menge_positiv/menge_negativ`, beide mit demselben Nachweis),
  die Zusammenfassung zählt 16 Zeilen und nennt `speicher_*`, der Tagesverlauf steht in der Monatsvorlage, jede
  Kennzahl trägt Ort und Endgültigkeit, und die CSV füllt ihre zwei Zellen. Es bleiben zwei benannte ABWEICHUNGEN des
  Vektors (Kennzahl-Zahl mit zehn statt vier Nachkommastellen; KZ-0005 heißt in der Referenzdatei mit Gedankenstrich).
- **⚠ Die Prüfsummen sind fortgeschrieben** — `b79d0fb8…`→`b113527d…` (9 637 B) und `d2073f76…`→`0f0feda0…` (9 918 B).
  Wer sie erneut bewegt, muss ALLE Nagelstellen in EINEM Zug erwischen: `bericht-vectors.json` (13),
  `events-vocabulary-vectors.json` (3), `berichtFixtures.ts` (2), `e2e/berichte.spec.ts` (2), `BerichtApiTest` (2),
  `BerichtCsvTest` (1), `bericht.md`, `uems-bericht-routen.md`, `uems-uebersicht.md` und diese Datei — plus die
  byte-gleiche Kopie `frontend/portal/src/test/berichtAbzuege.json`, die kein Grep nach der Prüfsumme findet.
- **Der Tagesverlauf steht im Abzug, aber die Berichtsseite zeigt ihn noch nicht** — `berichtSeite.ts` hat keinen
  Abschnitt dafür, er landet weiter in `ohneInhalt`. Das ist eine PORTAL-Lücke, keine Vertrags-Lücke.
- **Das Richtungspaar gehört in die VERDICHTUNG, nicht in den Abzug** (EW3). `V20260918101000` legt
  `menge_positiv`/`menge_negativ` an `messreihe_tag` und `messreihe_periode` (nullbar, ohne Nachfüllung — der
  Bestandsschutz-Vergleich sieht eine überall leere Spalte nicht). `Richtungspaar.ausTeilen` bildet Σ max(0, Teil) und
  Σ max(0, −Teil) über `VerbrauchRegeln.anteilDesWerts`; Tag und Monat aus ihren Viertelstunden, das Jahr aus seinen
  Monaten. Fehlt EINEM Teil sein Paar, fehlt es der ganzen Periode.
- **`RICHTUNGSPAAR` ist nicht `ANTEIL_RICHTUNGEN`.** Das eine sagt, wie die Verdichtung die zwei Anteile benennt
  (`charge_discharge` → Laden/Entladen, `import_export` → Bezug/Abgabe); das andere, was eine QUELLENBINDUNG mit einem
  Anteil belegen darf (Regel 7) — dort bleibt `charge_discharge` weiter ausgeschlossen. Wer das zusammenlegt, ändert
  still, welche Bindungen das System annimmt.
- **Der Anteil entsteht JE ROHWERT** (AP-08 E15/M5, firstmate-Entscheid 18.09.2026 = Option A). Im gepackten Katalog
  trägt JEDER Kanal mit zwei Richtungen `active_power` in W — einen Momentanwert (5 × `charge_discharge`,
  49 × `import_export`, kein einziger als Intervallmenge), seine Menge entsteht aus integrierter Leistung. Darum legt
  `V20260918104000` `energie_positiv`/`energie_negativ` an `messreihe_viertelstunde`, und `Richtungspaar.jeRohwert`
  bildet sie dort: Rohwerte mit `anteilJeRohwert` trennen, beide Hälften mit derselben Regel integrieren wie `energie`.
  **Ab der Tages-Ebene wird nur noch summiert** — wer dort rechnen wollte, verlöre jeden Vorzeichenwechsel INNERHALB
  einer Viertelstunde (`UemsRichtungspaarLaufTest` misst genau diesen Fall).
- **Das ALTER am Hypertable ist reine Metadaten-Arbeit.** `ADD COLUMN` nullbar ohne Default schreibt seit PG 11 nur den
  Katalog; komprimierte Chunks kann es an `messreihe_viertelstunde` nicht geben, weil sie RLS + FORCE trägt und
  TimescaleDB Kompression auf RLS-Tabellen verweigert (Grund steht in `V20260809000000`). Der CHECK steht darum
  ausdrücklich als `NOT VALID` — ein gültiger CHECK müsste jede Zeile lesen. Kosten: **0 B je Zeile, solange NULL**
  (Null-Bitmap 6 → 7 B, Zeilenkopf bleibt `MAXALIGN(23+7) = 32 B`), gefüllt ~24 B an 54 von 2 395 Katalogpunkten
  (2,3 %) ≈ 0,23 % des `vm`-Plans (`docs/performance/speicherplanung.md`).
