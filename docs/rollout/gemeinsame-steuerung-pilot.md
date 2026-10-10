# Gemeinsame Steuerung – Prüfstand- und Pilot-Drehbuch (NW-7, NW-8)

**Wer das hier fährt:** der Betreiber. Kein Werkzeug dieses Repositorys führt einen dieser Schritte aus,
keine Crew hat Produktionszugang (AP-15 I4). Was sich nicht am Schreibtisch gegenlesen lässt, ist mit
**⧉ vom Betreiber beim ersten Lauf zu bestätigen** gekennzeichnet.

**Was das hier ist:** AP-15 IP-32, die letzte Zelle von §8 „Gemeinsame Optimierung mehrerer Boxen“
(entschieden am 21.09.2026, E1–E8 = A). E6 = A legt drei Beweisstufen fest: (1) Zwei-Agenten-Test und
Simulator-Aufbau mit allen Matrixzeilen (Crew, gebaut: NW-2, NW-3), (2) ein **Prüfstand beim Betreiber**
mit zwei Boxen, einem Zähler, einem echten Wechselrichter oder einer Lastbank, etwa ein Tag (NW-7, §2),
(3) die **Pilotanlage in Stufen** mit Steckerprobe und einem vollen Monat Grenz-Nachweis (NW-8, §4–§6).
Der Pilot beginnt mit den gerechneten, nicht mit halbierten Anteilen (E6 = A).

**Was das hier nicht ist:** kein Code und kein Go. Leitsatz des Captains: erst alles in `uems` bauen,
dann nach `main` mergen und ausrollen. Das Ausrollen der Cloud steht im
[Rollout-Drehbuch der ersten Freigabe](uems-erste-freigabe.md); das nächste Box-Release kommt zusammen
mit dem Ausrollen von `uems` (Captain 22.09.2026, E3). Die Simulator-Ergebnisse stehen im
[Ausfallblatt NW-3](gemeinsame-steuerung-ausfalltests.md), die Planer- und API-Nachweise im
[Deckungsblatt NW-4/NW-6](gemeinsame-steuerung-nw4-nw6.md), die Alarmregeln in der
[Übergabe an Teil B](gemeinsame-steuerung-metriken.md). Beispielzahlen sind die der Anlage AN-1 „Werk
Ahrenberg – Halle 1“ am Netzanschluss NA-1: Einspeisegrenze 100 kW mit Anteilen 40 / 60 kW, Bezugsgrenze
550 kW mit Vorbehalt 473 kW und Anteilen 0 / 77 kW.

**Was „eingehalten“ heißt** (AP-15 §4.12): **M-1** kein Viertelstunden-Mittel am Netzzähler über der Grenze ·
**M-2** Überschreitungen im Augenblick nur für die Dauer einer Regelung (Startwert ≤ 60 s) und gezählt ·
**M-3** beides gilt bei eingespielter Störung im ungünstigsten Betriebspunkt.

---

## 0. Die Schritte auf einen Blick

| Schritt | Ort | Wer | Eintritt | Ergebnis |
|---|---|---|---|---|
| **V** Vorbedingungen (§1) | Repo, Simulator, gitops | Crew + Betreiber | `uems` grün | offene Simulatorläufe gefahren, Alarmregeln gemergt |
| **P** Prüfstand NW-7 (§2) | beim Betreiber, kein Kundentermin | Betreiber | V erledigt | sechs Protokolle A1, A2, A4, A7, A13, A15 unterschrieben |
| **Q** Bestandsfrage Q06 und Z1 (§3) | Produktion, lesend | Betreiber | vor Tor G1 | Pilotanlage gewählt — oder „nur Simulator“ |
| **R** Release (§7) | Cloud + Box | Betreiber | P ohne offenen Befund | Cloud mit `uems`, Box-Release an jeder steuernden Box |
| **S0–S3** Stufen (§4) | Pilotanlage | Kunde + Betreiber | R erledigt | Anteile aktiv, jede Box quittiert |
| **M** Pilotmonat (§5, §6) | Pilotanlage | Betreiber | S3 | Steckerprobe, Alarm-Übung, voller Monat Grenz-Nachweis |
| **B** Pilot-Bericht (§6.4) | — | Betreiber → Captain | M abgeschlossen | Entscheid über S4 und die allgemeine Freigabe |

**Hand des Betreibers (I4), vollständig:** Sprungprobe auslösen (§6.1) · scharfschalten (§4.4) · Mitglied nach
Box-Tausch bestätigen (§5.4) · Steckerprobe (§6.2) · Edge-Release (§7.1) · gitops-Merge der Box-Alarme (§1.3) ·
die Bestandsfrage Q06 (§3) · die Klärung mit dem Netzbetreiber der Pilotanlage, woran er eine Überschreitung
misst (§4.1).

---

## 1. Vorbedingungen (Schritt V)

### 1.1 Crew-Nachweise stehen grün

- NW-1 Anteils-Vektoren, NW-2 Zwei-Agenten-Test (`edge-app/core/internal/agent/zwei_agenten_test.go`), NW-4 und
  NW-6 ([Deckungsblatt](gemeinsame-steuerung-nw4-nw6.md)), NW-5 Kein-Verbund-Nachweis — auf dem Stand, der
  ausgerollt wird.
- NW-3 ([Ausfallblatt](gemeinsame-steuerung-ausfalltests.md)) ist gefahren bis auf die Läufe in §1.2.

### 1.2 Offene Simulatorläufe (Crew, vor dem Prüfstand)

Das Ausfallblatt aus IP-29 hat vier Läufe nicht gefahren und drei als „verletzt“ gemessen. Vor dem Prüfstand
fährt die Crew aus `tools/uems-verbund-sim/` nach (Befehl im Ausfallblatt, Abschnitt „Offene Containerläufe“):

