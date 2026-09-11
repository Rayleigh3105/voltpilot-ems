# Datenquelle und Zuständigkeit (UEMS AP-06 IP-1)

Stand 11.09.2026 · Vertrag 1.0 · Bezug: AP-06 §4.1–§4.7, §5.1/§5.2 und die Captain-Entscheide
**E1, E2, E3, E5, E7, E8, E9, E10 = B, E11, E12** vom 10.09.2026 (außer E10 alle Option A).

Dieser Vertrag sagt, **was eine Datenquelle ist, welche Box sie wann liest und nach welchen
Regeln sich das ändern darf** — und zwar so, dass aus denselben Fakten in der Cloud und im
Portal genau dasselbe Urteil und derselbe Kundensatz wird.

| Datei | Rolle |
|---|---|
| [`data-source-vectors.json`](./data-source-vectors.json) | 56 Fälle in acht Familien, Vokabular, Prüfreihenfolgen, Sätze; spielt im Referenzunternehmen Ahrenberg |
| [`data-source-assignment.schema.json`](./data-source-assignment.schema.json) | JSON Schema 2020-12 der Vektor-Datei; ihre `$defs` sind die Formen dieses Vertrags |
| [`edge-capabilities.json`](./edge-capabilities.json) + [`edge-capabilities.schema.json`](./edge-capabilities.schema.json) | die Tabelle „Software-Stand → Fähigkeiten“ als Daten (E12) |
| `services/api/.../uems/DatenquelleRegeln.java` + `DatenquelleRegelnVectorsTest` | Java-Zwilling; der Test prüft Schema, Fälle, Vokabular und jeden Fall gegen [`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) |
| `frontend/portal/src/uemsDatenquelle.ts` + `.test.ts` | TS-Zwilling gegen dieselbe Datei, samt beiden Schemas (`src/test/uemsSchemaLaeufer.ts`) |

**Wer die Regel ändert, ändert beide Zwillinge UND die Vektor-Datei.**

> ⚠ **Noch ruft niemand an.** Es gibt keine Tabelle `data_source`/`data_source_assignment`
> (IP-2), keinen Endpunkt (IP-3), keine Vorschlagsliste im Portal (IP-4); `gatewayDevice`,
> Registry-Push, Mess-Plan und Herzschlag sind unverändert. Heute ist die zuständige Box
> implizit `measurement_point.device_id` bzw. die eine Box je Anlage. Dieser Vertrag ist das
> Ziel, gegen das die Folgepakete bauen.

## 1. Begriffe

Die Wörter des Fachmodells ([`docs/fachmodell/glossar.md`](../../fachmodell/glossar.md): Box,
Datenquelle, Gerät, Komponente, Anlage) gelten unverändert. Dazu:

- **Datenquelle** — ein von einer Box erreichbarer Erfassungsweg (Protokoll + Adresse), hinter
  dem ein oder mehrere Geräte antworten. Ein Gateway mit vier Zählern ist EINE Quelle mit vier
  Geräten; eine WAGO-Steuerung mit N Karten ist EINE Quelle. „Datenquelle“ ist ein Wort der
  Einrichtungsflächen, nie der Auswertung.
- **Zuständigkeit** — „Box X liest Quelle Y von … bis …“. Je Quelle und Zeitpunkt genau eine
  Box oder keine („angehalten — keine Box liest“). Sie hängt an der QUELLE, nicht am Gerät und
  nicht an der Komponente (E2): ein Wechsel nimmt alle Geräte und Komponenten dahinter mit.
- **Heimat-Anlage** einer Box — die Anlage, in die sie angemeldet ist (Topic-Adresse,
  Zertifikat; AP-00 E7, unverändert). Die Zuständigkeit ist NICHT die Heimat: eine Box darf eine
  Quelle einer anderen Anlage lesen, wenn sie sie erreicht.
- **Führende Box** einer Anlage — die EINE Box, die die Anlagen-Summe bildet und Fahrplan,
  Regeln und Handeingriffe empfängt; alle anderen Boxen der Anlage sind **Lese-Boxen** (E3).
- **Steuerquelle** — die Quelle, hinter der die steuernde Komponente der Anlage antwortet. Sie
  wird immer von der Heimat-Box gelesen und wechselt ihre Box nicht, bis die gemeinsame
  Steuerung (AP-15) kommt.
- **Netzlage** — das dokumentierte Netz einer Quelle (Bezeichnung + Adressbereich, Bogen
  D1/D2). Dokumentation, keine Steuerung; der Beweis ist die Erreichbarkeitsprüfung von der
  gewählten Box (E11: eine Box = ein Netz).

## 2. Das Objekt Datenquelle (E1)

| Feld | Inhalt | Vektor-Feld |
|---|---|---|
| Kennzeichen | `DQ-n`, eindeutig je Kundenbereich, automatisch vergeben; ändert sich nie durch Technik | `kennzeichen` |
| Anlage | wo die Geräte verdrahtet sind — darf von der Heimat der lesenden Box abweichen | `anlage` |
| Protokoll | geschlossenes Vokabular: `modbus_tcp` Modbus TCP · `sunspec_modbus` SunSpec-Modbus · `mqtt` MQTT-Themen · `http` HTTP-Auskunft · `ocpp` OCPP-Station; neue nur über den Katalog | `protokoll` |
| Adresse | Host:Port · Themenfilter · URL · Stations-Kennung — ein Parameter, nie die Identität | `adresse` |
| Geräte hinter der Quelle | Geräte-ID je Gerät (Steckplatz bei Energiekarten, AP-05 E4) | `geraete_ids` |
| Netzlage | dokumentiertes Netz oder `null` | `netz` |
| Ein-Leser-Eigenschaft | Katalog-Flag der Vorlage: verträgt das Gerät einen zweiten Leser? **Vorgabe nein.** | `mehrere_leser` |
| Steuerquelle | trägt die Quelle die steuernde Komponente der Anlage? | `steuerquelle` |
| Zuständige Box | Zeiträume „Box · ab · bis“ (§4) | `zeitraeume[]` |

Lesetakt, Lebenszyklus (Entwurf · eingerichtet · aktiv · angehalten · archiviert), Beobachtung
(„liefert Daten“, siehe [`uems-zustand-vectors.json`](./uems-zustand-vectors.json)),
Rückmeldung und Verlauf gehören zum Objekt (AP-06 §4.2), sind aber nicht Gegenstand dieser
Regeln: sie entstehen in IP-2/IP-3/IP-14.

## 3. Identität — nie nur Register oder IP

1. **Die Identität einer Quelle ist ihr Kennzeichen.** Adresse, Port, Geräte-ID und Register
   identifizieren nichts.
2. **Eindeutigkeit je Box:** an einer Box darf zu jedem Zeitpunkt nur EINE Quelle je
   Protokoll + Adresse zuständig sein. Eine zweite wird abgelehnt und auf die bestehende
   verwiesen („Diese Adresse liest Box Halle 2 bereits als DQ-4 — Gerät dort hinzufügen?“).
   Ein weiteres Gerät hinter derselben Adresse (andere Geräte-ID) ist ein Gerät DIESER Quelle,
   nie eine neue Quelle.
3. **Dieselbe Adresse an einer ANDEREN Box ist eine andere Quelle** (AP-05 A5) — mit
   abweichender dokumentierter Netzlage ohne Rückfrage, nur mit dem Hinweis „Gleiche Adresse wie
   DQ-4 — anderes Netz“. Mit gleicher Netzlage greift §6.
4. **Die Kette eines Werts** ist Messstelle → Komponente → Gerät (Seriennummer/Steckplatz) →
   Datenquelle → lesende Box zum Messzeitpunkt. Ein Wechsel der Box ändert nur das letzte Glied
   (AP-04 E11); die Herkunft je Wert nennt die Box, deren Zeitraum den Messzeitpunkt enthält
   (Familie `zustaendig`, Herkunftsvertrag [`messwert-herkunft.md`](./messwert-herkunft.md)).
5. Die Regeln vergleichen die Adresse **so, wie sie gespeichert ist**. Die Normalisierung
   (Host klein, ohne Leerzeichen, Port immer ausgeschrieben) ist Sache des Endpunkts (IP-3).

## 4. Zuständigkeitszeiträume

- **Halboffen, auf die Minute:** `effective_from` gehört zum Zeitraum, `effective_to` nicht;
  `effective_to: null` heißt offen. Beide Zeitpunkte sind volle Minuten; ein Zeitpunkt mit
  Sekunden wird abgelehnt, nie gerundet.
- **Nie überlappend** (Speicher-Regel, IP-2 trägt sie als Ausschluss-Bedingung): ein neuer
  Zeitraum darf keinen bestehenden schneiden — auch nicht um eine Minute. Die Speicher-Regel
  beendet nichts von selbst. **Lücken sind erlaubt** und heißen „angehalten“.
- **Nie überschrieben, sondern beendet und neu begonnen** (AP-00 Regel 4): ein Wechsel ab `t`
  setzt beim laufenden Zeitraum `effective_to = t` und beginnt einen offenen Zeitraum der neuen
  Box ab `t` (Ende alt = Beginn neu).
- **Nie rückwirkend:** ein neuer Zeitraum beginnt jetzt oder später. „Jetzt“ zählt auf die
  Minute abgerundet — wer um 07:30:25 „ab 07:30“ einträgt, trägt jetzt ein. **Einzige
  Ausnahme** ist die Vorschlagsliste der Bestands-Übernahme (§8): sie beschreibt ab
  Reihenbeginn, was die Box ohnehin gelesen hat, und wird erst mit der Bestätigung geschrieben.
- **Ein geplanter Wechsel ist ein Zeitraum in der Zukunft.** Ein weiterer Wechsel VOR ihm wird
  abgelehnt („Ab 10.04.2027 07:30 liest bereits Box Halle 2 (neu) — erst diesen geplanten
  Wechsel zurücknehmen“); nichts wird still verschoben.
- **Box-Tausch (E7):** ab dem Tauschzeitpunkt übernimmt die Nachfolgerin Heimat-Anlage, Rolle
  und ALLE Zuständigkeiten der alten Box — ein laufender Zeitraum wird geteilt, ein geplanter
  wechselt ganz die Box, was davor liegt, bleibt. Nie rückwirkend: die Lücke eines Ausfalls
  bleibt bei der alten Box. Die Steuerquelle geht mit (die Nachfolgerin IST die Heimat-Box).
- **Übergabe mit Lücke (E9):** zum Zeitpunkt stellt die Cloud zuerst der alten Box die Menge
  ohne die Quelle zu, dann der neuen die Menge mit ihr — die kurze Lücke ist sichtbar, zwei
  Leser gibt es nie. Das ist Laufzeit (IP-6 ff.); der Vertrag legt nur fest, dass die
  Zuständigkeit genau bei `t` wechselt.

## 5. Einen Antrag prüfen: anlegen oder wechseln

Ein Antrag nennt Quelle (bestehend) oder Kandidat (neu), Ziel-Box, `effective_from`, das
Ergebnis der Erreichbarkeitsprüfung und — für §6 — ob der Kunde bestätigt hat. Geprüft wird in
fester Reihenfolge; **der erste zutreffende Grund entscheidet**:

| # | Grund | gilt für | Satz (Platzhalter in `{}`) |
|---|---|---|---|
| 1 | `protokoll_unbekannt` | beide | Dieses Protokoll kennt VoltPilot nicht — neue Protokolle kommen nur über den Katalog |
| 2 | `keine_volle_minute` | beide | Eine Zuständigkeit beginnt auf die volle Minute — bitte eine Uhrzeit ohne Sekunden wählen |
| 3 | `rueckwirkend` | beide | Eine Zuständigkeit beginnt frühestens jetzt — nie rückwirkend |
| 4 | `steuerquelle` | Wechsel | Diese Quelle steuert — ihre Box kann erst mit der gemeinsamen Steuerung wechseln |
| 5 | `spaeterer_wechsel_geplant` | Wechsel | Ab {zeitpunkt} liest bereits {box} — erst diesen geplanten Wechsel zurücknehmen |
| 6 | `schon_zustaendig` | Wechsel | {box} liest diese Quelle zu diesem Zeitpunkt bereits |
| 7 | `adresse_an_box_vergeben` | beide | Diese Adresse liest {box} bereits als {kennzeichen} — Gerät dort hinzufügen? |
| 8 | `netzlage_fehlt` | beide | Gleiche Adresse wie {kennzeichen} an {box} — erst das Netz beider Quellen eintragen (Bogen D1/D2) |
| 9 | `nur_ein_leser` | beide | Gleiche Adresse wie {kennzeichen} an {box} im selben Netz — nicht möglich: dieses Gerät verträgt nur einen Leser |
| 10 | `vergleich_bestaetigen` | beide | Gleiche Adresse wie {kennzeichen} an {box} im selben Netz — als Vergleichsquelle anlegen (gekennzeichnet)? |
| 11 | `pruefung_fehlt` | beide | Es fehlt: Prüfung von {box} |
| 12 | `pruefung_gescheitert` | beide | der Satz der Fehlerklasse (§7), z. B. „Box Halle 2 (neu) erreicht 192.168.10.31:502 nicht — Netz/VLAN prüfen (Bogen D1/D2)“ |

Erst die billigen Regeln der Cloud (Zeit, Identität, Doppel-Lesen), dann der Beweis von der
Box: **die Erreichbarkeitsprüfung zählt nur von GENAU der Ziel-Box** (E11, §4.4 Nr. 7) — ohne
sie bleibt eine neue Quelle Entwurf, und ein Wechsel wird nicht angelegt. Das Urteil ist
`erlaubt` (Satz „Ab {zeitpunkt} liest {box}“, dazu die Zeiträume danach), `bestaetigung_noetig`
(nur Grund 10) oder `abgelehnt`. Die Software-Version der Ziel-Box spielt keine Rolle: auch eine
alte Box darf lesen (E8 = A).

Das Lesebudget je Box (E6) prüft der Endpunkt danach mit den bestehenden Zwillingen
`MeasurementBudget.java` / `measurement-planner.js`; es ist nicht Teil dieser Regeln.

## 6. Doppel-Lesen nur als gekennzeichnete Vergleichsquelle (E10 = B)

Gleiche Adresse UND gleiche dokumentierte Netzlage an einer zweiten Box heißt: dasselbe Gerät
würde zweimal gelesen. Das geschieht **nie still**:

- **Gesperrt**, wenn das Gerät nur einen Leser verträgt — Katalog-Flag `mehrere_leser` bei einer
  der beiden Quellen nicht gesetzt (Vorgabe: ein Leser; WAGO-Koppler-Weg, Solarman-Logger) —
  oder wenn eine der beiden eine **Steuerquelle** ist. Keine Bestätigung öffnet das.
- **Sonst nur nach ausdrücklicher Bestätigung**, und dann als eigene, gekennzeichnete
  Vergleichsquelle ohne Bewertung (AP-04 E3; Hinweis „Vergleichsquelle zu DQ-2 an Box Halle 1 —
  gekennzeichnet, ohne Bewertung“) — nie dieselbe Komponente aus zwei Boxen.
- **Fehlt die Netzlage** bei einer der beiden, ist „anderes Netz“ nicht bewiesen: der Antrag
  wartet, bis das Netz eingetragen ist (`netzlage_fehlt`).

Maßgeblich ist die Box, die zum Zeitpunkt liest: eine ausgebaute Box, deren Zeitraum endete,
kollidiert mit nichts.

## 7. Fehlerklassen je Quelle (E5 = A, geschlossenes Vokabular)

Die Wörter des Verbindungstests (`edge-app/core/internal/testconn`), dazu zwei der Box und eines
der Cloud. **Ein anderes Wort wird beim Annehmen verworfen** — auch eine andere Schreibweise —,
und eine Klasse zählt nur von dem, der sie feststellen kann:

| Klasse | der Kunde liest | von | Satz |
|---|---|---|---|
| `unreachable` | nicht erreichbar | Box | {box} erreicht {adresse} nicht — Netz/VLAN prüfen (Bogen D1/D2) |
| `no_answer` | Zeitüberschreitung | Box | Gerät antwortet nicht rechtzeitig — Geräte-ID, Last oder Watchdog prüfen (Bogen D3/D4) |
| `invalid_response` | Gerät meldet Fehler | Box | Gerät antwortet mit Fehler — Registerbild oder Vorlage prüfen |
| `implausible` | Werte unplausibel | Box | Gerät antwortet, die Werte sind aber unplausibel — Vorlage und Wandlerfaktor prüfen |
| `fronius_api` | Solar-API antwortet nicht | Box | Die Solar-API des Geräts antwortet nicht |
| `timeout` | kein Ergebnis | Box | {box} bekommt von {adresse} kein Ergebnis im Lesefenster |
| `layout_changed` | Aufbau geändert | Box | Aufbau geändert — nichts wurde umgehängt |
| `budget` | Budget überschritten | Box | Diese Quelle passt nicht mehr in das Lesebudget von {box} — Takt strecken oder andere Box wählen |
| `box_meldet_sich_nicht` | Box meldet sich nicht | Cloud | {box} meldet sich nicht |

Nicht im Vokabular, weil sie kein Leseergebnis sind: `invalid_request` (Formular),
`not_supported` und `rate_limited` (Prüf-Kanal). Eine Box meldet nie, dass sie schweigt; die
Cloud behauptet nie, dass ein Gerät nicht antwortet. Der Block `data_sources[]` im Herzschlag,
der diese Klassen trägt, ist IP-13 (`data-source-status-vectors.json`).

## 8. Die Rolle der Box: führend oder lesend (E3 = A)

Die führende Box einer Anlage ist ein **gespeicherter Fakt** (IP-2: `site.lead_device_id`),
bestimmt in dieser Vorrang-Reihenfolge — **nie geraten**:

1. `gespeichert` — die ausdrückliche Wahl des Kundenadministrators;
2. `speicher` — sonst die Box, die den primären Speicher (die Steuerquelle) liest;
3. `einzige` — sonst die einzige Box der Anlage;
4. `keine_wahl` — sonst keine: „Welche Box führt diese Anlage? — Box wählen“. Das Lesen läuft
   weiter; Regeln und Handeingriffe sind bis zur Wahl benannt gesperrt.

Jede Box der Anlage liest „liest 2 Datenquellen · führt die Anlage“ bzw. „liest 1 Datenquelle ·
führt die Anlage nicht“ (A9). Zwei Boxen in einer Anlage sind nie von selbst ein Verbund.

**Bestands-Übernahme (A12, IP-4):** die vorhandenen Komponenten werden nach Box + Protokoll +
Adresse zu Vorschlägen gruppiert (Reihenfolge des ersten Auftretens, Kennzeichen ab der
nächsten freien Nummer des Kundenbereichs, Geräte-IDs aufsteigend, Steuerquelle, wenn eine
Komponente steuerbar ist); zuständig ist die heutige Box ab Reihenbeginn. Bis zur Bestätigung
ändert sich nichts.

## 9. Fähigkeiten einer Box (E12 = A)

[`edge-capabilities.json`](./edge-capabilities.json) nennt die Fähigkeiten, deren Fehlen eine
Fläche benennt — heute **Rückmeldung je Datenquelle** (`data_sources`) und **Zuständigkeit ab
Zeitpunkt** (`assignment_effective_at`) — mit dem ersten Release, das sie trägt (`ab_release`).

1. Meldet die Box `supports[]` im Herzschlag (IP-18), entscheidet **allein** ihre Meldung — auch
   eine leere Liste. Fremde Wörter werden verworfen.
2. Sonst die Tabelle: die Fähigkeit ist da, wenn der Stempel der Box zu einem Release des
   Registers `edge_release` gehört (Präfix-Regel `RolloutStates.releaseIsRunning`) und dieses
   Release in der Ordnung `release_seq` nicht vor `ab_release` liegt (Captain-Entscheid D5 —
   nie ein Zeichenketten- oder SHA-Vergleich).
3. Ein Stempel ohne Release (nackte SHA, „dev“, das semver-Beispiel „2.5.0“) beweist nichts.
   Die Fläche zeigt „Software 2.5.0 · Update nötig für: Rückmeldung je Datenquelle,
   Zuständigkeit ab Zeitpunkt“ (A7), mit dem Release-Tag statt des Builds, wo es eines gibt.

⚠ **Heute trägt kein ausgeliefertes Release eine der beiden Fähigkeiten** — `ab_release` ist
`null`, jede Box fährt das Übergangs-Verhalten (E8). Wer das Release baut, das eine Fähigkeit
bringt, trägt sein Tag dort ein. Keine Fähigkeit sind Zustellung je Box (E4, Cloud),
Nachfolger-Anmeldung (E7, Cloud) und die lesende Box je Wert (Topic) — dafür gibt es nie ein
„Update nötig“.

## 10. Die Fälle

| Familie | Fälle | pinnt |
|---|---|---|
| `antrag` | 21 | Eindeutigkeit je Box, Gateway, A4 anderes Netz, fehlende Netzlage, A8 (Rückfrage · bestätigt · Ein-Leser), Steuerquelle als Ein-Leser, A3 hin/zurück/laufende Minute, rückwirkend, volle Minute, geplanter Wechsel, schon zuständig, A11 (gescheitert · fehlt · andere Box), A13, Protokoll, A7 neue Quelle an alter Box |
| `zeitraeume` | 5 | Ende alt = Beginn neu, eine Minute Überschneidung, zweiter offener Zeitraum, leerer Zeitraum, Lücke |
| `zustaendig` | 2 | Herkunft je Wert A3 (DQ-3) und A5 (DQ-4, Ausfall bleibt bei der alten Box) |
| `box_tausch` | 3 | A5 Tausch, nicht rückwirkend, geplante Zuständigkeit geht mit |
| `fuehrende_box` | 5 | A9, A12, einzige Box, zwei Boxen ohne Speicher, ausdrückliche Wahl |
| `faehigkeiten` | 9 | A7 mit der echten Tabelle, Register-Ordnung, Stand ohne Release, `supports[]` (übersteuert · leer · mehr als die Tabelle), kein Stand |
| `fehlerklasse` | 9 | angenommen, verworfen (Konzept-Wort `exception`, fremdes Wort, Schreibweise), falscher Absender |
| `bestand` | 2 | A12 Vorschlagsliste Halle 1, Nummern laufen im Kundenbereich weiter |

**Die Beispielwelt ist das Referenzunternehmen.** Jeder Fall, der ein Ahrenberg-Objekt nennt,
übernimmt dessen Werte; `DatenquelleRegelnVectorsTest.jederFallStehtImReferenzunternehmen`
prüft Box-Name, Heimat, führende Rolle, Software-Stand, Anlage/Protokoll/Adresse/Netz/
Steuerquelle jeder Quelle, jeden Zeitraum (offen nur, wo das Ende zu `jetzt` noch nicht
eingetreten war), die Inbetriebnahme der Ziel-Box eines erlaubten Antrags und den Anschluss
jeder Bestands-Komponente. Was ein Fall erfindet (eine zusätzliche Box, einen Testaufbau, eine
künftige Tabelle), nennt er in `annahme` — sonst ist der Test rot.

## 11. Widersprüche und Lücken (benannt, nicht still aufgelöst)

1. **Codes der Fehlerklassen.** AP-06 §4.5 schreibt `timeout` für „Verbindung steht, keine
   Antwort“ und `exception` für „Gerät meldet Fehler“; E5 = A bindet an das Vokabular des
   Verbindungstests. Dort heißen diese Fälle `no_answer` und `invalid_response`; `timeout` hat
   dort die Bedeutung „kein Ergebnis im Fenster“. Umgesetzt ist der Entscheid-Wortlaut; der
   Vektor `fehlerklasse-exception-aus-dem-konzept-verworfen` pinnt es.
2. **Box der Übergabe am 10.04.2027.** Das Konzept nennt „Box Halle 2 (E-2)“; die Referenzdatei
   führt E-2 seit 04.11.2026 als ausgebaut, zuständig ist E-2′ „Box Halle 2 (neu)“. Die Vektoren
   folgen der Referenz.
3. **A4-Testaufbau.** Das Konzept legt die zweite Steuerung „DQ-6′“ in ein Netz „Lindach
   192.168.20.0/24“; die Referenz führt Box Lindach im Netz 192.168.30.0/24. Der Fall trägt den
   Testaufbau als `annahme`; kein Referenzwert ist verändert.
4. **„(AP-15)“ im Kundensatz** der Steuerquelle ist ein internes Paketkürzel und steht in keinem
   Kundentext; der Satz endet mit „… mit der gemeinsamen Steuerung wechseln“.
5. **Protokoll-Wörter.** Die Referenz schreibt „OCPP 1.6J“, das Vokabular „OCPP-Station“
   (`ocpp`); die Fassung ist Parameter der Station.
6. **Versionen.** Die Referenz nennt für Box Lindach „2.5.0“; echte Stempel heißen
   `edge-JJJJ.MM.N-<sha>`, geordnet über `release_seq`. Die Regel beweist aus einem Stempel ohne
   Release keine Fähigkeit — A7 bleibt so auch dann richtig, wenn `ab_release` gesetzt wird.
7. **Fehlende Netzlage** bei gleicher Adresse an zwei Boxen regelt das Konzept nicht; der
   Vertrag schließt die Lücke konservativ (`netzlage_fehlt`, nie „anderes Netz“ geraten).
8. **„Update nötig für …“** nennt der Satz auch, solange noch kein Release die Fähigkeit trägt;
   einen Weg zu Edge-Updates bietet die Fläche (IP-16) erst an, wenn `ab_release` gesetzt ist.

## 12. Was dieser Vertrag nicht regelt

Das Lesebudget (E6, bestehende Zwillinge), die Laufzeit der Übergabe (E9, IP-6 ff.), die Form
der Blöcke `data_sources[]` (IP-13) und `supports[]` (IP-18), Tabellen und Grants (IP-2),
Endpunkte und Rechte `datenquelle.bearbeiten`/`datenquelle.zustaendigkeit` (IP-3, AP-03),
Ladepunkte an einer zweiten Box (§5.2, bis AP-15) und das Entfernen einer noch zuständigen Box
(IP-19).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='DatenquelleRegelnVectorsTest')   # 117 Tests, rein
(cd frontend/portal && npx vitest run src/uemsDatenquelle.test.ts)       # 61 Tests
```
