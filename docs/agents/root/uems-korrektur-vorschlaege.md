# UEMS-Korrektur-Vorschläge: das System schlägt vor, freigegeben wird von Hand (AP-08 IP-14)

Neu angelegt am 13.09.2026. Entscheid AP-08 **E14 = A** (11.09.2026). Baut auf der Korrektur-Tabelle von IP-12
(`uems-korrektur-ersatzwert.md`), der Erkennung nach der Frist von AP-07 IP-13 (`uems-endgueltigkeit-tageswerte.md`)
und der Versionsregel von IP-13 (`uems-ersatzwert-methoden.md`) auf.

| Teil | Stelle |
|---|---|
| Regeln (rein) | `uems/KorrekturVorschlagRegeln`: Begründung, Vorschau alt/neu, Sperre, Zeiträume |
| Vertrag | `docs/contracts/v2/korrektur-vorschlag-vectors.json` (Muster, Notizen, Sätze, Vorschau-Form, Ablehnungen) |
| Lauf | `uems/KorrekturVorschlagLauf` — im STUNDENLAUF `EndgueltigkeitLaeufer` als letzter Schritt (kein eigener Schalter) |
| „neu“ | `ViertelstundeVerdichter.waereZeile` — dieselben Ladewege und dieselbe Regel wie `bilden`, geschrieben wird nichts |
| Migration | `V20260913224500`: INSERT der BYPASSRLS-Rolle auf die anlegenden Spalten + Trigger `messreihe_korrektur_system_nur_vorschlag` |

## ⚠ Nie automatisch — auch nicht, wenn nur Lücken gefüllt werden

Der Captain hat die Ausnahme „es wird ja nur eine Lücke gefüllt“ ausdrücklich VERWORFEN: eine Zahl, die vorher
„keine Werte“ hieß, ist für den Kunden eine Änderung. Darum:

- Der Lauf schreibt KEINE Zeile in `messreihe_viertelstunde`, `…_version`, `messreihe_tag`, `messreihe_periode` —
  nur `messreihe_korrektur` (Fassung 1), den Marker `correction` in `messreihe_ereignis` und `zustand` an
  `messreihe_korrektur_vorschlag`. Benannter Test: `UemsKorrekturVorschlaegeTest.bisZurFreigabeAendertSichKeineZahlUndKeineVersion`
  (Bestandsschutz-Fingerabdruck aller übrigen Tabellen vor/nach sechs Läufen) und
  `…einVorschlagDerNurEineLueckeFuelltErzeugtKeineVersionZwei`.
- Die DATENBANK hält es fest: die BYPASSRLS-Rolle darf nur Fassung 1 (= `vorschlag`) anlegen; eine Freigabe über
  sie scheitert am Trigger, ein `grund` fehlt ihr als Spaltenrecht (`…derSystemWegKannNichtFreigeben`).
- Eine Vorschau ohne Änderung erzeugt KEINEN Vorschlag (`ohne_aenderung`); die Zeilen der Erkennung gehen dann auf
  `verworfen` mit Notiz.

## Die drei Quellen

1. **Nachlieferung nach der Frist** (F10) — die BRÜCKE: offene Zeilen von `messreihe_korrektur_vorschlag` einer Reihe,
   aufeinanderfolgend, werden EINE Korrektur `nachlieferung_nach_endgueltigkeit` und gehen in derselben
   Transaktion auf `erledigt` („Aufgenommen in den Korrektur-Vorschlag K-…“). Die Tabelle von PR 702 bleibt
   unverändert. Vorher zählt `SpaetankunftMelder.melden` die Zeilen unter `FOR UPDATE` neu (eine zweite Welle steht
   dann mit drin); eine Gruppe WARTET, solange ihr letzter Eingang jünger als `RUHE` (15 min) ist oder die
   Verdichtung für die Reihe noch Arbeit hat. ⚠ Der Nachbar davor/danach kommt in die Vorschau, wenn er sich
   ändert: ein nachgelieferter Wert genau auf der Grenze ist der Endstand der Viertelstunde davor (Z1).
   Seit AP-08 IP-19 kommt JEDE Nachlieferung nach der Frist hier an, gleich aus welchem Grund ihr Intervall in
   der Arbeitsliste stand; vor der Frist bildet die Verdichtung automatisch neu und es entsteht kein Vorschlag
   (Paar F9/F10 in `UemsFristVorschlagTest`).
2. **Ablesestände nach der Frist** (F12) — `device_boundary` mit `endstand`/`anfangsstand`, eingegangen nach
   `endgueltig_ab` einer endgültigen Viertelstunde (Auswahl wie `BruchEreignisse`, Rückblick 90 Tage = Rohwerte);
   Art `ablesestaende_nachgetragen`. Ein nachgetragener Ersatzwert der Methode d ist NICHT diese Quelle (IP-13).
