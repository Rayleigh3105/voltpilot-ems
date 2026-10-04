# MiSpeL — bidirektionaler Ladepunkt (MP-31)

Stand 04.10.2026 · Vertrag 1.2 (MP-41a additiv: § 5a, § 6a; MP-33e: Vergleich aus der Ablage) · Quelle: BNetzA-Festlegung zur Marktintegration von Speichern und Ladepunkten
(„MiSpeL“, Beschluss 01.10.2026) — Anlage 1 (Abgrenzungsoption) und Tenor mit Begründung.
Konzept: MiSpeL-Fundament §2.4 und §6, Bauplan §8 Zeile MP-31; Entscheid E3 = D (Software-Tiefe sofort, V2H vor V2G).

Dieser Vertrag sagt, **ob ein Ladepunkt nach der Festlegung wie ein Stromspeicher zählt**, welcher Zähler Z2 ihn
misst und was der Optimierer über das Fahrzeug am Ladepunkt weiß. Er steuert nichts (MP-33) und hat keine Fläche
(MP-41 nach dem Bedienkonzept BK-41).

| Datei | Rolle |
|---|---|
| `services/api/src/main/resources/db/migration/V20261002214500__mispel_ladepunkt_bidirektional.sql` | `ladepunkt_faehigkeit` (Fassungen), `ladepunkt_fahrzeugfenster`, `ladepunkt_anwesenheit` (RLS + FORCE) |
| `services/api/.../mispel/LadepunktRegeln.java` | die reinen Regeln (Form, Einordnung, Befunde) |
| `services/api/.../mispel/LadepunktService.java` | Lesen mit Z2 und Befunden, Setzen als Fassung, `anlage(site, tag)` für MP-32/MP-33 |
| `services/api/.../web/SiteLadepunktBidirektionalController.java` | `GET`/`PUT /api/v1/sites/{siteId}/ladepunkte/…` |
| `…/mispel/LadepunktRegelnTest.java` · `…/mispel/LadepunktBidirektionalApiTest.java` · `…/uems/LadepunktBidirektionalMigrationTest.java` | Regeln rein · Routen gegen die Datenbank · Migration auf befüllter Datenbank |
| `services/api/src/main/resources/db/migration/V20261004114700__mispel_ladepunkt_fahrer_einstellungen.sql` | MP-41a: `ladepunkt_fahrer_einstellung`, `ladepunkt_abfahrt` (RLS + FORCE) |
| `services/api/.../mispel/LadepunktErtraege.java` · `…/LadepunktErtragService.java` | MP-41a: Erträge am Ladepunkt im Monat aus dem Monatslauf (A2–A4) |
| `…/mispel/LadepunktErtraegeApiTest.java` | MP-41a: A2-Monatslauf mit Fremdtankstrom → Route `ertraege` |

