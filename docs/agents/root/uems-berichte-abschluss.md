# UEMS-Berichte: Abschluss, Bestandsschutz und Flag-Nachweis (AP-12 IP-15, Meilenstein 7)

Das letzte der sechzehn AP-12-Pakete. Diese Seite ist der Einstieg in das ganze Berichtswesen: welcher Wegweiser welche
Schicht trägt, womit bewiesen ist, dass der Kern unberührt bleibt, was die Schalter wirklich schalten — und was ein Kunde
am Tag der Freigabe kann und was nicht. Stand: `uems` 52c715e0 (15.09.2026).

## Einstieg je Schicht

| Schicht | Wegweiser | Pakete |
|---|---|---|
| Vertrag, Vektoren, Zwillinge Java ⟷ TS, Referenzdatei 1.4 | `uems-bericht-vertrag.md` | IP-1 bis IP-3 |
| Tabellen (Stand append-only, Belege-Funktion) | `uems-bericht-tabellen.md` | IP-4 |
| Abzug bilden: Standort · Unternehmen, Kostenstellen, Kennzahlen | `uems-bericht-abzug.md`, `uems-bericht-abzug-unternehmen.md` | IP-5, IP-6 |
| Routen und Rechte (Freigabe, Vergleich, Anstoß verwerfen) | `uems-bericht-routen.md` | IP-7 |
| Naht Pfad 1 (Korrektur-Kaskade) · Läufer Pfad 2 (Struktur) | `uems-bericht-kaskade.md`, `uems-bericht-struktur.md` | IP-8, IP-9 |
| Ausgabe CSV (mit Bestand-Geräte-CSV) · PDF | `uems-bericht-ausgabe-csv.md`, `uems-bericht-ausgabe-pdf.md` | IP-10, IP-11 |
| Belegschutz | `uems-belegschutz.md`, Abschnitt in `uems-loeschwege.md` | IP-12 |
| Portal: Welt und Berichtsseite · Dialoge | `uems-berichte-portal.md`, `uems-bericht-dialoge.md` | IP-13, IP-14 |
| Nachweis nach den Fristen (die Abnahme) | `uems-bericht-nach-den-fristen.md` | IP-16 |

Die §8-Zelle nennt `uems-berichte-*.md`; die Dateien heißen seit IP-1 `uems-bericht-*.md` — nicht umbenennen, sonst brechen
die Verweise aus Übersicht, Code-Kommentaren und PR-Texten.

## Bestandsschutz

- **`UemsBerichteBestandsschutzTest`** fährt die Berichts-Maschine in Betriebsreihenfolge über MS-12 im Oktober 2026:
  Vergleichsstand ist der Oktober an der echten Kette (Rohwerte → Viertelstunden, Tage, Monat → endgültig) mit
  Rohwerten und Rollups des Kerns, bevor es einen Bericht gibt. Danach Anlegen, Entwurf, Freigabe Nr. 1, Stand/PDF/CSV,
  Liste, Vergleich; Pfad 2 über `StrukturAenderungLaeufer.lauf` (eine rückwirkende Ortskorrektur); Pfad 1 über die echte
  `BerichtKaskade` in EINER Transaktion mit der Monats-Stufe (`KorrekturKaskade.berichteBenachrichtigen`); Revision Nr. 2.
  Danach byte-gleich: jede Tabelle außerhalb `bericht%` (`Bestandsschutz.fingerabdruck`), die sechs Rollup-Tabellen,
  Verlauf und Export eines Messwerts (zwei Stunden gelesen und roh, ein Monat) und der Bestand-Geräte-CSV über seine Route
  als Kundenadministrator.
- ⚠ **Geteilte Tabellen mit Namen, nie ausgenommen:** AP-12 schreibt `bericht_freigegeben`, `bericht_revision_angestossen`,
  `bericht_entwurf_neu_gebildet`, `bericht_abgerufen` in `messreihe_ereignis` (`BERICHTS_MELDUNGEN` im Test). An Stelle
  anderer Pakete schreibt der Test die Protokollzeile `ort_korrigiert` (AP-04), K-2026-0007 und die Monats-Version 2 (AP-08).
  Wer eine neue AP-12-Schreibstelle in eine geteilte Tabelle legt, trägt sie dort ein.
