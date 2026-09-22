# Anteils-Dokument und Quittung (MQTT, UEMS AP-15 IP-7)

Kundenwort: **Gemeinsame Steuerung** — „Verbund“ steht nur in Vertrags- und Code-Namen. Die Regeln (G2–G5, T4) und
die Prüfung auf der Box stehen in [`steuerungsverbund.md`](./steuerungsverbund.md); dieses Dokument legt den Draht
fest. Schema: [`mqtt-verbund-anteile.schema.json`](./mqtt-verbund-anteile.schema.json) (Dokument; `$defs/quittung`
für den Uplink). Vektoren: [`verbund-anteile-mqtt-vectors.json`](./verbund-anteile-mqtt-vectors.json).

## 1. Topics

| Richtung | Topic | Retained | QoS |
|---|---|---|---|
| Cloud → Box | `ems/{tenant}/{site}/{device}/v2/verbund-anteile` | ja (Y1: gespeichert, ohne Ablauf) | 1 |
| Box → Cloud | `ems/{tenant}/{site}/{device}/v2/verbund-anteile-result` | wie `plan-result` | 1 |

Beide liegen auf dem eigenen `v2`-Teilbaum der Box — keine ACL-Änderung. v1-Topics werden nicht berührt. **Eine Box
ohne Gemeinsame Steuerung bekommt nie ein Dokument und hat kein solches Topic** (I6): veröffentlicht wird nur für
einen Verbund ab Stufe S1 (LA2), und nur an seine Mitglieder.

