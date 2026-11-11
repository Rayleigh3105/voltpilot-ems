# Messkonzept-Katalog für Erzeugungsanlagen

Stand 11.11.2026, Schritt S0 (Captain-Entscheide F1–F5 vom 11.11.2026). Daten: [`messkonzept-katalog.json`](messkonzept-katalog.json), Form: [`messkonzept-katalog.schema.json`](messkonzept-katalog.schema.json), Rechen- und Matrix-Fälle: [`messkonzept-katalog-vectors.json`](messkonzept-katalog-vectors.json). Prüfung: `services/api` `MesskonzeptKatalogVectorsTest`. Begriffe: [Fachmodell](../../fachmodell/glossar.md) „Erzeugungsanlage“, „Messkonzept“, „Zählpunkt“.

## 1. Wozu

Hängen hinter einem Netzanschluss mehrere Erzeugungsanlagen (EA) mit verschiedener Inbetriebnahme, hat jede ihren eigenen Vergütungssatz – der Zähler am Netzanschluss misst aber nur die Summe. Welche EA welchen Teil der Einspeisung bekommt, legt das **Messkonzept** fest. Der Betreiber wählt es auf dem Auswahlblatt seines Netzbetreibers, der Netzbetreiber prüft es.

Der Katalog hält die Konzepte als **Daten mit Quelle und Stand**: Zähler mit Rolle und Richtung, die Rechenregel je Größe als Formel, die Voraussetzungen als prüfbare Bedingungen und die Matrix der zulässigen Paare. **VoltPilot wählt nie ein Konzept.** Ein Mensch trägt es am Netzanschluss ein (Schritt S2); VoltPilot kann nach der Matrix zeigen, welche Konzepte in Frage kommen, und bei einem Widerspruch zum Aufbau warnen.

Heute liest den Katalog nur sein Test. Kein Fahrplan, keine Erlöse und keine Box hängen an ihm.

## 2. Quellen und Grenzen

| Kennung | Unterlage | Rolle |
|---|---|---|
| `VBEW-H-2024-09` | VBEW-Messkonzepte, Handout zur Auswahl der Messkonzepte, Ausgabe 09.2024 (Stand 24.09.2024) | Konzepte, Zähler, Voraussetzungen, Matrix (S. 7) |
| `VBEW-AH-2024-05` | VBEW-Messkonzepte, Messkonzepte und Abrechnungshinweise für Erzeugungsanlagen, Ausgabe 05.2024 (Stand 14.05.2024) | Formeln je EA |

- **Umfang (F1 = a):** Auswahlblatt A (eine EA) und B (zwei EA) sowie zwei Konzepte parallel hinter einem Hausanschluss. Ein Speicher hat seit Ausgabe 03/2024 kein eigenes Konzept; er ist in jedem Konzept mit Verbrauchern erlaubt (`speicher_erlaubt`). Blatt C und D kommen später.
- **Nutzungsbedingung:** Die Unterlage erlaubt die Weitergabe ihrer Inhalte und Darstellungen nur bestimmten Nutzern (Handout S. 2). Deshalb stehen hier **keine Schaltbilder und keine Textpassagen** des VBEW, nur Kennungen („MK B2a“), kurze Namen der Konzepte, Zähler, Formeln und eigene Beschreibungen. Ein Schaltbild im Portal ist vorher zu klären.
- **Keine Rechtsaussage.** Die Unterlage sagt selbst, dass sie keine Gewähr für die rechtliche Verbindlichkeit übernimmt. Der Katalog bildet ab, was sie sagt.

## 3. Ein Eintrag

| Feld | Bedeutung |
|---|---|
| `kennung`, `blatt`, `name` | „B2a“, Blatt „B“, der kurze Name des Konzepts |
| `beschreibung` | eigene Worte: was wo hängt |
| `quellen` | Fundstellen (Unterlage und Seite) |
| `erzeugungsanlagen` | wie viele EA das Konzept trägt (1 oder 2) |
| `verteilung` | `eine_ea` · `nach_leistung` (B1, B2, B2a) · `nach_erzeugung` (B3) · `nach_lage` (B4, parallel) |
| `rechenzeitraum` | nur bei `nach_erzeugung`: über welchen Zeitraum der Schlüssel gilt (Abschnitt 6) |
| `verbraucher` | `keine` (Volleinspeisung) · `erlaubt` · `nicht_im_kaskadenzweig` (B4) |
| `zaehler` | die Zähler des Konzepts (Abschnitt 4) |
| `regeln` | je Größe und EA eine Formel (Abschnitt 5) |
| `bedingungen` | die Voraussetzungen als prüfbare Bedingungen (Abschnitt 7) |

