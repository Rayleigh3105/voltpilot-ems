# UEMS-Netzanschluss als eigenes Objekt am Standort, Bindung 1 : 1 je Tag (AP-10 IP-6)

Neu am 13.09.2026. Entscheid **E8 = A**: der Netzanschluss ist ein Objekt am STANDORT, die Anlage hängt
zeitgültig an ihm — **an jedem Tag an genau EINEM**. Konzept `vp-uems-ap10-bilanzen` §4.2, §5.1, §8 IP-6;
Vertrag [`docs/contracts/v2/netzanschluss.md`](../../contracts/v2/netzanschluss.md) (seit AP-10 IP-1).

| Was | Wo |
|---|---|
| Migration | `V20260913235000__uems_netzanschluss.sql` — `netzanschluss`, `netzanschluss_kennzeichen` (Belegung), `netzanschluss_kennzeichen_seq`, `anlage_netzanschluss`, `netzanschluss_aenderung` |
| Regeln | `uems/NetzanschlussRegeln` ⟷ `uemsNetzanschluss.ts` gegen `netzanschluss-vectors.json` — AUFGERUFEN, nie nachgebaut |
| Schreibweg | `uems/NetzanschlussService` (+ `…Repository`, `…Abgelehnt` = geschlossener Satz, gepinnt gegen OpenAPI `NetzanschlussFehler`) |
| Routen | `web/NetzanschlussController`: `GET/POST /api/v1/standorte/{id}/netzanschluesse`, `GET/PUT …/{id}`, `POST …/{id}/anlagen` |
| Lesemodell | `StandortLesemodell`: `ZugeordneteAnlage.netzanschluss` (am Stichtag) und `OrtsbaumAbleitung.Anlage.netzanschluss` (Kennzeichen, `baum(z, tag)`) — vorher `null` |
| Rechte | `netzanschluss.verwalten` (Zellen wie `standort.verwalten`), lesen ohne eigene Kennung — Matrix-Nachtrag, KEINE Durchsetzung |
| Tests | `UemsNetzanschlussMigrationTest`, `NetzanschlussApiTest`, `NetzanschlussSchnittstelleVertragTest`, `StandortLesemodellTest` (Feld gegen `ortsbaum-vectors.json`) |

## ⚠ Die 1:1-je-Tag-Regel

- **Zwei Exklusionen, nicht eine:** `anlage_netzanschluss_eine_je_anlage` UND `…_eine_je_anschluss`
  (`daterange(ab, bis, '[]')`, `WHERE aufgehoben_am IS NULL`). Eine zweite Bindung derselben Anlage am
  selben Tag ist **409 `bindung_ueberlappt`** — ein Widerspruch, kein Nachtrag.
- **Ein Wechsel beendet die laufende Bindung am VORTAG** (`NetzanschlussRegeln.bindung`), die neue gilt
  ab ihrem Tag. Seit IP-6 sieht die Regel ALLE Tage: ein früherer Beginn vor einer späteren Bindung
  derselben Anlage ist ebenfalls `bindung_ueberlappt`, ein Anschluss, der an IRGENDEINEM Tag der neuen
  an einer anderen Anlage hängt, `anschluss_belegt` (zwei Fälle in den Vektoren, beide Zwillinge).
- **Eine Bindung endet mit ihrem Anschluss** (Trigger-Paar `uems_zuordnung_im_ziel` /
  `uems_ziel_deckt_zuordnungen` aus V20260913160000, AUFGERUFEN): vor/nach seinen Tagen 422
  `netzanschluss_besteht_nicht`, ein Ende, das eine Bindung abschnitte, 409 `bindung_besteht` mit Liste.
  `gueltig_ab` am Anschluss darf `null` sein (Ahrenberg nennt keinen; die Bindung von AN-1 beginnt
  12.03.2024) — dann begrenzt er nur nach hinten.
- **Die Anlage darf gehen (W5):** kein Fremdschlüssel auf `site`, Einfüge-Trigger mit Constraint-Name
  `anlage_netzanschluss_site_fk`; `SiteController.deleteSite` ruft `NetzanschlussService.beimLoeschen`
  (läuft heute → endet heute, später → aufgehoben, je Bindung ein Eintrag `anlage_entfernt`).

## ⚠ Die Kennzeichen-Regel (AP-00 E10)

- Einmal vergeben, **nie an einen anderen Anschluss weitergegeben** — auch nach Beenden oder Umbenennen
  (Trigger `netzanschluss_kennzeichen_belegen` → PK `netzanschluss_kennzeichen_belegt`, Muster
  `messstelle_kennzeichen`). Der Anschluss selbst darf zu seinem früheren zurück.
- Ohne Kennzeichen vergibt `NetzanschlussRegeln.kennzeichen(null, belegt, zaehler)` das nächste freie
  `NA-0001` unter der Zeilensperre des Zählers (Tabelle, keine Sequenz; rückt nur vor).
  `GET …/netzanschluesse` nennt es als `kennzeichen_vorschlag`, ohne zu vergeben.
- „Archivieren“ = das Ende setzen (`PUT` mit `gueltig_bis`, Tage wie §4.2 „bestehend ab/bis“); ein Ende
  wird nur vorgezogen (409 `bereits_beendet`).

## ⚠ Bewusst NICHT umgezogen (W9)

Die Preis- und Grenzspalten der Anlage (`site.max_feed_in_kw`, `site_supply_price` …) bleiben unverändert
an der Anlage; ihr Umzug mit Zeitgültigkeit ist das Folgepaket „Netzanschluss-Preisblatt“. `site` hat
KEINE Spalte `netzanschluss_id` — die Bindung ist die Tabelle (die Migrationsprobe prüft das).

## Befunde (PR-Text)

- **MaLo-Prüfziffer:** der Vertrag prüft nur `^[0-9]{11}$`, keine Prüfziffer — die Schnittstelle erfindet
  keine. Nach der gängigen BDEW-Regel (ungerade Stellen + 2 × gerade Stellen, Rest zu 10) ergäbe
  `4711000000` die Prüfziffer 9: die Ahrenberg-Nummern `…01`/`…02`/`…03` fielen durch. Eine Prüfziffer
  kommt nur mit Vertrag, Vektoren und neuen Beispielnummern.
- **Eindeutigkeit der Marktlokation** ist nicht Vertrag (zwei Anschlüsse mit derselben MaLo sind möglich).
- **Anlage am Standort des Anschlusses** ist nicht Vertrag und wird nicht geprüft (AN-2 zieht in den
  Ortsbaum-Vektoren den Standort, der Anschluss bleibt).
- Vektor-Familie: liegt seit IP-1 in `netzanschluss-vectors.json`, nicht in `ortsbaum-vectors.json`
  (`_abweichungen`); `ortsbaum-vectors.json` bleibt unverändert, ihr Anlagen-Feld wird jetzt gefüllt.

**Nicht gebaut:** Preis-Umzug (W9), Bilanz-Lesemodell (IP-9), Portal-Reiter (IP-13), Durchsetzung (AP-03).
