# Druckdateien, Stand v0.4

Fertige 3MF für das, was vorerst fertig ist. Wie man sie druckt: [Druckanleitung](../docs/drucken.md).

| Datei | Inhalt | Farben | gedruckt und bestätigt? |
|---|---|---|---|
| `gehaeuse-v04.3mf` | Unterteil und Deckel auf einer Platte, ein Drucklauf | weiß, schwarz, hellblau | siehe die beiden Einzelteile |
| `unterteil.3mf` | Unterteil: Wanne, Sockel mit Schlüssellöchern, vier Schraubsäulen | weiß | **ja.** Gedruckt am 10.10.2026 (mit dem Gehäuse v0.1) und mit dem Gehäuse v0.2; bestätigt am 11.10.2026: „ich habe das komplette gehäuse v0.2 gedruckt und es sitzt perfekt“. Die Form ist seit dem ersten Druck unverändert (festgehaltener Stand, `gehaeuse/passproben_gedruckt.json`) |
| `deckel.3mf` | Deckel mit Logo, Lichtschacht und Beschriftung in 3,8 mm | weiß, schwarz, hellblau | **Körper: ja**, bestätigt am 11.10.2026 als Deckel v0.2 („sitzt perfekt. Licht passt auch“). **Beschriftung: nach dem Druck gewählt** am 12.10.2026 („gedruckt - 1. wir nehmen 3,8 2. ja“; gefragt war nach der Schriftprobe, nach der Größe und danach, ob Lage und Buchstabenformen passen). Der Deckel ist der Körper von v0.2, aus dem nur die vier Wörter und ihre Dreiecke ausgespart und schwarz gefüllt sind. Ob auch der Deckel in dieser Fassung schon gedruckt ist, ist nicht ausdrücklich gesagt |
| `hutschienen-clip.3mf` | Zubehör: Clip für die Hutschiene TH 35, wird von hinten angeschraubt | einfarbig | **nein**, kein Druck gemeldet. Gerechnet und zur Probe geslict; Federkraft und Halt an einer echten Schiene sind unerprobt |
| `bohrlehre.3mf` | Zubehör: Streifen, der Abstand und Überstand der beiden Wandschrauben vorgibt | einfarbig | **nein**, kein Druck gemeldet. Die Wandmontage ist nicht einzeln bestätigt |

Nicht einzeln bestätigt, auch wenn das Gehäuse sitzt: ob die Büroklammer durch das Reset-Loch den
Taster trifft, ob alle Stecker im ganzen Gehäuse einrasten (an der Passprobe „Steckerwand“ am
09.10.2026 bestätigt), die Wandmontage, Farben und Logo im Druck.

## Was hier nicht liegt

Varianten sind Schalter im Programm und werden bei Bedarf gebaut (`./bauen.sh entwurf`, Ergebnis
unter `aus/gehaeuse-v04/`), nicht eingecheckt:

- der Deckel mit Schrift 4,5 mm (wie v0.3) und 3,0 mm (eine Bahn je Strich, nur mit dem
  Wandgenerator „Arachne“); beide baut der Schritt `entwurf` mit;
- die Beschriftung vertieft statt eingelegt, mit Reset und LEDs, ohne Beschriftung (Deckel v0.2);
- nur liegend ohne Sockel, Etikett auf dem Deckel oder an der Seite, alles in PETG;
- die Probestücke (Probe-Platte, Schablone, Steckerwand, Schachtprobe, Schriftprobe) und die STL;
- das Gehäuse einer Box mit Referenz und QR-Code auf der Unterseite: Es gibt es je Box, gebaut mit
  `./bauen.sh --referenz edge-…` nach `aus/kennung/<referenz>/` ([Kennung](../docs/kennung.md)). Es ist
  das Unterteil von hier ohne Etikettfeld, mit der Kennung in den ersten drei Schichten. **Gedruckt ist
  noch keine Kennung**; das Unterteil mit Kennung gilt bis zum Probedruck als nicht bestätigt.

Welche Schalter es gibt: [Bauen und ändern](../docs/bauen.md#varianten).

## Woran man erkennt, dass die Dateien zum Programm gehören

`./bauen.sh` vergleicht am Ende jede 3MF hier mit der frisch gebauten (Schritt `abgleich`) und endet
mit einem Fehler, wenn sie auseinanderlaufen. Byte für Byte gleich sind zwei Bauten nie: Die
Bibliothek, die die 3MF schreibt, vergibt jedes Mal neue Kennungen (`p:UUID`). Verglichen wird jede
Datei im Archiv ohne diese Kennungen; Ecken, Dreiecke, Namen, Farben und Filamentplätze müssen
Byte für Byte stimmen.

Die Dateien sind die des Standes v0.4 vom 11.10.2026, so wie sie zum Drucken bereitlagen. Ihre
Prüfsummen stehen in `SHA256SUMS` (prüfen mit `sha256sum -c SHA256SUMS`).

Nach einer gewollten Änderung am Modell: `.venv/bin/python -m gehaeuse.abgleich uebernehmen` (ersetzt
die geänderten 3MF und schreibt die Prüfsummen neu), dann in der Tabelle oben eintragen, was vom neuen
Stand gedruckt ist. Ein geändertes Teil ist bis zum nächsten Druck **nicht** bestätigt.