Beim Auflösen nach S3 bleibt dasselbe Dokumentformat: mitsteuernde Boxen halten zuletzt ihren Geräte-Rückfall
(oder 0), die führende hält nach allen Bestätigungen `verteilbar` (Grenze minus Vorbehalt samt verbleibenden
Geräte-Rückfällen), **nicht die ganze Grenze**. Keine leere retained-Nachricht, kein Ablauf (V5). Siehe
[gemeinsames Auflösen](steuerungsverbund.md#auflösen-der-ganzen-gemeinsamen-steuerung-55-i4i5-g3g5-v5).

## 2. Das Dokument (Downlink)

```json
{
  "schema_version": "1.0",
  "tenant_id": "…", "site_id": "…", "device_id": "<die Box des Topics>",
  "epoche": 1, "revision": 8, "schritt": "uebergang", "rolle": "fuehrt",
  "verteilbar": { "einspeisung": 100.0, "bezug": 77.0 },
  "anteile": {
    "einspeisung": { "<E-1>": 10.0, "<E-4>": 60.0 },
    "bezug":       { "<E-1>": 0.0,  "<E-4>": 77.0 }
  },
  "reserve_verbraucher": { "bezug": 0.0 },
  "published_at": "2027-10-20T09:00:00Z"
}
```

- **Die GANZE Tabelle** beider Richtungen und `verteilbar` reisen mit (Y1) — jede Box prüft die Summe selbst.
  Kennungen der Boxen sind die `device.id`; kW mit einer Nachkommastelle (Zehntel-kW, G2).
- **`device_id` = die Box des Topics.** Weicht sie ab, ist das Dokument nicht ihres: verworfen, ohne Quittung.
  Weichen `tenant_id`/`site_id` vom Topic ab, lehnt die Box mit `fremde_anlage` ab (T4).
- **`schritt`**: `uebergang` = je Box das Kleinere aus alt und neu (G5), ein Zielstand folgt; `ziel` = der Zielstand
  (auch, wenn der Übergang schon der Zielstand ist — reines Verengen).
- **`rolle`** (wahlfrei, IP-17): `fuehrt` · `steuert_mit` — die Rolle der Box des Topics. Sie ist nicht Teil der
  Prüfung; die Box hält sie mit dem Anteil und spiegelt sie im Herzschlag (die Wächter aus IP-18 brauchen sie).
- **`reserve_verbraucher`** (wahlfrei, AP-15 Folge von IP-19, V3; `schema_version` bleibt 1.0): je Box ihr eigenes
  `bezug` = die Summe der Nennleistungen ihrer steuerbaren Bezugs-Geräte AUSSERHALB des Ladeparks (Schreibfreigabe ja;
  Schalter/Relais, SG-Ready, Wärmepumpen, Heizstäbe, Pumpen, eine Wallbox ohne Platz in `wallboxes[]`), aus
  `steuerungsverbund_geraet`, aufgerundet auf 0,1 kW (`SteuerungsverbundAbleitung.reserveVerbraucher`). Ladepunkte,
  Speicher, Geräte ohne Schreibfreigabe und das Ungeregelte hinter dem Abgang zählen nicht. **Kein Doppelzählen:** ein
  solches Gerät steckt nicht im Vorbehalt (der deckt, was keine Box steuert), sondern einmal im Anteil seiner Box — die
  Reserve teilt diesen einen Anteil auf der Box nur auf. Vektoren: Abschnitt `reserve_verbraucher`.
- **`ungeregelt_hinter_abgang`** (wahlfrei, AP-15 Folge von IP-19, B3; `schema_version` bleibt 1.0): je Box, die
  NICHT führt, ihr eigenes `bezug` = der erklärte Höchstwert des Ungeregelten hinter ihrem Abgangszähler — die
  Erklärung `ungeregelt` (Gerätezeile ohne Komponente) plus Geräte ohne Schreibfreigabe (I1), also genau das, was die
  Ableitung ohne Rückfall in ihren Anteil zählt —, aufgerundet auf 0,1 kW
  (`SteuerungsverbundAbleitung.ungeregeltHinterAbgang`). Es reist nur über 0; ohne es bleibt das Dokument Byte für
  Byte wie vorher. Die Box braucht es nur blind (siehe Bezugswächter). Vektoren: Abschnitt `ungeregelt_hinter_abgang`.
- **Epoche und Revision steigen nur.** Die Revision steigt je Dokument eines Verbunds; eine neue Epoche setzt nur das
  Scharfschalten. Das Dokument reist **nie im Plan**.

Die Box prüft in der Reihenfolge von `steuerungsverbund.md` §1 (`dokument_pruefen`): `fremde_anlage` ·
`box_fehlt_im_dokument` · `revision_aelter` · `summe_ueber_verteilbar`; dieselbe Revision noch einmal (gespeichert,
nach Wiederverbindung) ist angenommen. Die Box-Seite ist IP-17, siehe §2a.

## 2a. Die Box (IP-17, `edge-app/core/internal/anteile`, `agent/verbund_anteile.go`)

- **Prüfung** mit dem Go-Zwilling (`anteile.DokumentPruefen`, NW-1), gegen die Identität der Box aus dem Topic. Der
  verglichene Stand ist der gehaltene — nur, wenn er unter derselben Identität angenommen wurde.
- **Angenommen heißt auf der Platte** (Y2): atomar nach `verbund-anteile.json` im Datenverzeichnis (Temp-Datei,
  fsync, Umbenennen), beim Start im Konstruktor geladen — vor dem ersten Messwert (R15, A13). Lässt sich das Dokument
  nicht speichern, nimmt die Box es nicht an und quittiert nichts; das gespeicherte Dokument kommt beim nächsten
  Verbinden wieder.
- **Quittung** für JEDE Annahme und JEDE Ablehnung eines lesbaren Dokuments dieser Box, retained wie `plan-result`,
  ohne den MQTT-Rückruf zu blockieren; `wirksam` = der Stand, den die Box danach hält (bei einer Ablehnung der alte,
  fehlt, wenn sie noch keinen hat).
- **Ohne Quittung, Anteil bleibt:** ein unlesbares Dokument (JSON, Version, Pflichtfeld, negative kW — dafür hat die
  Quittung kein Wort), ein Dokument für eine andere Box, und die **leere retained Nachricht**. Der Vertrag kennt kein
  Löschen des Dokuments; ein verlorenes oder gelöschtes Dokument darf nie erweitern — die Box BEHÄLT ihren Anteil, auf
  der Platte und im Herzschlag, bis ein neueres Dokument ihn ablöst. Das Ausscheiden aus der Gemeinsamen Steuerung ist
  darum ein eigener, ausdrücklicher Weg in der Cloud (§4 Nr. 6): die Box bekommt als letztes Dokument den Übergang mit
  ihrem eigenen Anteil auf dem Rückfall ihrer Geräte bzw. 0 — ein gewöhnliches Dokument, das sie nennt (kein
  `box_fehlt_im_dokument`), das sie annimmt und quittiert — und danach keines mehr. Sie hält es, bis sie neu
  eingerichtet wird (V5); nichts wird gelöscht, kein neuer Box-Code.
- **Herzschlag** (Y3): der Block `gemeinsame_steuerung` trägt `rolle`, `anteile_epoche`, `anteile_revision` und
  `anteile_kw` (die WIRKSAMEN eigenen Anteile je Richtung) — [Plan-Quittung](./mqtt-plan-result.md#spiegel-im-herzschlag-y3).
- **Einspeisewächter (IP-18):** gilt ein Dokument, regelt der Wächter gegen den Anteil der Richtung `einspeisung`
  (`edge-app/core/internal/guards/exportanteil.go`). `fuehrt`: Regelkreis gegen die ganze Grenze des Plans, solange
  der eigene Netzpunkt-Wert frisch ist (≤ 30 s); danach ohne Halten in 60 s linear auf den Anteil. `steuert_mit` —
  und ein Dokument **ohne** `rolle` (sichere Seite) — hält den Anteil immer am eigenen Messpunkt (Abgangszähler,
  ohne ihn die Summe der eigenen Geräte), blind `Anteil − Entladung`; die ganze Grenze ist dort nie Eingang (G1).
  Der Anteil gilt für Erzeugung UND Entladung (V6): der Wächter senkt auch die Entladung — blind auf den Anteil,
  mit frischer Messung erst, wenn die Erzeuger auf 0 stehen —, lädt nie und hebt nie an. Den Spielraum EINER
  frischen Messung vergibt er nur einmal: nach einem Zustand, in dem beide gesenkt waren (blind, Prüf-Verstellung),
  bekommt erst die Entladung ihren Anstieg, die Erzeuger den Rest (IP-18-Befund aus IP-27). Umgekehrt senkt ein
  Anstieg der Entladung — der Plan kehrt zurück, der Speicher wechselt von Laden auf Entladen — die Erzeuger im
  selben Takt um diesen Anstieg, was darüber hinausgeht die Entladung — ab der ersten Auswertung (vorher Schub 0)
  und blind auch auf der 60-s-Rampe gegen den Schub, mit dem sie begann; nach einem Uhrensprung rückwärts belegt eine
  Ladung keinen Spielraum, bis eine Messung nach dem Sprung-Zeitpunkt vorliegt (A8r). Er steht hinter der
  Arbitration (V1) und gilt in Ruhe, Pause und ohne Plan (V5); zusätzlich läuft die Box ohne Anteil als Schatten mit,
  das Ergebnis ist nie weiter als ohne Dokument. `sicherheitskappe` im Herzschlag heißt dann „= eigener Anteil“.
  Ohne Dokument verhält sich die Box Byte für Byte wie vor IP-17.
- **Anteils-Verlust (IP-22, E1 = A, R2):** gilt ein Dokument, zählt die Box je Tag der Anlage (Europe/Berlin), was
  der Einspeise-Anteil zurückhält (`edge-app/core/internal/guards/anteilverlust.go`): solange die Kappe mit Anteil
  unter der des Schattens ohne Anteil liegt UND die Erzeuger an ihr stehen, die Rate
  `min(Kappe ohne Anteil, verfügbare Erzeugung) − Kappe mit Anteil`. Die führende Box mit frischer Messung regelt
  gegen die ganze Grenze — ihr Abregeln ist nie Anteils-Verlust. **Belastbarkeit:** die verfügbare Erzeugung einer
  abgeregelten PV misst niemand (kein Register, keine Prognose auf der Box); die Box nimmt den höchsten GEMESSENEN
  PV-Wert der letzten 15 min — `kwh` ist eine Untergrenze, bei einem festen Anteil unter steigender Sonne nahe 0;
  `gebunden_s` (wie lange der Anteil die Erzeuger hielt) ist exakt. Ohne PV-Messung wird nichts gezählt. Die
  SCHÄTZUNG rechnet die Cloud daneben (`uems/AnteilVerlustSchaetzung`, `schaetzung_kwh` · `schaetzung_grundlage`):
  PV-Prognose der Anlage × kWp-Teil der Box − gemessene PV der Box, die Summe `gebunden_s` in die Viertelstunden mit
  der höchsten verfügbaren Erzeugung gelegt (Näherung, die Box meldet keine Zeitfenster); der Vertrag der Box ändert
  sich dadurch nicht. Der Tag
  liegt atomar auf der Platte (`anteil-verlust.json`, höchstens minütlich geschrieben), ein Neustart zählt weiter;
  Übertragung im Herzschlag `anteil_verlust` mit laufendem Tag und abgeschlossenem Vortag
  ([Plan-Quittung](./mqtt-plan-result.md#spiegel-im-herzschlag-y3)); die Cloud schreibt je Box und Tag das Größere
  (`steuerungsverbund_anteil_verlust`) und nennt es je Mitglied im `GET …/gemeinsame-steuerung` (heute, Monat).
- **Bezugswächter (IP-19, V3):** gilt ein Dokument, hält die Box den Anteil der Richtung `bezug` über alles, was sie
  auf der Bezugsseite steuert. **Ladebudget** (Ladepark-Rahmen: OCPP-Säulen und `wallboxes[]`,
  `edge-app/core/internal/lastmgmt/bezuganteil.go`): `steuert_mit` — und ein Dokument **ohne** `rolle` — hält den
  Anteil **am eigenen Messpunkt** (AP-15 Folge, Konzept §3.2 Schicht 2, §3.3, B3: der Anteil ist ALLES hinter dem
  Abgang, auch Gebäudelast und Geräte ohne Freigabe). Frisch (Abgangswert ≤ 30 s, nicht eingefroren, kein
  Uhrensprung) der Regelkreis von heute mit `planbar = Anteil`: Ladebudget = `min(Anteil, Anteil − (Abgang − gemessenes
  Laden))`, nie unter 0 — R3 mit 50 kW Gebäudelast hinter dem Abgang von Box Verwaltung: 27 statt 77 kW; mit einem
  Zähler wie DQ-10 (dahinter NUR, was die Box steuert) bleibt es 77. Eine stehende Zahl verlangt auch hier die eine
  Prüf-Verstellung (IP-27 A7), solange der Ladepark über dem Blind-Wert zieht. Blind (kein Abgangswert, älter als
  30 s, eingefroren, Uhrensprung, vor dem ersten Messwert, nach einem Neustart, oder eine Box ohne eigenen Zähler):
  `max(0, Anteil − reserve_verbraucher − ungeregelt_hinter_abgang)`, sofort — nur innerhalb von 60 s nie über dem
  zuletzt frisch gerechneten Wert. **Die Reserve zählt nie doppelt:** mit frischem Abgang stecken die anderen
  steuerbaren Verbraucher im gemessenen Rest; die Reserve gilt nur blind und ohne eigenen Zähler (dort ist die
  Gerätesumme wie bei IP-18 der Messpunkt: der Speicher lädt nur aus eigener PV, die anderen Verbraucher sind die
  Reserve). Ohne `ungeregelt_hinter_abgang` gilt blind `Anteil − Reserve` wie vorher. Was unerreichbare Säulen ziehen
  dürfen, geht vom Anteil ab (frisch steckt es zugleich im gemessenen Rest — die sichere Seite). `fuehrt`: der Regelkreis von heute gegen die ganze Anschlussgrenze, solange der
  Netzpunkt-Wert frisch ist (≤ 30 s); danach ohne Halten in 60 s linear auf den Anteil, wobei ein befehlsseitiger Batterieanstieg gegenüber dem
  Schub der letzten Netzpunkt-Messung bei Rampenbeginn das Ladebudget im selben Takt zusätzlich senkt (nie unter 0); vor dem ersten Messwert der
  Anteil. **Netzladen des Speichers** (`guards/bezuganteil.go`, hinter der Arbitration und vor der Abregelungs-Nachführung):
  nur `fuehrt` mit frischem Netzpunkt UND gepflegter Anschlussgrenze lädt aus dem Netz — Deckel
  `planbar − (Netz − gemessene Ladung + zugeteilte, noch nicht gezogene Ladeleistung)`, der Ladepark geht vor; sonst
  (blind, ohne Grenze, `steuert_mit`, ohne `rolle`) lädt der Speicher höchstens die eigene gemessene PV („nicht aus
  dem Netz“, ohne PV-Wert 0). **PV zählt einmal (AP-15 Folge):** läuft ein Ladepark, nimmt der Speicher auch aus PV
  nie, was der Ladepark-Regelkreis am Zähler schon als Spielraum gezählt hat — `steuert_mit` und ohne `rolle` mit
  frischem eigenem Zähler `min(PV, Anteil − (Abgang − gemessene Ladung + zugeteilte, noch nicht gezogene
  Ladeleistung))`, blind mit bekannter Messung (beide Rollen) derselbe Regelkreis auf der letzten Messung mit der
  aktuellen Zuteilung, vor dem ersten Messwert die PV; nie über der PV, nie unter 0. Beide Teile senken nur, entladen nie, heben nie an; das Ladebudget ist das Minimum mit der
  Box ohne Anteil (V5), „Jetzt voll laden“ verteilt innerhalb des Anteils (R13). Stufe im Herzschlag:
  `waechter.bezug` (die strengere beider Teile). **Der Anteil gilt für ALLES (Folge von IP-19):** trägt das Dokument
  `reserve_verbraucher.bezug`, rechnet das Ladebudget überall, wo der Anteil bindet und die Box die Verbraucher nicht
  misst (`steuert_mit` und ohne `rolle` blind, die führende Box blind, vor dem ersten Messwert, nach einem
  Uhrensprung), mit `max(0, Anteil − Reserve)` — R3 mit einer 10-kW-Wärmepumpe an Box Verwaltung: 67 statt 77 kW,
  473 + 67 + 10 = 550; frisch misst DQ-10 die laufende Wärmepumpe (77 − 10 = 67). Die führende Box mit frischem Netzpunkt
  misst die Verbraucher am Netzzähler; dort (und in ihrer Prüf-Verstellung) ändert die Reserve nichts. Der
  Netzladen-Deckel rechnet nicht vom Anteil und bleibt. Fehlt das Feld: keine Reserve, wie vorher; der Herzschlag
  spiegelt sie nur, wenn sie gilt (`reserve_verbraucher_kw`), das Betreiber-Blatt zeigt sie unter „Wirksam Bezug“.
- **Eingefroren gilt als blind (IP-20, B2):** ein Zähler kann weiter Werte mit frischem Zeitstempel liefern, aber
  immer dieselbe Zahl. Gilt ein Dokument, hört EINE Probe (`edge-app/core/internal/guards/eingefroren.go`,
  `Einfrierprobe`) den eigenen Messpunkt und die eigenen WIRKSAMEN Verstellungen der Box (PV-Kappe unter der
  gemessenen Erzeugung, Speicher vom gemessenen Wert Richtung 0, Ladepunkt-Zuteilung unter dem gemessenen Bezug —
  vorzeichenrichtig summiert; Anheben zählt nie, Regelung aus zählt nie). Steht die Summe mindestens 2 kW von ihrem
  Stand beim letzten Wertwechsel entfernt und bleibt der Wert danach 60 s exakt gleich (beides Startwerte), gilt er
  als eingefroren — mit dem Alter ab seinem letzten Wechsel, also genau wie ein Wert, der nicht mehr kommt: beide
  Wächter oben gehen in dieselben Blind-Stufen, das Netzladen fällt auf „nicht aus dem Netz“. Das Urteil hält, bis
  sich der Wert wieder ändert; dann gibt der Regelkreis gebremst frei wie nach jedem Blind-Zustand. Eine ruhende
  Anlage (nichts verstellt) ist mit gleichbleibendem Wert gesund. Ohne Dokument wird die Probe weder gefüttert noch
  gefragt.
- **Prüf-Verstellung (IP-27 Befund A7, erweitert B2):** steht der eigene Wert 30 s bitgleich still (gemessen an den
  Zeitstempeln der Werte), WÄHREND die Box über ihrem Anteil läuft (Erzeugung + Entladung bzw. Ladepark-Bezug bzw.
  Netzladen des Speichers, gemessen — dieselbe Größe, auf die sie blind zurückfällt), senkt der Wächter der Richtung
  des stehenden Werts EINMAL je Stillstand um 2,1 kW (2 kW + Schreibauflösung) und hält das; die Probe urteilt nach
  einer solchen gezielten Verstellung schon nach 20 s (Startwerte, NW-7). Bewegt sich der Wert: gesund, gebremste
  Freigabe; bleibt er: eingefroren = blind. Unter dem Anteil, ohne wirksam Senkbares oder zum zweiten Mal im selben
  Stillstand: keine Prüf-Verstellung.
- **Ein stehender Wert belegt keinen Spielraum (Folge von IP-28 Befund 1):** wiederholt eine Messung den Wert der
  vorigen bitgleich, ist sie keine neue Messung des eigenen Punkts — nur PV, Speicher und Ladepunkte darin sind neu.
  Darauf schiebt die Box höchstens, was die Messung belegt, auf der sich der Wert zuletzt bewegt hat:
  Einspeisewächter Erzeugung + Entladung wie damals plus deren Spielraum (Erzeuger zuerst gekappt), Ladebudget
  (Zwilling) und Netzlade-Deckel lesen Ladepunkte und Speicherladung jener Messung, nie mehr als jetzt. Sonst las
  ein Zähler, der in der Delle einer Prüf-Verstellung einfror, jede Freigabe erneut als Spielraum (Container: K-1
  8,0 → 10,1 → 12,2 kW). Keine Sperre der neuesten Messung: die Box misst alle 2 s und regelt alle 10 s, der Spielraum
  der bewegten Messung wird weiter gebremst ausgegeben. Ein Wert, der sich mit jeder Messung bewegt, regelt wie heute.
- **Dauer statt Uhrzeit (IP-27 Befund A8):** ein Wert mit älterem Zeitstempel als der letzte ist ein Uhrensprung —
  Einspeisewächter, Ladebudget (über einen Zwilling, der Tracker von heute bleibt unberührt) und Probe verankern neu
  statt zu verwerfen; ein Alter unter 0 ist blind (Anteil), nie „frisch“. Nur mit Dokument; der Weg der Einzelbox von
  heute hat dieselbe Lücke weiter (Befund `befundEinzelboxUhrZurueck`, Entscheidung des Betreibers).

## 3. Die Quittung (Uplink)

```json
{
  "schema_version": "1.0",
  "tenant_id": "…", "site_id": "…", "device_id": "<die Box des Topics>",
  "epoche": 1, "revision": 8,
  "urteil": "abgelehnt", "grund": "revision_aelter",
  "wirksam": { "epoche": 1, "revision": 9 },
  "ts": "2027-10-20T09:00:05Z"
}
```

- `epoche`/`revision` nennen das beurteilte Dokument; `urteil` ∈ `angenommen` · `abgelehnt`.
- `grund` nur bei `abgelehnt`, geschlossen: die vier Wörter aus `dokument_ablehnung` (IP-2). Ein anderes Wort, ein
  fehlender Grund bei `abgelehnt` oder ein Grund bei `angenommen` → die Cloud verwirft die Quittung.
- `wirksam` (wahlfrei): der Stand, den die Box danach hält.
- Topic- und Payload-Identität wie `plan-result`: `tenant_id`/`site_id`/`device_id` = Topic, sonst verworfen; die Box
  muss aktives Mitglied des Verbunds dieser Anlage sein.

## 4. Der Ablauf in der Cloud (`uems/SteuerungsverbundAnteilDienst`)

1. **Scharfschalten der Anteile** (`anteileScharfschalten`, ab S1): Auslegung muss in BEIDEN Richtungen `passt` sein
   (E2 = A), sonst nichts. Neue Epoche; „alt“ = was die Boxen wirksam halten: vor dem ersten Dokument die führende Box
   mit der ganzen Grenze und jede andere mit ihrem Rückfall (§5.3, W11), danach je Box das Größere aus quittiertem und
   gesendetem Dokument, sobald der Herzschlag sie meldet dessen Werte (Y3, IP-17).
2. **Übergang an ALLE Mitglieder**; der Zielstand wartet in der Dokument-Zeile.
3. **Zielstand erst nach der Quittung JEDER verengten Box** (Übergang < alt in irgendeiner Richtung). Fehlt eine, bleibt
   der Übergang — ohne Zeitablauf (R12: bleibt 10/60).
4. **Ändern** (`anteileAendern`) in derselben Epoche; nicht, solange ein Übergang wartet.
5. **Rückspielen (A18)**: meldet eine Box einen Stand über allem, was die Cloud je gemacht hat, oder lehnt sie mit
   `revision_aelter` ab, ist die Cloud-Datenbank zurückgespielt. Dann ändert die Cloud nichts mehr, bis neu
   scharfgeschaltet wird — und das nur mit den WIRKSAMEN Anteilen aller Mitglieder aus dem Herzschlag
   (`uems/WirksameAnteileAusHerzschlag`, IP-17: der jüngste Block je Box, im Prozess). Fehlt er für ein Mitglied —
   alte Box, noch kein Dokument, API frisch gestartet —, antwortet der Dienst `WIRKSAME_ANTEILE_UNBEKANNT`.
6. **Ausscheiden** (§5.5, `ausscheidenBeginnen`/`ausscheidenPruefen`, [Verbund-Vertrag §5](./steuerungsverbund.md#5-das-verbund-objekt-ip-4)):
   Übergang (`anlass = 'ausscheiden'`) an alle — die ausscheidende Box auf den Rückfall ihrer Geräte, die anderen
   unverändert; das Ziel der verbleibenden Boxen erst nach IHRER Quittung (oder der Bestätigung des Betreibers, dass
   ihre Geräte vom Netz sind) und nur an sie. Ohne Quittung bleibt der Übergang (R12).

Gespeichert wird in `V20260921190000`: `steuerungsverbund_anteile` (jedes Dokument, nur anhängen),
`steuerungsverbund_geraet` (Geräte je Box: Nennleistung, Schreibfreigabe — ohne sie zählt ein Gerät als ungeregelt mit
Nennleistung, I1; Ungeregeltes hinter dem Abgang ohne Komponente) und am Verbund der Vorbehalt je Richtung mit
wer/wann (IP-13 füllt ihn später aus Messwerten) sowie die Marke „Rückspielen erkannt“.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='VerbundAnteileVectorsTest,SteuerungsverbundZweischrittTest')
(cd services/api && ./mvnw test -Dtest=SteuerungsverbundAnteilDienstTest)   # Testcontainers
```
