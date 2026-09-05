# Die HEBEL des Verbindungstests (Geräteseiten Stufe 3, NACHTRAG 2)

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 8).


Der Test sagte seit PR 456 ehrlich, WAS gelesen wurde und WELCHE Regel verletzt
ist — die Hebel dagegen standen nur im Fließtext („Bitte Seriennummer, Port und
Modell prüfen"). Jetzt sind sie klickbar: `src/testHebel.ts` (rein) leitet sie
ab, der Anlege-Assistent rendert sie unter dem Ergebnis.

- **⚠ Ein Hebel entsteht aus BELEGEN, nie aus einer eigenen Diagnose.** Eingang
  ist ausschliesslich, was der Server gesagt hat (`errorCode`, `finding.rule` —
  beide seit dieser Runde maschinenlesbar auf `TestErgebnis` NEBEN dem deutschen
  Satz, damit keine Fläche einen Satz nach Stichworten durchsucht) und was die
  VORLAGE strukturell hergibt. Aus den gelesenen Zahlen wird NICHTS geschlossen —
  dieselbe Grenze, die `komponentenAssistent.overrideFuer` zieht.
- **⚠ Ein Hebel, der ins Leere ginge, wird nicht angeboten:** kein Feld, das die
  Vorlage nicht hat; kein Modellwechsel ohne Alternative (und NIE über Marken
  hinweg); keine Skalierung, die schon eingestellt ist.
- **⚠ Die REIHENFOLGE ist eine Aussage: BELEGTES führt, die FRAGE steht
  zuletzt.** Adresse → Modell (beides hat der Server benannt) → Skalierung (dafür
  gibt es keinen Beleg, deshalb ist ihr Titel eine Frage). Andersherum stünde
  eine Vermutung über der Erklärung, die die Box gerade geliefert hat — im
  Browser-Beweis aufgefallen.
- **⚠ Der Skalierungs-Hebel erscheint auch bei einem BESTANDENEN Test.** Der
  dokumentierte Deye-HV/LV-Fall (300 kW statt 30 kW) verletzt keine
  Plausibilitätsregel — geprüft wird allein der Ladestand — und käme sonst nie
  zur Sprache; „Weiter" ist dort offen, die Anlage entstünde mit zehnfachen
  Werten.
- **Der Klick ändert so wenig wie möglich:** die Adress-Hebel SPRINGEN ihr Feld
  nur an (was dort stehen muss, weiss der Mensch, nicht VoltPilot), nur die
  Skalierung setzt einen Wert — sie hat genau eine sinnvolle Alternative. Jede
  Feldänderung entwertet den Beleg (`setzeFeld`), also schliesst sich die
  Hebel-Liste und „Weiter" ist wieder zu: genau das sagt `HEBEL_HINWEIS`.

