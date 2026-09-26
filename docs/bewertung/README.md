# Bewertung: die Nachweismatrix von VoltPilot (AP-20)

VoltPilot bewertet sich selbst: jede Zusage an einen UEMS-Kunden bekommt einen prüfbaren
Beleg an Stand, Datum und Person oder Lauf. Alles Ungeprüfte bleibt **offen** und nennt, wer
liefert. Dieser Ordner ist ein **Betreiber-Dokument** und erscheint nie auf einer Kundenfläche.
Abschnittsnummern der Norm stehen hier und in der Übersicht für Prüfende, sonst nirgends.

> Eine mögliche Softwarezertifizierung, Förderlistung oder rechtliche Bewertung entsteht nicht
> automatisch durch dieses Paket.

VoltPilot sagt über sich nie „erfüllt“, „konform“, „zertifiziert“ oder „vollständig“ (MX4).
Gezählt wird nur je Urteil und je Träger, nie in Prozent.

| Datei | Inhalt | Paket |
|---|---|---|
| [`nachweismatrix.schema.json`](nachweismatrix.schema.json) | Vertrag: Felder, Pflichten je Urteil, Vokabulare, Gliederung | AP-20 IP-2 |
| [`nachweismatrix.json`](nachweismatrix.json) | die Matrix mit Normfassung und Stichtag; Zusagen-Teil seit IP-5, Norm-Teil seit IP-7, Kundenaufgaben seit IP-8 | AP-20 IP-2, IP-5, IP-7, IP-8 |
| [`luecken.json`](luecken.json), [`luecken.schema.json`](luecken.schema.json) | Lückenliste des Betreibers (L-nnn) mit Verlauf je Übergang, nie beim Kunden | AP-20 IP-3 |
| [`uebungen/`](uebungen/README.md), [`uebung.schema.json`](uebung.schema.json) | Übungen des Betreibers (U-JJJJ-nn): Rückweg-Übung und Alarm-Übung mit Artefakt und Prüfsumme, Vorlagen; gelesen von `tools/bewertung/uebungen.py` (RF-07); Z-015 urteilt `pruefe_matrix.py` daraus (Stand, Frist, Q15 mit Person) | AP-20 IP-19 
| [`vorschlaege/gitops/`](vorschlaege/gitops/README.md) | Regel `VoltPilotSicherungZuAlt` mit promtool-Test als Vorschlag; als Zweig nach gitops, gemergt vom Captain | AP-20 IP-19 |
| [`bewertungen/`](bewertungen/) | Entwürfe des Matrix-Prüfers (`BWB-JJJJ-nn.json`, `.md`, `.sha256`), je Lauf ein Laufprotokoll: Befehle, übersprungene Fälle, nicht gefahrene Klassen | AP-20 IP-10 |
| [`pruefpaket/`](pruefpaket/pruefpaket.md) | Prüfpaket für die Fachperson: Norm-Teil ohne Normtext, Frageliste, Protokoll-Vorlage, `.sha256`; gebaut von `tools/bewertung/pruefpaket.py` | AP-20 IP-11 |
| [`beschreibung-saetze.json`](beschreibung-saetze.json), [`produktbeschreibung/`](produktbeschreibung/beschreibung.md) | Satz-Quelle mit Bindung je Satz (§5.8 wörtlich); daraus erzeugt: Beschreibung, Übersicht für Prüfende, Wächter-Lauf, `.sha256`; heute **Entwurf** an BWB-2026-01 | AP-20 IP-21 |
| [`../../tools/bewertung/`](../../tools/bewertung/) | Vertragstest (AP-20 NW-1), Wachen des Zusagen-Inventars (`zusagen.py`) und der Lückenliste (`luecken.py`, AP-20 NW-3), Matrix-Prüfer (`pruefe_matrix.py`, AP-20 NW-2), Beschreibung mit Wächter (`produktbeschreibung.py`, AP-20 NW-4) | AP-20 IP-2, IP-3, IP-5, IP-4, IP-21 |

## Aufbau (MX1, MX2)

Eine Datei, zwei Teile, dazu die Kundenaufgaben. Verbunden sind sie über Abschnittsnummern.

- **Norm-Teil**: je Abschnitt der Gliederung 4 bis 10 eine Zeile. Das sind 30 Zeilen: die 26
  Abschnitte der zweiten Ebene, dabei 7.5, 9.1 und 9.2 in ihre Unterabschnitte geteilt. Die
  Gliederung steht als Liste `abschnitt` im Schema. Eine Zeile trägt nur Nummer und
  **eigene Umschreibung** (höchstens 160 Zeichen): **kein Normtext im Repo.** Einzelanforderungen
  liest die Fachperson an ihrer lizenzierten Ausgabe. „Vollständig“ heißt beim Norm-Teil nur,
  dass jede Zeile der Gliederung existiert. Erfüllt ist damit nichts.
- **Zusagen-Teil**: je Zusage eine Zeile `Z-nnn` mit Wortlaut, Quelle (`datei:zeile`), Träger,
  Abschnitten (oder keinem), Nachweis-Kandidaten, Nachweisen, Urteil und Lücken (MX3).
- **Kundenaufgaben** `KA-nn`: was außerhalb der Software beim Kunden bleibt. Jede Norm-Zeile
  nennt genau eine Kundenaufgabe, auch wenn VoltPilot den Abschnitt festhält. Eine
  Kundenaufgabe hat **kein Urteil** (NR5).

Die Verweise gelten in beide Richtungen. Nennt eine Norm-Zeile `Z-005`, nennt `Z-005` auch
diesen Abschnitt. Dasselbe gilt für Norm-Zeile und Kundenaufgabe. Die Teile sind nacheinander
entstanden: Zusagen (IP-5), Norm-Teil (IP-7), Kundenaufgaben (IP-8). Seitdem wird jeder Verweis
geprüft, auch in einen leeren Teil.

## Zusagen-Inventar (AP-20 IP-5, E1 = A)

Der Zusagen-Teil trägt jede Zusage an einen UEMS-Kunden aus den Orten, an denen VoltPilot zusagt.
Je Satz eine Zeile. Mehrere Sätze stehen nur dann in einer Zeile, wenn sie zusammen eine Zusage
sind, etwa Z-011.

