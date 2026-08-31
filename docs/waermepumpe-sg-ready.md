# Wärmepumpe über SG-Ready anbinden

Betreiber-Handbuch für den Verbrauchertyp **`heat-pump-sgready`**
(„Wärmepumpe (SG-Ready)"), gebaut in Paket **P8** des Programms
*Verbrauchsmanagement v1* (Konzept `vp-verbrauchsmgmt-konzept-v1` §3.1/§3.3/§3.4/§3.5;
**Captain-Entscheid E9: nur Zustand 3 „Anlaufempfehlung", ein Relais**).

---

## 1. Die eine Aussage, aus der alles folgt

> **VoltPilot schaltet eine FREIGABE, kein Gerät.**

Ein potentialfreier Relais-Kontakt liegt auf dem SG-Ready-Eingang der
Wärmepumpe. Ob die Pumpe daraufhin anläuft, wie lange und mit welcher Leistung,
entscheidet **sie** — ihre eigene Regelung, ihre Speichertemperaturen, ihre
Sperrzeiten. Daraus folgt jede Eigenheit dieses Typs:

| Frage | Antwort | Warum |
|---|---|---|
| Was zeigt die Geräteseite? | **Freigabe: Gesetzt / Aufgehoben**, nie „läuft mit X kW" | Der Kontakt sagt nichts über den Strom der Pumpe |
| Was ist der Nachweis? | die eigene D3-Stufe **`freigabe`** | „Nennleistung × Zeit" wäre eine erfundene Energie |
| Nennleistung? | **optional** | Sie ist eine Notiz über die Pumpe, kein Steuerwert |
| Ziel („bis 06:00 fertig")? | **gibt es nicht** — der Server lehnt es ab | Wir können den Lauf weder erzwingen noch nachweisen |
| Steuerart? | nur **Freigabe bei Überschuss** oder **Freigabe bei günstigem Strom** | §3.1 |

Der Kundensatz dazu steht wörtlich an genau zwei Stellen (Server + Portal) und
wird nirgends neu formuliert:

> Ohne Messung kann VoltPilot nur die Freigabe nachweisen, nicht den Verbrauch.

---

## 2. Die SG-Ready-Zustände — und was wir bewusst NICHT schalten

SG-Ready kennt vier Betriebszustände, kodiert über zwei Eingänge:

| Zustand | Eingänge | Bedeutung | VoltPilot |
|---|---|---|---|
| 1 · Sperre | 1 geschlossen | EVU-Sperre (harte Abschaltung) | **nein** — die Sperre gehört dem Netzbetreiber, nicht uns |
| 2 · Normalbetrieb | beide offen | die Pumpe regelt selbst | **Ruhezustand** (Relais offen) |
| 3 · **Anlaufempfehlung** | 2 geschlossen | verstärkter Betrieb, WP-interne Sollwertanhebung | **ja — der einzige Zustand, den wir schalten** |
| 4 · Anlaufbefehl | 1 + 2 geschlossen | die Pumpe wird gezwungen | **nein** (E9) — er braucht die Freigabe des Herstellers je Modell und ein zweites Relais |

**⚠ Zustand 3 ist eine EMPFEHLUNG.** Eine warme Pumpe kann sie ignorieren; das
ist kein Fehler und wird nie als „Ausführung nicht bestätigt" gemeldet.

---

## 3. Verdrahtung

1. **Ein Relais**, potentialfrei — dieselbe Hardware wie beim Heizstab:
   Shelly 1 oder Shelly Plus 1 (siehe
   [`edge-app/nodered/SHELLY.md`](../edge-app/nodered/SHELLY.md)).
   Ein messendes Shelly (1PM/Plug S) ist erlaubt, bringt hier aber **nichts**:
   der Strom der Wärmepumpe fließt nicht über den Steuerkontakt.
2. **Kontakt auf SG-Ready-Eingang 2** der Wärmepumpe (Klemmenbezeichnung nach
   Herstellerhandbuch; oft „SG1/SG2" bzw. „EVU/SG"). Eingang 1 bleibt **offen**
   und unbeschaltet — sonst entstünde Zustand 1 oder 4.
3. **Ruhezustand = offen = Zustand 2.** Das ist zugleich das Ausfallverhalten:
   der Katalogtyp trägt `default_failsafe: off`, und der Shelly-Treiber legt
   seinen geräteeigenen Abfall-Timer (`toggle_after`, 180 s) auf jeden
   EIN-Befehl — fällt Box oder WLAN aus, geht die Pumpe **von selbst** in den
   Normalbetrieb zurück. Dafür muss nichts von uns funktionieren.
4. **Kleinspannung:** der SG-Ready-Eingang ist ein Steuerkontakt. Netzspannung
   darauf zerstört die Steuerplatine — Verdrahtung durch eine Elektrofachkraft.

---

## 4. Einrichten

1. Relais wie in `SHELLY.md` §4 an `:8484` → *Einrichten* → *Weitere
   Energiequellen* → Rolle **Verbraucher** anlegen und **Verbindung testen**.
2. Im Portal den Verbraucher anlegen: Art **„Wärmepumpe (SG-Ready)"**,
   Verbindung = das gemeldete Relais. Die **Nennleistung darf leer bleiben**
   (das Feld heißt dort „Nennleistung (kW, optional)" und sagt warum).
3. Die Steuerart (*Freigabe bei Überschuss* / *bei günstigem Strom*) und ihre
   Folgefragen — Schwelle (Vorgabe 2 kW), Mindestfreigabe (30 min), Sperrzeit
   danach (20 min) — kommen mit dem Steuerart-Dialog (Paket P2). Bis dahin
   trägt die Vorlage `SgReady.policyDocument(...)` genau diese Werte.

### Mindestfreigabe und Sperrzeit sind GERÄTESCHUTZ

Sie landen als `min_on_seconds` / `min_off_seconds` im Verbraucherprofil und
binden auf dem Gerät im Zyklen-Wächter (`guards.CycleGuard`), also **vor** dem
Executor. Eine ziehende Wolke kann eine Wärmepumpe damit nicht im Takt takten.
Die Vorgabe 20 min Sperrzeit stammt aus den WP-Handbüchern; der wahre Wert steht
im Handbuch **Ihrer** Pumpe und geht vor.

---

## 5. Was der Nachweis kann — und was nicht

| kann | kann nicht |
|---|---|
| „Die Freigabe war heute 3 h 20 gesetzt." | „Die Wärmepumpe hat 8 kWh verbraucht." |
| Der Relais-Rücklesewert belegt, dass der Kontakt wirklich geschlossen war | Ob die Pumpe angelaufen ist |

Technisch: der Bestätigungskanal ist `freigabe`, die Ledger-Stufe
`EnergyConfirmation.FREIGABE`. Sie erzeugt **niemals** eine Energie-Zahl — auch
nicht mit gepflegter Nennleistung —, und weil das gespeicherte Niveau nur neben
einer Energie-Zahl steht, erreicht das Wort die Spalte `energy_confirmation`
gar nicht.

**Wer den Verbrauch wirklich wissen will**, braucht einen eigenen Zähler auf der
Zuleitung der Wärmepumpe. Der ist ein **zweites** Gerät (ein Messgerät, kein
Verbraucher) und ändert an der Freigabe nichts.

---

## 6. Simulator

`vp-consumer-sim --preset heat-pump-sgready` fährt den Freigabe-Kontakt: er ist
**Ein bei 0 kW** — das ist die Wahrheit, kein Fehlschlag. Damit lässt sich die
ganze Kette ohne Wärmepumpe durchspielen.

---

## 7. Wo die Regeln leben

| Regel | Ort |
|---|---|
| Katalogtyp | `services/api/src/main/resources/entitytypes/catalog.json` |
| Nachweis, Vorlage, Ablehnungen | `services/api .../consumers/SgReady.java` (rein, Docker-frei getestet) |
| D3-Stufe | `ConsumerRequirementLedger.EnergyConfirmation.FREIGABE` |
| Nennleistung optional | `ConsumerService` + Migration `V20260862000000` |
| Kundensätze | `frontend/portal/src/consumers/questions.ts`, `geraetGesicht.ts` |
| Simulator | `edge-app/core/internal/consumersim` (`ReleaseContact`) |
