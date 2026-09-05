# Erklärbarkeit Stufe 3 „Grenzen als Gründe": die Abregelung nennt ihren Urheber

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 131).


Die letzte Stufe des Erklärbarkeits-Konzepts (`data/vp-warum-erklaerbar-e2` §5.4 + §8 + §10
Stufe 3, Captain-Entscheide F1–F6). **Sie ist REIN Portal — kein Endpunkt, keine Spalte, keine
Migration:** die drei Ursachen liegen seit je in der Persistenz (`slot_flags` mit
`grid_limit_14a`/`feed_in_cap` aus `explain._binding_flags`, `price_eur_mwh`), die vierte
(die Grenze IM GERÄT) kam mit „Grenzen & Wächter" Stufe 0 in `device_curtailment_status`.

- **Der Anlass ist W4 („drosselt IHR meine Anlage?") und die Antwort war am Warum-Ort nicht
  zu bekommen:** die Rolle `abregeln` behauptete IMMER den negativen Börsenpreis — eine
  Ein-Ursachen-Aussage über eine Mehr-Ursachen-Entscheidung. Jetzt verzweigt der Satz auf die
  BELEGTE Ursache, und ohne Fakt sagt er nur, was der Plan TUT.
- **Die Reihenfolge ist eine Aussage: Netzbetreiber (§14a) → Anmeldung (Einspeisegrenze) →
  Markt (Negativpreis).** Der FREMDE Auftrag führt vor unserer eigenen Ökonomie; wer die
  Reihenfolge dreht, verschweigt genau den Urheber, nach dem gefragt wurde.
- **Der Satz über die Grenze IM GERÄT hat weiterhin GENAU EINEN Wohnort** —
  `curtailment.deviceLimitLine` (Portal) mit seiner Regel, dem Gerät nie unsere eigene
  Fahrplan-Kappe anzulasten. Der Warum-Ort reicht ihn durch.
- **Folge für künftige Solver-Arbeit:** wer ein neues Bindungs-Flag exportiert, das eine
  Abregelung verursachen kann, trägt es in `frontend/portal/src/grenzenWarum.ts` nach —
  sonst fällt sein Fall stillschweigend auf die Beobachtung zurück (was ehrlich, aber
  weniger hilfreich ist). Portal-Details in `frontend/portal/AGENTS.md`.