- **Die Kaskade ohne Berichte:** `UemsKorrekturKaskadeTest` (surefire: `berichte.enabled=false` → `BerichteNaht.Keine`),
  Verdrahtung `KorrekturKaskadeWiringTest`. Bestand-Geräte-CSV gegen den Stand VOR AP-12: `BestandGeraeteCsvTest`
  (Vorher-Datei vom unveränderten Export) und die md5-Karte `UemsLesepfadMengenTest.FLAECHE_VORHER` (0de28e6e), beide
  über `BestandGeraeteCsvVergleich.ohneNeueKopfzeilen` — die neun Kopfzeilen tragen den Abrufzeitpunkt.
- **Die Rollups fasst AP-12 nicht an:** keine Migration seit 7d2713c0 nennt eine Rollup-Prozedur oder -Tabelle. Der Export
  wurde nur von IP-10 (neun Kopfzeilen, Recht) und AP-03 IP-5 (Standort-Zaun) geändert. Fallen wie beim Kennzahlen-Abschluss:
  Datenbank-Jobs aus (`alter_job … scheduled => false`), feste Uhr am Verlaufsdienst (`rohGrenze`), kein zweiter Takt.
- Der Belegschutz schreibt bei der Ablehnung nichts — bewiesen mit dem Fingerabdruck der ganzen Datenbank in
  `UemsBelegschutzApiTest.b12_…`.

## Die Schalter

| Schalter (Umgebung) | Vorgabe | Fundstellen | schaltet | schaltet NICHT |
|---|---|---|---|---|
| `voltpilot.uems.berichte.enabled` (`VOLTPILOT_UEMS_BERICHTE_ENABLED`) | AN | `application.yml:403`, `BerichtKaskade.java:58` (`matchIfMissing = true`), `BerichteNaht.java:78` (`Keine` bei false), surefire `pom.xml:330` AUS | die Naht Pfad 1 und damit auch den Läufer | Routen, Portal, Freigabe, PDF/CSV, Abruf-Protokoll, Belegschutz, 403 am Bestand-CSV, D4-Neubildung beim Abruf |
| `voltpilot.uems.berichte.struktur.enabled` (`VOLTPILOT_UEMS_BERICHTE_STRUKTUR_ENABLED`) | AN | `application.yml:411`, `StrukturAenderungLaeufer.java:57-58` und `StrukturAenderungSchedulingConfig.java:14-15` (beide Schalter, `matchIfMissing`), Takt 5 min, erste Runde 4 min nach dem Start (`:102-103`), surefire `pom.xml:335` AUS | nur Pfad 2 | die Naht |
| `voltpilot.uems.berichte.build` (`VOLTPILOT_BUILD`) | leer | `application.yml:397` | kein Schalter — die Build-Kennung im Regelwerk-Verzeichnis | — |

- **Deploy:** gitops `mamotec/gitops` main 83170cb (frischer Klon 15.09.2026): die `api` liest `base/api/api.env`,
  `base/config/common.env`, `site.env` und Secrets — **kein** `VOLTPILOT_UEMS_*`, **kein** `VOLTPILOT_BUILD`. Im Repo setzt
  weder `deploy.yaml`/`deploy-fast.yaml` noch eine Compose- oder Infra-Datei einen der Schalter (`rg VOLTPILOT_UEMS` trifft
  nur `application.yml` und Wiring-Tests). Ohne Eintrag gilt überall die Vorgabe AN.
- **Befund, bestätigt: die Berichte lassen sich nicht dunkel ausliefern.** Kein Schalter nimmt `BerichtController`
  (`web/BerichtController.java:57`, ohne Bedingung), `BerichtVorlagenController`, die Portal-Welt, die Dialoge oder die neue
  Ablehnung am Bestand-Geräte-CSV.
- **Anders als der Satz aus AP-11 („alle Kunden sehen die Welten“):** die Navigation zeigt „Berichte“ nur, wenn ein
  Standort misst — Kachel und Leiste am Unternehmen (`ebenenNav.ts:529`), Reiter (`App.tsx:1115`, `:1284`), Einstieg am
  Standort (`standortEinstiege`); „misst“ = Funktion „Messen“ eingerichtet, angehalten oder aktiv (`ebenenNav.ts:496-499`).
  Der Umstieg legt für „Messen“ **kein** Objekt an (A11, `uems-funktionen.md`), und auch keine Migration tut es. Ein
  Bestandskunde sieht am Freigabetag also keinen Weg zu den Berichten, bis jemand „Messen & Auswerten“ einrichtet — für
  die Kennzahlen gilt dieselbe Bedingung plus eine Kennzahl. **Das ist Sichtbarkeit, kein Schutz:** `#/portfolio/berichte`
  rendert ohne Bedingung (`App.tsx:1324`), `/api/v1/berichte` antwortet jeder berechtigten Person, und der Bestand-Geräte-CSV
  ist für die Unterstützung sofort 403.
