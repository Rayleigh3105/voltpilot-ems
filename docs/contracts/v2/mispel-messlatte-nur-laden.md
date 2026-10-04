# MiSpeL — Messlatte „nur laden“ (MP-33d)

**Fassung 1.1 · additiv** (1.1 = MP-33e: kWh je Posten, Ablage je Viertelstunde, Summe in § 6a). Die Gegenrechnung zum Fahrzeug am bidirektionalen Ladepunkt: **dasselbe Haus, in dem das Auto
nur lädt.** Sie liefert die vier Posten und die Summe, die die Erträge am Ladepunkt im Monat bis jetzt offen lassen
([Vertrag MP-31/MP-41a § 6a](mispel-ladepunkt-bidirektional.md#6a-die-erträge-am-ladepunkt-im-monat-mp-41a),
`grund: messlatte_fehlt`; Bedienkonzept BK-41 A). Die Festlegung (BNetzA Az. 618-25-02, 01.10.2026) kennt diesen Vergleich
nicht. Er ist VoltPilots Vergleichsmaßstab, die Mengen bucht er trotzdem nach Anlage 1.

| Teil | Ort |
|---|---|
| Rechnung | `services/optimization/voltpilot_optimization/solver.py` `messlatte_nur_laden` |
| Ergebnis | `domain.MesslatteNurLaden` an `FahrzeugPlan.messlatte_nur_laden` (`SchedulePlan.fahrzeug`) |
| Prüfung | `services/optimization/tests/test_mispel_fahrzeug_a2.py` |
| Ablage (MP-33e) | `ladepunkt_messlatte` (`V20261004173000`), geschrieben von `persistence.messlatte_rows` im Schreiblauf des Plans |
| Lesen (MP-33e) | `LadepunktMesslatteRepository` → `LadepunktErtragService` → § 6a `posten`, `vergleich` |
| Prüfung (MP-33e) | `tests/test_mispel_messlatte_ablage.py` (Schreiber, Monatslauf A2) · `LadepunktErtraegeApiTest` |

## 1. Was gerechnet wird

Derselbe Lauf noch einmal mit `rueckspeisen_kw = 0`. Dabei bleiben gleich: dieselben Eingaben, Fenster, Abfahrtsziele und
Mindest-Ladestände, derselbe Planweg (Mischbetrieb, Aufzählung MP-33b, Knotengrenze im Check MP-33c). „Nur laden“ ist
**optimiert, nicht stur**: Auch dort lädt das Auto, wenn der Strom billig ist. Ohne Rückspeisung im Modell (unidirektional
oder ohne Mindest-Ladestand) ist der Plan selbst „nur laden“, dann gibt es keine Messlatte (`null`).

## 2. Die Posten (Schlüssel wie § 6a, EUR mit Vorzeichen: Ertrag positiv, Kosten negativ)

Je Slot vergleicht die Rechnung beide Pläne am Netzanschluss (`posten_je_slot`), über den Horizont summiert ergibt das `posten`:

| § 6a-Schlüssel | Feld | Rechnung je Slot |
|---|---|---|
| `weniger_gekauft` | `weniger_gekauft_eur` | weniger Bezug als „nur laden“ × Bezugspreis |
| `mehr_geladen` | `mehr_geladen_eur` | − mehr Bezug als „nur laden“ × Bezugspreis (das Haus lädt für das Zurückgeben nach) |
| `ins_netz_verkauft` | `ins_netz_verkauft_eur` | mehr Einspeisung als „nur laden“ × Einspeisewert (im Mischbetrieb blanker Spot); negativ, wenn das Zurückspeisen PV-Einspeisung verdrängt |
| `akku_verschleiss` | `akku_verschleiss_eur` | − 3 ct je rückgespeister kWh (`FAHRZEUG_VERSCHLEISS_CT_JE_KWH`, Schätzung) |

Seit 1.1 trägt jeder Posten seine kWh: `weniger_gekauft_kwh` (weniger Bezug), `mehr_geladen_kwh` (mehr Bezug),
`ins_netz_verkauft_kwh` (mehr Einspeisung, negativ wie ihr Betrag) und `rueckgespeist_kwh` (zum Verschleiß).
`MesslattePosten.mehr_geladen_kwh` ist der Mehrbezug am Netzanschluss — nicht `MesslatteNurLaden.mehr_geladen_kwh` (unten,
das Mehrladen des Autos).

Die ersten drei ergeben zusammen genau `kosten_nur_laden_eur − kosten_eur`, also die Kosten beider Pläne über
`cashflow_cost_eur`.

**Nicht aus der Messlatte:**

- `vermiedene_umlagen` und `vermiedenes_netzentgelt` nimmt § 6a aus (20) des **gemessenen** Monatslaufs. Der Planwert dazu
  steht in `gutschrift_eur` und `gutschrift_nur_laden_eur`: (16) × saldierte Bestandteile, mit Ladepunkt ohne (19) in A2/A3
  (A1 S. 36–37).
- `marktpraemie` auf (31) (A1 S. 39) steht erst mit dem Jahresmarktwert fest.
- Der Verschleiß des stationären Speichers in A3/A4 bleibt draußen.

Abgeleitet: `gegenueber_nur_laden_eur` = Summe der vier Posten + `gutschrift_eur` − `gutschrift_nur_laden_eur`;
`mehr_geladen_kwh` = `geladen_kwh` − `geladen_nur_laden_kwh`. Die Messlatte ist ein PLAN-Wert, keine gemessene Wirkung:
Eine Monatssumme entsteht aus den `posten_je_slot` der Pläne, die für die Viertelstunden des Monats galten.

## 3. Ablage (MP-33e)

`ladepunkt_messlatte` hält **je Ladepunkt und Viertelstunde** eine Zeile (Beginn, halboffen): die acht Felder aus § 2
und den Plan, aus dem sie stammt (`plan_id`, `generated_at`). Der Optimierer schreibt sie im Schreiblauf jedes Plans
(`TimescaleScheduleRepository.upsert_plan` → `persistence.messlatte_rows`, hinter einem Savepoint, fail-soft) für alle
Slots des Horizonts; ein Plan ersetzt eine Zeile nur, wenn er nicht älter ist. So hält die Ablage **den Plan, der für
die Viertelstunde galt** — dieselbe Regel wie `schedule` über `DISTINCT ON (time) … generated_at DESC` —, und derselbe
Plan ein zweites Mal ändert nichts. Der Monatslauf der Simulation plant dafür `wiederholbar` (Knotengrenze MP-33c).

- **Ohne Messlatte, aber mit Fahrzeug ohne geplante Rückspeisung** ist der Plan selbst „nur laden“ (§ 1): Zeilen mit 0.
- **Ohne Fahrzeug im Plan oder ohne rechenbare Messlatte bei geplanter Rückspeisung:** keine Zeile.
- **Lesen** (§ 6a): Summe über die Berliner Tage jedes Teils des Monatslaufs bis zur laufenden Viertelstunde (halboffen).
  Trägt die Ablage für einen Ladepunkt der Festlegung nicht **jede** dieser Viertelstunden, bleiben die vier Posten und
  die Summe offen (`messlatte_fehlt`) — eine Lücke ist eine fehlende Summe, keine kleinere. Satz eines Postens =
  EUR ÷ kWh (das Mittel, beim Verschleiß 3 ct).
- **Löschen:** die Komponente nimmt ihre Zeilen mit (`ON DELETE CASCADE`), über sie Anlage und Mandant; RLS + FORCE,
  die App-Rolle liest nur.
- **Live** schreibt heute noch niemand: der Betreiber-Schalter `VOLTPILOT_MISPEL_FAHRZEUG_SITES` ist leer, und Anlagen
  ohne Hausspeicher (A2) sind noch keine Lauf-Subjekte (`load_battery_sites`). Bis dahin bleibt § 6a bei `messlatte_fehlt`.

## Prüfen

`cd services/optimization && .venv/bin/python -m pytest tests/test_mispel_fahrzeug_a2.py tests/test_mispel_messlatte_ablage.py -q`
(der Monatslauf über 30 Tage ist `slow`) · `(cd services/api && ./mvnw test -Dtest=LadepunktErtraegeApiTest)` (Testcontainers)
