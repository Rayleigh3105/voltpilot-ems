# Datenquelle und Zuständigkeit (UEMS AP-06 IP-1)

Stand 11.09.2026 · Vertrag 1.0 · Bezug: AP-06 §4.1–§4.7, §5.1/§5.2 und die Captain-Entscheide
**E1, E2, E3, E5, E7, E8, E9, E10 = B, E11, E12** vom 10.09.2026 (außer E10 alle Option A).

Dieser Vertrag sagt, **was eine Datenquelle ist, welche Box sie wann liest und nach welchen
Regeln sich das ändern darf** — und zwar so, dass aus denselben Fakten in der Cloud und im
Portal genau dasselbe Urteil und derselbe Kundensatz wird.

| Datei | Rolle |
|---|---|
| [`data-source-vectors.json`](./data-source-vectors.json) | 61 Fälle in acht Familien, Vokabular, Prüfreihenfolgen, Sätze; spielt im Referenzunternehmen Ahrenberg |
| [`data-source-assignment.schema.json`](./data-source-assignment.schema.json) | JSON Schema 2020-12 der Vektor-Datei; ihre `$defs` sind die Formen dieses Vertrags |
| [`edge-capabilities.json`](./edge-capabilities.json) + [`edge-capabilities.schema.json`](./edge-capabilities.schema.json) | die Tabelle „Software-Stand → Fähigkeiten“ als Daten (E12) |
| `services/api/.../uems/DatenquelleRegeln.java` + `DatenquelleRegelnVectorsTest` | Java-Zwilling; der Test prüft Schema, Fälle, Vokabular und jeden Fall gegen [`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) |
| `frontend/portal/src/uemsDatenquelle.ts` + `.test.ts` | TS-Zwilling gegen dieselbe Datei, samt beiden Schemas (`src/test/uemsSchemaLaeufer.ts`) |

**Wer die Regel ändert, ändert beide Zwillinge UND die Vektor-Datei.**

> ⚠ **Wer anruft (Stand IP-6):** die Datenquellen-Schnittstelle
> `/api/v1/sites/{siteId}/data-sources` (`DatenquelleService`: anlegen, von genau der Box
> prüfen, zuweisen) über die Tabellen aus IP-2, und die Vorschlagsliste der Bestands-Übernahme
> `…/data-sources/vorschlag` + `…/vorschlag/uebernehmen` (`DatenquelleVorschlagService`, §8). Noch
> NICHT: die Liste im Übernahme-Assistenten des Portals. Seit IP-6 stellt der Registry-Push je Box zu
> (§8 „Der Push je Box“); Mess-Plan und Herzschlag sind unverändert, und wer eine Zuständigkeit
> schreibt, löst noch keinen Push aus (die Übergabe zum Zeitpunkt ist IP-7) — die Zuständigkeit
> erreicht ihre Box mit dem nächsten Registry-Push der Anlage.

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
| Protokoll | geschlossenes Vokabular: `modbus_tcp` Modbus TCP · `sunspec_modbus` SunSpec-Modbus · `mqtt` MQTT-Themen · `http` HTTP-Auskunft · `ocpp` OCPP-Station · `solarman_v5` Solarman-Datenlogger (seit IP-4, nach AP-06 Soll-Regel 8); neue nur über den Katalog | `protokoll` |
| Adresse | Host:Port · Themenfilter · URL · Stations-Kennung · Host:Port/Seriennummer des Solarman-Datenloggers — ein Parameter, nie die Identität | `adresse` |
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

**Der Dienst (IP-5).** Registry-Push und Flow-Aktivierung stellen der führenden Box zu
(`LeadDeviceService`, Ableitung `uems/FuehrendeBoxAbleitung`, Vektoren
[`lead-device-vectors.json`](./lead-device-vectors.json)). Die Vorrang-Reihenfolge ist die obige;
dazu kommen zwei Regeln, die nur ein Dienst mit echten Boxen braucht:

- Eine gespeicherte Wahl gilt nur, wenn die Box in DIESER Anlage angemeldet und nicht ausgebaut
  ist; sonst führt keine Box (`gespeichert_nicht_in_anlage`) — nie still eine andere, auch nicht
  die einzige. Heute löscht das Entfernen einer Box ihre Zeile und leert damit die Wahl
  (`ON DELETE SET NULL`); danach gilt wieder Speicher-Box → einzige Box.
- „Keine“ ist zweigeteilt: `keine_wahl` (mehrere Boxen, keine gewählt — der Kunde wählt) und
  `keine_box` (die Anlage hat keine Box — es gibt nichts zu wählen).

Die Box des Speichers gilt wie bis IP-5 ohne Anmelde-Prüfung. Für jede Bestandsanlage ist
`site.lead_device_id` NULL; dann ist die führende Box genau die der alten Einzel-Gateway-Weiche,
und wo die keine hatte, bleibt das Beobachtbare gleich (kein Push, `refused(no_gateway_device)`,
Vorschau-Grund `no_claimed_device` bzw. `multiple_devices_no_battery_link`).

**Der Push je Box (IP-6, E4 = A, W7).** Der Registry-Push (`…/v2/entities`) geht je Box: jede Box
bekommt ihren eigenen vollständigen Sollbestand aus genau den Komponenten, deren Datenquelle sie ZUM
Zeitpunkt des Pushs liest (§4, halboffen); die Anlagen-Rollen — Netz-Summe `grid-meter`, Haus-Summe
`house-load`, Speicher `battery-hybrid` — stehen nur im Push der führenden Box. Die Regel ist
`uems/PushJeBox` (rein), in Prüfreihenfolge:

1. Ohne führende Box kein Push, auch keiner je Box (`keine_fuehrende_box`) — wie bis IP-5.
2. Trägt keine Komponente der Anlage eine Datenquelle (jede Bestandsanlage bis zur Bestätigung der
   Vorschlagsliste), bleibt es der eine Push an die führende Box, Byte für Byte.
3. Eine Anlagen-Rolle gehört der führenden Box. Liest ihre Quelle eine andere Box, steht sie in
   keinem Push (`anlagen_rolle_an_anderer_box`); liest keine Box sie: `quelle_ohne_zustaendige_box`.
4. Eine Komponente ohne Datenquelle gehört der führenden Box.
5. Eine Komponente mit Datenquelle gehört der Box, die die Quelle zum Zeitpunkt liest. Liest keine:
   `quelle_ohne_zustaendige_box`; liest eine Box, die weder in der Anlage angemeldet noch ihre
   führende Box ist: `box_ausserhalb_der_anlage` — der Anlagen-übergreifende Fall wartet auf IP-7
   (A3, 10.04.2027 07:30: K-4 … K-7 stehen dann in keinem Push, nie bei Box Halle 1).

Einen Push bekommen die führende Box, jede Box mit mindestens einer Komponente und jede Box der
Anlage, für die schon ein Soll aufgezeichnet ist — auch mit leerer Menge, damit sie eine Quelle, die
sie nicht mehr liest, sicher vergisst. Die Mengen sind disjunkt durch Bau: jede Komponente wird genau
einmal entschieden. Das Soll steht je (Anlage, Box) in `entity_registry_state`. Ein Push-Lauf baut
ERST alle Nutzlasten, schreibt DANN das Soll aller Boxen in einer Anweisung und stellt zuletzt zu;
zugestellt heißt er nur, wenn jede Box ihren Push bekommen hat. Die Bestands-Übernahme
(Einheitsmodell Stufe 2) gilt erst mit beiden Pushes; hatte eine Box ihren schon, stellt ein neuer
Push nach dem Rückrollen beide zurück.

**Bestands-Übernahme (A9, A12, IP-4):** die vorhandenen Komponenten werden nach Box + Protokoll +
Adresse zu Vorschlägen gruppiert (Reihenfolge des ersten Auftretens, Kennzeichen ab der
nächsten freien Nummer des Kundenbereichs, Geräte-IDs aufsteigend, Steuerquelle, wenn eine
Komponente steuerbar ist); zuständig ist die heutige Box ab Reihenbeginn. Bis zur Bestätigung
ändert sich nichts. Die Regel ist `vorschlagsliste` (Familie `bestand`); dazu:

- **Ein komponiertes Geschwister** (`gehoert_zu`: Erzeuger, Netzzähler oder Hausverbrauch ohne
  eigenen Anschluss, gespeist vom Gerät seines Wechselrichters — die Gruppierung der
  Geräte-Ableitung `uems_geraet_ableiten_fuer`) landet in der Quelle seines Wechselrichters, auch
  wenn es vor ihm steht. Hat der keinen Vorschlag: `anker_ohne_vorschlag`.
- **Benannt ausgelassen, nie geraten** (`auslass_gruende`, in Prüfreihenfolge): `keine_box` (keine
  Box liest sie) → `keine_adresse` (kein Transport) → `protokoll_unbekannt` (die Rückwand für ein
  Wort, das kein realer Bestands-Transport ist — verworfen, nie auf ein anderes Wort abgebildet) →
  `keine_adresse` (keine eindeutige Adresse).
- **Lesetakt** ist der kleinste bekannte der Komponenten, sonst `null` = nicht erhoben.
- **Belegte Nummern** (`belegt`) werden übersprungen — wie `uems_datenquelle_kennzeichen()` es
  beim Speichern tut.

**Die Schnittstelle (`DatenquelleVorschlagService`).** `GET …/vorschlag` liest nur. Die Box einer
Komponente ist die, die sie heute liest: die eigene einer komponierten Zeile
(`measurement_point.device_id`), die Box, an deren Zentrale eine Ladestation hängt
(`device_charge_point`), sonst die führende Box (`LeadDeviceService`, dorthin geht der
Registry-Push). Der Reihenbeginn ist der Beginn ihrer ersten Speisung (`geraet_komponente`, AP-04),
frühestens ab der Ankunft der Box in ihrer Anlage (auf die nächste volle Minute). Ein Vorschlag,
dessen Adresse an seiner Box ab Reihenbeginn schon eine andere Quelle liest, trägt den Grund
`adresse_an_box_vergeben` (`bestandWegVergeben`, derselbe Satz wie im Antrag).
`POST …/vorschlag/uebernehmen` schreibt je bestätigtem Vorschlag in EINER Transaktion die Quelle
(ohne Name, Netzlage leer, Ein-Leser), ihre Zuständigkeit `[Reihenbeginn, offen)`,
`measurement_point.data_source_id`, `geraet.data_source_id` der laufenden Speisung und EINEN
Protokoll-Eintrag `aus_bestand_uebernommen` (`gilt_ab` = Reihenbeginn — die einzige Ausnahme von §4).
Bestätigt wird nur, was gezeigt wurde (Box, Protokoll, Adresse, Komponenten; sonst 409
`vorschlag_geaendert`); hat eine Komponente inzwischen auf anderem Weg eine Quelle, 409
`komponente_hat_quelle`; ein schon übernommener Vorschlag zählt als unverändert.
**Gerät dort hinzufügen:** trägt ein Vorschlag `adresse_an_box_vergeben` und hat an seiner Box
genau EINE Quelle derselben Anlage unter demselben Weg eine nicht beendete Zuständigkeit (nicht archiviert, mit allen
Geräte-IDs des Vorschlags, Steuerquelle, wenn er es ist), nennt das GET sie als `ziel`
(`id`, `kennzeichen`, `name`, sonst `null`). Bestätigt der Kunde den Vorschlag mit
`datenquelle_id` = dieses Ziel, hängt `uebernehmen` die Komponenten an die vorhandene Quelle
(`measurement_point`/`geraet.data_source_id`, Protokoll `aus_bestand_uebernommen` mit
`angehaengt: true`, `gilt_ab` = jetzt) — keine neue Quelle, keine neue Zuständigkeit, nichts
rückwirkend; die Antwort zählt sie als `angehaengt`. Zeigt das GET dieses Ziel nicht mehr: 409
`vorschlag_geaendert`. Ohne `datenquelle_id` bleibt der gesperrte Vorschlag 409.

**Vom Transport zum Protokoll** (`BestandAnschluss`, nur Cloud — die Box kennt keine Quelle, bevor
IP-6 sie ihr zustellt): gelesen wird `measurement_point.communication` + `connection_json`, so, wie
`EntityRegistryService.driverBlock` sie der Box reicht.

| Transport | Protokoll | Adresse | Geräte-ID |
|---|---|---|---|
| `modbus_tcp`, `kostal_modbus`, `kaco_modbus`, Selbstbau `modbus_baukasten` | `modbus_tcp` | `ip:port` (Selbstbau: `transport.host:port`) | `unit_id` |
| `sunspec_tcp`, `fronius_sunspec` | `sunspec_modbus` | `ip:port` | `unit_id` |
| `solarman_v5` (Deye über den Datenlogger) | `solarman_v5` | `ip:port/serial` — die Seriennummer des Datenloggers trägt jeder Solarman-V5-Rahmen; ohne sie keine Adresse | `mb_slave_id` |
| `kaco_http`, `fronius_solar_api`, `goe_http_api`, `shelly_http`, Batterie-Anschluss `http_local` | `http` | `schema://host:port[/pfad]` — `https`, wo der Treiber es nimmt (`scheme: https`, `insecure_tls`, `endpoint.tls`) | — |
| `mqtt_local` | `mqtt` | das EINE Thema aller Zuordnungen; mehrere Themen: keine Adresse | — |
| Ladestation (`device_charge_point`) | `ocpp` | die Stations-Kennung | — |
| jedes andere Wort (die Rückwand) | das Wort selbst → `protokoll_unbekannt` | — | — |

**Die Tabelle ist vollständig** (AP-06 Soll-Regel 8, Konzept vom Captain am 10.09.2026 abgenommen: JEDE vorhandene Komponente
wird genau einer Datenquelle zugeordnet): sie kennt genau die Transport-Wörter, die eine
Bestandsanlage tragen kann — die Vorlagen des Katalogs (`builtin.json`), die Anbindungs-Arten des
Admin-Werkzeugs (`ComponentTemplateDefinition.COMMUNICATIONS`), Selbstbau und Batterie-Anschluss
und die Treiber der Box (`edge-app/core/internal/inverter`, `componentapply`);
`BestandAnschlussTest.dieTabelleKenntJedesTransportWortDesBestands` hält das gleich. Ein fehlender
Port und eine fehlende Geräte-ID sind die Vorgaben des Treibers (eine 0 liest ein Treiber der Box
wie „fehlt“) — dieselben wie die Vorbelegung der Vorlage im Katalog (`BestandAnschlussTest` hält
die Ports gleich). Der Takt kommt aus `connection_json.interval_s` (von dort
hebt ihn der Push auf die Treiber-Ebene), sonst ist er nicht erhoben (`data_source.kadenz_s` NULL,
Migration V20260911270000) — die Spalte `measurement_point.interval_s` trägt die Vorgabe 5 JEDER
Zeile, erreicht die Box nicht und ist darum kein Beleg.

## 9. Fähigkeiten einer Box (E12 = A)

[`edge-capabilities.json`](./edge-capabilities.json) nennt die Fähigkeiten, deren Fehlen eine
Fläche benennt — heute **Rückmeldung je Datenquelle** (`data_sources`) und **Zuständigkeit ab
Zeitpunkt** (`assignment_effective_at`) — mit dem ersten Release, das sie trägt (`ab_release`).

1. Eine bekannte Fähigkeit aus `supports[]` gilt auch ohne Tabellenbeleg. Fremde Wörter
   werden verworfen; Details und Vokabular: [Fähigkeitsmeldung](edge-supports.md).
2. Zusätzlich gilt die Tabelle (auch bei fehlendem, leerem oder teilweisem Block): die
   Fähigkeit ist da, wenn der Stempel der Box zu einem Release des
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
| `bestand` | 7 | A12 Vorschlagsliste Halle 1 (Speicher als Geschwister von K-1), Nummern laufen im Kundenbereich weiter, Geschwister vor seinem Wechselrichter, Deye über den Datenlogger (`solarman_v5`), benannt ausgelassen (alle vier Gründe, kleinster Takt), A9 Vorschläge je Box, belegte Nummer übersprungen |

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
5. **Protokoll-Wörter — aufgelöst (Referenzdatei 1.1).** Die Referenz führt das Protokoll jetzt
   im Vokabular (`modbus_tcp`, `ocpp`; die Fassung 1.6J ist Parameter der Station und steht im
   Weg) und bei OCPP die Stations-Kennung als `adresse`; die Tests bilden nichts mehr ab.
6. **Versionen.** Die Referenz nennt für Box Lindach „2.5.0“; echte Stempel heißen
   `edge-JJJJ.MM.N-<sha>`, geordnet über `release_seq`. Die Regel beweist aus einem Stempel ohne
   Release keine Fähigkeit — A7 bleibt so auch dann richtig, wenn `ab_release` gesetzt wird.
7. **Fehlende Netzlage** bei gleicher Adresse an zwei Boxen regelt das Konzept nicht; der
   Vertrag schließt die Lücke konservativ (`netzlage_fehlt`, nie „anderes Netz“ geraten).
8. **„Update nötig für …“** nennt der Satz auch, solange noch kein Release die Fähigkeit trägt;
   einen Weg zu Edge-Updates bietet die Fläche (IP-16) erst an, wenn `ab_release` gesetzt ist.
9. **K-1 in der Datenbank (IP-4).** Die Referenz führt K-1 (Wechselrichter) und K-2 (der über ihn
   gemeldete Speicher) als zwei Komponenten an EINEM Gerät GR-1; die Datenbank hält beide in EINER
   Zeile (`battery-hybrid`), die PV eines Hybrid-Wechselrichters als komponiertes Geschwister an
   seiner Box. Die Vektoren folgen der Referenz (K-2 `gehoert_zu` K-1), `DatenquelleVorschlagApiTest`
   der Datenbank — beide ergeben DQ-1. K-1 heißt „SunSpec-Modbus“, DQ-1 führt `modbus_tcp`: gelesen
   wird er über den generischen Modbus-Treiber mit SunSpec-Karte (`communication: modbus_tcp`); der
   Treiber `sunspec_tcp` ergäbe `sunspec_modbus`.
10. **Der Deye-Datenlogger (`solarman_v5`) — erledigt (nach AP-06 Soll-Regel 8, Konzept vom Captain am
   10.09.2026 abgenommen).** Das Vokabular hatte
   für den häufigsten Bestands-Transport kein Wort, der Wechselrichter wäre ausgelassen worden —
   gegen Soll-Regel 8. Seit IP-4 ist `solarman_v5` („Solarman-Datenlogger“) ein eigenes Wort (nie
   auf `modbus_tcp` abgebildet: anderer Rahmen, anderer Port, die Seriennummer gehört zum Weg):
   Adresse `host:port/seriennummer` (`DatenquelleAdresse`), Slave-ID als Geräte-ID, CHECK
   `data_source_protokoll_chk` in V20260911270000 geweitet, Fall `bestand-deye-ueber-datenlogger`.
   Eine Erreichbarkeitsprüfung von der Box gibt es für den Datenlogger noch nicht
   (`pruefung_nicht_moeglich`) — die Übernahme braucht keine, sie beschreibt, was die Box liest.
11. **Der Lesetakt einer übernommenen Quelle** ist nur bekannt, wo eine Komponente ihn nennt; sonst
   liest die Box nach der Vorgabe ihres Treibers, die die Cloud nicht kennt. `kadenz_s` ist dann
   NULL — wer ihn braucht (Lesebudget IP-10, „liefert Daten“ IP-14), behandelt „nicht erhoben“
   ausdrücklich.

## 12. Was dieser Vertrag nicht regelt

Das Lesebudget (E6, bestehende Zwillinge), die Laufzeit der Übergabe (E9, IP-6 ff.), die Form
der Blöcke `data_sources[]` (IP-13) und `supports[]` (IP-18), Tabellen und Grants (IP-2),
Endpunkte und Rechte `datenquelle.bearbeiten`/`datenquelle.zustaendigkeit` (IP-3, AP-03),
Ladepunkte an einer zweiten Box (§5.2, bis AP-15) und das Entfernen einer noch zuständigen Box
(IP-19).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='DatenquelleRegelnVectorsTest,BestandAnschlussTest')   # 127 + 11 Tests, rein
(cd frontend/portal && npx vitest run src/uemsDatenquelle.test.ts)       # 66 Tests
(cd services/api && ./mvnw test -Dtest='DatenquelleVorschlagApiTest')    # IP-4, Testcontainers
(cd services/api && ./mvnw test -Dtest='FuehrendeBoxAbleitungVectorsTest,LeadDeviceServiceTest,LeadDeviceBestandVerhaltensgleichTest')   # IP-5, rein
```
