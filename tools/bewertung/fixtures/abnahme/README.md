# Fixture-Welt des Abnahme-Tests AP-20 (AP-20 IP-23, AP-20 NW-6)

**FIXTURE — nichts hier hat stattgefunden.** Keine Datei bewertet VoltPilot, keine Person hat etwas
bestätigt, kein Durchlauf und keine Übung ist gefahren. Die Welt dient allein
`tools/bewertung/test_abnahme.py`, das die zwölf Referenzfälle RF-01 … RF-12 des Konzepts
(`FM/vp-uems-ap20-fundament/report.md` §7) durch die echten Werkzeuge fährt. Die echte Lesart kommt mit
AP-20 IP-12, der echte Durchlauf mit AP-20 IP-14, die echten Übungen und Bestätigungen vom Betreiber
(AP-20 IP-19) — an denselben Fällen.

## Stände

Zwei leere Commits in einem Wegwerf-Repo, fester Autor „Fixture AP-20 IP-23“, festes Datum (der Test baut
sie und bricht ab, wenn git andere Kennungen bildet):

| Stand | Kennung | trägt |
|---|---|---|
| Tor-Beleg G1, 19.09.2026 | `513f6b35a…` | `laeufe/tor-g1/` (RF-11) |
| gebauter Stand, 28.09.2026 | `dcd7db409…` | `laeufe/gebaut/`, Übung, Nachweise der Übergänge |

## Dateien

| Datei | Inhalt | Fälle |
|---|---|---|
| `matrix.json` | Alle 30 Norm-Zeilen (Träger 15 · 7 · 4 · 4, wie im Repo), die neun Kundenaufgaben, die Zusagen der Fälle: Z-002, Z-004, Z-005, Z-009, Z-010, Z-012, Z-015, Z-016. 4.4, 6.3 und 9.1.1 stehen wie vor AP-20 IP-7 mit L-012. Z-010 steht wie vor AP-20 IP-6 ohne Kandidaten. Z-015 nennt nur den Weg über die Rückweg-Übung. Z-016 ist das Vertragsende nach E10 = A (Kurzform der Fixture). Jeder Kandidat existiert im Repo (Klammer). | alle |
| `luecken.json` | Die zwölf Lücken des Fundaments im Startbestand vom 25.09.2026, jede offen; `betrifft` nur Zeilen dieser Matrix | RF-02, RF-06, RF-08 … RF-12 |
| `uebergaenge.json` | spätere Übergänge je Fall: L-003 → behoben, L-004 → Restpunkt (RF-06), L-001 → behoben (RF-08), L-009 → behoben (RF-09) | RF-06, RF-08, RF-09 |
| `laeufe/gebaut/`, `laeufe/tor-g1/` | Surefire-Berichte mit Methoden wie im Repo und erfundenen Zahlen, je mit `stand.txt` | RF-01, RF-08, RF-09, RF-11 |
| `blatt/vor-der-uebung.yaml`, `blatt/nach-der-uebung.yaml` | Stand-Blatt des Betreibers: Q15 nicht bestätigt bzw. bestätigt | RF-02, RF-06, RF-07 |
| `uebungen/U-2026-01.json` + `rueckweg.json` | die Rückweg-Übung mit Artefakt und Prüfsumme | RF-02, RF-06, RF-07 |
| `fachperson-rf03.json` | die Lesart zu 9.2.2 (Name, Datum und Aussage aus dem Konzept, E4) | RF-03 |
| `beschreibung/pb-01.json` | der Entwurf PB-01, wörtlich aus dem Konzept | RF-09 |
| `pilot/PA-2026-01.json` + `.sha256` | das Protokoll des Pilot-Durchlaufs mit Prüfsumme | RF-10 |
| `vertragsende/` | Selbstauskunft „beendet“, Gesamtabzug (Auszug mit `manifest.json` und `pruefsummen.sha256`) und Löschnachweis in der Form des Produkts | RF-08 |

Neu erzeugt wird hier nichts; wer die Welt ändert, ändert die Dateien von Hand und fährt den Test.

## Was die Fälle NICHT abdecken

- **RF-08** läuft im Produkt. Die 409 an jedem Schreibweg, der Satz für den Kundenadministrator, der Abzug
  aus der Datenbank und das Löschen nach der Frist prüfen `KundenbereichBeendetApiTest`,
  `GesamtabzugApiTest` und `KundenbereichLoeschenApiTest` (Testcontainers). Hier zählen nur ihre
  Lauf-Berichte (die Matrix bindet Z-016 an je eine Methode), das Manifest mit seinen Prüfsummen und der
  Löschnachweis gegen die Spalten der Migration `V20260925223000`.
- **RF-10** hat noch keinen Protokoll-Leser (AP-20 IP-14). Geprüft werden Prüfsumme, Person nach NR4, die
  Ziele der Befunde (L-009 auf der Lückenliste hält Z-004 offen, KA-08 ohne Urteil) und G2 an den
  Kundenflächen des Repos. Dass in Ahrenbergs Feststellungen nichts entsteht, prüft erst der Durchlauf an
  der Prüfumgebung (AP-20 IP-13, IP-14).
- **RF-03, RF-07, RF-10**: der Test zeigt, wie die Werkzeuge eine Lesart, eine Übung und ein Protokoll
  lesen. Dass es sie gibt, zeigt er nicht.
- **RF-05** liest die Release-Notiz-Vorlage des Repos (`docs/rollout/release-notiz-vorlage.md:42`); zieht
  die Zeile um, zieht die Matrix im Repo und diese Fixture mit.
