# Der Verbindungstest bietet HEBEL an (Geräteseiten Stufe 3, NACHTRAG 2)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 152).


Scout `data/vp-geraeteseite-rev-b8` NACHTRAG Punkt 2 (Captain-Befund 21.08.2026):
„Konkrete Hebel direkt im Dialog anbieten - Logger-Adresse, Leistungsskalierung
×10, Modell-Alternative." Punkt 1 (gelesene Werte + verletzte Regel im Klartext)
und Punkt 3 („Trotzdem fortfahren") sind seit PR 456 gebaut; die Hebel standen
bis hierher nur im Fließtext der Fehlermeldung. **Reine Portal-Arbeit: kein
Endpunkt, keine Migration, kein Feld auf dem Draht.**

- **⚠ Ein Hebel entsteht aus BELEGEN, nie aus einer eigenen Diagnose der
  gelesenen Zahlen** — Eingang ist der `errorCode` bzw. `finding.rule` des
  Servers plus die STRUKTUR der Vorlage. Dafür trägt `TestErgebnis` beides jetzt
  maschinenlesbar NEBEN dem deutschen Satz (die Haus-Regel „keine Oberfläche
  durchsucht deutsche Sätze", dasselbe Muster wie `target_verdict` neben
  `state`).
- **⚠ Der Skalierungs-Hebel erscheint auch bei einem BESTANDENEN Test.** Der
  dokumentierte Deye-HV/LV-Fall (300 kW statt 30 kW) verletzt keine
  Plausibilitätsregel — geprüft wird allein der Ladestand (`socPlausible`) — und
  käme sonst nie zur Sprache, während „Weiter" offen steht. Sein Titel ist
  deshalb eine FRAGE: es gibt dafür keinen Beleg vom Server.
- **Regeln + Beweise:** `frontend/portal/src/testHebel.ts` (rein) mit
  `testHebel.test.ts` (16) + `AnlegenFlow.test.tsx` (+4,
  mutationsgeprüft: ohne die Ableitung fallen 10 Fälle). Im echten Chrome bei
  1440 und 375 durchgespielt: 0 px horizontaler Überlauf, 0 überstehende
  Elemente. Fläche + die Reihenfolge-Regel in `frontend/portal/AGENTS.md`.

