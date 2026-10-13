# Release-Notiz `edge-2026.10.2` – Entwurf

**Stand:** Entwurf vom 13.10.2026. Das Release ist **nicht getaggt**, NW-3 und der Zusatzlauf
„kurzer Verbraucher“ sind für dieses Paar **nicht gefahren**, ein Rollout ist nicht geplant. Diese
Datei hält fest, was das nächste Box-Release am Verhalten des Speichers ändert, damit die Notiz
beim Taggen nicht aus dem Gedächtnis entsteht. Die Notiz an Kunden gibt ausschließlich der
Betreiber frei ([Vorlage](release-notiz-vorlage.md), Abschnitt „Software-Aktualisierung der Box“).

## Was sich ändert

**Haltezeit vor dem Entladen in jeder Viertelstunde** (Entscheid A vom 13.10.2026; ersetzt die
Slot-Grenze des Entscheids E2 A vom 10.10.2026). Bis `edge-2026.10.1` wartete die Box nur in einer
Viertelstunde, die ein Laden plant, 60 s, bevor sie ein gemessenes Defizit aus dem Speicher deckte.
In jeder anderen Viertelstunde deckte sie das erste gemessene Defizit sofort – und weil ein
Wechselrichter einem Befehl erst nach einigen Sekunden folgt, kam die Entladung bei einem
Verbraucher von 10 bis 15 s zu spät und ging ins Netz (Zusatzlauf zu `edge-2026.10.1`, Simulator:
22,3 Wh hinter sechs Verbrauchern, bis 20 s am Stück).

Mit diesem Release gilt in **jeder** Viertelstunde, in der die Box der Messung nachregelt – Laden,
Ruhe, Deck-Viertelstunde, ungeplante Lastdeckung:

- Ein gemessenes Defizit hebt die Entladung erst an, wenn es 60 s ununterbrochen gemessen wurde.
  Die Deckung eines anhaltenden Defizits beginnt damit frühestens 60 s nach dessen Beginn; im
  Prüflauf am Deye-Profil nach rund **90 bis 100 s** (Haltezeit plus bis zu zwei Messtakte), am
  schnellen Gerät nach rund 70 bis 80 s. Der Entscheid nannte „60 bis 90 s“.
- Ein Verbraucher, der höchstens 60 s läuft, löst aus der Ruhe keine Entladung mehr aus. Er wird
  für diese Sekunden aus dem Netz gedeckt.
- Das Zurücknehmen bleibt sofort: Laden wird bei einem Defizit sofort zurückgenommen, eine laufende
  Entladung folgt dem Haus sofort nach unten und wird bei gemessener Einspeisung sofort
  zurückgenommen.
- Eine laufende Deckung fällt bei einer Lücke in der Messung nicht weg; sie kann nur nicht wachsen,
  bis das Defizit wieder 60 s gemessen ist.

**Unverändert:** geplante Verkäufe (ein Entlade-Sollwert des Fahrplans ohne Pflicht läuft wie
geplant), die Reserve (`effective_floor_soc_pct`), der Zyklenschutz, der Rückfall ohne Fahrplan und
der Eigenmodus des Wechselrichters („Gerät regelt“) – ein Gerät, das den Netzpunkt selbst regelt,
wartet nicht.

**Nicht erfasst:** ein kurzer Verbraucher **auf** einem schon stehenden Defizit (typisch nachts,
wenn der Speicher die Grundlast deckt). Die Haltezeit misst, ob das Haus im Defizit ist, nicht um
wie viel; dieser Fall wird wie bisher sofort nachgeführt.

Betroffen ist allein der Go-Core der Box (`vp-edge-core`; Edge Light nutzt denselben Kern). Cloud,
Optimierer und Portal ändern sich nicht; kein neuer Schalter, kein neues Feld im Heartbeat. Der
box-lokale Zustand zeigt die Wartezeit wie bisher als `deficit_hold`.

## Vor dem Taggen

1. NW-3 für das Paar fahren (`tools/nw3-box-image/nw3.sh --strecke`), `paare.json` nachziehen.
2. Zusatzlauf „kurzer Verbraucher“ fahren, beide Fälle:
   `kurzer-verbraucher.sh --ref edge-2026.10.2` (Fall `laden`) und `--fall ruhe`. Erwartet:
   beide **grün**. Gegenprobe im Fall `ruhe` gegen `edge-2026.10.1`: **rot**
   ([Erwartung je Stand](../../tools/nw3-box-image/README.md#zusatzlauf-kurzer-verbraucher)).
3. Der Pflichtlauf je Steuerprofil ([Prüfstände](../../edge-app/nodered/CONTROL-BENCH.md)) fährt
   seit diesem Stand drei Slot-Arten; Stufe 2 (Prüfstand, erstes echtes Gerät) steht für jedes
   Gerät aus – Simulatornachweise ersetzen keinen Hardware-Prüfstand.

## Text für die Notiz (Baustein für „sichtbare Änderungen“)

> Der Speicher deckt einen neu auftretenden Strombedarf jetzt erst, wenn dieser eine Minute lang
> ununterbrochen gemessen wurde. Ein Verbraucher, der nur wenige Sekunden läuft, wird in dieser
> Zeit aus dem Netz versorgt; dafür speist der Speicher nicht mehr ins Netz ein, wenn der
> Verbraucher schon wieder aus ist. Ein Bedarf, der anhält, wird wie bisher aus dem Speicher
> gedeckt – etwa anderthalb Minuten nach seinem Beginn.
