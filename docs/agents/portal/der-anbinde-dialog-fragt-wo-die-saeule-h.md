# Der Anbinde-Dialog fragt, WO die Saeule haengt (Cockpit Phase 1 / C1)

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 26).


Konzept `data/vp-verbraucher-cockpit-k1` §8 Phase 1 (C1), Captain-Entscheid E5.
Repo-weite Regeln und die Sicherheits-Asymmetrie in `../../AGENTS.md`
„Cockpit Phase 1 / C1"; die Portal-Seite in fuenf Punkten:

- **Alles Abgeleitete liegt rein in `src/ladesaeuleAnbinden.ts`**
  (`ANSCHLUSS_FRAGE`/`ANSCHLUSS_HILFE`/`ANSCHLUSS_OPTIONEN`/`ANSCHLUSS_VORGABE`
  + `anschlussSoll`/`anschlussWahl`/`anschlussZumSenden`/`anschlussSicht`);
  `components/LadesaeuleAnbinden.tsx` rendert sie in Schritt 1 als
  `fieldset`-Radiopaar (das `LadeparkKapsel`-Muster).
- **⚠ Es ist eine ORTSFRAGE, keine Einstellung.** „Wo haengt diese Saeule?" fragt
  nach einer TATSACHE der Anlage — deshalb kein „empfohlen", kein „moechten Sie".
  Die Hilfe sagt die FOLGE in Kundenwaehrung („aus dem Netzbezug herausrechnen"),
  nie die Formel der Box.
- **⚠ Eine UNVERAENDERTE Wahl sendet NICHTS** (`anschlussZumSenden` gibt
  `undefined`): das retained Dokument bliebe byte-gleich, und eine Zustellung,
  die nichts aendert, wird gar nicht erst ausgeloest. Beim ERSTEN Eintragen
  reist sie dagegen IMMER mit — auch wenn sie die Vorgabe ist: der Kunde hat sie
  gesehen und stehen lassen, und genau das macht das SOLL ausdruecklich.
- **Eine geaenderte Wahl auf einer SCHON eingetragenen Kennung bekommt einen
  eigenen Knopf** („Anschluss speichern"), der nur erscheint, wenn es wirklich
  etwas zu senden gibt — sonst verschluckte die Flaeche die Wahl, die der Kunde
  gerade traf.
- **⚠ Der Abweichungs-Satz erscheint NUR, wenn die Box etwas ANDERES meldet**
  (`anschlussSicht`). Eine Box, die gar nichts meldet, ist ein AELTERER Stand —
  daraus eine Abweichung zu machen waere eine Behauptung ueber eine Anlage, die
  dazu nichts gesagt hat. Die Zeile zeigt immer das SOLL, denn das ist die Wahl
  des Kunden.
- Beweise: `ladesaeuleAnbinden.test.ts` (+11) + `components/LadesaeuleAnbinden.test.tsx`
  (+6); die zwei Ehrlichkeitsregeln („unveraendert sendet nichts", „Schweigen
  ist keine Abweichung") sind mutationsgeprueft.

