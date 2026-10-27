# Gehäuse für das Edge Light

Das Edge Light ist ein Programm, kein Gerät: Es läuft auf kleinen Routern und auf jedem Linux
([Überblick](../README.md)). Das Gehäuse dagegen gehört zu genau einer Platine. Deshalb liegt hier
**je Gerät ein Ordner**, benannt nach Hersteller und Modell.

| Ordner | Gerät | Stand |
|---|---|---|
| [`glinet-gl-mt300n-v2/`](glinet-gl-mt300n-v2/README.md) | GL.iNet GL-MT300N-V2 „Mango“ | v0.4, vorerst fertig (12.10.2026); Unterteil und Körper des Deckels gedruckt und bestätigt |

Ein Geräteordner ist in sich geschlossen: das Modell als Programm, die fertigen Druckdateien, die
Druck- und Montageanleitung, das Maßmodell der Platine mit der Herkunft jeder Zahl und die
Geschichte der Entscheidungen.

## Was am Gehäuse zum Gerät gehört und was nicht

Es gibt bisher ein Gerät und deshalb keinen gemeinsamen Unterbau: Alles liegt im Ordner der Mango.
Die Trennung unten ist eine ehrliche Einschätzung, keine Schnittstelle im Code.

| | Dateien im Ordner der Mango | bei einem zweiten Gerät |
|---|---|---|
| **Gerätespezifisch** | `gehaeuse/massmodell.py` (Platine, Stecker, LEDs, Antennen), `gehaeuse/platine.py`, `gehaeuse/entwurf.py` (Wanne, Öffnungen, Lichtschacht, Verschluss), `gehaeuse/passproben.py`, `gehaeuse/massbild.py`, `gehaeuse/schachtbild.py`, der größte Teil von `gehaeuse/parameter.py` und `gehaeuse/pruefung.py`, `druck/`, `docs/massmodell*.md` | neu: zuerst das Maßmodell, dann Passproben, dann der Entwurf |
| **Wiederverwendbar, heute noch an die Mango gebunden** | Logo (`logo/logo-vektor.svg`, `gehaeuse/logo.py`), Strichschrift für die Beschriftung (`gehaeuse/schrift.py`, `gehaeuse/schriftprobe.py`), 3MF mit Farbplätzen (`gehaeuse/mehrfarb_3mf.py`), Kennung je Box mit QR-Code (`gehaeuse/kennung.py`; Lage in `entwurf.py`), Netz, Drucklage und Bilder (`gehaeuse/ausgabe.py`, `gehaeuse/vorschau.py`, `gehaeuse/formen.py`), Probe-Platte (`gehaeuse/probe_platte.py`), Kontrolle durch den Slicer und Auswertung des G-Codes (`gehaeuse/bambu.py`, `werkzeug/bambu_*`), Abgleich des Eingecheckten (`gehaeuse/abgleich.py`), `einrichten.sh`, `bauen.sh` | übernehmen; Stellen, die Namen aus dem Entwurf der Mango kennen (Läufe in `bambu.py`, Lage der Wörter), anpassen |
| **Wissen, das für jedes Gerät gilt** | [Regeln für Druck, Schrift und Logo](glinet-gl-mt300n-v2/docs/regeln.md), die Reihenfolge Maßmodell → Passproben → Gehäuse | lesen, nicht kopieren |

## Ein weiteres Gerät dazunehmen

1. Ordner `<hersteller>-<modell>/` neben dem der Mango anlegen und in die Tabelle oben eintragen.
2. Den Ordner der Mango als Vorlage kopieren. Das ist beim zweiten Gerät der ehrliche Weg: Erst mit
   zwei Geräten zeigt sich, was wirklich gemeinsam ist. **Dann** das Gemeinsame (rechte Hälfte der
   Tabelle) in einen Ordner neben den Geräten ziehen und beide darauf umstellen, nicht vorher.
3. Im neuen Ordner mit `gehaeuse/massmodell.py` beginnen: jede Zahl mit Herkunft, Schätzungen als
   Schätzung. Danach die Passproben drucken lassen und erst mit bestätigten Maßen den Entwurf bauen
   ([so ist es bei der Mango gelaufen](glinet-gl-mt300n-v2/docs/entscheidungen.md)).
4. `druck/` leeren. Druckdateien kommen erst hinein, wenn ein Stand als fertig gilt, jeweils mit dem
   Vermerk, was davon gedruckt und bestätigt ist.

## Dateien in diesem Bereich

`.gitattributes` in diesem Ordner nimmt Druckdateien (`*.3mf`) und Bilder (`*.png`) von der
Zeilenenden-Regel des Repositorys für `edge-light/**` aus: Sie sind Binärdateien und müssen nach dem
Auschecken Byte für Byte stimmen.