| Lauf | Warum offen | Soll vor P |
|---|---|---|
| **A20** | abgebrochen vor der Auswertung | Protokoll liegt vor; +7 kW bis zur Verengung wie NW-2 |
| **R1n**, **A2n**, **A7n** | Nacht (Bezug) nicht gefahren | Protokoll liegt vor; Bezug ≤ 550 kW |
| **A7** neu | gemessen auf Bildern vor PR 1068; Heilung in `b70334ea3`, `cf43bb735`, `f68d5e606` | Lauf auf Bildern ab `f68d5e606`, M-1 ≤ 100 kW |
| **A2**, **A15** „verletzt“ (100,171 / 100,258 kW) | kein Box-Fehler; 60 s Geräte-Rückfall ohne Marge im Viertel | nach Captain-Entscheid B (22.09.2026) nur mit Handgriff haltbar, siehe §4.1 Punkt 6 |

### 1.3 Alarmregeln in gitops

Die acht Regeln der [Übergabe an Teil B](gemeinsame-steuerung-metriken.md) sind im gitops-Repo gemergt
(Hand des Betreibers), auf Mitglieder einer scharfen Gemeinsamen Steuerung begrenzt. Ohne sie gibt es keine
Alarm-Übung (NW-9, §6.3).

---

## 2. Der Prüfstand (Schritt P, NW-7)

Ein eigener Aufbau beim Betreiber, kein Termin beim Kunden (E6 = A); er bleibt für jedes spätere Box-Release
nutzbar. Er zeigt, was kein Simulator zeigen kann: ob ein Gerät ohne seine Box wirklich tut, was sein
Datenblatt sagt, und ob ein echter Zähler sich so verhält, wie die Wächter es annehmen.

### 2.1 Aufbau

- **Zwei Boxen** mit dem Box-Release-Kandidaten (§7.1): **PS-F** führt und liest den Zähler, **PS-M** steuert mit.
- **Ein Zähler** am gemeinsamen Punkt, gelesen von PS-F; hinter PS-M ein eigener Abgangszähler (wie DQ-10 in
  Ahrenberg).
- **Geräte:** an PS-M ein echter Wechselrichter mit Schreibfreigabe für Modell und Firmware
  ([Geräte am Prüfstand freigeben](../../edge-app/nodered/CONTROL-BENCH.md)); an PS-F ein zweites steuerbares
  Gerät, möglichst **ein Speicher** (für A2 und den Speicher-Wachhund), und eine Lastbank für die Bezugsseite.
- **Cloud-Seite:** eine Prüfstand-Anlage in einer Nicht-Produktions-Cloud mit dem `uems`-Stand. Sie durchläuft
  S0 → S3 wie in §4, nur ohne die 14 Tage (die Frist ist eine Regel dieses Drehbuchs, nicht der Scharfschalt-Prüfung
  I1) — das ist zugleich die Generalprobe für §4. Ersatzweise die Nutzlasten aus `tools/uems-verbund-sim/nutzlast.py`
  über einen eigenen Broker. ⧉ vom Betreiber beim ersten Lauf zu bestätigen.
- **Grenze so eng wie Ahrenberg:** Einspeisegrenze `G` = Geräte-Rückfall PS-F + Geräte-Rückfall PS-M + ≤ 1 kW
  (Ahrenberg: 40 + 60 = 100 kW). Nur dann zeigt der Prüfstand, ob „Geräte-Rückfall ≤ Anteil“ trägt.
- **Messung:** Zähler im 1-s-Takt mitschreiben (Box-Telemetrie reicht nicht für M-2), daraus M-1 (höchstes
  Viertelstunden-Mittel) und M-2 (größte Überschreitung, längste Strecke darüber, Sekunden gesamt), wie im Simulator.
- **Ungünstigster Punkt (M-3):** Einspeisung mit voller Erzeugung und entladendem Speicher; Bezug mit Lastbank an
  der Vorbehaltsgrenze und ladendem Speicher.

### 2.2 Protokollkopf (einmal je Prüfstand-Tag)

| Feld | Eintrag |
|---|---|
| Datum, Ort | |
| Box-Stand PS-F / PS-M (Core-Tag, Palette, Stempel) | |
| Zähler (Hersteller, Modell, Firmware, Lesetakt) | |
| Geräte (Hersteller, Modell, Firmware; Freigabe-Nachweis) | |
| Grenzen `G` Einspeisung / Bezug; Anteile PS-F / PS-M je Richtung | |
| Geräte-Rückfall je Gerät und Richtung: Art, Wert, `nach_s` (hinterlegt) | |
| Übergangszuschlag laut Auslegung, `zuschlag_fehlt_kw` | |

### 2.3 Die sechs Zeilen

Jede Zeile mit Messgröße, Soll aus der Ausfallmatrix, Ist und Unterschrift. Eine Zeile, deren Soll nicht
erfüllt ist, ist ein **Befund** (§2.4) — sie wird nicht „nachgebessert“, bis sie passt.

**P-A1 — PS-M fällt ganz aus** (Strom weg am laufenden Mittag)

| Messgröße | Soll | Ist |
|---|---|---|
| Zeit bis das Gerät an PS-M auf seinen Rückfall fällt | ≤ hinterlegtes `nach_s` (Beispiel 60 s) | |
| Leistung des Geräts im Rückfall | = hinterlegter Wert, höchstens Anteil PS-M | |
| M-1 am Zähler | ≤ `G` | |
| M-2 größte Überschreitung · längste Strecke | nur während einer Regelung, ≤ 60 s | |
| Cloud: PS-M „stumm“ | nach 90 s ohne Herzschlag | |

**P-A2 — PS-F fällt ganz aus** (Strom weg, Speicher entlädt zum Zeitpunkt T0)

| Messgröße | Soll | Ist |
|---|---|---|
| Zeit bis die Geräte an PS-F auf ihren Rückfall fallen | ≤ hinterlegtes `nach_s` | |
| **Speicher-Wachhund:** Zeit, bis der Speicher den letzten Sollwert verlässt | messen; geht als `nach_s` in den Übergangszuschlag | |
| PS-M hält ihren Anteil am eigenen Zähler | durchgehend | |
| M-1 am Zähler | ≤ `G` — ohne Rest für den Puffer erwartet der Simulator 100,17 kW bei 100 kW (IP-29 A2) | |
| M-1 mit Handgriff (Rückfallwert um `zuschlag_fehlt_kw` gesenkt) | ≤ `G` | |

