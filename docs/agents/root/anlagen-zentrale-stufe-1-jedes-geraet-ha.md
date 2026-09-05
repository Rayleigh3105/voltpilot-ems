# Anlagen-Zentrale Stufe 1: jedes Gerät hat EINE deep-linkbare Seite

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 138).


Der Kern des genehmigten Konzepts `data/vp-anlagen-zentrale-konzept-h6` (§7,
Captain-Abnahme 20.08.2026 mit D1-D6). **Reine Portal-Arbeit — es entsteht kein
Backend, keine Migration, kein neuer Endpunkt:** die Seite komponiert
ausschließlich Lesepfade, die es längst gibt (`/devices` · `/entities` ·
`/sources` · `/components` · `/topology` · `/control-status` ·
`/curtailment-status` · `/edge-versions` · `/chargers` · `/entity-strategies`).

- **Der behobene Befund ist der ORT, nicht die Daten.** Ein Gerät lag über vier
  Teilwahrheiten verstreut, und die Funktionen auf GERÄTE-Ebene (Register
  lesen/schreiben, Befehle, Software, Freigabe) hingen an der ROLLE statt am
  Gerät.
- **Route:** `#/anlage/{siteId}/geraet/{ref}` = die VoltPilot-Box,
  `…/{geraetId}` = ein Gerät DAHINTER (`inverter` = das Hauptgerät, `src-…` =
  eine gemeldete Quelle, `cp-<ChargePointId>` = eine OCPP-Säule). **Der
  Schlüssel ist die REFERENZ, nicht die Geräte-UUID** — sie überlebt
  Unclaim/Re-Claim, also überlebt auch jedes Lesezeichen. Additiv: eine Adresse
  ohne Referenz fällt auf die Zentrale zurück, nie ein 404.
- **Kunde und Plattform-Admin sehen DIESELBE Seite** (Vorentscheidung V1): die
  Admin-Karten sind seit PR 1f nach `components/AdminGeraetKarten.tsx`
  HERAUSGELÖST und haben ZWEI Wirte — die Plattform-Geräteseite und, hinter dem
  EINEN Tor `rollen.showTechnicalLayer()`, die Kunden-Geräteseite; nie eine
  zweite Fläche und nie eine zweite Kopie (sonst wäre jede Handlung samt ihrer
  Rückfrage zweimal zu pflegen). **Die Plattform-Liste FÜHRT dorthin:** ein
  verbundenes Gerät wird über den Mandanten-Umschalter auf seine Geräteseite
  weitergeleitet, eine gedruckte, noch nicht verbundene Aufkleber-ID
  ausdrücklich NICHT — sie behält ihre Plattform-Vollansicht, weil es kein
  Gerät gibt, über das etwas zu sagen wäre.
- **NICHT in dieser Stufe** (Stufe 3, Konsolidierung): es wird nichts
  abgerissen — die Plattform-Geräteseite, der Register-Aufklapper der Zentrale
  und die Installateur-Ansicht bleiben unverändert stehen.
- Fläche, Regeln und Fallstricke: `frontend/portal/AGENTS.md` „Die
  GERÄTE-DETAILSEITE".

