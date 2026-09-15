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
  schreibt, bricht die Prüfsumme `sha256:b79d0fb8…` von Nr. 1. Den SHA-256 rechnet nur Java; der TS-Test hasht mit
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
- **Reservierung, keine Anlage:** die vier `bericht_*`-Ereignisse legt IP-4 in `vokabular.arten` an. `KennzahlVectorsTest`
  überspringt sie, `BerichtVectorsTest` prüft sie.
- **Keine TS-Frist-Klasse:** `FREIGABE_FRIST_TAGE` im TS-Zwilling ist gegen `regeln.freigabe_frist_tage` geprüft, die Java
  gegen `TagRegeln.FRIST` prüft. Der Quelltext-Wächter verbietet feste Zeitzonen und eigene Sieben-Tage-Rechnungen.
