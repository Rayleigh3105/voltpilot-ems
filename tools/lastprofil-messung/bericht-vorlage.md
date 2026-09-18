# NW-5 Lastprofil — Messbericht

- Umgebung: `<Probe-Umgebung>`
- Stand (Commit): `<Commit>`
- Messdauer: `<Sekunden>`
- Simulierte Dauer: `<Minuten>`
- Einordnung: `<Werkzeug-Beleg, keine Abnahme-Messung | Abnahme-Messung>`

| Schwelle aus §3.3 | Soll | Gemessen | Urteil |
|---|---:|---:|---|
| Samples verworfen | 0 | `<Messlücke, solange Writer keinen Zähler exportiert>` | NICHT MESSBAR |
| Ereignis-Bus-Rückstand nach Stoß abgebaut | < 15 min | `<Minuten>` | `<BESTANDEN / NICHT BESTANDEN>` |
| Ältester Arbeitslisten-Eintrag im Dauerlauf | < 15 min | `<Minuten>` | `<BESTANDEN / NICHT BESTANDEN>` |
| Stundenlauf | < 10 min | `<Minuten>` | `<BESTANDEN / NICHT BESTANDEN>` |
| Datenbankwachstum (roh + vm) | ±20 % der Speicherrechnung | `<Bytes; Soll-Bytes>` | `<BESTANDEN / NICHT BESTANDEN>` |
| Zeilen je Tag | 1 872 000 roh / 124 800 Viertelstunden | `<roh / Viertelstunden>` | `<BESTANDEN / NICHT BESTANDEN>` |

## Messwerte

- Writer-Rate: `<Rohzeilen/min>`
- Verbraucher-Rückstand: `<vorher → nachher>`
- Bytes je Speicherklasse: `<roh, vm, tag, ereignis>`

## Benannte Messlücke

Keine vorhandene Metrik oder Tabelle zählt vom Writer verworfene
Umschläge/Samples. `dropped_samples` belegt nur von der Box gemeldete
Pufferverluste. Die Schwelle darf deshalb nicht als bestanden markiert werden.
