# Anlagen-Zentrale Stufe 2: das STRUKTUR-SCHALTBILD

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 140).

**Historischer Aufbau:** Die spätere Anlagenbild-/Listen-Ansicht hat diese Oberfläche abgelöst. Der unerreichbare alte Renderer, sein Modell und CSS sowie die exklusiven Tests wurden im September 2026 entfernt; die aktiven Geräte- und Box-Ansichten bleiben erhalten.


Der zweite Reiter der Zentrale (Konzept `data/vp-anlagen-zentrale-konzept-h6` §8,
Revision 2: **es wohnt in einem EIGENEN Reiter neben „Ihre Geräte", nicht als
erste Karte** — der Einstieg bleibt die ruhige Liste). **Reine Portal-Arbeit: es
entsteht kein Endpunkt, keine Tabelle und keine gespeicherte Position.**

- **Der behobene Befund ist eine FRAGE, die keine Liste beantwortet:** wie hängt
  das alles zusammen? Von links nach rechts — VoltPilot ⇄ Ihre Box → die Wege →
  die Geräte → die Komponenten → der Netzanschlusspunkt.
- **⚠ Es ist STRUKTUR, nicht Energiefluss** (§8.5): keine kW-Pfeile, keine
  Animation, keine Leitungs-/Phasen-Darstellung, keine Netzwerk-Topologie. Der
  Energiefluss bleibt im Cockpit; dieses Bild sagt, WAS mit WEM spricht und WER
  was misst bzw. steuert.
- **Kein zweites Modell:** Eingabe ist DERSELBE Lesesatz, aus dem die
  Geräte-Karten darunter entstehen (`plantModel`, `/entities.localSetup` samt
  der PR-2b-Verbindungsfelder, `/sources`, `/chargers`, `/control-status`,
  `/curtailment-status`, `/edge-versions`). Ändert der Kunde einen Pin, ändert
  sich das Bild im selben Atemzug.
- **Das Layout ist DETERMINISTISCH und wird IM MODUL gerechnet** (die
  `flow-graph`-Lehre) — damit ist die Geometrie, also auch „läuft etwas über den
  Rand", ohne Browser prüfbar.
- **⚠ Die ABREGELUNG ist bewusst KEINE ⚡-Kante.** Die Rückmeldung der Box ZÄHLT
  abregelbare Einheiten (`units`/`certifiedUnits`), sie BENENNT sie nicht —
  welcher Erzeuger gemeint ist, weiß das Bild also nicht, und ein geratenes ⚡
  wäre eine Zusage über eine Kundenanlage. Der Stand steht deshalb dort, wo die
  Einspeisegrenze wohnt: am Netzanschlusspunkt, als Zahl („2 von 2
  freigegeben"), bei Teil-Freigabe zusätzlich als Lücken-Zeile. **Im
  Browser-Beweis gefunden** — die erste Fassung markierte auch die PV-Zeile des
  Hybriden, der gar nicht zu den gezählten Einheiten gehört.
- **Eine Lücke wird BENANNT, nie gefüllt:** die eigene LAN-Adresse der Box (bis
  D5), der Einbauort des Zählers, der Weg eines Geräts mit älterem Box-Stand.
- Fläche, Regeln und die zwei weiteren Browser-Befunde:
  `frontend/portal/AGENTS.md` „Das STRUKTUR-SCHALTBILD".