| Ort | Zusage-Art | Quelle |
|---|---|---|
| Plan-Abnahmen AP-01 … AP-19, Ergebnis AP-00 | `plan_abnahme` | `PG/plan.md:zeile` |
| Release-Notiz-Vorlage, jeder Satz | `release_notiz` | `docs/rollout/release-notiz-vorlage.md` |
| Box-Notiz (Abschnitt „Software-Aktualisierung der Box“ der Vorlage) | `box_notiz` | dieselbe Datei |
| Kundensätze der Flächen: Grenz-Satz und Verantwortungs-Satz | `flaeche` | `frontend/portal/src/glossar.ts` |
| Anmelde-Zeile | `anmeldung` | `AuthScreen.tsx`, Keycloak-Thema |
| Betriebszusagen: Sicherung, Aufbewahrung, Zugriffsschutz | `betrieb` | `docs/backup-restore.md`, `PG/`, `FM/` |

Hilfe, Wegweiser und Fachmodell sagen nichts zu. Die Hilfe hat keinen UEMS-Artikel, Wegweiser und
Fachmodell sind Arbeitsregeln. Die Kennzeichen Z-001 … Z-018 stammen aus dem Konzept und bleiben,
weil Lückenliste und spätere Pakete sie nennen.

**Quelle** ist `datei:zeile`, Bereiche als `von–bis`, mehrere Zeilen als `datei:45, :62`, mehrere
Dateien durch `; ` getrennt. `PG/` ist der Programmplan und `FM/` die Ablage eines Pakets. Beide
liegen außerhalb des Repos beim Captain. `<rev>:datei:zeile` zitiert einen festen Stand. Der
**Wortlaut** ist wörtlich. Eine Kurzform trägt `(Kurzform` im Wortlaut.

**Urteil.** Jede Zeile ist `offen` und nennt, wer liefert (NR7). Die Kandidaten hat AP-20 IP-6
zugeordnet (AP-00 … AP-15, Betrieb und die übrigen Sätze der Notizen), AP-20 IP-7 den ISO-Strang
AP-16 … AP-19 mit den Abschnitten (siehe unten).

**Bedingung** `gilt_solange` (wahlfrei, AP-20 W3). Ist ein Satz nur unter einer Bedingung wahr, steht sie
an der Zusage, und die Bewertung nennt sie mit. Endet die Bedingung, braucht der Satz vorher eine neue
Fassung. Heute trägt nur Z-011 eine: „keine Kundenanlage mit aktiven Anteilen“. Der Schlusssatz der
Release-Notiz stimmt nur, solange die gemeinsame Steuerung aus AP-15 bei keinem Kunden läuft. Die
neue Fassung vor der ersten solchen Anlage gibt der Captain.

**Die Wache** `tools/bewertung/zusagen.py` (MX5) ist rot, wenn

- ein Satz der Release-Notiz-Vorlage in keinem Wortlaut einer Zusage steht, deren Quelle die
  Vorlage nennt. Rahmen sind nur die Anleitung vor dem ersten Abschnitt, Überschriften, Betreff und
  Anrede. Der Betreff wiederholt den ersten Satz, der die Zusage trägt.
- eine Quelle nicht `datei:zeile` ist oder ihre Zeilen im Repo fehlen.
- der Wortlaut nicht an seinen Zeilen steht. Verglichen wird über Buchstaben und Ziffern, damit
  Anführungszeichen und Umbrüche im Quelltext nicht zählen. Eine Kurzform prüft nur die Zeilen. Hat
  sich eine Zeile nur verschoben, nennt die Wache die neue Zeile. Die Quelle wird dann mitgezogen.
- mit `--plan <pfad zu plan.md>` ein Satz der Plan-Abnahmen ohne Zusage bleibt.

Wer einen Kunden-Satz ändert, ändert die Zusage mit. Entfällt ein Satz, bleibt die Zusage stehen:
ihre Quelle zeigt dann auf den Stand, an dem der Satz galt (`<rev>:datei:zeile`).

## Norm-Teil (AP-20 IP-7, W7, W9)

Der Norm-Teil trägt die 30 Zeilen der Gliederung. Jede Zeile nennt Abschnitt, eigene Umschreibung,
Träger, die Zusagen des Abschnitts, genau eine Kundenaufgabe und die Herkunft der Zuordnung. Das
Urteil bleibt `offen`, bis die Fachperson ihre Lesart an der lizenzierten Ausgabe einträgt
(AP-20 IP-12). Die Umschreibung ist kein Titel und kein Normtext, sondern sagt, worum es geht.

- **Eingabe** ist die Spalte `norm_intern` von `FM/vp-uems-ap19-fundament/zuschnitt.json`. „Z. n“ in
  der Herkunft ist der n-te Eintrag von `zeilen`. Den Leistungsteil 6.2 … 6.6 tragen die Ist-Berichte
  von AP-16 … AP-18.
- **Zählung je Träger (RF-12):** 15 `haelt_fest`, 7 `verweis`, 4 `misst`, 4 `beim_kunden`. Der
  Prüfer druckt sie, der Vertragstest hält sie fest. Wer einen Träger ändert, ändert den Test mit.
- **L-012 ist geheilt.** 4.4 liegt ganz beim Kunden (KA-01), 6.3 hält VoltPilot mit AP-16 fest, 9.1.1
  misst VoltPilot mit Messung, Kennzahlen, Berichten und Leistungsvergleich. Ihre Herkunft beginnt mit
  „zugeordnet in AP-20 IP-7 (L-012)“.
- **Die Klimafrage** aus der Änderung 1 steht an 4.1 und 4.2 als Kundenaufgabe KA-05. VoltPilot
  führt dazu keine Angaben.
- **Die Ursachenregel** „Ursache braucht Fakt“ steht an 6.2, 9.1.1, 10.1 und 10.2 mit ihren Quellen:
  [`erklaerbarkeit-stufe-0-die-echtheits-reg.md`](../agents/root/erklaerbarkeit-stufe-0-die-echtheits-reg.md)
  Zeile 9–10, `PG/plan.md:413` und `:659`. „AP-08 E7“ ist der Kasten Ersatzwerte und nie diese
  Regel (W7).
- **Die Zusagen einer Zeile** folgen aus `norm` der Zusagen. Nennt eine Zusage einen Abschnitt, steht
  sie in dessen Zeile (MX1).

**ISO-Strang AP-16 … AP-19.** Die Plan-Abnahmen dieser Pakete (Z-001 … Z-005, Z-039), ihre Sätze
der Release-Notiz (Z-047 … Z-060) und der Verantwortungs-Satz (Z-075) tragen Abschnitte und
Kandidaten aus Abnahme-, API- und Bestandsschutz-Tests. Der Vertragstest prüft, dass jeder
Kandidat `Klasse#methode` im Testcode steht. Ein Kandidat bleibt ein Kandidat (NR7): Die Zeile ist
`offen`, bis der Lauf am Stand sie trägt (AP-20 IP-10).

## Nachweis-Kandidaten und Klammer (AP-20 IP-6)

