# Geräteseiten Stufe 1: die ATTRIBUTION „Ziel-Gerät führt"

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 144).


Scout `data/vp-geraeteseite-rev-b8` §5 (Captain-Abnahme 21.08.2026, E1–E4 alle
angenommen). Der behobene Befund war eine ZWEITE WAHRHEIT, kein fehlender
Datensatz: auf EINER Seite stand oben „⚡ VoltPilot steuert den Speicher" und
darunter „VoltPilot sendet an dieses Gerät keine Befehle. Es wird nur gelesen."

- **⚠ DIE REGEL LEBT SEITHER EINMAL: `command/DeviceAttribution`** (rein,
  Docker-frei geprüft) — wörtlich `komponenten.ts plantModel` Regel 1 + 2:
  **① der Pin gewinnt** (`edge_source_id` → genau dieses Gerät), **② der
  PRIMÄRE Wechselrichter erbt das KOMPONIERTE** (Zeilen ohne Pin, die an der
  Box hängen). Wer NICHT der primäre Wechselrichter ist, erbt NICHTS — eine
  komponierte Zeile einem beliebigen Gerät zuzuschreiben wäre genau die
  erfundene Zuordnung, gegen die das Modell gebaut ist. Vorher entschied das
  Portal so und der Server anders (`DeviceScopes` suchte ausschließlich über
  den Pin, und eine komponierte Zeile trägt per Konstruktion keinen).
- **Der PRIMÄRE Wechselrichter ist die gemeldete Quelle mit `kind = "primary"`**
  (Kennung `inverter`) — dieselbe Bedingung, unter der die Box ihren
  `local_setup`-Wechselrichter-Eintrag baut, an dem das Portal seine Regel 2
  festmacht. **Ohne gemeldete Quelle wird NICHTS angenommen:** ein Gerät, das
  nur über einen Pin bekannt ist, erbt kein Komponiertes.
- **⚠ DIE BOX IST EIN TOR, KEIN GERÄT: ihr Bezug ist seither auf die
  ANLAGENWEITEN Zeilen eingeengt** (`entity_id IS NULL` — Abregelung, Wächter,
  Not-Aus, Lücke; ebenso die Register-Vorgänge über
  `RegisterWriteEventRepository.betweenForBox`). Alles mit Komponente hat jetzt
  ein eigenes Gerät, auf dessen Seite es steht; denselben Befehl an zwei Orten
  zu zeigen wäre eine zweite Wahrheit. **Es geht nichts verloren, es wandert:**
  die ganze Anlage auf einmal zeigt weiterhin die Befehle-Seite OHNE Filter —
  genau deshalb gehören Einengung und Attributions-Fix in EINEN Schritt (vorher
  hätte die Einengung den Speicher-Strom vollständig unsichtbar gemacht).
- **`writes` stimmt dadurch von selbst:** der Deye trägt seine Speicher-Befehle,
  `NUR_LESEN` erscheint nur noch, wo es wahr ist.
- **Portal-Seite:** `befehle.GERAETE_BEFEHLE` ist die Gegenrichtung von
  `ANLAGENWEITE_BEFEHLE` („Befehle an ein einzelnes Gerät … stehen auf der Seite
  dieses Geräts"), der Box-Kopfsatz sagt nicht mehr „alle Befehle dieser
  Anlage", und „Alle anzeigen" führt auf der Box in die UNGEFILTERTE
  Befehle-Seite — sonst führte der Weg zurück auf dieselbe Liste.
  `registerWrite.geraeteVerlauf` zieht die Grenze client-seitig identisch.
- **Beweise:** rein `DeviceAttributionTest` (6) · Testcontainers
  `CommandHistoryApiTest.derSpeicherSollwertStehtAufDerSeiteDesWechselrichtersDerIhnAusfuehrt`
  (echte DB: der Wechselrichter trägt seinen Strom und `writes=true`, ein anderes
  gemeldetes Gerät erbt NICHTS, die Box zeigt nur die Abregelung) + der
  umgeschriebene `derGeraeteFilterTrenntDieBoxVonDenGeraetenDahinter`.

