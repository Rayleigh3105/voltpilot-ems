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
| [`nachweismatrix.json`](nachweismatrix.json) | die Matrix mit Normfassung und Stichtag; Zusagen-Teil seit IP-5, Norm-Teil seit IP-7, Kundenaufgaben folgen | AP-20 IP-2, IP-5, IP-7 |
| `luecken.json` | Lückenliste des Betreibers (L-nnn), nie beim Kunden | AP-20 IP-3 |
| [`../../tools/bewertung/`](../../tools/bewertung/) | Vertragstest (AP-20 NW-1), Wache des Zusagen-Inventars (`zusagen.py`); später der Matrix-Prüfer | AP-20 IP-2, IP-5, IP-4 |

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

**Urteil.** Jede Zeile ist `offen` und nennt, wer liefert (NR7). Kandidaten und Abschnitte trägt
die Zeile nur, wo das Konzept sie schon nennt. Zugeordnet werden sie in AP-20 IP-6 (AP-00 … AP-15
und Betrieb) und IP-7 (AP-16 … AP-19, Norm-Teil; siehe unten).

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
python3 tools/bewertung/nachweismatrix.py                       # Exit 0 = Vertrag hält, 1 = rot, 2 = Aufruf; druckt RF-12 je Träger
python3 tools/bewertung/zusagen.py [--plan <plan.md>]          # Wache MX5: Exit 0 = jede Zusage hat ihre Zeile
python3 -m unittest discover -s tools/bewertung -p 'test_*.py'  # AP-20 NW-1 und die Wache
```

Der Test braucht `jsonschema`, wie die Vertragstests von `services/optimization`. Fehlt es,
bricht der Lauf ab, statt übersprungen zu werden.
