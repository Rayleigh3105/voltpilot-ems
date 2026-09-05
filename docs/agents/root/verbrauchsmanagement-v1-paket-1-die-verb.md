# Verbrauchsmanagement v1 — Paket 1: die Verbraucher-Zone LESEND

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 164).


Erstes Paket des Programms „Steuerart je Verbraucher" (Konzept/Report
`data/vp-verbrauchsmgmt-programm` §6/§7/§8 P1). Die Steuerung bekommt eine
ZONE, die je Verbraucher sagt, WIE er lädt oder läuft. **Es entsteht KEIN
Schreibpfad** — die Steuerart wird gelesen, nicht gesetzt (das bauen P2/P4).
Ohne Verbraucher und ohne Ladepunkt antwortet der Endpunkt ehrlich leer, und
die Fläche zeigt ihren Leer-Zustand.

- **⚠ DIE STEUERART IST EINE PROJEKTION, NIE EIN ZWEITES DATENFORMAT** (der
  Grundsatz des Programms). `verbraucher/SteuerartProjektion` (rein,
  Docker-frei geprüft — das `Tagesprotokoll`/`FleetPflege`-Muster) liest den
  BESTEHENDEN `consumer_policy`-Bestand rückwärts: aus den Anforderungen eines
  aktiven Dokuments wird ein Paar **Quelle + Ziel**. Es wird nichts gespeichert,
  nichts migriert und kein Feld ergänzt — wer die Steuerart ändern will, ändert
  die Policy, und die Projektion folgt.
- **⚠ MEHRDEUTIG HEISST „Eigene Regel", nie eine geratene Quelle.** Die
  Rückwärts-Regel nimmt je aktiver Anforderung entweder eine QUELLE oder ein
  ZIEL; sobald eine zweite Anforderung derselben Art auftaucht oder ein Blatt
  nicht in das schmale Vokabular passt, ist das Ergebnis `eigene_regel`. Die
  Alternative wäre, aus einem beliebig verschachtelten Bedingungsbaum eine
  einfache Quelle zu behaupten — genau die erfundene Aussage, die das Haus
  verbietet.
- **⚠ EIN OCPP-LADEPUNKT KANN HEUTE STRUKTURELL KEINE POLICY TRAGEN.** Eine
  komponierte `ev-charger`-Zeile bekommt nie ein `consumer_profile` (Konzept
  S3), und `consumer_policy.entity_id` hat einen FK darauf. Ein Ladepunkt ohne
  eigene Policy erbt deshalb den ANLAGEN-STANDARD aus
  `site_charging_config.surplus_policy` (`schnell|nur_sonne|sonne_zuerst` →
  `sofort`/`ueberschuss`; die Herkunft ist dann `standard` statt `policy`).
  `VerbraucherApiTest` hält den FK als STRUKTUR-Wächter fest, damit P5 ihn
  bewusst weiten muss, statt still darüber zu stolpern.
- **⚠ `NormalizePolicy`s Vorgabe ist `schnell`** (die Kompatibilitäts-Zusage der
  Box) — ohne gepflegte Politik ist der Anlagen-Standard also `sofort`, nie
  „Überschuss". Wer das dreht, ändert das Verhalten JEDER Bestandsanlage.
- **`GET /api/v1/sites/{siteId}/verbraucher`** (`SiteVerbraucherController`,
  RLS-gefenced wie jede `/sites/**`-Route — kein `@PreAuthorize`, fremde Anlage
  **404**, Admins über den `X-Tenant-Id`-Umschalter; in `openapi.yaml`) liefert
  DREI Dinge: `verbraucher[]` (Name · Typ · Steuerart · Regelzahl ·
  Standard/abweichend · Ziel-Fortschritt), `ladepunkte` (der Anlagen-Standard
  samt Folger-Zahl und der Ladepark-Rahmen) und die initiale `rangliste`.
  **Der Dienst liest je Quelle EINMAL en bloc** (`activePoliciesForSite`,
  `listForSiteByEntity`, `chargePointIdsByEntity`, `entityStrategies`) — kein
  N+1 je Verbraucher.