**P-A4 — Broker/Internet für beide Boxen weg** (30 min, Uplink beider Boxen trennen)

| Messgröße | Soll | Ist |
|---|---|---|
| M-1 am Zähler | ≤ `G`, ohne Unterbrechung | |
| PS-F regelt weiter am Zähler; PS-M hält ihren Anteil | durchgehend | |
| Plan-Rückfall der Box | nach 20 min (`execution.mode: fallback`) | |
| Telemetrie nach der Rückkehr | aus dem Puffer nachgeliefert, keine Lücke | |

**P-A7 — Zählerwert der führenden Box fehlt oder friert ein**

(a) *fehlt:* Busleitung des Zählers trennen. (b) *friert:* den Zählerwert über einen Modbus-Zwischenstecker, der
die letzte Antwort wiederholt, festhalten. ⧉ Aufbau für (b) vom Betreiber zu wählen.

| Messgröße | Soll | Ist |
|---|---|---|
| (a) PS-F auf dem eigenen Anteil, ohne Halten | frisch bis 30 s, dann 60 s linear, ≤ 90 s nach dem letzten Wert | |
| (b) Prüf-Verstellung nach 30 s bitgleichem Stillstand über dem Anteil | eine Verstellung um 2,1 kW | |
| (b) Urteil „eingefroren“ nach der Prüf-Verstellung | nach 20 s | |
| M-1 am Zähler, (a) und (b) | ≤ `G` | |
| Bezugsseite (Lastbank): nach der Rückkehr des Zählers wird der Spielraum einmal vergeben | kein zweites Anheben ohne neue Messung (Folge `vp-uems-v15-folge-bezug-doppelfreigabe`, `17abebe1c`) | |
| **Startwert 30 s:** längster bitgleicher Stillstand des echten Zählers im Normalbetrieb (≥ 1 h, Anlage ruhend und bewegt) | bei bewegter Anlage deutlich unter 30 s | |
| **Startwert 20 s:** Zeit vom 2,1-kW-Schritt am Gerät bis zum geänderten Zählerwert | deutlich unter 20 s | |

Steht ein echter Zähler im Normalbetrieb oft 30 s bitgleich, kostet jede Prüf-Verstellung 2,1 kW Leistung; braucht
er für einen Schritt fast 20 s, urteilt die Probe „eingefroren“ über einen gesunden Zähler. Beides ist ein Befund
für ein Box-Release (die Startwerte stehen in [`mqtt-verbund-anteile.md`](../contracts/v2/mqtt-verbund-anteile.md)
§2a), kein Grund, am Prüfstand umzustellen.

**P-A13 — Neustart von PS-F mitten im Abregeln**

| Messgröße | Soll | Ist |
|---|---|---|
| Hochfahrzeit bis zur ersten Schreibung | messen | |
| Erste Schreibung vor dem ersten Messwert | höchstens der gespeicherte Anteil | |
| M-1 am Zähler | ≤ `G` | |
| Ereignis `box_restart` in der Cloud | vorhanden | |

**P-A15 — PS-F lebt, erreicht ihr Gerät nicht** (Busleitung Box → Gerät trennen)

| Messgröße | Soll | Ist |
|---|---|---|
| Zeit bis das Gerät auf seinen Rückfall fällt (Wachhund des Geräts) | ≤ hinterlegtes `nach_s` | |
| Leistung des Geräts im Rückfall | = hinterlegter Wert | |
| Quelle in der Cloud | `stale`, Entität nicht planbar | |
| M-1 am Zähler | ≤ `G`; ohne Rest wie P-A2 (Simulator 100,258 kW) | |

**Unterschrift je Zeile:** Name, Datum, Box-Stand. Die Protokolle legt der Betreiber zum Pilot-Bericht (§6.4).

### 2.4 Abbruch am Prüfstand

- **M-1 über `G`** in einer Zeile: Zeile abbrechen, Befund an firstmate/Captain; keine Pilotanlage kommt über S2,
  bis er geklärt ist.
- **Geräte-Rückfall anders als hinterlegt** (Wert oder Zeit): dieses Modell zählt bis zur Klärung mit seiner
  Nennleistung. Eine Datenblatt-Angabe ist keine Bestätigung am Prüfstand; die trägt nur der Betreiber ein
  ([Vertrag §1](../contracts/v2/steuerungsverbund.md)).
- **Startwerte (P-A7) passen nicht:** Befund für das Box-Release; der Pilot darf nicht auf diesem Zählermodell
  scharfschalten, bis der Captain entschieden hat.

---

## 3. Die Bestandsfrage Q06 und die Wahl der Pilotanlage (Schritt Q)

**Q06** läuft mit dem Vorher-Blatt `tools/betriebsabfragen/bestand-vor-uems.sql` gegen `main`
([Betriebsabfragen](../../tools/betriebsabfragen/README.md), lesend, Rolle mit `BYPASSRLS`). Sie beantwortet:
**Wie viele Anlagen haben mehr als eine Box?** Das ist der Pilotfall P3.

- **Null Anlagen mit zwei steuernden Boxen:** kein Feldpilot. NW-8 steht dann für jede Zeile auf „nur Simulator“
  plus Prüfstand; der Captain entscheidet, ob damit freigegeben wird.
- **Eine oder mehr:** Pilotanlage nach diesen Kriterien wählen, alle Pflicht:
  1. jede steuernde Box hat ein steuerbares Gerät mit Schreibfreigabe für Modell und Gerät;
  2. der Netzanschluss ist gebunden, eine Box liest den Zähler am Netzanschluss (B1), und der Hauptzähler steht
     in der Bilanz (sonst gibt es keinen Grenz-Nachweis, §6.4);
  3. die Geräte-Modelle sind am Prüfstand gelaufen (§2) — oder der Prüfstand wird mit ihnen wiederholt;
  4. der Kunde ist einverstanden, dass eine Box 30 min vom Netzwerk getrennt wird (§6.2).