AP-20 IP-6 hat jeder Zusage außerhalb des ISO-Strangs ihre Kandidaten zugeordnet: den
Plan-Abnahmen AP-00 … AP-15, dem Betrieb und den übrigen Sätzen von Release- und Box-Notiz. Ein
Kandidat ist kein Beleg (NR7). Jede Zeile bleibt `offen`, bis der Lauf am Stand sie trägt
(AP-20 IP-10). Ein Kandidat hat eine von drei Formen:

| Form | Beispiel | Die Klammer verlangt |
|---|---|---|
| `Klasse#methode` | `UnterstuetzungApiTest#a14NotfallZugriffIstEngUndLaut` | die Java-Testklasse genau einmal unter `services/*/src/test/java`, darin `void methode(` |
| `pfad#Fall` | `tools/edge-simulator/test_uems_ahrenberg.py#test_a1_two_edges_configure_no_foreign_sources` | die Testdatei, darin `it('Fall'` oder `test('Fall'` wörtlich (`.ts`, `.tsx`, `.js`), `def Fall(` (`.py`) oder `func Fall(` (`.go`) |
| `pfad[:zeile] Bemerkung` | `tools/generalprobe/rueckweg.sh → rueckweg.json (AP-14 NW-8)` | die Datei im Repo und die Zeile darin; für Artefakte, Werkzeuge und Dokumente |

**Die Klammer** `tools/bewertung/klammer.py` (AP-20 NW-1) ist rot, wenn

- eine genannte Klasse, Methode, Testdatei, ein Fall oder eine Zeile fehlt oder eine Klasse
  mehrdeutig ist. Gleiche einfache Namen gibt es in mehreren Diensten.
- ein Kandidat keine der drei Formen hat, etwa eine Klasse ohne Methode.
- eine Zeile weder Kandidat noch Lieferant nennt.
- eine Plan-Abnahme keinen Fall trägt (`Klasse#methode` oder `pfad#Fall`).
- eine offene Betriebszusage den Betreiber nicht nennt, der bestätigt.
- eine Zeile noch auf AP-20 IP-6 wartet.

Die Klammer prüft den Baum, nicht die Laufzeit. Ob ein Kandidat grün ist, sagt der Lauf. Ob er die
Zusage trägt, hat IP-6 gelesen. Trägt er nur einen Teil, nennt `wer_liefert` den Rest.

**Gegen den Abnahmetext gelesen** (AP-01, AP-02, AP-06, AP-13; in Klammern der Abnahmefall des
Konzepts):

| Zusage | tragen die Kandidaten | trägt keiner |
|---|---|---|
| Z-020 (AP-01 A1) | Aufnehmen legt nur Entwurf und Ruhe an; gestartet wird erst mit grüner Liste; der Assistent schaltet vor dem Start nichts scharf | dass Geräte, Datenquellen und Messstellen vorher und nachher dieselben sind |
| Z-021 (AP-01 A2) | Landung im Anlage-Cockpit bei einem Standort mit einer Anlage, die Leiste Cockpit · Fahrplan · Verlauf · Steuerung · Anlage, das Lesezeichen `#/anlage/{id}` | — |
| Z-022 (AP-02 A1) | ein rückwirkender Umzug: Kennzeichen, Stand am Stichtag, Anstoß des Berichts; die Vorschau ist die Wirkung | den Fall selbst: Umzug ab 01.03.2027, der Februar-Bericht zeigt neu gebildet weiter 156 100 kWh |
| Z-025 (AP-06 A1) | der Push je Box trägt nur ihre Quellen, gezählt am Broker; die Steuerquelle wechselt die Box nicht | — |
| Z-026 (AP-06 A2) | der Ausfall liest nur festgehaltene Fakten; die Lücke ist nie Stillstand | dass die Messungen der anderen Box vollständig bleiben, zeigt nur der Simulator |
| Z-037 (AP-13 O1) | Zeitraum mit Zone, Verlauf mit Lücke in einem Abzeichen, der Satz des Grundes, die Zahlen der Route | alle drei Teile zusammen auf einer Fläche |

**Betrieb.** Eine Betriebszusage gilt in Produktion, ein Test zeigt nur, dass der Code es kann.
Darum nennt jede offene Betriebszusage den Betreiber, der mit Datum bestätigt: Z-015 Q15 und die
Rückweg-Übung, Z-016 und Z-076 die Aufbewahrungs-Jobs, Z-017 die Anmelde-Ereignisse.

**Ohne Kandidat** bleiben Z-012 und Z-013 (Captain und Betreiber), Z-040 (die Einleitung der
Notiz), Z-066 und Z-067 (kein Test hält, dass die Anzeige nichts speichert) und Z-068 … Z-070
(Ankündigungen am Versandtag). Jede nennt, wer liefert.

## Lückenliste des Betreibers (AP-20 IP-3, E6 = A)

Die eigenen Lücken von VoltPilot stehen in `luecken.json`, der Vertrag in `luecken.schema.json`.
Die Liste ist Betreiber-Sache. Keine Lücke erscheint als Feststellung, Aufgabe, Hinweis oder Satz
in einem Kundenbereich (G2). Umgekehrt wird die Feststellung eines Kunden nur dann eine Lücke von
VoltPilot, wenn ein Befund aus einem Durchlauf es ausdrücklich sagt (PD3). Der Startbestand sind
die zwölf Lücken L-001 … L-012 des Fundaments, alle `offen` seit dem 25.09.2026. L-012 ist mit
AP-20 IP-7 behoben.

Eine Lücke trägt Text, Quelle, die Zeilen, die sie betrifft, wer liefert und einen Verlauf mit
Datum, Person und Begründung je Übergang (LU1). Betroffen ist eine Zusage `Z-nnn` oder eine
Norm-Zeile (Abschnittsnummer), nie eine Kundenaufgabe (NR5). Der Verlauf wird nur ergänzt, nie
umgeschrieben. Eine Lücke wird nie gelöscht: `L-nnn` steht lückenlos aufsteigend.

**Zustand** (`zustand`, LU2, LU3):

| Wort | Heißt | Pflicht am Übergang |
|---|---|---|
| `offen` | erkannt, niemand arbeitet daran | — |
| `in_arbeit` | ein Paket hat begonnen | — |
| `behoben` | geschlossen | `nachweis` an einem Stand, wie in der Matrix (Nachweis-Art, NR1, NR3) |
| `restpunkt` | bleibt bewusst stehen | `angenommen_von: "Captain"`, `grenze` (was dann nicht gilt) und `bis` |

