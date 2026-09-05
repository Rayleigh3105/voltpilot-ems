# Erklärbarkeit Stufe 1 „Der Echtheits-Kern": die Treiber werden EXPORTIERT

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 129).


Der Auftrag der Regel oben: Stufe 0 hat die unechten Ursachen entfernt, diese Stufe liefert die
FAKTEN — also dürfen die echten Ursachen wieder gesagt werden, und nur die (Konzept
`data/vp-warum-erklaerbar-e2` §4/§5, Captain-Entscheide F1 Technik-Blick für alle · F2 Gleichstand
aussprechen · F6 Politik als Politik benennen). Alles additiv: ein Lauf ohne die Felder rendert
zeichengleich die beobachtende Stufe-0-Fassung.

- **⚠ Zwei Ableitungen WUSSTEN alles und gaben es nicht heraus — das war die ganze Lücke.**
  `derive_terminal_value_eur_per_kwh` kannte beim Rechnen den Anker-Zweig und die freie
  Auffüll-Quote und gab einen `float` zurück; `explain.py` holte die reduced costs und VERWARF sie.
  Jetzt liefert **`domain.derive_terminal_value` ein `TerminalValue`-Objekt** (`v_end` ·
  `anchor_kind` · `refill_free_pct` · `guard_capped`), und der alte float-Einstiegspunkt ist seine
  Reduktion auf den Wert — **es bleibt EINE Ableitung**, die v1 und Co-Optimizer-Zwilling weiter
  teilen, und kein Aufrufer musste angefasst werden.
- **VIER additive nullable Spalten** (Migration `V20260824000000`, Spiegel in
  `infra/local/timescale/04-schedule.sql`): die zwei RUN-Fakten `why_terminal_anchor` (geschlossenes
  Vokabular `einspeisewert` · `bezugspreis` · `marktpreis` · `vorgabe`) und `why_refill_free_pct`
  je Zeile wiederholt (das `terminal_value`-Muster), die zwei SLOT-Fakten `why_next_best` +
  `why_next_best_margin_ct` **nur auf einem RUHENDEN Slot**. NULL überall = Erklär-Schicht aus oder
  Vor-Feature-Lauf. Der frozen MQTT-Kontrakt ist unberührt (das Warum erreicht die Box nie), die
  Ersparnis-Simulation fährt weiter `explain_plan=False`, und die **Golden-Suite ist unverändert
  grün** — ein eigener Test beweist die Byte-Identität der Setpoints mit und ohne Export.
- **⚠ Die Marge ist ANALYTISCH gerechnet, nicht aus den reduced costs gelesen — und das ist eine
  Konstruktions-Entscheidung, keine Bequemlichkeit.** Im Fix-and-relax-LP ist `is_charging` FIXIERT,
  also klemmt das `charge_gate` die Ladeseite eines ruhenden Slots auf 0 und ihre reduced cost ist
  degeneriert. `explain.next_best_alternative` rechnet deshalb aus den gepinnten
  Stationaritäts-Identitäten in den KUNDEN-Preisen (`decken = imp − λ/η − wear`, `verkaufen = exp −
  λ/η − wear`, `solar_speichern = η·λ − exp − wear`, `netzladen = η·λ − imp − wear`); der Kreuz-Check
  gegen `−rc/dt` läuft im Test auf der ENTLADE-Seite, wo die rc belastbar ist.
- **Es werden nur ZULÄSSIGE Alternativen genannt** — Laden braucht SoC-Luft (und im EEG-Modus echten
  PV-Überschuss), Entladen Energie über dem Boden, `netzladen` die Netzlade-Freigabe, `decken` ein
  Haus-Defizit. Eine Marge gegen eine unmögliche Handlung wäre ein erfundenes Bedauern: eine leere
  Batterie an einer EEG-Anlage in einem PV-losen Slot bekommt deshalb **gar keine** (beide Felder
  null), und eine positive Marge wird nie berichtet.
- **Der Betreiber-Blick nennt denselben Treiber aus denselben Spalten** (`SlotEconomics.whyText`
  bekam eine 9-stellige Überladung + `nextBestClause`; `OptimizerDiagnosticsRepository.SlotRow`
  trägt die zwei Slot-Fakten) — kein zweiter Rechenweg, und ein Wort außerhalb des Vokabulars wird
  IGNORIERT statt geraten. **`NEXT_BEST_TIE_CT` (0,05 ct) lebt DREIMAL** — `explain` (Optimizer),
  `SlotEconomics` (api), `fahrplanWhy` (Portal): **alle drei zusammen ändern.**
- **Abnahme (§4.5), als Test gepinnt:** der 17.08.-Abend meldet jetzt Anker `bezugspreis`, freie
  Auffüllung 0 % und je ruhendem Slot `decken` mit Marge **0,0 ct = Gleichstand** — genau die vier
  Fakten, die gefehlt haben; der sonnige Normaltag meldet `einspeisewert` + 62 %. Beweise:
  `tests/test_why_facts.py` (19, u. a. Byte-Identität + der rc-Kreuz-Check),
  `SlotEconomicsTest.idleWhyTextNamesTheExportedNextBestAndCallsATieATie`,
  `PortalApiTest.scheduleEndpointReturnsLatestPlanTenantScoped` (Lesepfad + NULL-Degradation).
  Portal-Seite (die drei Lesehöhen, die Gate-Tabelle, der gefütterte Wächter) in
  `frontend/portal/AGENTS.md`.
- **NICHT in dieser Stufe:** die „Lage"-Zeile mit Tages-Bogen und Morgen-Ausblick (Stufe 2, gebaut -
  siehe den nächsten Abschnitt), die Abregel-/Grenzen-Verzweigung (Stufe 3) und die
  Eingaben-Diff-Zeile (Stufe 4, F3 zurückgestellt).