## 4. Zähler und Rollen

Ein Zähler hat eine **Kennung**, wie sie auf dem Blatt steht (`Z1` … `Z4`), und eine **Rolle nach seiner Bedeutung**. Die Nummer ist nur Beschriftung: Bei der MiSpeL-Festlegung heißt „Z2“ der Zähler für Speicher oder Ladepunkte, beim VBEW ein Erzeugungszähler. Wer Zähler verschiedener Quellen zusammenführt, geht über die Rolle, nie über die Nummer.

| Rolle | Was er misst |
|---|---|
| `netz` | Bezug und Lieferung am Hausanschluss (der Zweirichtungszähler `Z1`) |
| `erzeugung` | Lieferung einer oder mehrerer EA, ihre ganze Erzeugung (`misst`) |
| `kaskade` | Lieferung am Abgang eines Zweigs, in dem EA und Verbraucher hängen (`zweig`, nur B4) |

- `richtungen`: `bezug` und/oder `lieferung`. In Formeln heißt die Menge eines Zählers Kennung plus `B` (Bezug) oder `L` (Lieferung): `Z1L` ist die Lieferung von `Z1`.
- `misst`: die EA, deren **ganze** Erzeugung der Zähler misst. Beim Zweirichtungszähler einer Volleinspeisung (A1, B1) sind das alle EA, sonst ist die Liste leer.
- `wahlfrei`: der Zähler ist laut Blatt nicht in jedem Fall nötig (B4: Z2 und Z3). Fehlt er, fehlt auch die Größe, die ihn braucht – unbekannt ist keine Null.

## 5. Formeln

Eine Formel ist ein Ausdruck über Zählermengen und Leistungen, in kWh über den Rechenzeitraum:

```
ausdruck := term   (("+" | "-") term)*
term     := faktor (("*" | "/") faktor)*
faktor   := zahl | name | "(" ausdruck ")"
name     := Z<n>B | Z<n>L        Menge eines Zählers dieses Konzepts in Bezug/Lieferung
          | P_EA<k>              Leistung der EA k (kWp) aus ihrer Fassung am Tag
```

Je Konzept gibt es genau eine Regel für `bezug` (ohne EA) und je EA genau eine für `einspeisung`; `selbstverbrauch` nur, wo das Konzept ihn ermittelt. Eine Formel nennt nur Zähler ihres Konzepts und nur Richtungen, die der Zähler misst; `P_EA` steht nur in Konzepten `nach_leistung`. Der Test prüft das.

**Parallel** (`parallel`): Zwei vollständige Konzepte stehen hinter einem Hausanschlusskasten nebeneinander (Handout S. 3), jedes mit eigenem Zweirichtungszähler. Jede EA gehört zu genau einem Teil und rechnet nach der Regel ihres Teils; zwischen den Teilen wird nichts verteilt. In Formeln trägt der Teil den Namen vorn: `T1.Z1L`, `T2.P_EA1`. Der Bezug am Hausanschluss ist `T1.Z1B + T2.Z1B`.

## 6. Rechenzeitraum

Die Regel nach Erzeugung (B3) ergibt je Viertelstunde gerechnet und summiert andere Mengen als über den Monat (Fall „B3 je Viertelstunde“ in den Vektoren: in der ersten Viertelstunde speist nur EA1 ein, in der zweiten verbraucht das Haus alles von EA2; je Viertelstunde bekommt EA1 alles, über beide zusammen bekommen beide die Hälfte). Die Unterlage rechnet über den Abrechnungszeitraum und nennt keinen kürzeren. **Lesart von VoltPilot:** Erlöse und Berichte rechnen über den Monat (`rechenzeitraum.vorgabe = monat`, `herkunft = voltpilot`); je Viertelstunde nur Plan und Live-Anzeige, und das steht dabei. Werte des Messstellenbetreibers bringen ihren eigenen Zeitraum mit und gehen vor (F4).