3. **Umklassifizierung** (E4, F7) — `KorrekturVorschlagLauf.umklassifizierung(tenant, entity, kanal, zeitpunkt,
   als_ueberlauf|als_ruecksetzung, modul, akteur, jetzt)`: der Bearbeiter fragt, das System rechnet mit
   umgedeuteter Zähler-Deklaration durch dieselbe Regel und legt den Vorschlag MIT DEM BEARBEITER als Ersteller an.
   Die Bestätigung ersetzt die Höchstzuwachs-Schranke (Deklaration Modul/Modul je 1 s), nicht den Wertebereich;
   ohne Modul `wertebereich_fehlt`, fremde Reihe `reihe_unbekannt`. Noch ruft keine Route an (IP-16).

## ⚠ Die Doppelvorschlag-Sperre

Fachlicher Schlüssel = Kundenbereich + Art + Reihe + Zeitraum, nie ein Zeitstempel; geprüft unter
`pg_(try_)advisory_xact_lock` je Reihe, kein Index (der Status steht in späteren Fassungen).

- `liegt_schon_vor`: ein NICHT entschiedener Vorschlag derselben Art überschneidet den Zeitraum → nichts entsteht,
  die Zeilen der Erkennung bleiben offen.
- `schon_entschieden`: ein entschiedener über GENAU diesen Zeitraum schlug dieselben NEUEN Werte vor (alt zählt
  nicht) → nichts entsteht, die Zeilen gehen mit Verweis auf ihn auf `erledigt`. Neue Werte = neue Tatsache = neuer
  Vorschlag.
- Belegt mit zwei Stundenläufen, mit wieder geöffneten Zeilen und nach einer Ablehnung
  (`…zweimalDerselbeStundenlaufErzeugtEinenVorschlag`, `…dieSperreHaengtAmSchluesselUndAnDerEntscheidung`).

## Begründung und Vorschau

- Die Begründung sagt, was das System GESEHEN hat, nie, was der Mensch tun soll (Wächter in `copy.test.ts`, u. a.
  „angefragt“ ist verboten). Uhrzeit über `ErgebnisZustand.uhr` (MESZ/MEZ an der doppelten Stunde), Anzahl mit
  Tausenderpunkt; 10–500 Zeichen (`messreihe_korrektur_text_gueltig`).
- Vorschau je Viertelstunde `{periode, von, bis, aendert, alt, neu}`; `alt` = neueste Version (Version 1, darüber
  Menge/Zustand/Kennzeichen einer Version ≥ 2), ohne Zeile `version: null` + „keine Werte“; `neu.version` immer
  `null`. Beträge als Dezimaltext, ungerundet.
- Marker `correction` (Urheber `cloud`, Status `vorschlag`, abgeleitete Kennung) in derselben Transaktion — die
  Cloud meldet nie mehr.

## Grenzen und Befunde

- Nur die Viertelstunde: Tag/Monat/Jahr und jede Version bildet die Kaskade (`uems-korrektur-kaskade.md`; sie wendet
  die Vorschau „neu“ an, `Stand.gleich` vergleicht ohne „korrigiert (Version n)“); Freigabe und
  Vier-Augen seit IP-15 (`uems-vieraugen-freigabe.md`), Anlegen und Portal IP-16.
- Liegt ein wirksamer Ersatzwert auf derselben Viertelstunde, zeigt „neu“ die Rohwert-Rechnung (ohne Ersatzwert).
- Befund AP-07: `SpaetankunftMelder` rührt eine erledigte Zeile nie wieder an — eine Welle, die NACH dem Bündeln
  für dieselbe Viertelstunde eintrifft, meldet `late_arrival`, erzeugt aber keine offene Zeile mehr. `RUHE` und der
  Arbeitslisten-Check machen das selten, nicht unmöglich.
- Befund IP-13: `ErsatzwertLauf` bildet Version 2 aus einem wirksamen Ersatzwert ohne Korrektur-Freigabe (§4.6 sieht
  „Ersatzwert eingetragen“ als Korrektur-Art vor) — gehört zu IP-15/IP-17, hier nicht geändert.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='KorrekturVorschlagRegelnTest,EndgueltigkeitWiringTest')
(cd services/api && ./mvnw test -Dtest='UemsKorrekturVorschlaegeTest,UemsKorrekturErsatzwertMigrationTest')   # Testcontainers
(cd frontend/portal && npx vitest run src/copy.test.ts)
```
