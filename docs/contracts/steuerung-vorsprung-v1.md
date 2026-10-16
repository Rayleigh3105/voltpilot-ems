# Vorsprung mit Bestand je Anlage (api → Optimierer), v1

Grundlage: Entscheid NS-2 A (Captain, 15.10.2026), Untersuchung `vp-herzogau-nie-schlechter-k5` §7, Bauplan NS-P2.
Die Kachel „VoltPilot-Steuerung“ zeigt je Anlage Monat und letzte 7 Tage **mit Bestand** gegen den sturen Speicher
(HZ-3 A, faire Messlatte seit NS-1 A). Der Optimierer hält beide Zahlen über ein Vorsprung-Budget nie tiefer als das
Budget unter null ([Optimierer-README](../../services/optimization/README.md#garantie-vorsprung-budget-ns-2-a)). Dazu
braucht er sie beim Einlesen. Er liest die Datenbank direkt (`inputs.py`), keine Route der api – deshalb legt die api
die Zahlen je Anlage in einer Tabelle ab.

| Seite | Ort |
|---|---|
| Tabelle | `steuerung_vorsprung`, Migration `V20261017031500__steuerung_vorsprung.sql` (RLS mit `FORCE`, Laufzeitrolle schreibt) |
| Erzeuger | api `optimizer/SteuerungVorsprungLaeufer` (Takt 5 min, je Kundenbereich unter `TenantContext`), Zahlen aus `repo/SteuerungVorsprung` über `EarningsRepository#vorsprungStaende` |
| Verbraucher | Optimierer `inputs._vorsprung_stand` → `domain.VorsprungStand` → `vorsprung.mit_budget`, nur an Anlagen in `OPTIMIZER_VORSPRUNG_BUDGET_ANLAGEN` |
| Schalter | api `voltpilot.steuerung-vorsprung.enabled` (`VOLTPILOT_STEUERUNG_VORSPRUNG_ENABLED`, Vorgabe an); ob ein Plan die Zahlen nutzt, entscheidet allein der Optimierer-Schalter je Anlage |

## Spalten

Eine Zeile je Anlage (`site_id` Primärschlüssel), bei jedem Takt überschrieben.

| Spalte | Typ | Bedeutung |
|---|---|---|
| `site_id`, `tenant_id` | uuid | Anlage und Kundenbereich (zusammengesetzter Schlüssel auf `site`) |
| `tag` | date | Berliner Tag D, zu dem die Fenster gehören: der jüngste Tag mit gemessenem Eimer |
| `messung_bis` | timestamptz | Ende des letzten gemessenen Eimers von D – der Moment von `vorsprung_kwh` |
| `bewertung_ct_kwh` | numeric(8,2) | Bewertung einer gespeicherten kWh: Bezugspreis × √0,92 (fest 25 ct → 23,98 ct; dynamisch Tagesmittel) |
| `vorsprung_kwh` | numeric(12,3) | gemessener Ladestand − Vergleichsspeicher in kWh; ein Rückstand ist negativ |
| `kapazitaet_kwh` | numeric(12,3) | kWh je 100 % des Vergleichsspeichers (NS-1 A: aus der Messung, sonst Nennwert), > 0 |
| `monat_mit_bestand_eur` | numeric(12,2), NULL | Σ der Tage vom Monatsersten bis einschließlich D, mit Bestand; **NULL bei einer Lücke** |
| `sieben_tage_mit_bestand_eur` | numeric(12,2), NULL | Σ der Tage D−6 … D, der laufende Tag bis `messung_bis`; **NULL bei einer Lücke** |
| `tage_mit_bestand_eur` | numeric(12,2)[] | die 6 abgeschlossenen Tage D−6 … D−1, ältester zuerst; ungemessener Tag 0, Tag mit Lücke NULL |
| `berechnet_am` | timestamptz | wann die api die Zeile geschrieben hat |

## Regeln

1. **Dieselben Zahlen wie die Kachel.** Monat und Tage kommen aus `SteuerungMitBestand` über denselben Walk wie
   `tagesbildForSite` (Tag mit Bestand = Kasse + (Vorsprung 24:00 − Vorsprung 00:00) × Bewertung, je Tag auf den
   Cent; Tagesbeginn am Monatsersten = Stand nach dem Anker). Belegt in `SteuerungTageszahlTest` (Fälle
   `mit_bestand`: Monatsgrenze, Lücke).
2. **Das 7-Tage-Fenster schließt den laufenden Tag ein** (D−6 … D). Solange D läuft, zeigt die Kachel die 7 Tage
   davor – morgen aber genau dieses Fenster; der Plan von heute kann nur noch dieses bewegen.
3. **Der Stand gehört zum jüngsten gemessenen Tag.** Hat eine Anlage an D noch keinen Eimer, gilt in der ersten Stunde
   nach Mitternacht der Vortag; danach hat sie keine Zeile. So verankert der Optimierer einen Monatswechsel selbst.
4. **Fehlende Daten = kein Budget.** Eine Lücke (fehlender gemessener Ladestand am Tagesrand) leert jede Summe, die den
   Tag braucht (NULL wie auf der Kachel). Ohne Vorsprung am letzten Eimer, ohne Bewertung oder Kapazität gibt es keinen
   Stand, und die Zeile der Anlage wird gelöscht – nie bleibt ein alter Stand als Budget stehen.
5. **Frische.** Der Optimierer nutzt einen Stand nur, wenn `messung_bis` höchstens 60 min vor dem ersten Slot des
   Laufs liegt (`vorsprung.HOECHSTALTER`); bis dahin gilt „der Vergleichsspeicher hat sich wie der echte bewegt“.

## Wie der Optimierer die Zeile liest

Er zerlegt jede Summe in einen festen Teil und den Bestand: `fest = summe − vorsprung_kwh × bewertung`. Je Slot des
Plans gilt `Vorsprung = fest + Kasse seit messung_bis + Wert(Vorsprung in kWh)`. Den Bestand bewertet er vorsichtiger
als die Kachel: ein Rückstand mit `bewertung_ct_kwh`, ein Vorsprung mit dem Einspeisewert des nächsten Mittags
(höchstens der Bewertung, nie unter null) – der geprüfte Vorsprung ist so nie größer als die Zahl der Kachel. Den
Vergleichsspeicher stellt er um `vorsprung_kwh / kapazitaet_kwh` Prozentpunkte unter den echten Ladestand. An jeder
Mitternacht des Horizonts fällt der älteste Tag aus `tage_mit_bestand_eur` aus dem 7-Tage-Fenster; am Monatsersten
beginnt der Monat bei 0 und der Vergleichsspeicher springt auf den echten Stand.

Beispiel (Herzogau, 13.10. 12:15):

```json
{"tag": "2026-10-13", "messung_bis": "2026-10-13T10:15:00Z", "bewertung_ct_kwh": 23.98, "vorsprung_kwh": -4.500,
 "kapazitaet_kwh": 59.700, "monat_mit_bestand_eur": 12.34, "sieben_tage_mit_bestand_eur": 1.20,
 "tage_mit_bestand_eur": [1.10, 0.00, 0.85, -0.25, 0.00, 2.00]}
```

## Versionen

v1 ist rein additiv (neue Tabelle). Spalten nur additiv ergänzen; eine Änderung an Namen, Einheit oder NULL-Regel
ändert Java (`SteuerungVorsprung`, `SteuerungVorsprungRepository`), Python (`inputs._vorsprung_stand`,
`domain.VorsprungStand`, `vorsprung.py`) und diesen Vertrag gemeinsam. Prüfungen: api `SteuerungVorsprungTest`,
`SteuerungTageszahlTest` (Läufer, RLS); Optimierer `test_vorsprung_budget.py`, `test_vorsprung_budget_db.py` (liest
die Tabelle aus der Migrationsdatei).
