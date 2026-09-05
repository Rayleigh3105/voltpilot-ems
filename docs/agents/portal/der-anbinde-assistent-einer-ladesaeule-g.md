# Der Anbinde-Assistent einer Ladesäule (Geräteseiten Stufe 3, E1)

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 7).


Aus drei erklärenden Sätzen ist ein geführter Weg geworden: Kennung festlegen →
Adresse in der Säule eintragen → warten, bis sie sich meldet. Die Regeln und
JEDER Satz liegen rein in `src/ladesaeuleAnbinden.ts`; die Flächen rendern nur.

- **EIN Körper, ZWEI Wirte** (`components/LadesaeuleAnbinden.tsx`): der eigene
  `LadesaeuleAnbindenDrawer` der Ladevorgänge-Seite und die Ladesäulen-KARTE des
  Anlege-Flusses (`AnlegenFlow`). Das
  `AdminGeraetKarten`-Muster — eine zweite Kopie hieße, jeden Satz und jede
  Regel zweimal zu pflegen. Der Wirt liefert die Box über den neuen
  `geraetSeite.boxOf` (die Schwester von `boxRefOf`, damit „welche Box ist es
  denn?" nur EINMAL beantwortet wird).
- **⚠ Ein Bauteil mit zwei Wirten bringt seine GESTALT selbst mit.** Die erste
  Fassung borgte sich `vp-assist-*` aus `KomponenteAssistent.css` — die wird nur
  vom Anlege-Assistenten importiert, also rendete der Drawer-Weg die
  Schrittliste ohne `list-style: none` und damit mit DOPPELTER Nummer („1.
  1Kennung festlegen"). **Im Browser-Beweis gefunden, nicht im Test** (jsdom hat
  keine Stylesheets). Seither eigene `vp-anbinden-*`-Klassen in
  `components/LadesaeuleAnbinden.css`.
- **Die drei Ehrlichkeitsregeln der Fläche** (jede als Test gepinnt): die
  ADRESSE wird nie erfunden (ohne bewiesene LAN-Adresse oder ohne gemeldeten
  Anschluss steht der WEG da, nie ein `ws://`); EINGETRAGEN ≠ GEMELDET (der
  Abschluss liest ausschließlich die vom Gerät gemeldeten Säulen); und ein
  Zustand, den die Box noch gar nicht gemeldet HAT, wird nicht als Defekt
  gelesen — vor der ersten Kennung meldet sie keine Ladepunkt-Lage, also steht
  dort „sobald die Kennung eingetragen ist …" (`grund: 'noch-nicht-gemeldet'`)
  statt „es kann sich keine Säule verbinden".
- **⚠ Seit dem 24.08.2026 gibt es eine ENTFERNEN-Tür (Captain-Order) — der
  frühere `KEIN_LOESCHEN`-Satz ist ERSATZLOS entfallen.** Je Zeile ein
  Papierkorb, dahinter der Haus-`ConfirmDialog` mit `entfernenFrage` +
  `entfernenFolgen`; der erste Klick entfernt NICHTS, er fragt. **Die ZUSAGE ist
  dieselbe wie auf der `:8484`-Fläche** (`VPOcpp.removalConsequences`) — beide
  Wege dürfen über dieselbe Handlung nichts Verschiedenes versprechen; das
  Portal nennt zusätzlich, was gleich bleibt und dass der Weg zurück offen ist.
  - **⚠ Die Folgenliste sagt die WAHRHEIT, nicht das Naheliegende: „Ein
    laufender Ladevorgang endet dadurch NICHT."** OCPP kennt seinen eigenen
    Totmann, das Sicherheitsprofil liegt IN der Säule, und sie lädt damit
    weiter — langsam, aber sie lädt. „Der Ladevorgang endet" wäre eine
    Falschaussage über eine Kundenanlage.
  - Sie nennt ausdrücklich, was GLEICH bleibt (andere Säulen, Anschlussgrenze,
    Ausfall-Schutz) und dass der Weg zurück offen ist — das Haus-Muster für
    jede Umstellung.
  - **`ENTFERNEN_HINWEIS` behauptet KEINE Zustellung** („sobald Ihre Box das
    nächste Mal verbunden ist. Bis dahin gilt, was sie zuletzt übernommen
    hat.") — das Dokument reist retained, und eine Box mit älterem Image kennt
    das Feld noch gar nicht.
  - Der Papierkorb ist 26 px SICHTBAR mit ≥44-px-Trefferfläche über `::before`
    (das `.vp-switch`-Muster) — ein 44-px-KASTEN zöge die 0,4 rem
    auseinanderliegenden Zeilen sichtbar auseinander.
- **⚠ Die Kennung folgt dem Namen nur, solange NIEMAND sie angefasst hat** — ab
  dem ersten Tastendruck gewinnt der Mensch. `kennungVorschlag` schlägt bei
  einem Namen ohne erlaubte Zeichen GAR NICHTS vor; ein leeres Feld ist
  ehrlicher als ein geratener Name. Das Vokabular (`[A-Za-z0-9._-]{1,64}`) ist
  der Zwilling von `ChargingConfigService.CHARGE_POINT_ID` — der Server glaubt
  der Fläche nichts.
- **⚠ Der Assistent pollt schneller als der Live-Takt des Hauses** — hier wird
  AKTIV gewartet (der Kunde steht an der Säule und tippt), und er lebt nur,
  solange er offen ist.
- **Die ZUSAGE lebt weiter in `ladepunkte.ANBINDEN_ALLOWLIST`**, der Einstiegs-
  Satz in `ANBINDEN_EINSTIEG` (Nachfolger des entfallenen `ANBINDEN_SCHRITTE`):
  beide stehen auf mehreren Flächen, und zwei Formulierungen derselben Zusage
  wären zwei Wahrheiten.

