# Geräte-Erlebnis Slice 1: Anlagenbild als direkte Navigation (27.08.2026)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 141).


Die aktuelle Komponenten-Seite (`#/anlage/{siteId}/modell`) führt weiter mit
dem elektrischen Anlagenbild und behält `Anlagenbild`/`Liste`, ist aber keine
Auswahlfläche mit Zwischenstufe mehr. Die vollständigen Portal-Regeln stehen in
`frontend/portal/AGENTS.md`; repo-weit sind diese Verträge wichtig:

- Ein reales Gerät ist im Bild ein echter Link auf seine bestehende
  Geräte-Detailseite. Die frühere Detail-Seitenleiste bzw. das mobile
  Bottom-Sheet, inline Anlege-Plätze und „Verbindungen anzeigen" sind entfernt;
  der eine primäre „Gerät hinzufügen"-Knopf bleibt.
- Hybrid-Wechselrichter erscheinen genau einmal unter PV, zeigen dort ihre
  PV-Produktion und weisen die integrierte Speicherrolle sichtbar aus. Ein
  fehlender Speicherwert erzeugt weder ein Duplikat noch einen erfundenen Wert.
  Der eigene Accessible Name des Karten-Links wiederholt beide sichtbaren
  Aussagen, damit er sie nicht vor Screenreadern verdeckt.
- Die Datenverbindungs-Karte ist ein Link auf die bestehende Box-Seite und
  verwendet die bereits autoritativen Felder `Device.lanHost` sowie
  `GET /api/v1/edge-versions`. Nur belegbar private/link-lokale Adressen im
  Kundennetz werden angezeigt; öffentliche, syntaktisch ungeeignete und
  Loopback-Adressen werden vor DOM und Accessible Name verworfen — auch
  IPv4-gemappte IPv6-Loopbacks wie `[::ffff:127.0.0.1]`. Ein vorhandener Port
  ist nur von 1 bis 65535 gültig. Fehlende
  Adresse/Version bleiben ruhige Platzhalter — kein neuer Backend-Vertrag war
  nötig.
- Der Site-Reiter „Befehle an Geräte" ist entfernt. Die `befehle`-Route bleibt
  für die gefilterten Absprünge der einzelnen Geräte (`?geraet=` bzw.
  `?komponente=`) gültig und weiterhin dem Bereich „Anlage" zugeordnet.

