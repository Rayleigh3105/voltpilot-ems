# Vertragsende I: der Kundenbereich „beendet" (UEMS AP-20 IP-16)

E10 = A, BT4, RF-08: der Betreiber setzt einen Kundenbereich auf „beendet"; danach ist jeder
Schreibweg `409 kundenbereich_beendet`, nur der Kundenadministrator liest noch, die Datenannahme
verwirft mit Zählung. IP-17 (Gesamtabzug) und IP-18 (Löschen nach der Frist, Löschnachweis) folgen.

- **Zustand:** `tenant.beendet_am` / `beendet_frist_tage` / `beendet_von` (`V20260925170000`).
  NULL = aktiv — bewusst keine Zustandsspalte mit Default (sie änderte jede Bestandszeile, der
  Bestandsschutz der Migrationsnachbarn schlüge an). Trigger `tenant_beendet_einmalig`: ein
  beendeter Bereich wird nie umgeschrieben, die App-Rolle ändert die Spalten nie.
- **Übergänge:** `POST /api/v1/admin/tenants/{id}/beenden` (Auftrag, Begründung, Name
  eintippen, `fristTage` Startwert 90) und `…/wiederaufnehmen` (Auftrag, Begründung) —
  `AdminKundenbereichEndeController`, je EINE Anweisung mit Vorzustand im `WHERE` und
  Protokollzeile `kundenbereich_uebergang` (Admin-Rolle nur SELECT/INSERT, FK CASCADE, damit der
  Löschweg unverändert bleibt). Zweiter Aufruf = 409.
- **Sperre:** `KundenbereichEndeFilter` in der `secured`-Kette nach dem `ZugriffFilter` — vor
  Handler, Körper-Leser und `RechtInterceptor`. Kundenrouten: jedes Nicht-GET 409; Lesen nur
  Kundenkonto mit Zuweisung „Kundenadministrator" oder Bestandskonto; `/me` für alle — die
  Selbstauskunft trägt `kundenbereich.beendet {beendet_am, loeschung_fruehestens, liest, text}`
  (aktiv: `null`). Plattform-Routen mit `{tenantId}`/`{siteId}`/
  `{deviceId}` im Pfad: jedes Nicht-GET 409, außer `ADMIN_AUSNAHMEN` (beenden,
  wiederaufnehmen, `delete`, `offboarding/cleanup`, Konto sperren). **Falle:** der Filter steht
  vor der Autorisierung — auf Plattform-Pfaden antwortet er nur einer Plattform-Rolle, sonst
  verriete er Zustand und Daten eines fremden Bereichs.
- **Neue Route unter `/api/v1/admin/` mit Kundenbereich unter anderem Variablennamen** (z. B.
  `{kundenbereich}`): der Filter erkennt sie nicht. `KundenbereichBeendetApiTest` fällt dann auf
  (`OHNE_KUNDENBEREICH` ist genau) — Muster in `KundenbereichEndeFilter` ergänzen, nicht die Liste.
- **Datenannahme:** `BeendeteKundenbereiche` (ingest) liest `tenant.beendet_am` höchstens einmal
  je Minute mit den Zugangsdaten der Box-Auskunft; Treffer = `voltpilot_ingest_verworfen_total
  {grund="kundenbereich_beendet"}`, quittiert, KEIN `rejected`-Ereignis (das wäre selbst ein
  Schreibweg in den Bereich). Lesefehler behält den letzten Stand; die API sperrt sofort, der
  ingest spätestens nach einer Minute.
- **Portal:** `KundenbereichEndeHinweis` in `AppShell` über dem Unterstützungs-Hinweis, gespeist aus
  `selbst.kundenbereich.beendet` — **keine eigene Anfrage**: eine erste Fassung holte eine eigene
  Route und machte 76 E2E-Fälle rot (`ERR_CONNECTION_REFUSED` auf der Bühne, die Specs zählen
  Konsolenfehler). Der Satz kommt aus der API (`KundenbereichEnde.text()`), er nennt den
  Gesamtabzug erst mit IP-17.
- **Offen (Befund IP-16):** die 20 MQTT-Rückmeldewege der API (`*StatusListener`,
  `*ResultListener`) und die Läufer (`@Scheduled`) schreiben für beendete Bereiche weiter; der
  Flotten-Rollout `POST /admin/rollouts` erreicht auch ihre Boxen.
- **Nachweis:** `KundenbereichBeendetApiTest` (NW-5, Routen aus `RequestMappingHandlerMapping`,
  Fingerabdruck der ganzen DB unverändert), `KundenbereichEndeTest`, ingest
  `BeendeteKundenbereicheTest`, Portal `KundenbereichEndeHinweis.test.tsx`.
