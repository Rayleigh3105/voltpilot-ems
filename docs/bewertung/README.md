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
| [`nachweismatrix.json`](nachweismatrix.json) | die Matrix; heute leer, mit Normfassung und Stichtag | AP-20 IP-2, gefüllt ab IP-5 |
| `luecken.json` | Lückenliste des Betreibers (L-nnn), nie beim Kunden | AP-20 IP-3 |
| [`../../tools/bewertung/`](../../tools/bewertung/) | Vertragstest (AP-20 NW-1); später der Matrix-Prüfer | AP-20 IP-2, IP-4 |

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
diesen Abschnitt. Dasselbe gilt für Norm-Zeile und Kundenaufgabe. Ein Verweis in einen Teil,
der noch keine Zeile trägt, wird nicht geprüft. So können die Teile nacheinander entstehen:
Zusagen (IP-5), Norm-Teil (IP-7), Kundenaufgaben (IP-8).

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
Lauf-Berichten fällt später der Matrix-Prüfer (AP-20 IP-4, AP-20 NW-2).

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
- **MX5**: Eine Zusage ohne Zeile ist rot. Die Wache dafür baut AP-20 IP-5.
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

## Wer was tut

| Wer | Tut | Tut nie |
|---|---|---|
| Crew | pflegt Matrix und Lückenliste, fährt die Läufe im Testfenster mit `stand.txt`, stellt die Normfassung fest | ein positives Urteil ohne Lauf oder Bestätigung eintragen |
| Werkzeug | prüft den Vertrag (heute) und urteilt nach NR1 bis NR9 (AP-20 IP-4) | freigeben, einen Restpunkt annehmen, löschen (G5) |
| Betreiber | bestätigt mit Datum, was nur er wissen kann, und fährt Übungen | ein Urteil des Werkzeugs überschreiben |
| Fachperson | liest den Norm-Teil an ihrer lizenzierten Ausgabe und trägt je Zeile eine Lesart mit Name und Datum ein | VoltPilot bei der Umsetzung beraten (FP2) |
| Captain | gibt eine Bewertung frei und nimmt einen Restpunkt mit Grenze und Datum an | — |
| Kunde | trägt die Kundenaufgaben und führt sein Energiemanagement selbst | eine Lücke von VoltPilot sehen (G2) |

## Prüfen

```sh
python3 tools/bewertung/nachweismatrix.py                       # Exit 0 = Vertrag hält, 1 = rot, 2 = Aufruf
python3 -m unittest discover -s tools/bewertung -p 'test_*.py'  # AP-20 NW-1
```

Der Test braucht `jsonschema`, wie die Vertragstests von `services/optimization`. Fehlt es,
bricht der Lauf ab, statt übersprungen zu werden.