- ⚠ **`VOLTPILOT_UEMS_BERICHTE_ENABLED=false` ist ein halber Zustand:** Anlegen, Freigeben, Abrufen laufen weiter, der
  Entwurf bleibt über D4 beim Abruf aktuell — aber ein freigegebener Stand bekommt nach einer Korrektur oder rückwirkenden
  Struktur KEINEN Anstoß (kein Banner „Revision nötig“). Pfad 1 holt ihn beim Wieder-Einschalten nicht nach (die Wirkung
  des Anlasses ist geschrieben); Pfad 2 schon (Wasserzeichen je Zeile).
- **Erstes Ausrollen:** keine Migration, kein Dev-Seed, keine Bestandsübernahme legt einen Bericht an (einzige
  Einfügestelle `BerichtRepository.java:114` hinter `POST /api/v1/berichte`); die Naht findet ohne `bericht_quelle` nichts.
  Der Läufer liest ab der ersten Runde ALLE Zeilen von `ort_aenderung` (verschoben, korrigiert, flaeche_geaendert) und
  `messstelle_aenderung` (ort_zugeordnet, ort_korrigiert, verteilung_geaendert) aller Kundenbereiche, höchstens 200 je Takt,
  und schreibt je Zeile ein Wasserzeichen — auch ohne Bericht (`StrukturAenderungLaeufer.java:173`).

## Am Tag der Freigabe

**Ein Kunde kann** (sobald ein Standort misst): Monats- und Jahresberichte für Standort und Unternehmen anlegen (vier
Vorlagen, Kennzahlen abwählbar), den Entwurf mit Datenstand und Voraussetzungen lesen, ihn als Berichtsstand freigeben
(Kopie mit Prüfsumme, unveränderlich), Entwurf gegen Stand vergleichen, einen Anstoß verwerfen, als Revision Nr. n + 1
freigeben; Stände bleiben nach Korrekturen und abgelaufenen Rohdaten lesbar (IP-16). Anstöße kommen von selbst: Korrektur,
Bezugsgrößen-Berichtigung, rückwirkende Kennzahl-Fassung (Pfad 1), rückwirkende Zuordnung, Fläche, Verteilung (Pfad 2);
Folgen-Dialoge nennen „Freigegebene Berichte: …“. Zitierte Messstellen sind an sechs Kunden-Löschwegen geschützt. Rechte
G1–G3 sind durchgesetzt (fremder Standort 404, fehlendes Recht 403); Bestandsnutzer sind Kundenadministratoren und dürfen
alles.

**Ein Kunde kann nicht:**

1. **Einen Berichtsstand im Portal als PDF oder CSV herunterladen** — `AUSGABE_EINGEHAENGT = { pdf: false, csv: false }`
   (`berichtSeite.ts:649`). Die Routen `…/staende/{nr}/pdf` und `…/csv` stehen und sind geprüft; es fehlt nur der Knopf. Auch
   „zuletzt abgerufen“ und die Spalte „letzter Abruf“ zeigt das Portal nicht (`BerichtePage.tsx:37`). **Die größte Lücke:**
   ein Bericht, den man nicht weitergeben kann.
2. **Den Tagesverlauf oder Monatswerte im Bericht sehen** — der Abzug trägt sie nicht (`vp-uems-b12-tagesverlauf-speicher`).
3. **Laden und Entladen des Speichers getrennt sehen** — MS-04 ist eine Netto-Menge, `speicher_laden_kwh`/`_entladen_kwh`
   fehlen (fehlend, nicht 0) — dito.
4. **Zwei CSV-Zellen je Kennzahl** (`ort`, `endgueltig_ab`) — leer bis Abzug 1.2 — dito.
5. **Bei PV aus Leistung das Kennzeichen „aus Leistung integriert …“** im Bericht (MS-03, Lücke 5 aus IP-5).
6. **Eine Messstelle ohne Ort, die nur über die Anlage zum Standort gehört** (MS-22 „Rest“) im Standort-Bericht — Q3 über die
   Anlage ist nicht gebaut.
7. **Gas und Wärme in der Zusammenfassung** (nur Strom in kWh), Vergleichswerte je Messstelle (nur Zählungen), einen
   Ortswechsel im Zeitraum als „bis … · ab …“.
