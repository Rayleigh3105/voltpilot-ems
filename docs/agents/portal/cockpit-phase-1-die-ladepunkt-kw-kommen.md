# Cockpit Phase 1: die Ladepunkt-kW kommen ueber die ENTITAET, und ein alter Messwert liest nie als aktuell

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 25).


Cloud-/Edge-Seite: root `CLAUDE.md` „Cockpit Phase 1 / E1+E2". Portal-Regeln:

- **`ladepunkte.messwertAlter` / `aktuelleLeistung`** sind die EINE Regel ueber
  die Frische eines Ladepunkt-Messwerts (`meteredAt`, seit E2). Ein VERALTETER
  Wert faellt auf den Zustand zurueck, den es dafuer laengst gibt
  (`laedt_ohne_messung` + Detail „Leistung veraltet") und geht in KEINE Summe
  ein - kein neues Wort, keine neue Farbe. **Ohne Stempel ist alles
  byte-identisch** (eine Frische zu BEHAUPTEN, die niemand gemessen hat, waere
  die gefaehrlichere der beiden Auskuenfte).
- **⚠ `ladepunkte.ts` ist import-frei** und fuehrt das Live-Fenster deshalb als
  dokumentierten ZWILLING von `api.ts` `ONLINE_WINDOW_MS` - **beide zusammen
  aendern**; `ladepunkte.test.ts` liest beide Seiten und faellt sonst um.
- **`heuteAusEntitaet` nimmt zuerst den `energy_kwh`-ZAEHLER** (`max − min`, mit
  der Monotonie-Regel des Registers: eine fallende Reihe ergibt GAR KEINE Zahl)
  und faellt sonst auf die Leistungs-Integration zurueck. Ein Zaehler MISST, eine
  Integration schaetzt.
- **`gemesseneEntitaeten` schliesst Ladepunkte seither EIN** (sie sind messende
  Komponenten). Der OCPP-Register-Abruf bleibt daneben, weil nur er die Zahl JE
  STECKER kennt; **die Saeulen-Summe wird NIE auf einen von zwei Steckern
  geschrieben** - das waere eine erfundene Aufteilung. Bei EINEM Stecker ist der
  Entitaets-Zaehler der ehrliche Rueckfall.