Der erste Übergang führt nach `offen`. Erlaubt sind danach `offen` → `in_arbeit`,
`offen` → `restpunkt`, `in_arbeit` → `behoben`, `in_arbeit` → `restpunkt`, `in_arbeit` → `offen`
(Paket abgebrochen), `restpunkt` → `in_arbeit`, `restpunkt` → `restpunkt` (der Captain verlängert
mit neuer Grenze oder Frist) und `behoben` → `offen` (wieder aufgetreten).

**Restpunkt.** Einen Restpunkt nimmt nur der Captain an, mit Grenze und Datum „bis“ (LU3). Die
Crew legt ihn vor und trägt ihn erst ein, wenn das Wort des Captains vorliegt. Die Begründung
nennt, wo es steht. Eine überschrittene Frist zeigt die Liste beim Abruf („Frist überschritten
seit …“). Sie schickt nichts und ändert nichts (G4). L-004 ist Restpunkt-Kandidat (E11 = A),
steht aber `offen`, bis der Captain annimmt (LA6).

```json
{"am": "2026-10-05", "nach": "restpunkt", "person": "Crew (AP-20 IP-24)", "begruendung": "Wort des Captains: …",
 "angenommen_von": "Captain", "grenze": "Ein Verlust der Daten-VM verliert auch die Sicherung.", "bis": "2027-03-31"}
```

**Bindung an die Matrix.** Liste und Matrix nennen einander. Jede Zeile, die eine nicht behobene
Lücke betrifft, nennt sie in `luecken`. Eine behobene Lücke nennt keine Zeile mehr. Eine offene
Lücke (`offen`, `in_arbeit`) hält jede Zeile offen, die sie nennt (NR6). Ein Restpunkt hält nicht
offen. Er begrenzt, was Bericht und Beschreibung sagen dürfen (LU4). Eine Zeile in einem Teil,
der noch leer ist, wird nicht geprüft.

**Die Wache** `tools/bewertung/luecken.py` (LU5, AP-20 NW-3) ist rot, wenn

- die Matrix eine L-nnn nennt, die nicht auf der Liste steht: eine neue Lücke ohne Eintrag.
- eine Zeile eine nicht behobene Lücke nicht mehr nennt, die sie betrifft: geheilt, heißt aber
  noch offen. Wer eine Lücke heilt, entfernt den Verweis und trägt `in_arbeit` → `behoben` mit
  Nachweis ein.
- ein Restpunkt ohne `angenommen_von: "Captain"`, Grenze oder `bis` steht.
- `behoben` ohne Nachweis steht, ein Übergang nicht erlaubt ist oder Datum, Person oder
  Begründung fehlen.
- eine Zeile mit `belegt` oder `nicht_maschinell_pruefbar` eine offene Lücke nennt (NR6).
- eine L-nnn auf einer Kundenfläche steht (G2): Portal (`frontend/portal/src`, `public`),
  `services/api/src/main`, Keycloak-Thema, Release-Notiz-Vorlage. Testdateien zählen nicht.

## Kundenaufgaben (AP-20 IP-8, NR5, RF-04)

Die neun Kundenaufgaben KA-01 … KA-09 sagen, was außerhalb von VoltPilot beim Kunden bleibt. Jede
Norm-Zeile nennt genau eine, jede Kundenaufgabe nennt ihre Norm-Zeilen, und beide Richtungen
stimmen überein (AP-20 NW-1).

- **Herkunft** ist die Spalte „beim Kunden“ von `FM/vp-uems-ap19-fundament/zuschnitt.json`, „Z. n“
  wie im Norm-Teil. Ergänzt ist, was AP-19 nicht hatte: Ursache und Wirkung im Leistungsteil
  (KA-04, AP-18), die Klimafrage der Änderung 1 (KA-05), die eigene Aufbewahrung vor Vertragsende
  (KA-06) sowie Messmittel, Messplanung und Einstufung (KA-07).
- **Der Satz** (`text`) ist Kundensprache. Er erscheint später im Hilfe-Artikel (AP-20 IP-22) und
  in der Übersicht für Prüfende (AP-20 IP-21) und nennt die Aufgabe als Verantwortung des Kunden.
  Abschnittsnummer, Kennzeichen, Norm und Vokabular-Schlüssel stehen nie darin.
- **Kein Urteil**, weder als Feld noch im Satz. Das Schema kennt kein Feld dafür. Der Prüfer ist rot
  an jedem Wort des Urteil-Vokabulars und an „erfüllt“, „konform“, „zertifiziert“, „vollständig“ und
  „Lücke“, auch gebeugt. Das Verb der Aufgabe bleibt erlaubt: „belegen“ und „erfüllen“ sagen, was der
  Kunde tut, nicht ob er es getan hat. VoltPilot weiß das nicht und behauptet darum nichts. Eine
  Kundenaufgabe wird nie gezählt, auch nicht als erfüllt, offen oder Lücke.
- **Wo gesagt** (`wo_gesagt`) nennt, wo der Kunde die Aufgabe heute liest: alle neun im Hilfe-Artikel
  (AP-20 IP-22, L-010 behoben) und in der Übersicht für Prüfende auf Anfrage (AP-20 IP-21). Einzelne Teile sagen
  daneben Zusagen (Z-048, Z-054, Z-059, Z-075).

Gegenüber dem Konzept sagt KA-06 „den Gesamtabzug laden“ statt „nehmen“, wie der Knopf (AP-20 BT4).

## Matrix-Prüfer (AP-20 IP-4, E3 = A)

`tools/bewertung/pruefe_matrix.py` fällt je Zeile ein Urteil nach NR1 bis NR9. Er **fährt keine
Tests**: er liest Lauf-Berichte, Stand-Blatt, Artefakte und Lückenliste, wie der Tor-Prüfer, und
nutzt dessen Lesefunktionen (`tools/freigabe/pruefe_tor.py`: `zaehler`, `lies_stand_txt`,
`gleicher_stand`, `lies_stand`, die Artefakt-Leser). Die Matrix ändert er nicht. Er urteilt nur
über eine Matrix, deren Vertrag und Lückenliste halten. Sonst bricht er ab.

```sh
python3 tools/bewertung/pruefe_matrix.py \
  --laeufe services/api/target/surefire-reports --laeufe /LAEUFE/portal-junit \
  --artefakte /BETREIBER/generalprobe --blatt /BETREIBER/bewertung-stand.yaml \
  [--stand <commit>] [--heute JJJJ-MM-TT] [--aus docs/bewertung/bewertungen] [--kennung BWB-JJJJ-nn]
```

**Lauf-Ordner.** Jede JUnit-Datei darin zählt: Surefire `TEST-*.xml` und Vitest
`--reporter=junit`. Jeder Ordner braucht eine `stand.txt`, sonst trägt keiner seiner Berichte
einen Stand (NR3). Die erste Zeile ist der Commit wie beim Tor-Prüfer. Danach folgen
`gefahren_von` (Pflicht) und `datum` (ohne sie gilt der Tag der Berichtsdatei):