- **Zwei Anlagen hinter einem Anschluss** sieht Q06 nicht (die Datenbank lehnt die Bindung eines Anschlusses an
  zwei Anlagen ab, `anschluss_belegt`). Die Frage geht an den Kunden; der Weg ist der Umzug der zweiten Box in
  die erste Anlage (AP-15 §5.6).

**Z1 (AP-15 Anhang B, aus W2):** Anlagen OHNE Gemeinsame Steuerung, deren führende Box und Speicher-Box
auseinanderfallen. Lesend gegen das Schema von `uems` (nach dem Rollout):

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '120s';
-- führende Box = site.lead_device_id, in DIESER Anlage angemeldet und nicht ausgebaut
SELECT count(DISTINCT s.id) AS anlagen
  FROM site s
  JOIN device l ON l.id = s.lead_device_id AND l.site_id = s.id AND l.ausgebaut_am IS NULL
  JOIN asset a  ON a.site_id = s.id AND a.type = 'battery'
               AND a.device_id IS NOT NULL AND a.device_id <> s.lead_device_id
 WHERE NOT EXISTS (SELECT 1 FROM steuerungsverbund_mitglied m
                    WHERE m.site_id = s.id AND m.aufgehoben_am IS NULL
                      AND m.gueltig_ab <= now() AND (m.gueltig_bis IS NULL OR now() < m.gueltig_bis));
