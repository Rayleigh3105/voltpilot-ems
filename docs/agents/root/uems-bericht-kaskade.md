# UEMS-Bericht-Kaskade: ein Bericht merkt, dass sich unter ihm etwas geändert hat (AP-12 IP-8, Pfad 1)

Neu angelegt am 15.09.2026, Meilenstein 3 „Revision ausgelöst“. Entscheide AP-12 E6/E7/E8 = A (14.09.2026). Keine
Migration, keine Fläche, keine Route. Baut auf der Korrektur-Kaskade (`uems-korrektur-kaskade.md`), dem Abzug
(`uems-bericht-abzug.md`), den Tabellen (`uems-bericht-tabellen.md`) und den Routen (`uems-bericht-routen.md`) auf; die
Regeln sind `docs/contracts/v2/bericht.md` B1/B4/B5/B7, R1, EW1/EW3.

| Teil | Stelle |
|---|---|
| Naht | `uems/BerichtKaskade` — Bean statt `BerichteNaht.Keine`; Flag `voltpilot.uems.berichte.enabled` (yml AN, surefire AUS; aus → `Keine`, die Tabellen bleiben) |
| Betroffen | `KennzahlKaskade.messstellen` (Reihe → führende, zeitgültige `messstelle_quelle`; `Betroffen.messstellen` nach Kennzeichen) → `bericht_quelle` (Mandant, `objekt_id`, Tage einschließlich) → `BerichtRegeln.betroffene` (je Bericht der gültige Stand vor dem Entwurf, nie ein ersetzter) |
| Entwurf | Entwurf `FOR UPDATE OF e` → `BerichtAbzugBildung.bilden(con, …, "kaskade")` → Meldung `bericht_entwurf_neu_gebildet` (`datenstand`, `anlass_kennung`) |
| Anstoß | gültiger Stand (höchste Nr. ohne „ersetzt durch“) → `bericht_revision_anstoss` `ON CONFLICT … DO NOTHING` → nur bei neuer Zeile `bericht_revision_angestossen` (`nr`, `anstoss_art`, `anlass_kennung`, `anlass_fassung`) |
| Meldungen | `MessreiheEreignisRepository.anhaengen` auf DER Verbindung der Kaskade (Urheber cloud, Kennung abgeleitet) |
| Tests | `UemsBerichtKaskadeTest` (Testcontainers) · `KorrekturKaskadeWiringTest` |

## ⚠ Fallen

1. **Die Uhr.** `Betroffen.jetzt` nimmt die Kaskade VOR ihrer Transaktion (`lauf(Instant.now())`), ihre Versionen tragen
   `created_at` = Beginn der Transaktion. Mit `jetzt` als Datenstand würfe D2, und die Kaskade rollte in jedem Takt
   zurück. Der Datenstand ist darum `max(jetzt, clock_timestamp())`, auf die nächste volle Sekunde AUFGERUNDET
   (sekundengenau wie die Meldungen). Tests mit einer Uhr in der Zukunft sehen `jetzt`.
2. **Wirft statt zu überspringen.** D2, ein fehlender Entwurf oder Stand, eine verworfene Meldung — jeder Fehler rollt die
   ganze Kaskade zurück, auch Stufen und Kennzahlen; der nächste Takt versucht es wieder. Einen Unternehmensbericht bildet
   `bilden` erst mit IP-6 — vorher gibt es auch keinen Unternehmens-Entwurf (Anlegen = 501), also keine Quelle, die trifft.
3. **Verwaltungsrolle ohne RLS:** jede Abfrage nennt `tenant_id`; die Bildung liest über dieselbe Verbindung und sieht so
   die eben geschriebene Version.
4. **Welcher Weg gilt, entscheidet die Kaskade** (`KorrekturKaskade.berichteBenachrichtigen`), nie die Naht.
5. **B7 gilt dem Anstoß, nicht dem Entwurf.** Derselbe Anstoß zweimal = eine Zeile, eine Meldung. Der Entwurf bildet sich
   bei jeder Wiederholung neu (Datenstand = seine Bildung, EW1) und meldet wieder — die Kaskade selbst wiederholt einen
   Anlass nicht (`messreihe_kaskade_wirkung`).
6. **Die Kennung von `bericht_entwurf_neu_gebildet`** enthält Datenstand UND Anlass: zwei Anlässe in derselben Sekunde
   sind zwei Meldungen (sonst verwirft das Vokabular die zweite als Fortschreibung → Abbruch). Die Route findet den Anlass
   über `nutzlast.datenstand` = Datenstand des Entwurfs (`BerichtRepository.anlassDerNeubildung`).
7. **Der Anstoß trifft den Stand, der beim Aufruf gültig ist** — hat eine Freigabe Nr. 2 inzwischen festgeschrieben, Nr. 2.

## Grenzen (benannt, nicht gebaut)

- **Bezugsgrößen** trägt Pfad 1 seit AP-11 IP-9 (`Betroffen.bezugsgroessen[]`: Quellen `bezugsgroesse`/`stammdatum`, Anstoß
  `bezugsgroesse_fassung`), ebenso eine rückwirkend geänderte Berechnung (Quellen `kennzahl`, `kennzahl_fassung_rueckwirkend`) —
  `dieBezugsgroesseTraegtPfadEinsSeitAp11Ip9_undStoesstNieDoppeltAn`, `uems-kennzahl-ausloeser.md`. Pfad 2 (AP-12 IP-9)
  lässt sie Pfad 1.
- **Kennzahl-Quellen** (KZ-…) trifft Pfad 1 über ihre Messstellen (mittelbare Quellen, B3); `kennzahl_neu_gebildet` liest
  die Naht nicht.
- **Unternehmensbericht:** der Kaskaden-Test nimmt als zweiten betroffenen Bericht den Jahresbericht ST-1; BR-2026-0002 (U)
  prüft der Vertragslauf gegen das Quellenverzeichnis der Datenbank — gebildet wird er erst mit IP-6.
- Archivierte Berichte behandelt die Naht wie alle anderen (B1 kennt keine Ausnahme).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='KorrekturKaskadeWiringTest,BerichtVectorsTest')
(cd services/api && ./mvnw test -Dtest='UemsBerichtKaskadeTest')   # Testcontainers: B1/B2/B3, B7, Rollback, Uhr, Vertrag, Grenze
(cd services/api && ./mvnw test -Dtest='UemsKorrekturKaskadeTest,UemsKennzahlKaskadeTest')   # Testcontainers
```
