# Steuerlogik: Rückmeldung des Mitlaufs im Herzschlag (Vertrag)

Eine ausgelieferte [Steuerlogik](steuerlogik.md) läuft auf der Box mit, ohne zu schalten (Stufe 2, zweiter Teil).
Was sie tut, meldet die Box im Herzschlag `ems/{tenant_id}/{site_id}/{device_id}/status` im Block `logik`: welche Logik in welcher Fassung mitläuft, ihr Zustand und das Vergleichsprotokoll „würde schalten“ gegen „ist geschaltet“ (Bericht des Konzepts, Abschnitt 3.2 und 8.4).
Schreiber: `edge-app/core/internal/logiklauf` (über `agent/steuerlogik.go`), beide Box-Arten, Fähigkeit `steuerlogik_mitlauf` ([supports](edge-supports.md)).
Leser: die API (`services/api/.../steuerlogik/SteuerlogikRueckmeldung`, eigener Eingang `SteuerlogikRueckmeldungListener`), sichtbar vorerst nur für die Plattform.

Additiv: Ohne mitlaufende Logik fehlt der Block, der Herzschlag bleibt Byte für Byte, was er war.
Beispiel: [steuerlogik-rueckmeldung.valid.waermepumpe.json](examples/steuerlogik-rueckmeldung.valid.waermepumpe.json) (gepinnt von `logiklauf_test.go`), Vektoren der Annahme: [steuerlogik-rueckmeldung-vectors.json](steuerlogik-rueckmeldung-vectors.json).

## Form

`logik.laeufe[]`, höchstens 8 (die Box lässt nicht mehr mitlaufen):

| Feld | Bedeutung |
|---|---|
| `flow_id`, `flow_version`, `content_hash` | die Logik, wie sie im Satz auf `v2/flows` kam (dieselbe Identität wie `flows.applied`) |
| `name` | Name der Logik |
| `zustand` | `mitlaufend`: rechnet, schaltet nicht (geschlossenes Vokabular; ein anderes Wort verwirft den Lauf) |
| `seit` | seit wann diese Fassung auf der Box mitläuft (RFC 3339); zugleich der Lauf, zu dem das Protokoll gehört |
| `tag` | der Tag der Anlage (`YYYY-MM-DD`, Zeitzone aus dem Bündel), zu dem die Zähler gehören |
| `lage` | `nr`, `titel`, `art` (`solar`, `grid`, `waiting`, `idle`, `fault`), `satz`: die zutreffende Lage-Zeile der Logik |
| `zustaende` | was sich die Logik merkt, in Kurzform: `on`/`off`, Zahl eines Zählers, Restzeit eines Zeitgebers |
| `unbekannt` | Eingänge ohne frischen Wert (die ehrliche Lücke der Anlage, nie ein erfundener Wert) |
| `fehler` | Ausdrücke, die sich heute nicht rechnen ließen |
| `geraete.{kennung}` | je Gerät der Vergleich, siehe unten |
| `wechsel[]` | die jüngsten Wechsel, höchstens 16, älteste zuerst |

Je Gerät: `entity_id`, `name` (wie in der Logik); `wunsch` (was der Kern jetzt schalten würde) und `ist` (der beobachtete Schaltstand), beide als Stand `{stufe, ein, sollwert, betriebsart, anteil}` mit nur den Feldern, die die Ausgangsart hat; fehlt `ist`, ist der Stand unbekannt, nie „aus“.
Dazu die Zähler des Tages: `verglichen_s` (Sekunden, in denen beide Seiten bekannt waren), `abweichend_s` (davon verschieden), `laengste_abweichung_s`, `wunsch_wechsel`, `ist_wechsel`.
Eine Stufe gegen Ein/Aus vergleicht „0 heißt aus“; Sollwert (gleich innerhalb 0,05 K) und Betriebsart vergleicht die Box, wo das Gerät sie zurückliest ([Modbus-Gerät](modbus-geraet.md)), und ein Gerät mit mehreren Ausgängen weicht ab, sobald einer abweicht; der Anteil hat keinen beobachteten Stand.

Eine Zeile des Protokolls: `nr` (zählt je Lauf ab 1, eine Lücke ist sichtbar), `t`, `geraet`, `was` (`wunsch` oder `ist`), `neu` (der neue Stand dieser Seite), `andere` (die andere Seite in derselben Sekunde), `lage` (Titel der Lage in dieser Sekunde).
Der Anfangsstand eines Laufs ist kein Wechsel; gezählt werden Änderungen danach, auch zu und von unbekannt.

## Wie die Box beobachtet

- Eingänge: Netz (`site.grid`), PV (`site.pv`), Speicherleistung (`battery.power`, + laden) und Ladestand (`battery.soc`) aus derselben gesicherten Hausbilanz, die jeder Schutz der Box liest, je mit eigenem Alter; `<gerät>.temperature` aus den Fühler-Proben der Stufe 1, wenn das Gerät genau eine Temperatur meldet (mehrere sind mehrdeutig und bleiben unbekannt); `sun.elevation` aus der Lage im Bündel; `price.current` aus der [Preis-Zuleitung](mqtt-price-current.md), solange der Preis gilt.
  `<gerät>.<signal>` eines eigenen Modbus-Geräts mit Schreibwerten, dessen Definition das Signal einem Kanal zuordnet.
  Alles andere ist unbekannt; der Kern behandelt es nach `max_age`.
- Ist: die Rücklesung der eigenen Ausgangsmenge, wenn die Box selbst steuert; bei einem eigenen Modbus-Gerät mit Schreibwerten dessen Rücklesung (Ein, Sollwert, Betriebsart, höchstens 60 s alt); sonst die angeheftete Quelle des Geräts (`edge_source_id`), solange sie frisch ist (Shelly: Ausgänge oder Relais).
  Ohne Pin und ohne Rücklesung ist der Stand unbekannt.
- Takt jede Sekunde, unabhängig vom Schiedsrichter; die Zähler beginnen um Mitternacht der Anlage und mit jedem Start des Programms neu.

## Annahme in der Cloud

Topic-Identität gleich Nutzlast-Identität, die Box unter dem Mandanten des Topics aufgelöst; nur bekannte Felder in ihren Grenzen, ein Lauf ohne gültige Identität fällt ganz weg, eine kaputte Zeile oder ein kaputtes Gerät allein.
Gespeichert wird je Box und Logik der jüngste bereinigte Block ohne Protokoll (`steuerlogik_lauf`); das Protokoll zeilenweise mit dem Schlüssel Box, Logik, Lauf (`seit`), `nr` (`steuerlogik_wechsel`), so dass ein wiederholter Herzschlag nichts doppelt schreibt; 90 Tage.
Ein Block ohne gültigen Lauf leert den Mitlauf der Box; ein Herzschlag ohne Block lässt ihn stehen.
Plattform-Routen: `GET /api/v1/admin/sites/{siteId}/steuerlogik` (Logiken, Quittung, Mitlauf) und `GET …/{logikId}/wechsel?tag=YYYY-MM-DD` (das Protokoll eines Tages der Anlage).

## Versionsregeln

Der Herzschlag bleibt `schema_version: "1.0"`; der Block ist additiv.
Neue Felder sind additiv; ein neues Wort für `zustand` (etwa „scharf“ in Stufe 3) kommt mit Vektor, Schreiber und Leser zugleich.