ROLLBACK;
```

⧉ vom Betreiber beim ersten Lauf zu bestätigen. Das Ergebnis ist eine Zahl für den Captain, kein Schritt am Kunden.

---

## 4. Die Stufen S0–S3 an der Pilotanlage

Die Stufen sind die des Konzepts (§3.9). Die Kriterien unten sind die Eintritts- und Abbruchbedingungen dieses
Drehbuchs; wo die Software selbst prüft, steht es dabei. Jede Strukturänderung führt das betroffene Mitglied auf S1
oder S2 zurück; sein Anteil bleibt reserviert (I3).

### 4.1 Vor S0: Einrichten der Pilotanlage vorbereiten

1. **Netzbetreiber klären** (I4): woran er eine Überschreitung misst (Viertelstunden-Mittel am Zähler oder
   Augenblickswert), und ob die Anlage eine Vorgabe nach § 14a bekommt — an welche Box das Signal geht. Steuerbare
   Verbraucher nach § 14a hängen an der Box, die das Signal bekommt, oder das Signal ist an jede solche Box
   verdrahtet (G6, Matrixzeile A16); beim Einrichten je Mitglied `vorgabe_signal` eintragen. Misst der
   Netzbetreiber im Augenblick statt in der Viertelstunde, gilt M-2 als Grenze: Befund an den Captain vor S3.
2. **Grenzen ins Grenzblatt** am Netzanschluss eintragen, zeitgültig ab dem Tag des Einrichtens, beide Richtungen
   (oder ausdrücklich „keine Einspeisegrenze“). **Immer**, auch wenn das Anlagenfeld schon eine Grenze trägt: das
   Anlagenfeld bleibt nicht zeitgültig, der Grenz-Nachweis nennt die Herkunft (Entscheid firstmate 22.09.2026).
   Kontrolle: der Grenz-Nachweis meldet `grenzherkunft = grenzblatt` für jeden Tag des Pilotzeitraums.
3. **Zähler je mitsteuernder Box: prüfen, was dahinter liegt.** Wörtlich aus der Klärung
   „Ungeregeltes hinter dem Abgang“ (§5):

   > **Zähler je mitsteuernder Box: prüfen, was dahinter liegt.** Die mitsteuernde Box hält auf der Bezugsseite ihren Anteil nur für die Ladepunkte. Was sonst hinter ihrem Abgangszähler Strom zieht, rechnet sie nicht ab. Deshalb gilt vor S1:
   > 1. Am Schaltplan oder in der Unterverteilung nachsehen: Hinter dem gewählten „Zähler dieser Box“ hängt NUR, was diese Box mit Schreibfreigabe steuert, also Ladepunkte, PV, Speicher. Kein Gebäudeverteiler, keine Wärmepumpe oder Maschine ohne Freigabe, nichts einer anderen Box. Vorbild ist DQ-10 in Ahrenberg.
   > 2. Ist das nicht so, gibt es zwei Wege. Entweder „kein eigener Zähler“ wählen. Dann ist der Vorbehalt von Hand zu erklären, denn die Verbund-Bilanz dieser Anlage bleibt „unbekannt“ und liefert keinen Vorschlag. Oder den Vorbehalt von Hand erklären, **einschließlich** der größten Last hinter diesem Zähler (Viertelstundenwert × 1,1). Den Vorschlag „aus den Messwerten“ dann NICHT übernehmen, er ist genau um diese Last zu klein. Einen späteren Senken-Vorschlag nicht freigeben.
   > 3. In S1 (14 Tage) gegenprüfen: Bei stehendem Ladepark, etwa nachts, zeigt der Abgangszähler keinen nennenswerten Bezug (Richtwert ≤ 2 kW). Liegt der Vorschlag „aus den Messwerten“ deutlich unter dem erklärten Vorbehalt, ist das ein Hinweis auf Last hinter einem Abgang. Dann Punkt 1 wiederholen.
   > 4. Geräte ohne Schreibfreigabe gehören nicht hinter den Zähler einer mitsteuernden Box. Wenn doch, zählt ihre Nennleistung in den erklärten Vorbehalt.
   > 5. Vor jedem Scharfschalten und vor jeder Freigabe eines Vorbehalts-Vorschlags Punkt 1 erneut bestätigen und im Protokoll vermerken.

   *Stand heute:* seit `d89afd712` („Bezug am Messpunkt“) hält die mitsteuernde Box ihren Bezugs-Anteil gegen
   die eigene Abgangsmessung — auch Gebäudelast hinter dem Abgang drückt dann ihren Ladepark, statt die Grenze.
   Punkt 1 bleibt trotzdem Pflicht: Last hinter dem Abgang frisst den Anteil der Ladepunkte, und blind zählt nur,
   was als `ungeregelt_hinter_abgang` erklärt ist.
4. **Geräte-Rückfall** je steuerbarem Gerät am Gerät hinterlegen und im Einrichten eintragen
   (`PUT …/gemeinsame-steuerung/komponenten/{id}/rueckfall`), mit den am Prüfstand gemessenen `nach_s`.
5. **Box-Stand:** jede steuernde Box meldet `steuerungsverbund_anteil`, `sprungprobe` und `plan_quittung`
   (Betreiber-Blatt, Spalte Fähigkeit). Eine Box ohne sie bleibt Lese-Box (A12, I2) — Scharfschalten lehnt ab
   (`faehigkeit_fehlt`).
6. **Puffer für den Ausfall der führenden Box** (Captain 22.09.2026, „Ja dann mach B“): der Puffer kommt nur aus
   dem Rest über den Geräte-Rückfällen, nie als Ablehnung. Wo kein Rest ist, bleibt A2 auf der Einspeiseseite
   offen (Ahrenberg: die Einspeise-Anteile sind gleich den Geräte-Rückfällen; im Simulator 100,17 kW in der
   Ausfall-Viertelstunde). Das Einrichten zeigt dann den Hinweis mit `zuschlag_fehlt_kw`
   ([Vertrag, Übergangszuschlag](../contracts/v2/steuerungsverbund.md)). **Beachten, nicht wegklicken:**
   entweder den **Rückfallwert K-1 am Wechselrichter senken** (Ahrenberg: auf höchstens 36 kW) oder den
   **Speicher-Wachhund am Prüfstand messen** (P-A2) und das kürzere `nach_s` hinterlegen — der Puffer wird dann
   kleiner. Ohne einen der beiden Handgriffe: kein Scharfschalten dieser Anlage.

### 4.2 S0 „erklärt“ → S1 „beobachtet“

- **Eintritt S0:** §4.1 vollständig, Punkte 1–6 im Protokoll abgehakt.
- **Handlung:** der Kundenadministrator richtet ein (Anlage → Technik → Karte „Gemeinsame Steuerung“, sechs
  Fragen, §5.2 des Konzepts); Frage 6 zeigt Anteile, Auslegung und Hinweise, erst „Absenden“ schreibt. An den
  Boxen ändert sich nichts. Absenden hebt auf S1.
- **Abbruch:** Auslegung `passt` nicht → kein Scharfschalten (I1); Handgriff am Gerät oder die Anlage bleibt im
  Betrieb mit einer steuernden Box.

### 4.3 S1 „beobachtet“ → S2 „geprüft“

- **Eintritt S2 (Kriterien dieses Drehbuchs):** mindestens 14 Tage in S1; jeder ausgewertete Tag der Verbund-Bilanz
  `plausibel`, keiner `unplausibel`; Tage `unbekannt` zählen nicht mit und verlängern die Frist; der Vorbehalt ist aus
  den Messwerten bestätigt oder bewusst von Hand erklärt (§4.1 Punkt 3); nachts zeigt jeder Abgangszähler ≤ 2 kW
  bei stehendem Ladepark.
- **Bilanz-Toleranz prüfen:** die Verbund-Bilanz urteilt `unplausibel` ab einem Ungeregelten unter
  −max(2 kW, 5 %) in mindestens zwei Viertelstunden. Diese Zahl hat die Bau-Bahn gesetzt, nicht das Konzept. Je
  Tag den kleinsten Abstand zur Toleranz ins Protokoll; ein `unplausibel` ohne auffindbare Ursache oder ein Abstand
  dauernd nahe null ist ein Befund über die Zahl.
- **Handlung: Sprungprobe je steuernder Box** (§6.1).
- **Abbruch:** `unplausibel` (A17, Alarm `GemeinsameSteuerungBilanzUnplausibel`) → Ursache suchen (unbekannter
  Erzeuger, falscher Abgang, verdrehtes Vorzeichen), S1 beginnt neu. Alarm `GemeinsameSteuerungVorbehaltZuKlein`
  (A20) → §4.1 Punkt 3 wiederholen.

### 4.4 S2 „geprüft“ → S3 „Anteile aktiv“

- **Eintritt S3:** jede steuernde Box hat eine geltende, bestandene Sprungprobe (die Software hebt dann selbst auf
  S2); I1 vollständig — das Betreiber-Blatt listet, was fehlt; §4.1 Punkt 3, Absatz 5 erneut bestätigt; Box-Release an jeder
  steuernden Box (§7.1).
- **Handlung (Hand des Betreibers):** `POST /api/v1/admin/sites/{siteId}/gemeinsame-steuerung/scharfschalten`. Neue
  Epoche; Zweischritt mit dem heutigen Zustand als „alt“: zuerst verengt die führende Box auf ihren Anteil, erst nach
  ihrer Quittung bekommen die mitsteuernden ihr Dokument, erst wenn alle quittiert haben, veröffentlicht der Planer
  je Box. Im Betreiber-Blatt: „1 von 2“ → „2 von 2“, danach je Box `plan_id` veröffentlicht = angenommen.
  Bis zum Ende dieses Zweischritts ist die Anlage blind nicht sicher (W11) — Scharfschalten darum nur, wenn beide
  Boxen verbunden sind, und die Quittungen nicht über Nacht offen lassen.
- **Abbruch:** ein Anteils-Dokument abgelehnt (`summe_ueber_verteilbar`, `revision_aelter`), Zweischritt länger als
  30 min offen (`AnteileNichtBestaetigt`), Plan nicht angenommen (`PlanNichtAngenommen`) → **anhalten** (§4.5).

### 4.5 Abbruch-Kriterien im Betrieb (S3 und Pilotmonat)

| Beobachtung | Handlung |
|---|---|
| Ein Viertelstunden-Mittel am Hauptzähler über der Grenze (M-1, Grenz-Nachweis) | sofort **anhalten**, Befund an den Captain; Fortsetzen erst nach Klärung |
| Überschreitung im Augenblick länger als 60 s oder wiederholt (M-2, Zählerdaten) | anhalten, Befund |
| Beschwerde des Netzbetreibers | anhalten; bei Wiederholung **auflösen** |
| `GemeinsameSteuerungOhneFuehrendeBox` (kritisch) | Box vor Ort prüfen; die Anlage hält blind die Anteile, nichts abschalten |
| `GemeinsameSteuerungBilanzUnplausibel` | die Software fällt selbst auf S1 zurück; Ursache wie §4.3 |
| `GemeinsameSteuerungAufAnteil` mehr als einmal am Tag | Zähler der führenden Box prüfen (A7); am Prüfstandsmodell gemessen? |
| `GemeinsameSteuerungUhrUnsicher` | Uhr der Box prüfen (A8); keine Handlung an den Anteilen |
| ein Gerät erreicht seinen Rückfall nicht oder zu spät | auflösen; Modell zurück an den Prüfstand |

**Anhalten** (`POST …/anhalten`) führt zum Betrieb mit einer steuernden Box zurück; **die Anteile bleiben in Kraft**,
Anhalten nimmt nie einen Wächter weg. Fortsetzen geht ohne neue Probe, wenn sich an der Struktur nichts geändert hat.
**Auflösen** (`POST …/aufloesen`) nimmt die Anteile im Zweischritt zurück.

---

## 5. Im Pilotzeitraum bekannte Sonderfälle

### 5.1 Uhren

Die Box-Wächter rechnen Dauer statt Uhrzeit (A8, `cf43bb735`); die Einzelbox-Wächter verankern bei rückwärts
springender Uhr neu (`15990894d`, Captain: „ja, mit dem nächsten Box-Release“). Beides kommt mit dem Box-Release
(§7.1); vorher keine Pilotbox.

### 5.2 Verlust durch feste Anteile

Die Box zählt den Anteils-Verlust als **Untergrenze** (kWh) und die gebundene Zeit exakt (IP-22); die Cloud schätzt
den Verlust zusätzlich aus der Prognose. Kundensatz **Variante A** (Captain): der Kunde sieht kWh nie ohne
„mindestens“, sonst die Zeit. Der Pilot-Bericht (§6.4) weist Untergrenze und Schätzung getrennt aus.

### 5.3 Rollup einer Mehr-Box-Anlage

Mit `5db1e626b` (PR 1040) liest die Verdichtung einer Mehr-Box-Anlage mit bestimmter führender Box Bezug und
Einspeisung an der führenden Box, PV als Summe der Boxen, Last als führende Box plus Nettoabgabe jeder weiteren Box.
**Ohne Neuberechnung:** der Job verdichtet wie immer die letzten 7 Tage neu, ältere Buckets bleiben bis
`CALL refresh_telemetry_rollups('<ab>')` nach der alten Regel. Ob der Betreiber das für die Pilotanlage (und alle
Mehr-Box-Anlagen) nachholt, entscheidet er beim Rollout; die Release-Notiz nennt es (§7.3).

### 5.4 Box-Tausch im Pilotzeitraum

Erst seit `vp-uems-v15-folge-boxtausch-verbund` erlaubt (`4c5642e0c`, dazu `8c4350704`): Nachfolger-Anmeldung wie
AP-06 E7; die Nachfolgerin übernimmt die Mitgliedschaft und quittiert das Anteils-Dokument; der Betreiber bestätigt
das Mitglied (`POST /api/v1/admin/…/mitglieder/{boxId}/bestaetigen`). Bis dahin gilt A14 (Anteil reserviert, eine
führende Nachfolgerin bekommt keinen Plan). Danach im Betreiber-Blatt prüfen, ob die Sprungprobe der Box gilt;
sonst neu fahren. Bringt die Nachfolgerin einen älteren Box-Stand mit, gilt A12, bis ihr Update durch ist.

---

## 6. Sprung- und Steckerprobe, Alarm-Übung, Grenz-Nachweis (NW-8, NW-9)

### 6.1 Sprungprobe je steuernder Box (S1 → S2)

- **Wann:** in S1 und wenn die Bedingung passt — Sonne für einen Erzeuger, ein ladendes Fahrzeug für einen
  Ladepunkt; der Zähler der führenden Box hat einen Wert der letzten 60 s.
- **Auslösen:** `POST /api/v1/admin/sites/{siteId}/gemeinsame-steuerung/sprungprobe`
  `{box_id, art, sprung_kw}` mit 5 kW ≤ `sprung_kw` ≤ 50 kW (Beispiel: PV 55 → 25 kW für 60 s). Die Box fährt den
  Sprung zweimal, immer in die sichere Richtung, und bricht von selbst ab, wenn ihr eigener Wächter eingreifen müsste.
- **Soll:** Urteil `bestanden` — Richtung und Größe am Netzzähler ± max(10 %, 2 kW), zweimal
  ([Vertrag §10](../contracts/v2/steuerungsverbund.md#10-die-sprungprobe-ip-21)).
- **Abbruch:** `nicht_gesehen` oder `falsche_richtung` → die Box hängt nicht (so) hinter diesem Anschluss (R19,
  A17): Struktur korrigieren, nie ein zweites Mal „probieren“. `zu_klein`/`zu_gross` → Messpunkt oder Gerät prüfen.
  `abgebrochen`/`nicht_auswertbar` → einmal wiederholen; beim zweiten Mal Befund.

| Box | Art | `sprung_kw` | Zeit | Urteil | gesehen / erwartet (je Sprung) | Unterschrift |
|---|---|---|---|---|---|---|
| | | | | | | |

### 6.2 Steckerprobe (einmal je Pilotanlage)

- **Wann:** in S3, bei hoher Sonne, Einspeisung nahe der Grenze.
- **Handgriff:** das Netzwerkkabel der **mitsteuernden** Box 30 min ziehen. Sie regelt lokal weiter und hält ihren
  Anteil; für die Cloud ist sie stumm (A5; im Feld zugleich die Sicht von A1).
- **Eintragen:** Zeitraum und Box als Betreiber-Zeitraum:
  `POST /api/v1/admin/sites/{siteId}/gemeinsame-steuerung/steckerprobe` `{von, bis, box_id, bemerkung}`
  (`vp-uems-v15-folge-grenznachweis`, `20222e232`). Das Betreiber-Blatt rechnet den Grenz-Nachweis genau für
  `[von, bis)`.
- **Soll:** höchstes Viertelstunden-Mittel in `[von, bis)` ≤ Einspeisegrenze; Lücke = „nicht belegt“ ist kein
  Bestanden — dann wiederholen. Die andere Box bekommt weiter ihren Plan.
- **Ergebnis im Betreiber-Blatt**, zusätzlich hier:

| von | bis | Box | höchstes Viertel | Grenze | Urteil | Unterschrift |
|---|---|---|---|---|---|---|
| | | | | | | |

### 6.3 Alarm-Übung (NW-9, einmal echt)

Die Steckerprobe ist die echte Übung: nach 5 min ohne Herzschlag muss `GemeinsameSteuerungBoxStumm` für die
gezogene Box feuern und nach dem Einstecken enden. Zeitpunkt von Feuern und Ende ins Protokoll.

Der **Dauerläufer** kann diese Übung heute nicht liefern: seine Boxen bekommen keinen Plan 2.0 und sind in keiner
Gemeinsamen Steuerung, darum haben sie keine Reihe
([Übergabe an Teil B](gemeinsame-steuerung-metriken.md)). Soll die Übung vor dem Pilot laufen, braucht der
Dauerläufer eine Mitgliedschaft (Einrichten über die Routen von IP-5) — das ändert den Dauerläufer-Kundenbereich,
der laut AP-14 nicht steuert. Entscheidung des Betreibers; dieses Drehbuch empfiehlt die Übung an der Pilotanlage.

### 6.4 Grenz-Nachweis und Pilot-Bericht

- **Grenz-Nachweis:** `GET …/netzanschluesse/{id}/grenznachweis?monat=` für einen vollen Kalendermonat in S3
  (E6 = A): je Richtung höchstes Viertelstunden-Mittel am Hauptzähler gegen die am Tag wirksame Grenze, Minuten
  darüber, jede Unterbrechung mit ihrem Höchstwert. **Soll:** Kopfzeile „Grenze im <Monat> eingehalten“, jeder Tag
  belegt, `grenzherkunft = grenzblatt`.
- **Pilot-Bericht:** `GET /api/v1/admin/sites/{siteId}/gemeinsame-steuerung/anteil-verlust?von=&bis=` (Untergrenze
  und Schätzung je Box getrennt) mit den Prüfstand-Protokollen (§2.3), der Sprungprobe, der Steckerprobe, der
  Alarm-Übung und dem Grenz-Nachweis an den Captain. Er entscheidet damit über S4 (Zuteilung auf Zeit, E1 = A) und
  die allgemeine Freigabe.

---

## 7. Release (Schritt R)

### 7.1 Box-Release

Das nächste Box-Release kommt zusammen mit dem Ausrollen von `uems` (Captain 22.09.2026, E3); Bau, Tag,
Zuweisung und Rollout sind Hand des Betreibers. Pflicht vor S3 an der Pilotanlage: der Box-Stand im Tag ist der
des ausgerollten `uems`-Stands — gleich, ob `uems` als Merge oder als Squash nach `main` kommt:

```bash
# <uems-sha>: der Stand von uems, der nach main gemergt wurde · <box-tag>: der Tag des Box-Release
git diff --stat <uems-sha> <box-tag> -- edge-app/core edge-app/nodered
```

Soll: leer, oder nur Änderungen, die danach auf `main` dazukamen. Der Stand trägt damit unter anderem (Commits auf
`uems`): Sprungprobe auf der Box `b1d679bfa` · Wächter A7/A8 `5fc937a51` · Doppelfreigaben `41327e9bd`, `17abebe1c` ·
Reserve der Verbraucher `d7344c77b` · Bezug am Messpunkt `d89afd712` · PV zählt einmal `173d69e4b` · stehender Wert
`b70334ea3` · Sollwertpfad auf einer Uhr `dd5f45b08` · Einzelbox-Uhrensprung `15990894d` · Anteilsweg nach
Uhrensprung `cf43bb735` · blinde Rampe und Bezugsrampe bei Plan-Rückkehr `f68d5e606`, `f8943db4c`. ⧉ vom Betreiber
beim ersten Lauf zu bestätigen.

### 7.2 Eintrag der Versions-Tabelle (Entwurf)

Die Versions-Tabelle ist `docs/contracts/v2/edge-capabilities.json` mit dem Release-Register (`edge_release`,
Ordnung `release_seq`). Für AP-15 gilt:

- **Keine neue Zeile** für `steuerungsverbund_anteil`, `sprungprobe` und `plan_quittung`: sie sind **nur gemeldet**
  ([Fähigkeiten im Herzschlag](../contracts/v2/edge-supports.md)). Eine Zeile verlangte ein `ab_release`, und jede
  Bestandsbox bekäme einen allgemeinen „Update nötig“-Hinweis. I1 prüft die Meldung der Box.
- **Das Release selbst** wird im Release-Register eingetragen, damit `release_seq` es ordnet.
- **Mitgebracht wird `data_sources`** (AP-06 IP-13, im Core gebaut und gemeldet). Wer das Release einträgt, füllt
  dort das `ab_release` aus — Entwurf:

```diff
     {
       "code": "data_sources",
       …
-      "ab_release": null
+      "ab_release": "<Tag des Box-Release>"
     },