8. **Die Kennzahl-Abwahl nach dem Anlegen ändern** oder eine Kennzahl wieder wählen.
9. **Am Banner „Revision nötig“ sehen, wer was geändert hat** — die Route liefert am Anstoß weder Person noch Quelle.
10. **Sich auf den Belegschutz an Verwaltungswegen verlassen:** Verwaltungs-Löschen einer Komponente und Re-Pin-Aufräumen
    prüfen nicht (`vp-uems-belegschutz-verwaltungswege`); der Satz „zitiert in …“ kommt erst NACH dem Bestätigen; einen Knopf
    „Bindung beenden“ gibt es nicht.
11. **Nach den Fristen überall „nicht mehr gespeichert“ lesen** — nur Monat und Jahr der Werte-Route antworten 404
    `wert_nicht_mehr_gespeichert`; Tag, Viertelstunde, Stunde, Versionen, Kennzahl-Werte und Kostenstellen sagen still
    „keine Werte“, eine berechnete Messstelle prüft die Frist nicht. Der Bericht selbst bleibt lesbar.
12. **Sich darauf verlassen, dass D4 jede Kostenstellen-Quelle fragt** — `BerichtRepository.aenderungenSeit` fragt sie noch
    nicht eigens (`uems-bericht-routen.md`; benannt, nicht nachgeprüft).
13. **Als Unterstützung (Plattform, Partner) Geräte-Messwerte exportieren** — 403, und das Portal sagt beim Klick nichts
    (`void downloadMeasurementExport`, `BeobachteteRegister.tsx:653`). Release-Note unten.
14. **Im Regelwerk-Verzeichnis eine Git-SHA lesen** — `VOLTPILOT_BUILD` ist im Cluster nicht gesetzt; der Abzug nennt Version
    und Build-Zeit (gitops-Runde, Roadmap Teil F).
15. **Stück- oder kg-Werte im Portal eingeben** — „kWh je Stück“ bleibt im Bericht ohne API-Eintrag leer
    (`uems-kennzahlen-abschluss.md` Punkt 1).
16. **Berichte ohne „Messen & Auswerten“ über die Navigation finden** (siehe Schalter) — nur per Adresse.

Bewusst draußen (entschieden, keine Lücke): Erlöse (E3 = A), Vier-Augen bei der Freigabe (E5 = A).

**Urteil:** die Kernzusage steht und ist ausführbar bewiesen — ein Stand ist eine Kopie, erklärt sich nach Korrekturen und
Fristen (IP-16), wird nie geändert, bekommt Revisionen von selbst, und der Kern bleibt byte-gleich. Freigabefähig mit den
benannten Lücken; vor einer Freigabe an Kunden wiegen Punkt 1 (kein Download im Portal) und das fehlende Dunkel-Schalten
am schwersten.

## Release-Note „Unterstützer: kein CSV mehr“

Zum Kopieren (Kundenbereich, Support):

> **Messwert-Export: die VoltPilot-Unterstützung lädt keine CSV-Datei mehr herunter.** Der Export „CSV mit Metadaten
> exportieren“ im Verlauf eines Messwerts gehört jetzt zum Recht „Export je Standort“. Kundenadministratoren und
> Energiemanager exportieren wie bisher, Bearbeiter, Bedienberechtigte und Leser für ihre Standorte. Die Datei hat dieselben
> Spalten und Zeilen wie bisher und neun zusätzliche Kopfzeilen: Zeitraum von und bis, erzeugt am, erzeugt von, Zeitzone,
> Dezimalzeichen, Trennzeichen, Standort, Unternehmen. Wer als VoltPilot-Unterstützung oder Partner in einem Kundenbereich
> arbeitet, bekommt die Datei nicht mehr — Messdaten verlassen den Kundenbereich nur durch den Kunden selbst.

Intern dazu: die Schaltfläche bleibt für die Unterstützung sichtbar, ein Klick tut nichts Sichtbares (403 ohne Meldung) —
wer fragt, bekommt diesen Satz. Ohne OIDC (nur Entwicklung) ist der Export 401 wie jede UEMS-Route. Matrix-Zeile
`export.standort` (`docs/contracts/v2/rechte-matrix.json`), Test `BerichtApiTest.derBestandGeraeteCsvGehoertZuExportStandort_…`.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest=UemsBerichteBestandsschutzTest)   # Docker; ohne Docker laut übersprungen
(cd services/api && ./mvnw test -Dtest='UemsKorrekturKaskadeTest,UemsLesepfadMengenTest')   # Docker
(cd services/api && ./mvnw test -Dtest='BestandGeraeteCsvTest,KorrekturKaskadeWiringTest,StrukturAenderungWiringTest')
bash tools/agents-md-budget.sh
```