> **Wer anruft (Stand MP-32):** die vier Routen und der Monatslauf der Abgrenzung in A2–A4 (MP-32 liest
> `LadepunktService.anlage` für die Stand-Gründe, [Vertrag](./mispel-abgrenzung.md#monatslauf-und-nachweis-mp-8)); der
> Optimierer (MP-33) liest Fähigkeit, Fenster und Anwesenheit direkt (`inputs.load_fahrzeugspeicher`, Python-Zwilling
> der Einordnung in `fahrzeugspeicher.einordnung`; [Wegweiser](../agents/root/mispel-optimierer-mischbetrieb.md#fahrzeug-als-speicher-mp-33));
> Fläche seit MP-41a: Fähigkeit in Anlage › Aufbau (Kurzblick des Ladepunkts, `LadepunktFaehigkeitDialog`) und die
> Erträge in Verlauf › Erlöse (`LadepunktErtragKarte`); die Wallbox-Karte in Steuerung › Laden folgt mit MP-41b.

## 1. Der Ladepunkt und seine Identität

Ein Ladepunkt ist eine **Komponente** der Anlage (`measurement_point`) vom Katalog-Typ `ev-charger` (die
OCPP-Säule, die die Plattform aus dem Herzschlag komponiert) oder `wallbox` (eine Wallbox über ihre eigene
Anbindung — der V2H-Pilot MP-40 kommt so, ohne OCPP). Die OCPP-Kennung (`device_charge_point.charge_point_id`) wird
nur angezeigt; `device_charge_point` ist der Herzschlag-Spiegel, wird je Herzschlag ganz ersetzt und trägt hier nichts.
Eine andere Komponente oder eine fremde ist `404 ladepunkt_unbekannt`.

Das Fahrzeug hat **keine** eigene Identität: Laden aller angeschlossenen Fahrzeuge ist Verbrauch **im Ladepunkt**,
Rückspeisung Erzeugung **im Ladepunkt**, „ohne Belang, ob stets das gleiche oder ob verschiedene Elektromobile“
angeschlossen werden (A1 S. 27, Abschn. 3.2.5).

## 2. Die Fähigkeit (Fassungen ab einem Tag)

| Feld | Regel | Fundstelle |
|---|---|---|
| `nutzbarkeit` | `unidirektional` („ausschließlich unidirektional nutzbar“) · `bidirektional` („bidirektional nutzbar“) — nach den **technischen Gegebenheiten**, nicht nach dem Wunsch des Kunden | A1 S. 7 (Begriff „Ladepunkt“), S. 26, Abschn. 3.2.5 |
| `v2h` · `v2g` | Rückspeisung ins Haus bzw. ins Netz; bidirektional = mindestens eine; unidirektional = keine | A1 S. 26 Fn. 21 |
| `rueckspeisung_bei_einspeisung_unterbunden` | die Rückspeisung wird technisch unterbunden, sobald gleichzeitig Strom ins Netz eingespeist wird; nur ohne V2G | A1 S. 27 Fn. 22, Abschn. 2.1.3 |
| `rueckspeiseleistung_kw` | höchste Rückspeiseleistung, über 0 bis 1000; leer = nicht bekannt (nie 0); nur bidirektional | — (Planungsangabe für MP-33) |
| `gueltig_ab` | Tag (00:00 in der Zeitzone des Kundenbereichs); die Fassung gilt bis zum Tag vor der nächsten | A1 S. 102–104, Abschn. 11 |

Fassungen werden nie überschrieben: eine neue Fassung desselben Tages hebt die alte auf (`aufgehoben_am`), beide
bleiben lesbar. Der Umbau uni- → bidirektional ist eine bestimmungsrelevante Änderung (Rumpfmonat, A1 S. 102) — darum
Fassungen ab einem Tag und kein Schalter.

**Bestand:** ein Ladepunkt **ohne** Fassung gilt als unidirektional (Captain-Vorgabe; VoltPilot konnte bis hier kein
bidirektionales Laden). Die Ansicht sagt dazu `faehigkeit.erfasst: false`; die Migration schreibt keine Zeile.

**Nicht hier:** „Rückspeisen ja/nein“ als Freigabe des Kunden und ein Zyklenbudget sind Wünsche, keine Fähigkeit —
sie stehen seit MP-41a in [§ 5a](#5a-die-einstellungen-des-fahrers-mp-41a). Eine abgeschaltete Rückspeisung macht einen
Ladepunkt nach A1 S. 26 nicht unidirektional.

## 3. Die Einordnung nach Anlage 1

| `einordnung` | wann | Folge | Fundstelle |
|---|---|---|---|
| `sonstiger_verbrauch` | unidirektional (auch Bestand) | gewöhnlicher sonstiger Verbrauch, keine Abgrenzung | A1 S. 7 und S. 26, Abschn. 3.2.5 |
| `ladepunkt_der_festlegung` | bidirektional mit V2G, oder V2H ohne die Sperre | dem Stromspeicher gleichgestellt; Formelsätze mit Ladepunkt | A1 S. 26, Abschn. 3.2.5, Fn. 21 |
| `alternative_zur_ausschliesslichkeit` | bidirektional, nur V2H, Rückspeisung bei gleichzeitiger Einspeisung unterbunden | kein Ladepunkt im Sinne der Anlage 1: weder Umlagesaldierung noch Förderung für Strom aus dem Ladepunkt, aber Förderung für den EE-Strom direkt | A1 S. 26 Fn. 21, S. 27 Fn. 22, Abschn. 2.1.3 |

## 4. Z2 am Ladepunkt (gelesen, nie gespeichert)

Z2 kommt aus den [Zählerrollen](./mispel-zaehlerrolle.md) (MP-6): ein Ladepunkt liegt am Tag hinter einer Messstelle
mit Rolle Z2, wenn er die Komponente ihrer führenden Quelle (Hauptgröße) ist oder die einer Messstelle, die — auch
mittelbar — „Unterzähler von“ ihr ist. Je Richtung ein Eintrag (`Z2V` Verbrauch im Ladepunkt, `Z2E` Erzeugung im
Ladepunkt) mit `messstelle`, `zaehlpunkt`, `messstellenbetreiber`, `eichstatus`, `eichfrist_bis`, `wertequelle` und dem
`urteil` der Zählerrolle. Eichstatus und Urteil sind die der Zählerrolle; dieser Vertrag kennt keinen zweiten.

| Code | Schwere | wann | Fundstelle |
|---|---|---|---|
| `unidirektional_hinter_z2` | fehler | ein unidirektionaler Ladepunkt (auch Bestand) liegt hinter Z2 — sonstiger Verbrauch hinter dem Zähler des Speichers/Ladepunkts | A1 S. 25, Abschn. 3.2.4, und S. 26, Abschn. 3.2.5 |
| `z2_fehlt` | hinweis | Ladepunkt der Festlegung ohne Z2: nur der Ein-Zähler-Fall A11 (Fremdtankstrom nicht erkennbar) oder die Pauschaloption | A1 S. 26–27, Abschn. 3.2.5; S. 32–33 |
| `z2_richtung_fehlt` | hinweis | nur Z2V oder nur Z2E | A1 S. 26–27; S. 32–33 |
| `z2_nicht_tauglich` | fehler | das Urteil der Zählerrolle ist `nicht_tauglich` (z. B. nicht eichrechtskonform) | Tenor S. 28, Abschn. 3.2.3.2.1 |
| `z2_nicht_pruefbar` | hinweis | das Urteil ist `nicht_pruefbar` (Eichstatus oder Messobjekt unbekannt) | Tenor S. 28, Abschn. 3.2.3.2.1 |
| `ausschliesslichkeit_mit_ladepunkt` | fehler | Förderweg am Tag `marktpraemie_ausschliesslichkeit` und ein Ladepunkt der Festlegung | A1 S. 27 Fn. 22 |

Tenor S. 28: auch Ladepunkt-Messwerte müssen mess- und eichrechtskonform sein — die Forderung, nicht konform erfasste
Werte zu nutzen, „scheidet … aus“.

> **Bekannte Lücke (Folgepunkt):** das Urteil der Zählerrolle selbst (MP-6) zählt die Topologie-Rolle `charging`
> hinter Z2 noch als erlaubt, ohne die Nutzbarkeit zu kennen. Den Fehler zeigt bis dahin nur dieser Befund
> `unidirektional_hinter_z2`; der Monatslauf (MP-32) liest beide: das Urteil als `zaehler_<urteil>:<MS>`, den Befund
> als `ladepunkt_unidirektional_hinter_z2:<MS>` — beide halten den Lauf vorläufig.

## 5. Das Fahrzeugfenster (Planungsangabe, kein Gegenstand der Festlegung)

Der laufende Stand am Ladepunkt, ganz ersetzt bei jedem `PUT`; nur an einem Ladepunkt, der heute oder später
bidirektional ist (sonst `422 ladepunkt_nicht_bidirektional`).

| Feld | Regel |
|---|---|
| `mindest_soc_pct` | unter diesen Ladestand wird nie entladen; 0–100, leer = nicht gesagt |
| `kapazitaet_kwh` | nutzbare Kapazität des Fahrzeugs, das hier üblicherweise steht; über 0 bis 500, leer = nicht bekannt |
| `anwesenheit[]` | `{wochentag, ankunft, abfahrt, abfahrt_soc_pct}`: ISO-Wochentag des Ankunftstags (1 = Montag), Uhrzeiten `HH:MM` in der Ortszeit des Kundenbereichs, halboffen `[ankunft, abfahrt)`, `abfahrt` vor `ankunft` = über Mitternacht; `abfahrt_soc_pct` = Ladestand bei Abfahrt, nicht unter `mindest_soc_pct`; Fenster überschneiden sich nicht (auch nicht über das Wochenende) |

Unbekannt ist keine Null: das gemessene Anstecken und der gemeldete Ladestand bleiben Telemetrie der Säule
(`device_charge_connector`); das Fenster ist die Erwartung, nicht der Ist-Zustand.

## 5a. Die Einstellungen des Fahrers (MP-41a)

Bedienkonzept BK-41, Variante A (Captain 04.10.2026): „Zurückspeisen: Aus · Ins Haus · Haus + Netz“, „Abfahrt und
Reserve“ in Prozent und Kilometern, eine Abfahrt für mehrere Wochentage, „nur die nächste Fahrt“, „Akku schonen“. Wie
das Fahrzeugfenster ein **Wunsch** am Ladepunkt (nicht am Fahrzeug, A1 S. 27), der laufende Stand ohne Fassungen, ganz
ersetzt bei jedem `PUT`; nur an einem Ladepunkt, der heute oder später bidirektional ist (`422 ladepunkt_nicht_bidirektional`).

| Feld | Regel |
|---|---|
| `rueckspeisen` | Pflicht: `aus` · `v2h` (nur ins Haus) · `v2g` (Haus und Netz) — das Vokabular von `entities[].fahrzeug.rueckspeisen` im [Fahrplan 2.0](./mqtt-schedule-2.0.md#fahrzeug-an-bidirektionalen-ladepunkten-mispel-mp-39). Ohne Zeile gilt `aus` (`erfasst: false`). Nie über der Fähigkeit: trägt weder die Fassung von heute noch eine spätere den Wunsch, `422 rueckspeisen_ueber_faehigkeit` (A1 S. 26 Fn. 21). |
| `reserve_pct` | Die Reserve ist **kein neues Feld**, sondern `mindest_soc_pct` des Fahrzeugfensters (§ 5): beide Wege schreiben dasselbe Feld; leer = nicht gesagt — dann speist die Box nicht zurück (MP-39). Nicht über dem Ladestand bei Abfahrt eines Anwesenheitsfensters. |
| `vollzyklen_je_tag` | „Akku schonen“: `0.5` · `1` · `2` volle Ladungen am Tag; leer = nicht gesagt (der Optimierer rechnet heute fest mit 1, `domain.py` `FAHRZEUG_VOLLZYKLEN_JE_TAG`). |
| `abfahrten[]` | `{wochentage[], abfahrt, abfahrt_soc_pct}`: eine Abfahrt (`HH:MM`, Ortszeit des Kundenbereichs) mit dem Ladestand bei Abfahrt für einen oder mehrere ISO-Wochentage (1 = Montag); je Wochentag höchstens eine; `abfahrt_soc_pct` 0–100 und nicht unter der Reserve. Gespeichert je Wochentag; gelesen wieder zusammengefasst (gleiche Uhrzeit und gleicher Ladestand = eine Abfahrt). |
| `naechste_fahrt` | `{abfahrt: "JJJJ-MM-TTTHH:MM", abfahrt_soc_pct}` oder `null`: einmalig, in der Zukunft und höchstens 7 Tage voraus; danach gilt wieder der Wochenplan. Die Ansicht zeigt sie nur, solange sie bevorsteht (veraltet ist nicht aktuell). |

Ansicht (`fahrer_einstellungen` in jeder Ladepunkt-Ansicht): `{erfasst, rueckspeisen, rueckspeisen_wirksam, reserve_pct,
vollzyklen_je_tag, abfahrten[], naechste_fahrt, km_je_prozent, geaendert_am, geaendert_von}`. `rueckspeisen_wirksam` ist
der Wunsch am Tag `am`, nie über der Fähigkeit dieses Tages (`v2g` ohne V2G → `v2h`, ohne V2H → `aus`).
`km_je_prozent` = Kapazität × 6 km/kWh ÷ 100 (dieselbe Schätzung wie das Ladeziel im Portal), `null` ohne Kapazität —
eine Anzeigehilfe, kein Messwert.

**Wer liest:** heute nur die Ansicht. Der Optimierer (MP-33) liest Freigabe und Zyklenbudget noch nicht, und er sendet
den Block `fahrzeug` im Fahrplan noch nicht — ohne Block speist die Box nie zurück (MP-39). Beides ist ein Folgepaket.

## 6. Die Schnittstelle

| Route | Recht | Antwort |
|---|---|---|
| `GET /api/v1/sites/{siteId}/ladepunkte[?am=JJJJ-MM-TT]` | `messwerte.ansehen` (Leseweg der Anlage) | `{anlage, am, ladepunkte[]}` |
| `GET /api/v1/sites/{siteId}/ladepunkte/{komponenteId}[?am=…]` | `messwerte.ansehen` | die Ansicht |
| `PUT /api/v1/sites/{siteId}/ladepunkte/{komponenteId}/faehigkeit` | `geraet.einrichten` | die Ansicht am Tag `gueltig_ab` |
| `PUT /api/v1/sites/{siteId}/ladepunkte/{komponenteId}/fahrzeugfenster` | `ladepunkt.betrieb` | die Ansicht heute |
| `PUT /api/v1/sites/{siteId}/ladepunkte/{komponenteId}/fahrer-einstellungen` | `ladepunkt.betrieb` | die Ansicht heute (MP-41a, § 5a) |
| `GET /api/v1/sites/{siteId}/ladepunkte/ertraege/{JJJJ-MM}` | `messwerte.ansehen` | die Erträge im Monat (MP-41a, § 6a) |

Ansicht: `{anlage, komponente, name, typ, charge_point_id, am, faehigkeit{erfasst, nutzbarkeit, v2h, v2g,
rueckspeisung_bei_einspeisung_unterbunden, rueckspeiseleistung_kw, gueltig_ab, gueltig_bis}, einordnung,
einordnung_fundstelle, z2[], befunde[], fahrzeugfenster, fassungen[], signierter_messwert, fahrer_einstellungen}`.

| Code | Status | Fakten |
|---|---|---|
| `anfrage_ungueltig` | 400 | `feld` (unbekanntes Feld, falsche Form, `gueltig_ab` fehlt) |
| `faehigkeit_ungueltig` | 400 | `grund`: `nutzbarkeit` · `betriebsweise` · `angaben_ohne_rueckspeisung` · `unterbunden` · `rueckspeiseleistung` |
| `fahrzeugfenster_ungueltig` | 400 | `grund`: `mindest_soc` · `kapazitaet` · `anwesenheit` · `abfahrt_soc` · `ueberschneidung` |
| `fahrer_einstellungen_ungueltig` | 400 | `grund`: `rueckspeisen` · `reserve` · `vollzyklen` · `abfahrt` · `abfahrt_soc` · `ueberschneidung` · `naechste_fahrt` |
| `zeitraum_ungueltig` | 400 | `feld` = `monat` (vor 2026-10, der Festlegung) |
| `rueckspeisen_ueber_faehigkeit` | 422 | `am`, `rueckspeisen`, `fundstelle` |
| `faehigkeit_unveraendert` | 409 | `am` |
| `ladepunkt_nicht_bidirektional` | 422 | `am`, `fundstelle` |
| `ladepunkt_unbekannt` · `anlage_unbekannt` | 404 | — |

Löschen: die Komponente nimmt Fähigkeit, Fenster und Anwesenheit mit (`ON DELETE CASCADE`), über sie auch Anlage und
Mandant.

## 6a. Die Erträge am Ladepunkt im Monat (MP-41a)

`GET …/ladepunkte/ertraege/{JJJJ-MM}` liest den **gespeicherten Monatslauf der Abgrenzung** (`mispel_abgrenzung_monat`,
MP-8/MP-32) wie die MiSpeL-Karte von MP-18 und rechnet keine Menge neu. Nur Teile (Kalender- oder Rumpfmonat, A1 S. 102)
mit Formelsatz A2, A3 oder A4 zählen; ohne sie sind `teile` und `posten` leer (keine Karte).

`{anlage, monat, ladepunkte[{komponente, name, einordnung}], teile[], posten[], vergleich{stand, grund, summe_eur}, ust_pct}`
(`ust_pct` = USt-Satz des Preisblatts, mit dem Umlagen und Netzentgelt brutto gerechnet sind; `null` ohne Preisblatt);
ein Teil: `{schluessel, erster_tag, letzter_tag, formelsatz, formelsatz_bezeichnung, nur_ladepunkt, stand, wertequelle,
mengen[{nr, begriff, fundstelle, kwh}], ins_haus}`.

| Menge | Begriff (A1, wörtlich aus dem Formelkatalog) | Seite |
|---|---|---|
| (5), (9), (10) | Verbrauch im Stromspeicher und/oder Ladepunkt; davon zeitgleicher Netzstromverbrauch und zeitgleicher Verbrauch von Strom aus der EE-Anlage | S. 34 |
| (6), (11) | Erzeugung im Stromspeicher und/oder Ladepunkt; Basiswert der zeitgleichen Netzeinspeisung daraus | S. 34–35 |
| (12), (13) | **Fremdtankstrom** = MAX[(6) − (5); 0] — zählt nicht; berücksichtigungsfähige zeitgleiche Netzeinspeisung | S. 16, Abschn. 2.1.6; S. 35 |
| (14) | Wirkungsgrad 0,85 in A2, A3, A4 (als `kwh`-Feld der Faktor) | S. 35 |
| (15), (16), (20) | EE-Speichererzeugung; saldierungsfähige Netzeinspeisung; umlagereduzierende Strommenge | S. 36–37 |
| (28), (31) | grundsätzlich förderfähige bzw. förderfähige Netzeinspeisung von EE-Speichererzeugung in AW>0-Zeiten | S. 38–39 |
| `ins_haus` = (6) − (11) | Erzeugung, die nicht zeitgleich ins Netz ging — nach dem gewillkürten Speichervorrang im Haus verbraucht | S. 14–16, Abschn. 2.1.5 |

`nur_ladepunkt` ist `true` in A2 (Z2 misst nur den Ladepunkt, A1 S. 29–30) und `false` in A3/A4: dort misst Z2
Stromspeicher **und** Ladepunkt gemeinsam (S. 30–32); die Mengen sind die beider, und kein Posten aus dem Rechenwerk wird
dem Auto allein zugeschrieben (`grund: speicher_und_ladepunkt`).

**Posten** (immer alle sieben, in dieser Reihenfolge; `{schluessel, stand, eur, menge_kwh, formel, satz_ct, grund,
vorbehalt}`, `eur` mit Vorzeichen): `weniger_gekauft`, `mehr_geladen`, `ins_netz_verkauft`, `vermiedene_umlagen` und
`vermiedenes_netzentgelt` = (20) × Satz des Preisblatts × (1 + USt) wie MP-18 (Netzentgelt mit `vorbehalt: true`, W10),
`akku_verschleiss`, `marktpraemie` = (31) × MAX[AW − Jahresmarktwert; 0], erst mit dem Jahresmarktwert bestimmt.

**Vergleich** „dasselbe Haus, in dem das Auto nur lädt“: die Messlatte ohne Rückspeisen rechnet der Optimierer (MP-33d)
und legt sie je Viertelstunde ab; die Route summiert sie über die Tage der Teile bis zur laufenden Viertelstunde
([Vertrag Messlatte § 3](mispel-messlatte-nur-laden.md#3-ablage-mp-33e), MP-33e). Die vier Posten kommen dann mit
`menge_kwh` und dem Mittel als `satz_ct`. Fehlt der Ablage eine Viertelstunde eines Ladepunkts, sind `weniger_gekauft`,
`mehr_geladen`, `ins_netz_verkauft`, `akku_verschleiss` und `vergleich.summe_eur` offen (`grund: messlatte_fehlt`) — die
Karte zeigt Mengen und Posten, aber keine Summe: ein Minus steht nie allein, unbekannt ist keine Null. `summe_eur` ist
die Summe der auf Cent gerundeten Posten ohne Marktprämie und steht nur, wenn diese sechs bestimmt sind; sonst ist
`vergleich` offen mit dem Grund des ersten offenen Postens (in A3/A4 `speicher_und_ladepunkt`). In der Pauschaloption gibt es keine
eigenen Ladepunkt-Mengen (A2 S. 11, Fn. 10; Fremdtankstrom nicht erkennbar, A1 S. 16) — dann keine Teile.

## 7. Was dieser Vertrag nicht regelt

- **Rechenwerk** A2/A3/A4 mit Fremdtankstrom, A11 und P2 mit 0,2 für Ladepunkte (MP-32); der Rumpfmonat beim Umbau
  (Anlass `speicher_ladepunkt` in `MispelRumpfmonate`) wird dort aus den Fassungen gebildet.
- **Optimierer** (Fahrzeug als Speicher, Wirkungsgrad 0,85, Zyklenbudget, Freigabe) MP-33; **Box** MP-35ff.; der
  **Simulator** (Wallbox mit Fahrzeug, Z2V/Z2E als getrennte Register, Szenario V2H-Abend) steht in
  `edge-app/core/internal/ladepunktsim` (MP-34, [Wegweiser](../../agents/root/mispel-simulator-fahrzeug.md)).
- **Signierte Ladepunkt-Messwerte** (OCMF) als Z2-Quelle mit Eichstatus: [Vertrag](./mispel-ladepunkt-ocmf.md) (MP-38);
  die Ansicht trägt dafür `signierter_messwert` mit `eichstatus`.
- **Fläche** der Einstellungen des Fahrers (Wallbox-Karte in Steuerung › Laden): MP-41b, wenn `mispel` die neue
  Steuerung von `main` nachgezogen hat. Fähigkeit im Aufbau und Erträge: MP-41a.
- **Anbindung an Optimierer und Box:** der Optimierer liest § 5a noch nicht und sendet den Fahrplan-Block `fahrzeug` noch
  nicht; die Messlatte „nur laden“ für § 6a rechnet MP-33d, abgelegt und gelesen wird sie seit MP-33e.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='LadepunktRegelnTest')                                   # rein, kein Docker
(cd services/api && ./mvnw test -Dtest='LadepunktBidirektionalApiTest,LadepunktErtraegeApiTest,LadepunktBidirektionalMigrationTest')  # Testcontainers
```