```

  Der Eintrag ist eine Vertragsänderung: vorher alle Leser finden und fahren
  (`rg -l "edge-capabilities.json" services frontend docs/contracts`). In diesem Paket ist er **nicht** angewandt.

### 7.3 Release-Notiz (Entwurf)

Ein Absatz für die Notiz „Neue Einstiege im Portal“ bzw. „Software-Aktualisierung der Box“ der
[Vorlage](release-notiz-vorlage.md). Kundenwort ist „Gemeinsame Steuerung“. Es gelten die Sprachregeln, mit denen
`frontend/portal/src/copy.test.ts` die Vorlage prüft (u. a. kein „Verbund“, „Steuerungsverbund“, „gemeinsam
optimiert“, „Pilot“, „Rollout“, „Stufe S…“), dazu „Zähler“ statt „Messpunkt“ (AP-15 S1). Die zwei Punkte unten
bestehen diese Regeln; sie stehen noch nicht in der Vorlage.

> - Steuern in einer Anlage mehrere Boxen Geräte, finden Sie unter Anlage → Technik die Karte „Gemeinsame
>   Steuerung“. Dort tragen Sie ein, welche Boxen mitsteuern, welche Box den Zähler am Netzanschluss liest und was
>   hinter dem Anschluss erzeugt oder verbraucht, ohne dass eine Box es steuert. Aktiv wird die Gemeinsame
>   Steuerung erst nach einer kurzen Prüfung durch VoltPilot. Solange Sie nichts einrichten, ändert sich an Ihrer
>   Anlage nichts.
> - In Anlagen mit mehreren Boxen zeigt die Tagesansicht ab [TT.MM.JJJJ] die Erzeugung als Summe aller Boxen und
>   Netzbezug und Einspeisung am Zähler des Netzanschlusses. Werte vor dem [TT.MM.JJJJ] bleiben unverändert[, bis
>   VoltPilot sie neu berechnet].

Die beiden abschließenden Sätze der Vorlage bleiben unverändert (AP-15 §6.8: die Sprachregel S3 bleibt). Vor der
Nachricht an den Kunden der Pilotanlage in S3 liest der Captain, ob „Mehrere Boxen werden nicht als eine Einheit
optimiert.“ für ihn noch stimmt — dieses Drehbuch ändert den Satz nicht.

---

## 8. Vollständigkeit gegen die Ausfallmatrix

Jede Zeile der Matrix (AP-15 §5.1, 20 Zeilen) hat ihren Prüfstand- oder Feld-Schritt oder den Vermerk
„nur Simulator“. **„nur Simulator“** heißt: nur Crew-Nachweise (Zwei-Agenten-Test NW-2, Simulator-Aufbau NW-3,
Planer- und API-Tests NW-4), kein Hardware- und kein Feldschritt.

| Zeile | Ausfall | Prüfstand (NW-7) | Feld (NW-8/NW-9) | Vermerk |
|---|---|---|---|---|
| **A1** | mitsteuernde Box fällt ganz aus | **P-A1** §2.3 | Steckerprobe §6.2 (Cloud-Sicht), Alarm-Übung §6.3 | — |
| **A2** | führende Box fällt ganz aus | **P-A2** §2.3 (Speicher-Wachhund) | Vorbedingung §4.1 Punkt 6 (Puffer, Handgriff); kein Schritt an der Kundenanlage | Simulator „verletzt“ ohne Handgriff (§1.2) |
| **A3** | Cloud weg, Broker erreichbar | — | — | **nur Simulator** (NW-2, NW-3 „hält“, NW-4) |
| **A4** | Broker/Internet für alle Boxen weg | **P-A4** §2.3 | Grenz-Nachweis §6.4: jede Unterbrechung mit Höchstwert | — |
| **A5** | Internet nur für eine Box weg | — | **Steckerprobe** §6.2 | — |
| **A6** | Partner-Wert beim Planer veraltet | — | — | **nur Simulator** (NW-4; im Aufbau nicht fahrbar) |
| **A7** | Netzpunkt-Wert fehlt oder friert ein | **P-A7** §2.3 (Startwerte 30 s / 20 s / 2,1 kW, Bezugs-Doppelfreigabe) | Abbruch-Kriterium `AufAnteil` §4.5 | Simulator-Lauf neu (§1.2) |
| **A8** | Uhr einer Box geht falsch | — | — | **nur Simulator** (NW-2; im Container nicht fahrbar); im Pilot überwacht: `UhrUnsicher` §4.5, Box-Release §5.1 |
| **A9** | Plan nicht zugestellt / nicht quittiert | — | S3: `plan_id` veröffentlicht = angenommen je Box §4.4; `PlanNichtAngenommen` §4.5 | — |
| **A10** | Anteils-Änderung nicht zugestellt / nicht quittiert | — | **Scharfschalten-Zweischritt** §4.4 („1 von 2“ → „2 von 2“) | — |
| **A11** | zwei Befehlsquellen | — | — | **nur Simulator** (NW-2, NW-3 „hält“, NW-4) |
| **A12** | Box ohne Fähigkeit (alter Stand) | — | Vorbedingung §4.1 Punkt 5 (Fähigkeit je Box im Betreiber-Blatt), Box-Release §7.1 | — |
| **A13** | Neustart mitten im Eingriff | **P-A13** §2.3 | — | — |
| **A14** | Box-Tausch | — | nur wenn ein Tausch anfällt: §5.4 | sonst **nur Simulator** (NW-3, NW-4) |
| **A15** | Box erreicht ihr Gerät nicht | **P-A15** §2.3 | — | Simulator „verletzt“ ohne Handgriff (§1.2) |
| **A16** | § 14a-Vorgabe nur an einer Box (Befund) | — | **Netzbetreiber-Klärung** und `vorgabe_signal` je Mitglied §4.1 Punkt 1 | — |
| **A17** | erklärte Struktur stimmt nicht (Befund) | — | **Sprungprobe** §6.1, Verbund-Bilanz in S1 §4.3 | — |
| **A18** | Cloud-Datenbank zurückgespielt | — | — | **nur Simulator** (NW-3 „hält“, NW-4) |
| **A19** | Zuteilung auf Zeit (nur S4) | — | — | **entfällt:** S4 nicht gebaut (E1 = A); Testfall erst mit IP-33 |
| **A20** | Ungeregeltes wächst über den Vorbehalt (Befund) | — | Vorbehalt in S1 §4.3, Abgangszähler §4.1 Punkt 3, `VorbehaltZuKlein` §4.5 | Simulator-Lauf offen (§1.2) |

Zeilen mit Prüfstand-Schritt: A1, A2, A4, A7, A13, A15 — genau die Liste von NW-7 (§4.11 des Konzepts).
Zeilen mit Feld-Schritt: A1, A2, A4, A5, A7, A9, A10, A12, A14 (bei Tausch), A16, A17, A20. „nur Simulator“: A3, A6, A8,
A11, A14 (ohne Tausch), A18. Entfällt: A19.
