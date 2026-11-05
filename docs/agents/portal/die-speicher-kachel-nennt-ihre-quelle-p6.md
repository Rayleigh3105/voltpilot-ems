# Die Speicher-Kachel nennt ihre QUELLE

Der Speicher-Knoten des Topologie-Lesemodells trägt `soc_source`: WELCHE Entität den Ladestand geliefert hat (`docs/contracts/v2/topology-read-model.md`).
Die Portal-Flächen sagen das, wo es sonst dem falschen Gerät zugeschrieben würde.

## Die Anzeige

- **Cockpit-Kachel** (`adaptiveLive.storageTile` → `livePuls` → `LivePuls.tsx`):
  `socQuelle` = „Ladestand von: &lt;Gerät&gt;" - NUR, wenn der Ladestand von einem anderen Gerät kommt als die Kilowatt der Kachel.
  Ein Speicher, der seinen eigenen Ladestand meldet, bekommt die Zeile nicht: sie wäre eine Wiederholung des Kachel-Namens.
- **Geräteseite** (`geraetGesicht.speicherKacheln` aus `GesichtInput.speicherKnoten`):
  der Ladestand eines anderen Geräts gewinnt über das Schweigen dieses Geräts, mit „Ladestand von: …" als Wort.
- Die Formulierung wohnt einmal in `ladestandVon.ts`.

Ohne Ladestand gibt es keine Quelle zu nennen; ein abwesendes Feld bleibt abwesend, nie ein geratener Wert.