## 7. Bedingungen

Jede Bedingung hat eine `art` aus einem geschlossenen Vokabular und eine Fundstelle. Geprüft werden sie erst mit Schritt S2 – als Hinweis, nie als Sperre.

| `art` | prüfbar aus | Parameter |
|---|---|---|
| `gleicher_energietraeger` | Art der EA | `ausnahme: kaufmaennisch_bilanzielle_weitergabe` (B3) |
| `ohne_zonung_nach_bemessungsleistung` | Förderweg der EA (kommt mit `mispel`) | – |
| `keine_selbstverbrauchsverguetung` | Förderweg der EA | – |
| `keine_verbraucher` | Aufbau der Anlage (Komponenten hinter dem Zähler) | `bereich: hinter_netzzaehler` (A1, B1) · `kaskadenzweig` (B4) |
| `leistungsgrenze` | Leistung und Art der EA | `ea`, `wenn: beide_im_selbstverbrauch`, `grenzen` (B4: PV und Wasserkraft 30 kW, BHKW 50 kW) |
| `lastgangmessung` | Messung der Zählpunkte | `wenn: energietraeger_verschieden`, `mim_und_nicht_mim` (B3) |
| `matrix` | Inbetriebnahme und Leistung beider EA | die Matrix (Abschnitt 8) |

## 8. Matrix (Handout S. 7)

Für zwei PV-Gebäudeanlagen hängt die Wahl an der EEG-Fassung jeder Anlage. Die Matrix hat vier **Klassen**; die Zuordnung steht als Daten in `matrix.klassen[].zuordnung`:

| Klasse | Inbetriebnahme | Leistung |
|---|---|---|
| `eeg_bis_2012_i` | vor dem 01.04.2012 (auch ausgeförderte Anlagen) | – |
| `eeg_2012_ii_ohne_mim` | 01.04.2012 bis 31.07.2014 | bis 10 kWp oder über 1 MWp |
| `eeg_2012_ii_mim` | 01.04.2012 bis 31.07.2014 | über 10 kWp bis 1 MWp (Marktintegrationsmodell) |
| `ab_eeg_2014` | ab dem 01.08.2014 | – |

Die Grenzen der Inbetriebnahme gelten laut Unterlage „in der Regel“; ohne Inbetriebnahme (oder in EEG 2012-II ohne Leistung) gibt es keine Klasse und damit keinen Vorschlag.

**Die Regel der Matrix:** Ist genau eine der beiden Anlagen im Marktintegrationsmodell, kommt nur B4 in Frage; in jedem anderen Paar B1, B2, B2a und B3, nicht B4. Ist eine Anlage aus `eeg_bis_2012_i` beteiligt, gilt der Vorbehalt zu B2a: Wird für eine PV-Anlage nach EEG 2009 oder 2012-I eine Vergütung des Selbstverbrauchs beansprucht, scheidet B2a aus. Die `zeilen` stehen wie in der Unterlage (elf, das gemischte Paar aus EEG 2012-II in beiden Reihenfolgen); der Test prüft, dass sie vollständig, symmetrisch und gleich der Regel sind.

## 9. Was daraus wird

| Schritt | Was der Katalog dort tut |
|---|---|
| S1 (gebaut) | nichts – die Erzeugungsanlage mit Fassungen steht ohne Messkonzept da |
| S2 | am Netzanschluss eine Fassung „Messkonzept“ mit Kennung aus diesem Katalog und Zählpunkten mit Rolle; Vorschlag nach Matrix; die Zählerrolle vom Zweig `mispel` wird dafür verallgemeinert (F5) |
| S3 | berechnete Messstellen je EA aus `regeln`; B3 braucht einen neuen Formeltyp „Anteil aus Messwerten“ |
| S4 | Exportwert am Netzanschluss für den Optimierer aus den Sätzen der EA und der `verteilung` |

## 10. Ändern

Ein neues Konzept oder eine neue Ausgabe der Unterlage: Eintrag mit Quelle und Seite ergänzen, `quellen` und `stand` nachziehen, Vektoren dazu, Test grün. Eine Kennung wird nie umgedeutet; eine geänderte Regel einer neuen Ausgabe bekommt einen eigenen Eintrag mit eigener Quelle.
