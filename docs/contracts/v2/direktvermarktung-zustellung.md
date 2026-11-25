# Direktvermarktung: Zustellung zwischen Cloud und Box (…/v2/direktvermarktung*)

Die Zustellung des Direktvermarktungs-Anschlusses (Konzept `vp-direktvermarktung-konzept` d2, §5.7 „Zustellung", Entscheidungen E1-E6 = A): das Partnerprofil von der Cloud zur führenden Box, der Zugang (Schlüsselmaterial) auf Anfrage der Box, die Quittungen der Box und der Herzschlag-Block `direktvermarktung` zurück.
Vektoren: [`direktvermarktung-zustellung-vectors.json`](direktvermarktung-zustellung-vectors.json).
Partnerprofile selbst: [`catalog/direktvermarkter`](../../../catalog/direktvermarkter/README.md); die Box-seitige Schnittstelle: `edge-app/core/internal/direktvermarkter`.

**Leser und Prüfer:** Go `edge-app/core/internal/direktvermarkter/zustellung.go` (Parse + `Profile.Pruefe`, Tests `zustellung_test.go`, `anschluss_test.go`), Java `services/api` Paket `direktvermarktung` (`DirektvermarktungZustellung`, `DirektvermarktungStandListener`, `DirektvermarktungQuittungListener`, `DirektvermarktungAnfrageListener`), Tabelle `direktvermarktung_stand` (nur Anzeige, nie Soll-Stand - AGENTS.md-Regel der Fernwartung gilt hier genauso).

## 1. Topics

| Richtung | Topic | retained | QoS |
|---|---|---|---|
| Cloud → führende Box | `ems/{tenant}/{site}/{device}/v2/direktvermarktung` (Partnerprofil) | **ja** (Muster `v2/price`): eine offline gewesene Box holt den Stand beim Verbindungsaufbau selbst ab; **leer = Rückzug** | 1 |
| Box → Cloud | `…/v2/direktvermarktung-anfrage` (Zugang erbitten, nur ein Fingerabdruck) | nein | 1 |
| Cloud → Box | `…/v2/direktvermarktung-zugang` (Einmal-Antwort: Schlüsselmaterial) | **nein**: Schlüsselmaterial liegt nie beim Broker; eine Box, die die Antwort verpasst, fragt schlicht erneut | 1 |
| Box → Cloud | `…/v2/direktvermarktung-quittung` (`zugestellt` / `geloescht`) | nein | 1 |

Topic- und Payload-Identität (`tenant_id`, `site_id`, `device_id`) müssen übereinstimmen, in beiden Richtungen; sonst wird die Nachricht still verworfen.
Alle Topics liegen im `v2/#`-Teilbaum der per-Gerät-ACL - mit zwei ausdrücklichen Ausnahmen: die Box darf auf ihr eigenes `v2/direktvermarktung` und `v2/direktvermarktung-zugang` **nicht publizieren** (deny vor dem `v2/#`-Allow, Muster `v2/measurement-config`), damit sie ihr eigenes retained Profil nicht fälschen kann. `AclGrantWriter` und `tools/pki/voltpilot-ca.sh` bleiben byte-gleich.

## 2. Das Partnerprofil (Cloud → Box, retained)

```json
{
  "schema_version": "1.0",
  "tenant_id": "…", "site_id": "…", "device_id": "…",
  "generated_at": "2026-11-25T12:00:00Z",
  "partner": "luox",
  "revision": 3,
  "zugang_fingerabdruck": "SHA256:…",
  "profil": { "id": "luox", "modbus": {…}, "register": […], "regeln": {…} }
}
```

- `profil` ist die VOLLSTÄNDIGE gepackte Laufzeit-Sicht des Partners - dieselbe Form, die `catalog/direktvermarkter/tools/package_edge_runtime.py` in `edge-app/core/internal/direktvermarkter/profiles.json` erzeugt, AUFGELÖST (Wortfolge und `bei_veraltet` nie `offen (Fxx)`). Die Cloud liest sie aus genau diesem generierten Derivat (Maven-Ressource) und bettet den Partner-Teilbaum unverändert ein: EINE Quelle, nie zwei driftende Auflösungen. Ein neuer Partner braucht so keine neue Firmware (E6 = A, Stufe 7).
- Die Box prüft streng (`Profile.Pruefe`): nur Funktionen 3/4/6/16, bekannte Typen, keine überlappenden Register, Band nur an Halteregistern, das Register `vermarkter_vorgabe_pct` muss da sein, `offen (…)`-Werte sind abgelehnt. Ein Dokument, das die Box nicht sicher bedienen kann, wird GANZ verworfen - nie halb übernommen.
- `revision` zählt je Anlage aufwärts (jede Neuzustellung erhöht); `zugang_fingerabdruck` nennt den Zugang, den die Box halten soll.
- Die Box persistiert das Dokument (Muster `v2/control-certification`): eine offline startende Box behält den Anschluss, den sie rechtmäßig hatte. Wiederzustellung desselben Dokuments (jeder Reconnect) ist idempotent und setzt NIE den laufenden Watchdog-Zustand zurück.
- **Leeres Payload = Rückzug** (Beenden, Admin „sperren", Lösen der Box, Box-Tausch): die Box stoppt die Schnittstelle, löscht Zugang UND Profil von der Platte und quittiert `geloescht`. Schlägt das Löschen fehl, quittiert sie NICHT - das retained Leer-Payload liefert der Broker beim nächsten Reconnect erneut.

## 3. Der Zugang (Anfrage → Einmal-Antwort → Quittung)

Anfrage der Box (sie nennt den Fingerabdruck aus dem Profil, den sie **noch nicht hat** - nie Material):

```json
{ "schema_version": "1.0", "tenant_id": "…", "site_id": "…", "device_id": "…",
  "zugang_fingerabdruck": "SHA256:…", "angefragt_am": "…" }
```

Antwort der Cloud (entschlüsselt aus `direktvermarktung_zugang`, einmal, über dieselbe mTLS-MQTT-Verbindung):

```json
{ "schema_version": "1.0", "tenant_id": "…", "site_id": "…", "device_id": "…",
  "partner": "luox", "zugang_fingerabdruck": "SHA256:…", "gueltig_bis": "…",
  "gegenstelle": { "host": "…", "port": 1194, "protokoll": "udp" },
  "dateien": { "zertifikat_pem": "…", "schluessel_pem": "…", "ca_pem": "…", "tls_schluessel_pem": "…" } }
```

- Die Cloud antwortet NUR der führenden Box der Anlage, NUR für den Fingerabdruck des aktiven, nicht zurückgezogenen Zugangs, und protokolliert die Zustellung append-only. Kein Byte des Materials erscheint je in einem Log, einem Protokolleintrag oder einer Fehlermeldung - loggbar ist allein der Fingerabdruck.
- Die Box nimmt die Antwort nur an, wenn ihr aktives Profil GENAU diesen Fingerabdruck nennt, legt sie ab (Mango `/etc/vp-edge-light/vermarkter/`, nur root, 0600; PFC200 `/home/voltpilot/vermarkter/`, 0600 - die root-Kopie fürs Firmware-OpenVPN macht Stufe 4 über den root-Helfer `vp-vermarkter`; Docker-Box unter ihrem Datenverzeichnis) und quittiert `zugestellt`. Meta-Datei zuletzt schreiben, zuerst löschen: ein halber Stand liest sich immer als „kein Zugang".
- Fragt die Box und bekommt keine Antwort (Cloud war gerade nicht da), fragt sie frühestens nach 10 Minuten erneut; jeder Reconnect fragt über die retained Wiederzustellung ohnehin neu.

Quittung der Box:

```json
{ "schema_version": "1.0", "tenant_id": "…", "site_id": "…", "device_id": "…",
  "zugang_fingerabdruck": "SHA256:…", "ereignis": "zugestellt", "am": "…" }
```

`ereignis` ist `zugestellt` (Zugang liegt auf der Box; setzt `zugestellt_am`) oder `geloescht` (Zugang ist von der Box runter; setzt `zurueckgezogen_am` beim Rückzug). Quittungen sind idempotent - QoS 1 darf doppelt zustellen, eine wiederholte Quittung ändert nur nichts mehr.

## 4. Box-Tausch und Wechsel der führenden Box (PS-D22)

Erst löscht die alte Box, dann bekommt die neue: die Cloud zieht das Profil bei der alten Box zurück (leeres retained Payload) und stellt an die neue führende Box erst zu, **nachdem** die `geloescht`-Quittung der alten Box da ist - luox sieht nie zwei Tunnel mit demselben Zertifikat.
Ist die alte Box endgültig weg (gelöscht, nie wieder online), gibt der Admin den Zugang über „Zugang neu senden" frei; eine automatische Frist ersetzt die Quittung bewusst nicht.
Nennt das Profil einer Box einen NEUEN Fingerabdruck (Zugang ersetzt), löscht die Box ihren alten Zugang selbst, quittiert `geloescht` für den alten und fragt nach dem neuen.

## 5. Der Herzschlag-Block `direktvermarktung` (Box → Cloud)

Ein additiver Block im Status-Herzschlag (`ems/{t}/{s}/{d}/status`), nur solange ein Profil zugestellt ist; fehlender Block heißt „Stand unbekannt", nie Ruhewert (§5.1 „Unbekannt ist keine Null").

```json
"direktvermarktung": {
  "partner": "luox", "lage": "verbunden", "revision": 3,
  "zugang_fingerabdruck": "SHA256:…",
  "vorgabe_pct": 30, "grenze_kw": 3.0,
  "lebenszeichen_am": "…", "letzte_abfrage_am": "…", "letzte_schreibung_am": "…",
  "abfragen_je_minute": 1.0,
  "tunnel": { "oben_seit": "…", "handshake_am": "…", "gegenstelle": "…" },
  "werte": { "einspeisung_w": 1200, "erzeugung_w": 3000, "netzbetreiber_pct": 100, "referenz_w": 10000 }
}
```

- `lage` ist das Vokabular aus Konzept §5.4: `ohne_profil` (dann fehlt der Block ohnehin), `ohne_zugang`, `zugang_ungueltig`, `baut_auf`, `tunnel_oben`, `verbunden`, `vorgabe_aktiv`, `abgelaufen`, `tunnel_unten`. Bis der Tunnel-Verwalter (Stufe 2 Mango / Stufe 4 PFC200) sich anmeldet, bleibt ein Anschluss mit Profil und Zugang ehrlich in `baut_auf` und der `tunnel`-Teil fehlt.
- `vorgabe_pct` ist die WIRKSAME Vorgabe (vom Lebenszeichen begrenzt); `grenze_kw` nur, wenn Vorgabe aktiv UND die Referenz frisch bekannt ist. `werte` nur, wenn der Eingabe-Cache frisch ist (dieselbe 30-s-Grenze, unter der die Schnittstelle liest) - veraltete Werte meldet die Box dem Partner als Ausnahme und der Cloud gar nicht.
- Die Cloud (ein eigener Listener je Block, Muster `koppel`) spiegelt den Block in `direktvermarktung_stand` (eine Zeile je Anlage, nur Anzeige) und setzt den groben `zustand` des Anschlusses nach: `baut_auf → verbindet`, `tunnel_oben → wartet_auf_partner`, `verbunden/vorgabe_aktiv/abgelaufen → verbunden`, `tunnel_unten/zugang_ungueltig → gestoert`; `ohne_zugang` lässt ihn stehen. Die feinere Lage leitet das Portal selbst ab.
- Nachweis auf der Box (§5.4): die Ereignisliste im Flash neben dem Zugang (`profil_erhalten`, `profil_zurueckgezogen`, `zugang_gespeichert`, `zugang_geloescht`, `partner_liest`, `vorgabe_geschrieben pct=…`, `lebenszeichen_abgelaufen`; nur bei einem Ereignis, höchstens 250 Zeilen, nie ein Schlüssel - `internal/ereignisliste`, Zwilling der Fernwartungs-Liste).
- Nachweis als Messreihe (§5.4): die vier Messpunkte `dv.vorgabe_pct`, `dv.grenze_kw`, `dv.verbunden`, `dv.lebenszeichen_alter_s`. Der Zustell-Abgleich legt sie in den Messplan der Zustell-Box (`MeasurementSelectionService.direktvermarktungsPunkte`: Box-Zeilen ohne Komponente und ohne Katalogeintrag - synthetische Punkte des Kerns, kein Geräte-Lesezugriff) und nimmt sie mit der `geloescht`-Quittung wieder heraus. Auf der Box bedient sie ein eigener Leser aus dem Anschluss-Stand (`agent/direktvermarktung_messpunkte.go`, Zwilling `dvMesspunktVorlagen`; `measurements.KernEigeneVorlagen` hält die Messwerte-Bibliothek von diesen Schlüsseln fern), über denselben Messwerte-Weg wie jeder andere Punkt. Ein Wert, den der Anschluss gerade nicht weiß (keine aktive Vorgabe, Referenz veraltet, nie ein Lebenszeichen), fehlt im Batch - nie eine erfundene Null.

## 6. Alarme (Cloud, Werte-Katalog, Leserart `direktvermarktung`)

Aus `direktvermarktung_stand` und `direktvermarktung_zugang`, Fristen aus Konzept §5.7: `direktvermarktung.verbindung_weg` (15 Min.), `direktvermarktung.partner_liest_nicht` (60 Min.), `direktvermarktung.anlage_folgt_nicht` (5 Min.), `direktvermarktung.zugang_laeuft_ab` (30 Tage) und `direktvermarktung.zugang_laeuft_gleich_ab` (7 Tage - eine zweite Wertart, weil ein aktiver Alarm keine zweite Meldung schickt). „Unbekannt hält": ein aktiver Alarm bleibt bei unbekanntem Stand aktiv und entwarnt nie aus einer Lücke.

## 7. Sicherheit (Konzept §8)

- Zustellung nur über die bestehende mTLS-MQTT-Verbindung der Box; der Partner selbst erreicht nur den einen Modbus-Port am Tunnel (Stufe 2/4), nie die Cloud-Zustellung.
- Die Anfrage trägt einen Fingerabdruck, nie Material; die Einmal-Antwort geht nicht retained und nur an die führende Box; die Box kann ihr eigenes Profil-Topic nicht beschreiben (ACL-Deny).
- Passwort der ZIP: bleibt in der Übernahme (eigener Auftrag), erreicht diese Zustellung nie. Kein Schlüssel, kein Passwort, kein PEM-Inhalt in Logs, Protokollen, Quittungen oder der Ereignisliste; die Ereignisliste maskiert SSH- und PEM-Muster zusätzlich als letzte Sicherung.
- Fähigkeitswort `direktvermarktung` (edge-supports): die Cloud stellt nur an eine Box zu, die das Wort meldet (Edge Light und Edge Industrie; die Docker-Box meldet es nie).

## 8. Koexistenz

Additiv; v1 bleibt unberührt, kein bestehendes Topic ändert sich. Schema-Fassung „1.0"; neue wahlfreie Felder brechen keine alten Leser (beide Seiten überlesen Unbekanntes beim Lesen und prüfen streng beim Senden).