- **⚠ Der Ladepark-Rahmen wird DURCHGEREICHT, nie neu formuliert**
  (`LadeparkRahmen`): Grenze, Sicherheitsabstand, Modus und der deutsche
  `budget_note` kommen aus dem, was die BOX gemeldet hat; **ohne gepflegte
  Grenze steht `GRENZE_FEHLT`**, nie eine erfundene Zahl.
- **`regeln` zählt AKTIVE Wenn/Dann-Ansprüche** (`FlowService.entityStrategies`),
  NICHT die Policy — die Regeln 1–8 der Projektion verbrauchen ein aktives
  Policy-Dokument per Konstruktion ganz; es zusätzlich als „Regel" zu zählen
  hiesse, dieselbe Sache zweimal zu behaupten.
- **Die initiale Rangliste** (`RanglisteProjektion`, rein) ist die
  §7.3-Ableitung aus dem, was schon da ist: Vorrang-Ladepunkte
  (`site_charge_point_priority`) zuerst, der SPEICHER als eigener Eintrag —
  **standardmäßig oben**, sobald `storage_priority` auf `speicher_vor_auto`
  steht —, danach die übrigen Verbraucher und Ladepunkte. Ohne Speicher-Asset
  gibt es keinen Speicher-Eintrag. **⚠ Zwei Details davon hat Paket P4
  präzisiert** (siehe seinen Abschnitt): eine go-e-Wallbox folgt ihrem PROFIL
  statt der Ladepunkt-Regel, und gleichrangige OCPP-Säulen sind EINE Zeile.
- **Das Ladepark-Lastmanagement ist KEIN Betriebsmodell mehr** (es ist SCHUTZ
  und läuft immer): im Anwendungs-Katalog wechselt `lastmanagement` auf
  `klasse: basis` · `abschaltbar: false` · `regal: false` (beide byte-gleichen
  Kopien, `catalog_version` hochgezählt). Die DATEN-Migration
  **`V20260863000000`** löscht seine `site_profile_state`-Zeilen — ohne sie
  läse `SiteProfileService` ein gespeichertes `aus` weiterhin als „nicht aktiv",
  und ein Kunde behielte unterdrückte Ladepunkt-Flächen ohne Weg zurück. **Die
  Einstellung auf der BOX bleibt unangetastet** — der Ladepark ändert sein
  Verhalten durch diese Runde um kein Byte.
- **⚠ Die Exklusivitäts-Invariante hält:** `regal == istBetriebsmodell`, und die
  Gruppe `speicher` sind weiterhin die drei Strategie-Modelle. `lastmanagement`
  hatte nie eine Gruppe (es ist Schutz, es konkurriert mit niemandem).
- **Beweise:** rein `SteuerartProjektionTest` (15: jede Form einmal hin und
  zurück, Mehrdeutigkeit, OCPP ohne Policy, das Ziel-Vokabular) ·
  `RanglisteProjektionTest` (7) · `LadeparkRahmenTest` (4) · Testcontainers
  `VerbraucherApiTest` (echte DB + Keycloak: die Reise über alle Formen, der
  FK-Wächter, der Anlagen-Standard aus `surplus_policy`, die initiale
  Rangliste, `GRENZE_FEHLT`, RLS 404). Portal-Seite in
  `frontend/portal/AGENTS.md`.
- **NICHT in diesem Paket:** die Steuerart SETZEN (P2 — der Dialog, inzwischen
  gebaut, siehe den nächsten Abschnitt), die Rangliste ORDNEN (P4) und ein
  Schreibweg zur Box. Die Ladepunkt-MENÜS der Jetzt-Zone sind P3a und
  inzwischen gebaut — P1 reicht sie nur durch.

