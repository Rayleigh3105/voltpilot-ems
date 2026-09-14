# UEMS-Funktionen: die Routen — lesen, starten, anhalten, fortsetzen, beenden (AP-01 IP-3)

Neu am 14.09.2026 (AP-01 IP-3, R1/R2, E6 = C, E9; Entscheid firstmate zu Verbindungstest und Grenze).
Keine Migration. `web/FunktionController` → `uems/FunktionService` → Regel `uems/FunktionZustandAbleitung`
(IP-1, AUFGERUFEN, nie nachgebaut) mit den Eingängen aus `uems/FunktionFakten`; Tabellen aus IP-2
(`uems-funktionen.md`), Ruhe aus IP-4 (`uems-ruhe-bis-zum-start.md`). OpenAPI-Tag `funktionen`, Portal nur
Typen in `api.ts` (`Funktionen`, `FunktionTeilnahme`, `FunktionFehler` …) — die Flächen sind IP-5 … IP-8.

- `GET /api/v1/funktionen` — je nicht archiviertem Standort `messen` und `steuern` (Zustand, `seit`, Satz,
  `fehlt`), je Anlage (heute zugeordnet ODER mit Teilnahme an seiner Funktion) die Teilnahme mit `pruefliste`,
  `fehlt`, `wege` und den jetzt erlaubten `aktionen`; `unternehmen.{messen,steuern}` = „läuft an x von y
  Standorten“ (x = Standorte mit `aktiv`, y = nicht archivierte).
- `PUT /api/v1/sites/{id}/funktionen/steuern` `{"aktion": starten|anhalten|fortsetzen|beenden}` und
  `PUT /api/v1/standorte/{id}/funktionen/steuern` `{"aktion": anhalten|fortsetzen|beenden}` → 200
  `{aktion, betroffen, standort}`; Ablehnung `{code, message, fehlt, wege}`: 400 `anfrage_ungueltig`, 404
  `nicht_gefunden` (fremd, NIE 403, VOR der Aktion geprüft), 409 = Grund des Vertrags mit seinem Satz.

## ⚠ Die Fallen

- **R1/R2 heißt: in DERSELBEN Transaktion.** Der Dienst sperrt zuerst die Unternehmens-Zeile
  (`UnternehmenRepository.sperren`, derselbe Riegel wie der Bestands-Umstieg), liest DANN Teilnahmen und
  Fakten und leitet erst dann den Übergang ab. Wer eine Prüfung vor `@Transactional` zieht, baut eine
  Prüfung, die keine ist.
- **Gespeichert ist der Lebenslauf, die Prüfliste nie.** Aufgenommen/gestartet/angehalten/beendet stehen in
  `funktion_teilnahme`; entwurf ⟷ eingerichtet entscheidet bei JEDEM Lesen die Prüfliste aus frischen Fakten
  (eine gespeicherte `eingerichtet`-Zeile kann „entwurf“ lesen). Die Ruhe ohne Ende wird aus `angehalten`
  gebildet — der Dienst schreibt Teilnahme und `device_override` immer zusammen.
- **Übernommen ohne Startdatum** (W5, z. B. nur Lade-Steuerart): `teilnahme()` kennt „gestartet ohne
  Datum“ nicht. Der Dienst gibt ihr `created_at` als Platzhalter und nimmt Satz und `seit` vom Bestands-Satz
  „Gestartet (übernommen)“ — nie ein erfundenes Datum.
- **Anhalten UND Beenden setzen die Ruhe** (`putRuhe`, macht eine Handpause zur Ruhe), Starten/Fortsetzen
  heben sie auf (`clearRuhe`, eine Handpause bleibt). Eine beendete Anlage steuert nicht; Freigaben
  zeitgültig beenden und Betriebsmodell „an“ beim Start sind NICHT hier (IP-10b ff.). Registry-Push erst
  `afterCommit`, best-effort.
- **Standort = Anlage für Anlage.** `uebergangStandort` entscheidet erlaubt/abgelehnt (Fortsetzen ganz oder
  gar nicht), geschrieben wird je Teilnahme, deren `uebergangAnlage` erlaubt ist; weicht die Namensliste von
  `u.betroffen()` ab, bricht der Dienst ab. Eine nie gestartete Teilnahme wird nie angehalten.
- **Die Fakten (`FunktionFakten`)** — wer eine Quelle ändert, ändert sie HIER:
  Box = nicht ausgebaut, letzter EINGANG ≤ 5 min (wie `OverviewRepository`) · Hauptzähler = gemessen, nicht
  archiviert, Stellung „Hauptzähler“ + Richtung „Bezug“ heute, Beobachtung aus dem Messstellen-Register ·
  Freigabe = Speicher (`battery-hybrid`) über `device_control_activation`, Verbraucher = steht in
  `VerbraucherService.forSite` · Verbindungstest = in der Freigabe enthalten, nur Selbstbau-Schalter
  (`switch.freigabe`) brauchen einen bestandenen Schalt-Test ≤ 90 Tage (`consumer_audit_event`
  `switch_tested`, AP-01 §4.4) · Grenze = heute an Netzanschluss mit `vereinbart_kw` gebunden UND eine
  gesetzte `site_charging_config.grid_limit_kw` ≤ vereinbart (keine gesetzte Grenze ist grün, kein
  Netzanschluss rot; Budget-Rechnung IP-13) · Betriebsweise = Steuerart mit Herkunft ≠ `ohne`, Betriebsmodell
  = aktive Karte Gruppe `speicher`, sonst aktiver `speicher-fahrplan`.
- **Bewusst so: ohne Netzanschluss kein Start und kein Fortsetzen.** Anhalten geht immer, Fortsetzen prüft
  die Grenze wie der Start — eine übernommene Anlage ohne gebundenen Netzanschluss (AP-10 IP-6) bleibt nach
  dem Anhalten angehalten, bis er eingetragen ist; der 409 nennt den Weg („Ordnen Sie … unter Standort ›
  Netzanschlüsse ihrem Netzanschluss zu …“).
- **Messen** hat noch keinen Schreibweg (IP-9a): ohne Zeile `kein_objekt` ohne Fakten; mit Zeile reicht der
  Dienst die Register-Beobachtung als Eingänge an `messen()` zurück (liefert = guter Wert jetzt).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='FunktionApiTest')                  # 6, Testcontainers
(cd services/api && ./mvnw test -Dtest='FunktionSchnittstelleVertragTest') # 4, rein (DTO ⟷ OpenAPI ⟷ api.ts)
(cd services/api && ./mvnw test -Dtest='RechteKennungenDerRoutenTest')     # Rechte-Kommentare der Routen
```