```text
5ec44cdaeb802740f31b5dacd7a54d97aa243372
datum: 2026-09-28
gefahren_von: Crew (Lauf AP-20 IP-10)
```

Ein Artefakt-Ordner trägt dieselbe `stand.txt`.

**Kandidaten, die der Prüfer liest.** Es sind die Formen der [Klammer](#nachweis-kandidaten-und-klammer-ap-20-ip-6).
Nach einer Klasse oder einer Testdatei darf eine Anmerkung in Klammern stehen.

| Kandidat | liest | Beleg |
|---|---|---|
| `Klasse` | die Suite der Klasse: jeder Fall grün, keiner übersprungen | `test_lauf` |
| `Klasse#methode` | die Fälle der Methode, auch parametrisiert | `test_lauf` |
| `pfad#Fall` | den Fall in der Testdatei, auch unter `describe` („… > Fall“); einen Test mit Untertests (`node --test` schreibt ihn als `<testsuite>`) nur, wenn jeder Untertest grün ist und keiner übersprungen | `test_lauf` |
| `pfad` einer Testdatei | jeden Fall der Datei | `test_lauf` |
| `werkzeug → rueckweg.json`, `→ probe.json` | das Artefakt, geprüft vom Leser des Tor-Prüfers | `werkzeug_artefakt` |

Eine Testdatei findet der Prüfer so. Vitest nennt ihren Pfad in Suite und `classname`,
`node --test --test-reporter=junit` nennt ihn in `file`. pytest `--junitxml` nennt das Modul in
`classname`. Go nennt den Import-Pfad des Pakets aus dem `go.mod` darüber, über gotestsum oder
go-junit-report. Ein anderer Kandidat ist kein Beleg (NR1, NR7). Das gilt auch für
`pfad[:zeile] Bemerkung` ohne Artefakt, etwa eine Vektor-Datei, ein Dokument oder ein Skript. Die
Zeile bleibt offen, bis ein Lauf sie trägt.

**Reste in `wer_liefert`.** Was `wer_liefert` außer „Lauf am Stand (AP-20 IP-10)“ nennt, trägt
kein Kandidat (AP-20 IP-6). Solch ein Rest hält die Zusage offen, auch neben einem grünen Test. Die
Crew nimmt ihn aus der Matrix, wenn er geliefert ist. Einen **Rest des Betreibers** beantwortet
allein sein Stand-Blatt, und zwar unter dem Kennzeichen der Zusage. Die Form ist die des
Tor-Prüfers:

```yaml
Z-016:
  bestaetigt: ja
  am: 2026-10-14
  durch: Betreiber (Vorname Name)
  beleg: die Aufbewahrungs-Jobs der Speicherklassen laufen, letzter Lauf heute 03:10
```

Das Stand-Blatt macht nie einen Test grün. Für einen Punkt ohne Rest des Betreibers liest der
Prüfer es nicht. **Ausnahme Z-015** (BT1, BT2): dort trägt den Rest „Q15 bestätigen und die
Rückweg-Übung fahren“ der Befund zu `→ rueckweg.json` selbst - `belegt` nur mit dem Punkt
`q15_wal_archiv` (Person, Datum, Aussage) UND einer durchgeführten Übung unter
[`uebungen/`](uebungen/README.md), die ihren Stand trägt und nicht fällig ist; sonst `offen` mit
dem Grund (`uebung_fehlt`, `uebung_ohne_stand`, `uebung_faellig`, `q15_offen`).

**Urteil je Zusage.**

- `belegt`: jeder Kandidat hat einen grünen Lauf oder ein geprüftes Artefakt **dieses** Standes.
  Dazu nennt `wer_liefert` keinen Rest, und keine offene Lücke nennt die Zusage.
- `nicht_maschinell_pruefbar`: alles trägt, aber mindestens ein Teil nur mit einer Bestätigung.
  Das schwächste Glied entscheidet. Eine Bestätigung aus dem Stand-Blatt oder aus `bestaetigung`
  der Matrix zählt nur mit Person, Datum bis zum Prüftag und Aussage (NR4). Eine Rolle allein
  („Betreiber“, „Fachperson“) ist keine Person.
- `offen`: alles andere. Das Urteil nennt je Befund, was fehlt und wer liefert. Offen machen
  diese Befunde:
  - rot, übersprungen oder der Fall fehlt;
  - älterer oder anderer Stand, ohne `stand.txt`, ohne `gefahren_von`, kein Bericht;
  - ein Kandidat ohne lesbaren Lauf, keine Kandidaten (RF-05), ein Rest in `wer_liefert`;
  - eine Bestätigung ohne Person, Datum oder Aussage;
  - eine Lücke `offen` oder `in_arbeit` (NR6).

  Ein Restpunkt hält nicht offen. Er steht mit Grenze und Frist am Urteil (LU4).
- `nicht_zugesagt` bleibt, wie die Matrix es sagt: eine Grenze.

Eine **Norm-Zeile** wird `nicht_maschinell_pruefbar` nur mit der Lesart `traegt` einer benannten
Fachperson mit Datum und Text (RF-03). Eine Anmerkung oder ein Widerspruch bleibt offen (FP3).
**Kundenaufgaben** stehen ohne Urteil im Bericht und werden nie gezählt (NR5).

**Der Entwurf.** Der Prüfer schreibt `BWB-JJJJ-nn.json`, `BWB-JJJJ-nn.md` und
`BWB-JJJJ-nn.sha256` nach `--aus`. Vorgabe ist `docs/bewertung/bewertungen/`, die Kennung ist
die nächste freie im Jahr des Prüftags. Die `.md` nennt die Prüfsumme der JSON-Fassung.
`shasum -a 256 -c BWB-JJJJ-nn.sha256` prüft beide. Eine Kennung, die es schon gibt, schreibt er
nicht noch einmal (G3). Jede Zeile der JSON-Fassung ohne `pruefung` hält den Vertrag der Matrix.
So kann ein Lauf (AP-20 IP-10) die Urteile in die Matrix übernehmen. Gleiche Eingaben ergeben
gleiche Bytes. Gezählt wird je Urteil und Träger, nie in Prozent (MX4). Exit 0 heißt: der
Entwurf ist geschrieben. Das ist kein Tor (G4). Freigeben kann nur der Captain (G5). Exit 2
heißt: Aufruf, Eingabe oder Wache rot.

## Vokabulare

Die Vokabulare sind geschlossen. Quelle ist das Schema. Wer eines ändert, ändert Schema,
dieses README und die festgenagelte Liste in `tools/bewertung/test_nachweismatrix.py` gemeinsam.

**Urteil** (`urteil`). Positiv sind nur die ersten beiden.

| Wort | Heißt | Pflicht an der Zeile |
|---|---|---|
| `belegt` | Es gibt einen nachprüfbaren Beleg an **diesem** Stand. | mindestens ein Nachweis aus Lauf, Artefakt, Protokoll oder Stand mit Prüfsumme; jeder mit Fundstelle, Stand, Datum und `gefahren_von` |
| `nicht_maschinell_pruefbar` | Eine benannte Person hat mit Datum und Aussage bestätigt. Das Werkzeug hat es nicht nachgeprüft. | Zusage: `bestaetigung` (von, datum, aussage); Norm-Zeile: `fachperson` (name, datum, lesart, text) |
| `offen` | Was fehlt und wer es liefert. Das gilt für jede Zeile ohne Beleg und für jeden Kandidaten ohne Lauf. | `wer_liefert` mit mindestens einem Eintrag |
| `nicht_zugesagt` | VoltPilot sagt das ausdrücklich nicht zu. Das erscheint als Grenze, nie als Lücke. | `grund` |

Eine Norm-Zeile urteilt nur `offen` oder `nicht_maschinell_pruefbar` (`urteil_norm`). Ihre
Zuordnung kann nur die Fachperson an der lizenzierten Ausgabe bestätigen.

**Träger einer Norm-Zeile** (`traeger_norm`):

| Wort | Heißt |
|---|---|
| `haelt_fest` | VoltPilot hält fest. Der Kunde entscheidet und handelt. |
| `verweis` | VoltPilot hält einen Verweis auf das System des Kunden. |
| `misst` | VoltPilot misst, rechnet und berichtet. Deutung und Entscheidung liegen beim Kunden. |
| `beim_kunden` | Nichts davon liegt in VoltPilot. |

Eine Zusage trägt `traeger_zusage` mit dem einzigen Wert `voltpilot`. Ein zweiter Wert braucht
einen Entscheid.

**Nachweis-Art** (`nachweis_art`): `test_lauf` · `vektor_lauf` · `werkzeug_artefakt` ·
`betreiber_bestaetigung` · `fachperson_bestaetigung` · `protokoll` · `stand_mit_pruefsumme`.
Die ersten drei brauchen `lauf` (Pfad des Berichts oder Artefakts) und `lauf_sha256` (NR1).

**Zusage-Art** (`zusage_art`): `plan_abnahme` · `release_notiz` · `flaeche` · `anmeldung` ·
`betrieb` · `box_notiz`.

**Wer liefert** (`wer`): `Crew` · `Betreiber` · `Kunde` · `Fachperson` · `Captain`.

**Lesart der Fachperson** (`lesart`): `traegt` · `anmerkung` · `widerspruch`. Ein Widerspruch
wird eine Lücke. Kein Satz ändert sich still (FP3).

## Beleg-Regeln NR1 bis NR9

Die Regeln sind die des Tor-Prüfers ([`tools/freigabe/README.md`](../../tools/freigabe/README.md)),
ausgedehnt auf die ganze Matrix. Der Vertrag (AP-20 NW-1) prüft die Form. Die Urteile aus
Lauf-Berichten fällt der [Matrix-Prüfer](#matrix-prüfer-ap-20-ip-4-e3--a) (AP-20 IP-4, AP-20 NW-2).

- **NR1**: Ein Beleg ist nie „die Datei existiert“. Ein Test zählt nur mit einem Lauf-Bericht,
  ein Werkzeug nur mit seinem Artefakt.
- **NR2**: Übersprungen ist nicht grün, und rot ist nicht grün. Ein Testcontainers-Test ohne
  Docker gilt als übersprungen.
- **NR3**: Ein Beleg gilt nur an seinem Stand. Der Lauf-Bericht braucht `stand.txt` gleich dem
  geprüften Commit. Ein älterer Lauf trägt einen neueren Stand nicht.
- **NR4**: `nicht_maschinell_pruefbar` zählt nur mit Person, Datum und Aussage, sonst ist die
  Zeile offen. Das ist strenger als der Tor-Prüfer.
- **NR5**: Eine Kundenaufgabe hat kein Urteil. Sie wird benannt und nie als erfüllt, offen oder
  Lücke gezählt.
- **NR6**: Eine offene Lücke, die eine Zusage nennt, hält diese Zusage offen, auch wenn ein Test
  grün ist.
- **NR7**: Ein Kandidat ist kein Beleg. Jede Zeile ohne Lauf ist offen und nennt, wer liefert.
- **NR8**: Ein Alarm, der nie ausgelöst wurde, ist nicht geliefert. Der Beleg ist die Übung.
- **NR9**: Eine Nachweis-Kennung trägt immer ihr Paket, also „AP-14 NW-6“ und nie nur „NW-6“.
  Der Vertrag prüft das in jedem Text der Matrix.

## Matrix-Regeln MX1 bis MX6

- **MX1**: Eine Datei mit Norm-Teil und Zusagen-Teil, dazu die Kundenaufgaben, verbunden über
  Abschnittsnummern.
- **MX2**: Eine Zeile trägt Abschnittsnummer und eigene Umschreibung. Kein Normtext im Repo.
- **MX3**: Jede Zusage trägt Wortlaut, Quelle, Träger, Abschnitte, Kandidaten, Urteil und bei
  `offen` auch, wer liefert.
- **MX4**: Das Urteil kommt aus dem Vokabular. Gezählt wird nur je Urteil und Träger.
- **MX5**: Eine Zusage ohne Zeile ist rot. Die Wache ist `tools/bewertung/zusagen.py` (AP-20 IP-5).
- **MX6**: Die Normfassung steht mit Stichtag in der Datei und wird bei jeder Bewertung neu
  festgestellt. Eine neue Ausgabe ist eine neue Matrix-Fassung und keine stille Änderung.

## Normfassungen je Matrix-Fassung (MX6)

| Fassung | international | deutsch | zuerst festgestellt |
|---|---|---|---|
| 1 | ISO 50001:2018 einschließlich Amd 1:2024 | DIN EN ISO 50001:2018-12 mit DIN EN ISO 50001/A1:2024-12 | 25.09.2026 |

Am Tag jeder Bewertung stellt die Crew die Fassung fest und schreibt den `stichtag` fort.
Ändert sich die Ausgabe, entsteht eine neue Zeile hier, ein neuer Eintrag in `NORMFASSUNGEN`
(`tools/bewertung/nachweismatrix.py`) und eine neue `matrix_fassung`. Hat die neue Ausgabe
eine andere Gliederung, braucht es auch ein neues Schema.

## Rhythmus

Die Entscheidung AP-20 E2 = A lautet: gestuft, ohne Tor.

- Der **maschinelle Teil** läuft am gebauten Stand, empfohlen vor dem Merge und ohne Bedingung.
  Er wiederholt sich bei jedem Release mit UEMS-Änderung.
- Der **fachliche Review** wiederholt sich bei neuer Normausgabe oder bei einem Paket mit
  neuen Zusagen.
- **Betrieb, Durchlauf beim Kunden und Bericht** folgen am ausgelieferten Stand nach dem
  Rollout.
- Die **Wiederherstellungs-Übung** läuft halbjährlich; sechs Monate sind der Startwert (BT1).

Kein Tor, kein Läufer, keine Nachricht (G4). Weder Merge noch Rollout warten auf die
Bewertung. Fristen rechnet das Werkzeug beim Abruf.

**Der erste Lauf** (AP-20 IP-10) ist [`BWB-2026-01`](bewertungen/BWB-2026-01.md) am Stand
`09862815f`. Wie er gefahren wurde, steht im
[Laufprotokoll](bewertungen/BWB-2026-01-laufprotokoll.md): ein Lauf-Ordner je Suite mit
`stand.txt`, gefahren werden die Klassen und Dateien, die ein Kandidat nennt. Jede Klasse ohne
Kandidat steht dort als „nicht gefahren“, denn sie trägt kein Urteil (NR1). Ein neuer Stand
braucht einen neuen Lauf. Ein Bericht eines älteren Standes trägt ihn nicht (NR3, RF-11).

## Prüfpaket für die Fachperson (AP-20 IP-11, E4 = A)

Die externe Auditorin (oder der Auditor) für Energiemanagementsysteme liest den Norm-Teil an ihrer
lizenzierten Ausgabe. Was sie dafür bekommt, liegt unter [`pruefpaket/`](pruefpaket/pruefpaket.md) und
entsteht nur aus den Quellen, nie von Hand: `tools/bewertung/pruefpaket.py` liest Matrix, jüngsten
BWB-Entwurf und `produktbeschreibung/` (AP-20 IP-21, dort nur mit Prüfsumme je Datei).

- **`pruefpaket.md`**: jede der 30 Zeilen mit Abschnittsnummer, eigener Umschreibung, Träger,
  Kundenaufgabe, Herkunft und den Zusagen mit ihrem Urteil im Entwurf; Stand von Übersicht und
  Beschreibung; die Frageliste (Gliederung, 4.4, 6.3 und 9.1.1 aus L-012, Klimafrage, Grenze zwischen
  Verweis und geführt); die Anleitung zur Vorlage.
- **`protokoll-vorlage.json`**: je Norm-Zeile `name`, `datum`, `lesart`, `text` leer, in der Form des
  Felds `fachperson` der Matrix; dazu je Frage eine Antwort und ein Kopf zur Person (FP2). AP-20
  IP-12 übernimmt die ausgefüllte Vorlage (FP1, FP3, FP4).
- **`pruefpaket.sha256`**: `cd docs/bewertung/pruefpaket && shasum -a 256 -c pruefpaket.sha256`.
- **Kein Normtext (MX2).** Das Werkzeug baut kein Paket, wenn eine Umschreibung länger als 160 Zeichen
  ist, die Pflichtform der Norm trägt („Organisation muss“, „shall“) oder ein Zitat enthält.
- **Wer Matrix oder Bewertung ändert, baut das Paket neu** (`python3 tools/bewertung/pruefpaket.py`), nach der
  Beschreibung (`produktbeschreibung.py`), denn das Paket trägt deren Prüfsummen.
  Der Test `test_pruefpaket.py` ist rot, solange das Paket im Repo nicht der Bau aus den Quellen ist.
  Ein zweiter Bau ist byte-gleich; der Tag im Kopf ist der Stichtag der Normfassung.

## Produktbeschreibung und Übersicht für Prüfende (AP-20 IP-21, E7 = A)

Was VoltPilot über sich sagen darf, entsteht nur aus einer Bewertung: `tools/bewertung/produktbeschreibung.py`
liest die jüngste `bewertungen/BWB-*.json` und die Satz-Quelle [`beschreibung-saetze.json`](beschreibung-saetze.json)
(Wortlaut aus dem Konzept §5.8, je Satz eine Bindung an `zusage`, `kundenaufgabe` oder `luecke`) und schreibt
[`produktbeschreibung/`](produktbeschreibung/beschreibung.md). Nie von Hand; ein zweiter Bau ist byte-gleich.

- **`beschreibung.md`**: Funktionen in Kundenwörtern, unter jedem Satz die Zusage und ihr Urteil, daneben die
  Kundenaufgaben ihrer Norm-Zeilen, alle Kundenaufgaben, Restpunkte mit Grenze und Frist (PB4), Verantwortungs- und
  Grenz-Satz. **Keine Abschnittsnummer** (PB3).
- **`uebersicht-fuer-pruefende.md`**: Abschnitt → was VoltPilot festhält → was bei Ihnen bleibt → Stand der Prüfung,
  mit Bewertung, Stand und Datum im Kopf und dem Grenz-Satz Wort für Wort (E8). Das einzige Dokument mit
  Abschnittsnummern; auf Anfrage, **nie im Portal, nie in einem Bericht** (PB3). „Was VoltPilot festhält“ nennt nur
  Zusagen mit positivem Urteil: ihren Satz aus der Quelle, sonst den Wortlaut, den der Kunde schon liest
  (Release-Notiz, Fläche, Anmeldung, Box-Notiz), sonst nur das Kennzeichen.
- **`produktbeschreibung.json`**: Kennung `PB-01`, Zustand, Bewertung mit Prüfsumme, Wächter-Lauf je Satz
  (Funde, Bindung, zugelassen, Grund). **`produktbeschreibung.sha256`**: `shasum -a 256 -c`.

**Wächter (PB1, PB2, NW-4, RF-09).** Jeder Satz geht gegen die Wortliste: AP-14 S1 und AP-19 SP2 (Muster aus
`frontend/portal/src/copy.test.ts`), Rechtsaussagen („DSGVO-konform“, „GDPR compliant“, „rechtssicher“,
„garantiert“) und Norm-Nummern; nur Grenz-Satz und neutrale Nennung dürfen Konformität und ISO nennen. Und gegen
die Bindung: ein Satz an einer Zusage ohne positives Urteil fällt auch ohne verbotenes Wort. Ein Wort-Fund ist rot
und baut nichts; ein Satz an einer offenen Zeile wird **zurückgehalten** und erscheint im Wächter-Lauf mit Grund,
bis seine Zeile positiv ist. Ohne Bindung gehen nur die Rahmen-Sätze des Werkzeugs (Titel, erster Satz, Kopf und
Fuß der Übersicht, Grenz-Satz, Träger). Ein Restpunkt der Bewertung ohne Satz in der Quelle ist rot (PB4). Texte
außerhalb des Repos (Website, Angebot) prüft `--entwurf <datei>` in derselben Form wie RF-09.

**Hilfe-Artikel im Portal (AP-20 IP-22, E7 = A).** Der Artikel „Was VoltPilot für Ihr Energiemanagement festhält —
und was bei Ihnen bleibt“ (`frontend/portal/src/help/content/energiemanagement.ts`, Einstieg aus dem Bereich
Energiemanagement) trägt nur Sätze aus §5.8: Titel, Kurztext, die Überschriften der Beschreibung, die Funktionssätze
an einer positiven Zeile, alle Kundenaufgaben, Verantwortungs- und Grenz-Satz, jeden angenommenen Restpunkt mit
Grenze. `--check` liest ihn gegen Quelle und jüngste Bewertung und ist rot an einem Satz an einer offenen Zeile
(heute Z-004), an einem Satz ohne Quelle, an einem fehlenden Pflicht-Satz und an einer Stelle, die kein Wortlaut
ist. Die Richtung ist fest: das Werkzeug liest den Artikel, der Artikel verweist auf nichts hier (ein Verweis wäre
rot, s. u.). Wird eine Zeile positiv, kommt ihr Satz von Hand in den Artikel; wird sie offen, ist `--check` rot, bis
er herausgenommen ist. Wortliste und die zwei Pflicht-Sätze prüft zusätzlich `copy.test.ts` (Block AP-20 IP-22).

**Gilt nur mit ihrer Bewertung (PB5).** `--check` ist rot, wenn eine jüngere Bewertung die eigene ablöst, wenn sich
die Bewertung seit dem Bau geändert hat (etwa durch ihre Freigabe), wenn eine Datei nicht der Bau ist oder wenn
Portal oder API auf die Beschreibung verweisen. Ein Entwurf bleibt grün und sagt, dass er einer ist:
„Entwurf — Bewertung BWB-2026-01, gebauter Stand, nicht freigegeben“ steht sichtbar in beiden Dokumenten.
`--vor-ausgabe` ist zusätzlich rot, solange die Bewertung nicht freigegeben ist: **vor jeder positiven Aussage im
Vertrieb**. Nach der Lesart der Fachperson (AP-20 IP-12) und der Freigabe (AP-20 IP-24) wird die Beschreibung neu
erzeugt; freigeben kann sie nur der Captain.

## Wer was tut

| Wer | Tut | Tut nie |
|---|---|---|
| Crew | pflegt Matrix und Lückenliste, fährt die Läufe im Testfenster mit `stand.txt`, stellt die Normfassung fest | ein positives Urteil ohne Lauf oder Bestätigung eintragen |
| Werkzeug | prüft den Vertrag und urteilt nach NR1 bis NR9 in einem Entwurf (AP-20 IP-4) | freigeben, einen Restpunkt annehmen, löschen, die Matrix ändern (G5) |
| Betreiber | bestätigt mit Datum, was nur er wissen kann, und fährt Übungen | ein Urteil des Werkzeugs überschreiben |
| Fachperson | liest den Norm-Teil an ihrer lizenzierten Ausgabe und trägt je Zeile eine Lesart mit Name und Datum ein | VoltPilot bei der Umsetzung beraten (FP2) |
| Captain | gibt eine Bewertung frei und nimmt einen Restpunkt mit Grenze und Datum an | — |
| Kunde | trägt die Kundenaufgaben und führt sein Energiemanagement selbst | eine Lücke von VoltPilot sehen (G2) |

## Prüfen

```sh
python3 tools/bewertung/nachweismatrix.py                       # Exit 0 = Vertrag hält, 1 = rot, 2 = Aufruf; druckt RF-12 je Träger
python3 tools/bewertung/zusagen.py [--plan <plan.md>]          # Wache MX5: Exit 0 = jede Zusage hat ihre Zeile
python3 tools/bewertung/klammer.py                             # Klammer AP-20 NW-1: Exit 0 = jeder Kandidat existiert, keine Zeile ohne Kandidat oder Lieferant
python3 tools/bewertung/luecken.py [--heute JJJJ-MM-TT]        # Wache AP-20 NW-3: Exit 0 = Liste hält, zeigt Zustand und Frist
python3 tools/bewertung/pruefe_matrix.py --laeufe <ordner> …    # Urteil je Zeile, BWB-Entwurf mit SHA-256 (AP-20 NW-2)
python3 tools/bewertung/pruefpaket.py [--check]                # Prüfpaket für die Fachperson (AP-20 IP-11): Exit 0 = gebaut bzw. hält
python3 tools/bewertung/produktbeschreibung.py [--check]       # Beschreibung + Übersicht (AP-20 IP-21, NW-4), mit --check auch der Hilfe-Artikel (IP-22): Exit 0 = gebaut bzw. hält, meldet Entwurf
python3 tools/bewertung/produktbeschreibung.py --vor-ausgabe   # PB5: Exit 1, solange die Bewertung nicht freigegeben ist
python3 tools/bewertung/produktbeschreibung.py --entwurf <datei>  # Wächter über einen fremden Text: Exit 1 = ein Satz abgelehnt
python3 -m unittest discover -s tools/bewertung -p 'test_*.py'  # AP-20 NW-1, AP-20 NW-2 und die Wachen
python3 -m unittest discover -s tools/bewertung -p 'test_abnahme.py'  # Abnahme AP-20 NW-6: RF-01 … RF-12, je mit Gegenprobe
```

**Abnahme-Test (AP-20 IP-23, AP-20 NW-6).** `tools/bewertung/test_abnahme.py` fährt die zwölf Referenzfälle
des Konzepts an einer Fixture-Welt unter `tools/bewertung/fixtures/abnahme/` durch die Werkzeuge oben; jeder
Fall hat eine Gegenprobe, die rot werden muss. Was dort ein Mensch liefert (Lesart der Fachperson, Übung,
Pilot-Durchlauf, Annahme eines Restpunkts), ist als FIXTURE gekennzeichnet und ersetzt nichts davon; was
die Fixture nicht abdeckt, steht in ihrer [README](../../tools/bewertung/fixtures/abnahme/README.md).

Der Test braucht `jsonschema`, wie die Vertragstests von `services/optimization`. Fehlt es,
bricht der Lauf ab, statt übersprungen zu werden.
