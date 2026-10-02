# MiSpeL-Zählerrolle am Messstellen-Register (MP-6)

Stand 02.10.2026 · Vertrag 1.0 · Quelle: BNetzA-Festlegung zur Marktintegration von Speichern und
Ladepunkten („MiSpeL“), Beschluss 01.10.2026 — Anlage 1 (Abgrenzungsoption) und Tenor mit Begründung.
Konzept: MiSpeL-Fundament §5.3, Bauplan §8 Zeile MP-6.

Dieser Vertrag sagt, **welche Rolle eine Messstelle in den Messkonzepten der Anlage 1 spielt** und welche
Regeln das Register dabei hält. Er ändert den [Messstellen-Vertrag](./messstelle.md) nicht.

| Datei | Rolle |
|---|---|
| `services/api/src/main/resources/db/migration/V20261002121500__mispel_messstelle_zaehlerrolle.sql` | Tabelle `messstelle_zaehlerrolle` (Fassungen, RLS + FORCE) |
| `services/api/.../uems/ZaehlerrolleRegeln.java` | die reinen Regeln (ohne Spring, Datenbank, Uhr) |
| `services/api/.../uems/ZaehlerrolleService.java` | Lesen mit Befunden, Setzen als Fassung, `anlage(site, tag)` für das Rechenwerk |
| `services/api/.../web/MessstelleZaehlerrolleController.java` | `GET`/`PUT /api/v1/messstellen/{id}/zaehlerrolle` |
| `…/uems/ZaehlerrolleRegelnTest.java` · `…/uems/ZaehlerrolleApiTest.java` | Regeln rein · Routen gegen die Datenbank |

> **Wer anruft (Stand MP-6):** die zwei Routen. Noch ohne Fläche (MP-17 nach abgestimmtem Bedienkonzept)
> und das Rechenwerk (MP-8, `MispelAbgrenzungService` ruft `ZaehlerrolleService.anlage` am ersten und letzten Tag). Kein TS-Zwilling — er entsteht mit der Fläche.

## 1. Die Rollen (Anlage 1 S. 32–33, Abbildungen der Basisfälle)

| Rolle | Wortlaut der Festlegung | Größen der Formelsätze |
|---|---|---|
| `Z1` | Zweirichtungszähler am Netzanschluss | `Z1NB` Netzbezug (Richtung Bezug) · `Z1NE` Netzeinspeisung (Abgabe) |
| `Z2` | Zähler für die Stromspeicher und/oder Ladepunkte | `Z2V` Verbrauch (Bezug, Laden) · `Z2E` Erzeugung (Abgabe, Entladen, Erzeugung) |
| `Z3` | Zähler für den separat gemessenen Stromspeicher (Basisfall A4) | `Z3V` · `Z3E` wie Z2 |

Eine Messstelle trägt genau EINE Richtung. Der Zweirichtungszähler Z1 sind darum zwei Messstellen mit
Rolle Z1 (Bezug und Abgabe) — derselbe Zählpunkt. Die Größe der Festlegung folgt aus Rolle und Richtung,
nie aus einer eigenen Spalte. „Laden / Entladen“ in einer Messstelle trennt die Richtungen nicht und
liefert keine Größe.

## 2. Die Angaben je Fassung

| Feld | Regel | Fundstelle |
|---|---|---|
| `rolle` | `Z1` · `Z2` · `Z3`; `null` = ab diesem Tag keine Rolle (dann keine weiteren Angaben) | A1 S. 32–33 |
| `zaehlpunkt` | Zählpunktbezeichnung, 33 Zeichen `^DE[0-9A-Z]{31}$`; leer = noch nicht bekannt; nichts wird umgewandelt | A1 S. 23 („Zähler“ = Zählpunkte) |
| `messstellenbetreiber` | Name, 1–200 Zeichen; leer = nicht erhoben | A1 S. 23, MsbG unberührt |
| `eichstatus` | `eichrechtskonform` · `nicht_eichrechtskonform`; leer = nicht erhoben (unbekannt ist NICHT konform) | A1 S. 23 |
| `eichfrist_bis` | letzter Tag der Eichgültigkeit, optional | A1 S. 23 |
| `wertequelle` | `messstellenbetreiber` · `geraet` — Pflicht bei einer Rolle | Tenor S. 28 |
| `gueltig_ab` | Tag (00:00 in der Zeitzone des Kundenbereichs); die Fassung gilt bis zum Tag vor der nächsten | — |

Fassungen werden nie überschrieben: eine neue Fassung desselben Tages hebt die alte auf (`aufgehoben_am`),
beide bleiben lesbar. Die Messmittel-Angaben am Einbau (AP-16 IP-15, `geraet.pruefungsart`) beschreiben das
Gerät der Box; die Zählerrolle beschreibt den Zählpunkt der Festlegung — beide bleiben getrennt.

## 3. Die Plausibilität (Befunde beim Lesen)

**Was hinter einem Zähler liegt:** die Komponente seiner führenden Quelle (Hauptgröße, an dem Tag) und jede
Messstelle, die an dem Tag — auch mittelbar — „Unterzähler von“ ihm ist. Was eine Komponente misst, sagen die
Rollen ihrer Messwerte in der Topologie der Anlage (`pv`, `storage`, `consumer`, `grid`, `charging`,
`charging-own`). Eine Messstelle ohne Quelle hat ein **unbekanntes** Messobjekt — nie „nichts dahinter“.

