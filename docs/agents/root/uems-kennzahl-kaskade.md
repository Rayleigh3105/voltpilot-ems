# UEMS-Kennzahl-Kaskade: eine Korrektur zieht bis in jede Kennzahl durch (AP-11 IP-8)

Neu am 15.09.2026. Entscheid AP-11 **E8 = A** (14.09.2026), hier der **Reihen-Pfad**. Baut auf der Korrektur-Kaskade
(`uems-korrektur-kaskade.md`), dem Rechenlauf (`uems-kennzahl-rechenlauf.md`) und dem Lesen der Werte
(`uems-kennzahl-werte-lesen.md`) auf. Abnahme: eine Korrektur an einer Messreihe zieht sich ohne Zutun bis in jede
Kennzahl durch, die davon lebt — und die alte Zahl bleibt lesbar (K7).

| Teil | Stelle |
|---|---|
| Naht | `uems/KennzahlKaskade` — Bean; `KennzahlenNaht.Keine` ist keine Bean mehr (nur noch für Stufen-Tests) |
| Rechnen | `KennzahlLauf.nachKorrektur` — derselbe Code wie der Regellauf, mit `Kaskade` im `Kontext` |
| Lesen in der Transaktion | `KennzahlEingangLeser.mit(repo, versionen)` → `MessstelleWerteService.werte(…, WertVersionenLeser)` |
| Meldung | `uems/KennzahlNeuGebildet` → `kennzahl_neu_gebildet` (`V20260915061500`, Zwillinge wie `bilanz_neu_berechnet`) |
| Zeitpunkt | `KorrekturKaskade.Betroffen.jetzt` (additiv; der 13-stellige Konstruktor bleibt für die Bericht-Vektoren) |

## Der Weg

1. `Betroffen.reihen` → `messstelle_quelle` (Rolle `fuehrend`, Gültigkeit überlappt `[von, bis)`) → gemessene Messstellen;
   dazu `Betroffen.messstellen` (die berechneten, denen die Kaskade eine Version gab).
2. Jede nicht archivierte Kennzahl mit einer davon als Eingang einer wirksamen Fassung, rekursiv jede, die eine betroffene
   Kennzahl liest (`KennzahlLauf.betroffene`); Ordnung über `BerechnetePeriode.reihenfolge` (aufgerufen), Kreis benannt.
3. Je Kennzahl die Sperre `uems-kennzahl:` VOR dem ersten Lesen, dann jede Periode jeder Art, die `ersterTag…letzterTag`
   berührt: endgültig und geändert → Version n + 1, `anlass_art` `eingang`, `anlass_kennung` = der Beleg
   „K-2026-0007 (freigegeben 12.11.2026)“ (`KennzahlKaskade.beleg`: Kennung, Entscheidung, Tag der Fassung in der Zone),
   Kennzeichen „korrigiert (Version n + 1)“; vorläufig → zieht nach; unverändert → nichts.
4. Je Version n + 1 eine Meldung (Bezug `kennzahl`, [von, bis) = die Periode, Pflicht `ausloeser` und `version`).

## ⚠ Fallen

- **Sichtbarkeit.** Die Kaskade schreibt als Verwaltungsrolle in EINER offenen Transaktion; der normale Leser (App-Rolle,
  eigene Verbindung) sähe weder die neue Messstellen-Version noch die eben gebildete KZ-0001. Darum laufen genau die zwei
  Lesewege, die die Kaskade ändert, über `con`: Messstellen-Versionen ab 2 (`WertVersionenLeser`, Mandant im SQL) und
  gespeicherte Kennzahl-Werte (`KennzahlRepository`, nach Kennzahl-ID). Version 1, Quellen, Bezugsgrößen und Definitionen
  liest weiter die App-Rolle mit RLS. ⚠ Nie das ganze Lesemodell auf die Verwaltungsverbindung legen: sie ist BYPASSRLS,
  und eine Messstelle wird nach Kennzeichen gefunden.
- ⚠ **Befund, nicht gelöst:** die Herkunft einer berechneten Messstelle in Version n (`bilanzwert_eingang`, eben
  geschrieben) liest das Lesemodell weiter über die App-Rolle — in der Kaskade kann nur die `ursache` einer
  UNVOLLSTÄNDIGEN berechneten Messstelle fehlen (Kundensatz „MS-16 fehlt“).
- **V3 ohne Nummer.** Dieselbe Aussage aus denselben Eingängen ist keine Version n + 1 (`KennzahlRegeln.versionSatz`
  filtert „korrigiert (Version n)“ und „Berechnung geändert (Fassung n)“); eine geänderte Eingangs-Version zählt als
  Änderung — dasselbe Muster „Aussage UND was wirkt“ wie in den Stufen.
- **Wirft statt zu überspringen.** Liegt `Betroffen.jetzt` nicht nach der neuesten Zeile, oder schrieb jemand unter der
  Sperre, bricht die Naht ab: die ganze Kaskade rollt zurück und versucht es im nächsten Takt.
- **Beleg ≠ Kennung.** `anlass_kennung` trägt den SATZ (die Herkunft zeigt ihn byte-gleich zum Vektor, die Leseseite
  findet `K-…`/`EW-…` darin per Muster); die Meldung `kennzahl_neu_gebildet` trägt als `ausloeser` die Kennung allein.
  Die Routen liefern ungerundeten Dezimaltext (0,1473170732) — ein Test vergleicht auf vier Stellen (U4).
- **Kein Schalter.** `voltpilot.uems.kennzahlen.enabled` nimmt nur den Stundenschritt, nie die Naht (wie der Not-Aus der
  Kaskade nur ihren Takt nimmt).
- **Nachziehen trägt den Anlass seiner Version** — auch im Regellauf. Vorher schrieb er dort NULL, und der Trigger
  `kennzahl_wert_version_folgt` hätte das Nachziehen einer vorläufigen Version 2 abgewiesen.
- **Nicht gebaut:** der Nenner- und Definitions-Auslöser (`Betroffen.bezugsgroessen`, IP-9), die Berichte (AP-12 liest
  `kennzahl_neu_gebildet`), das Portal (IP-15).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='KorrekturKaskadeWiringTest,KennzahlLaufQuelltextTest,KennzahlVectorsTest')
(cd services/api && ./mvnw test -Dtest='UemsKennzahlKaskadeTest')   # Testcontainers: K7, alte Zahl lesbar, Rollback, V3
(cd services/api && ./mvnw test -Dtest='UemsKennzahlRechenlaufTest,KennzahlWerteApiTest')   # Testcontainers
```
