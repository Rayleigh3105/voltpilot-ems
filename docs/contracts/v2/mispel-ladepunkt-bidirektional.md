# MiSpeL — bidirektionaler Ladepunkt (MP-31)

Stand 02.10.2026 · Vertrag 1.0 · Quelle: BNetzA-Festlegung zur Marktintegration von Speichern und Ladepunkten
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

> **Wer anruft (Stand MP-32):** die vier Routen und der Monatslauf der Abgrenzung in A2–A4 (MP-32 liest
> `LadepunktService.anlage` für die Stand-Gründe, [Vertrag](./mispel-abgrenzung.md#monatslauf-und-nachweis-mp-8)); der
> Optimierer (MP-33) liest Fähigkeit, Fenster und Anwesenheit direkt (`inputs.load_fahrzeugspeicher`, Python-Zwilling
> der Einordnung in `fahrzeugspeicher.einordnung`; [Wegweiser](../agents/root/mispel-optimierer-mischbetrieb.md#fahrzeug-als-speicher-mp-33));
> keine Fläche (MP-41). Kein TS-Zwilling — er entsteht mit der Fläche.

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
sie kommen mit Optimierer und Fläche (MP-33, MP-41). Eine abgeschaltete Rückspeisung macht einen Ladepunkt nach A1
S. 26 nicht unidirektional.

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

## 6. Die Schnittstelle

| Route | Recht | Antwort |
|---|---|---|
| `GET /api/v1/sites/{siteId}/ladepunkte[?am=JJJJ-MM-TT]` | `messwerte.ansehen` (Leseweg der Anlage) | `{anlage, am, ladepunkte[]}` |
| `GET /api/v1/sites/{siteId}/ladepunkte/{komponenteId}[?am=…]` | `messwerte.ansehen` | die Ansicht |
| `PUT /api/v1/sites/{siteId}/ladepunkte/{komponenteId}/faehigkeit` | `geraet.einrichten` | die Ansicht am Tag `gueltig_ab` |
| `PUT /api/v1/sites/{siteId}/ladepunkte/{komponenteId}/fahrzeugfenster` | `ladepunkt.betrieb` | die Ansicht heute |

Ansicht: `{anlage, komponente, name, typ, charge_point_id, am, faehigkeit{erfasst, nutzbarkeit, v2h, v2g,
rueckspeisung_bei_einspeisung_unterbunden, rueckspeiseleistung_kw, gueltig_ab, gueltig_bis}, einordnung,
einordnung_fundstelle, z2[], befunde[], fahrzeugfenster, fassungen[]}`.

| Code | Status | Fakten |
|---|---|---|
| `anfrage_ungueltig` | 400 | `feld` (unbekanntes Feld, falsche Form, `gueltig_ab` fehlt) |
| `faehigkeit_ungueltig` | 400 | `grund`: `nutzbarkeit` · `betriebsweise` · `angaben_ohne_rueckspeisung` · `unterbunden` · `rueckspeiseleistung` |
| `fahrzeugfenster_ungueltig` | 400 | `grund`: `mindest_soc` · `kapazitaet` · `anwesenheit` · `abfahrt_soc` · `ueberschneidung` |
| `faehigkeit_unveraendert` | 409 | `am` |
| `ladepunkt_nicht_bidirektional` | 422 | `am`, `fundstelle` |
| `ladepunkt_unbekannt` · `anlage_unbekannt` | 404 | — |

Löschen: die Komponente nimmt Fähigkeit, Fenster und Anwesenheit mit (`ON DELETE CASCADE`), über sie auch Anlage und
Mandant.

## 7. Was dieser Vertrag nicht regelt

- **Rechenwerk** A2/A3/A4 mit Fremdtankstrom, A11 und P2 mit 0,2 für Ladepunkte (MP-32); der Rumpfmonat beim Umbau
  (Anlass `speicher_ladepunkt` in `MispelRumpfmonate`) wird dort aus den Fassungen gebildet.
- **Optimierer** (Fahrzeug als Speicher, Wirkungsgrad 0,85, Zyklenbudget, Freigabe) MP-33; **Box** MP-35ff.; der
  **Simulator** (Wallbox mit Fahrzeug, Z2V/Z2E als getrennte Register, Szenario V2H-Abend) steht in
  `edge-app/core/internal/ladepunktsim` (MP-34, [Wegweiser](../../agents/root/mispel-simulator-fahrzeug.md)).
- **Signierte Ladepunkt-Messwerte** (OCMF) als Z2-Quelle mit Eichstatus: [Vertrag](./mispel-ladepunkt-ocmf.md) (MP-38);
  die Ansicht trägt dafür `signierter_messwert` mit `eichstatus`.
- **Fläche** (Einstellungen am Ladepunkt): MP-41, erst nach dem abgestimmten Bedienkonzept BK-41.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='LadepunktRegelnTest')                                   # rein, kein Docker
(cd services/api && ./mvnw test -Dtest='LadepunktBidirektionalApiTest,LadepunktBidirektionalMigrationTest')  # Testcontainers
```