| Code | Schwere | wann | Fundstelle |
|---|---|---|---|
| `sonstiger_verbrauch_hinter_zaehler` | fehler | hinter (oder als) Z2/Z3 misst etwas Verbrauch (`consumer`, `grid`) | A1 S. 25, Abschn. 3.2.4 |
| `sonstige_erzeugung_hinter_zaehler` | fehler | hinter (oder als) Z2/Z3 misst etwas Erzeugung (`pv` ohne Speicher/Ladepunkt) | A1 S. 25, Abschn. 3.2.4 |
| `ladepunkt_hinter_z3` | fehler | hinter Z3 ein Ladepunkt — Z3 misst den Speicher allein | A1 S. 25, Abschn. 3.2.4 |
| `dc_kopplung_erzeugung` | hinweis | eine Komponente mit Speicher UND Solar: gleichstromseitig gekoppelt, geeichte DC-Messung erforderlich | Tenor S. 31–32 |
| `messobjekt_unbekannt` | hinweis | das Messobjekt ist unbekannt — die Trennung ist nicht prüfbar | A1 S. 25 |
| `z1_nicht_hauptzaehler` | hinweis | Z1 steht nicht als Hauptzähler im Baum | A1 S. 23 |
| `zaehlpunkt_abweichend` | fehler | zwei Messstellen derselben Rolle nennen verschiedene Zählpunkte | A1 S. 23 |
| `gegenrichtung_fehlt` | hinweis | zur Rolle fehlt die Messstelle der anderen Richtung | A1 S. 32–33 |
| `zaehlpunkt_fehlt` · `messstellenbetreiber_fehlt` | hinweis | Angabe nicht erhoben | A1 S. 23 |
| `eichstatus_unbekannt` | hinweis | Eichstatus nicht erhoben | A1 S. 23 |
| `nicht_eichrechtskonform` · `eichfrist_abgelaufen` | fehler | nicht konform bzw. Frist vor dem Tag abgelaufen | A1 S. 23 |
| `wertequelle_geraet` | hinweis | Gerätewerte sind für Nachweis und Abrechnung nicht maßgeblich | Tenor S. 28 |

Hinter Z2 sind Speicher (`storage`), Ladepunkte (`charging`, `charging-own`) und eine Messstelle mit Rolle Z3
erlaubt (A4). **Urteil** je Messstelle: `nicht_tauglich` bei einem Fehler, `nicht_pruefbar` bei
`messobjekt_unbekannt` oder `eichstatus_unbekannt`, sonst `tauglich`; ohne Rolle `keine_rolle`.

## 4. Die Schnittstelle

`GET /api/v1/messstellen/{id}/zaehlerrolle[?am=JJJJ-MM-TT]` (Recht `messstelle.ansehen`) →
`{messstelle_id, messstelle, am, anlage, rolle, festlegungsgroesse, urteil, befunde[], fassungen[]}`.

`PUT /api/v1/messstellen/{id}/zaehlerrolle` (Recht `messstelle.bearbeiten`) mit
`{rolle, zaehlpunkt, messstellenbetreiber, eichstatus, eichfrist_bis, wertequelle, gueltig_ab}` → die Ansicht
am Tag `gueltig_ab`. Geprüft am ersten Tag und an jedem Tag, an dem sich die Stellungen der Anlage ändern:

| Code | Status | Fakten |
|---|---|---|
| `anfrage_ungueltig` | 400 | `feld` (unbekanntes Feld, falsche Form, `gueltig_ab` fehlt) |
| `zaehlerrolle_ungueltig` | 400 | `grund`: `rolle` · `zaehlpunkt` · `messstellenbetreiber` · `eichstatus` · `wertequelle` · `angaben_ohne_rolle` |
| `zaehlerrolle_passt_nicht` | 422 | `grund`: `nicht_gemessen` · `nicht_strom` · `keine_wirkenergie` · `richtung` |
| `ohne_anlage` | 422 | `am` — keine elektrische Stellung am ersten Tag |
| `zaehlerrolle_vergeben` | 409 | `am`, `groesse`, `messstelle` — dieselbe Größe liefert schon eine andere Messstelle der Anlage |
| `zaehler_nicht_getrennt` | 422 | `am`, `fundstelle`, `befunde[]` — Trennung verletzt (A1 S. 25) |
| `zaehlerrolle_unveraendert` | 409 | `am` |
| `zustand_passt_nicht` | 409 | Messstelle archiviert |

Eine fremde Messstelle ist 404, nie 403. Ändert sich der Baum später über einen anderen Weg (Stellung,
Quelle), lehnt jener Weg nicht ab — der Befund zeigt es beim Lesen, und das Rechenwerk liest das Urteil.

## 5. Was dieser Vertrag nicht regelt

- **Z4 (A6) und ZW (A7):** weitere verschiedenartige Erzeugung und separat belieferte Wärmepumpe — kommen mit
  ihren Formelsätzen; das Vokabular wird dann per neuer Migration erweitert.
- **Ein-Zähler-Sonderfälle A8, A10, A11** brauchen nur Z1 und keine getrennte Messung (A1 S. 25 Fn. 18); welche
  Fallkonstellation eine Anlage hat, wählt der Förderweg/Formelsatz-Assistent (MP-5/MP-17), nicht dieser Vertrag.
- **MSB-Werte** (Import, Abweichungsampel) sind MP-15; die Wertequelle sagt nur, woher die maßgeblichen Werte kommen.
- Die Schreibwege von Stellung und Quelle prüfen die Trennung nicht.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='ZaehlerrolleRegelnTest')   # rein, kein Docker
(cd services/api && ./mvnw test -Dtest='ZaehlerrolleApiTest')      # Testcontainers
```
