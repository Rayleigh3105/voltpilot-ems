# Steuerung Stufe 5: es läuft immer nur EIN Betriebsmodell

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 118).


Fünfte Stufe des Steuerungs-Umbaus (Konzept `data/vp-steuerung-konzept-b3` §3.4 + §5 Stufe 5 + §6/§7:
„es fährt immer nur EIN Betriebsmodell; der Kunde stellt selbst um, sofort aktiv, wenn technisch
möglich"). **Additiv, ohne Migration:** eine Anlage, die kein Betriebsmodell eingeschaltet hat, und
jede Fläche ausserhalb der Zone verhalten sich zeichengleich wie vorher.

- **⚠ DIE EXKLUSIVITÄT GEHÖRT DEM SERVER, das Portal ZEIGT sie nur.** Erzwungen wird sie in
  `SiteProfileService.loeseAb`, das VOR `switchOn` läuft; das Portal (Radio statt Schalter) kann sie
  weder umgehen noch erfinden, und ein direkter Aufruf hat dasselbe Ergebnis wie ein Klick.
- **⚠ DIE GRUPPE HEISST `speicher` UND SIND DIE DREI MODELLE MIT STRATEGIE-KNOTEN** — Marktoptimierung,
  Lastspitzenkappung, atypische Netznutzung. Das ist eine **argumentierte Abweichung vom
  Konzept-Wortlaut „alle vier"** (die Begründung steht ausführlich im Katalog-Kopf und im Javadoc):
  das Ladepark-Lastmanagement ist SCHUTZ, nicht Marktteilnahme, hat `strategie_knoten: null`
  (sein `switchOff` ist ein dokumentierter No-op — die Box bewacht den Anschluss weiter) und ist
  ABGELEITET aktiv, sobald eine Säule da ist. Es exklusiv zu machen hiesse entweder, jeder Anlage mit
  Ladepunkt die Marktoptimierung zu verbieten, oder eine Wechsel-Karte zu zeigen, deren erste Zeile
  („Ihr Lastmanagement endet") eine Falschaussage über eine laufende Anlage wäre.
- **Katalog:** `exklusiv_gruppe` je Anwendung (beide byte-gleichen Kopien, `catalog_version` 1.2.0),
  gelesen von `AnwendungKatalog.Anwendung.exklusivGruppe()`/`istExklusiv()`; `gruppengeschwister(a)`
  ist die eine Nachschlage-Funktion. **Nur Regal-Einträge tragen eine Gruppe** (in
  `AnwendungKatalogTest` festgenagelt).
- **DIE SEQUENZ eines Wechsels A→B ist bindend** (`SiteProfileService.setState`, dokumentiert im
  Javadoc von `loeseAb`) und läuft in EINEM Aufruf, in EINER Transaktion:
  1. **prüfen** (Anwendung bekannt · Klasse schaltbar · Zustand aus dem Vokabular) — vor dem ersten
     Schreibvorgang, damit ein Fehlschlag nichts halb Umgestelltes hinterlässt;
  2. **`loeseAb`** je Geschwister DERSELBEN Gruppe: gespeichertes `aus` wird übersprungen (dort ist
     nichts zu beenden), sonst wird geprüft, ob es WIRKLICH läuft — gespeichertes `an` ODER
     `AnwendungDerivation.derivedActive` (ein aus Stammdaten abgeleitetes Modell läuft ebenso);
  3. je laufendem Geschwister **`switchOff`** — seine gated Knoten schliessen und seine AKTIVE
     Flow-Version stilllegen (`FlowService.deactivate` re-publiziert dabei die kleinere
     Rollout-Menge, der Flow verlässt also auch das Gerät) — plus ein **gespeichertes `aus`**;
     ⚠ ein blosses Löschen der Zeile genügt NICHT: das abgeleitete Signal würde das Modell beim
     nächsten Lesen wiederbeleben (die Overlay-Regel aus M3);
  4. **`switchOn`** für B (Tor öffnen, Starter säen) und sein `an` speichern.
  Was dabei ausdrücklich NICHT passiert: die Anlage wird nicht angefasst (der nächste Fahrplan
  entscheidet, spätestens in 15 Minuten), und ein gruppenloses Modell bleibt unberührt.
- **⚠ „läuft seit …" hängt an `site_profile_state.updated_at`, und der Upsert trägt
  `WHERE state IS DISTINCT FROM EXCLUDED.state`.** Ohne diese Bedingung verschöbe jedes idempotente
  Schreiben (Doppelklick, Assistenten-Durchlauf, erneutes `an`) den Startzeitpunkt — „läuft seit
  heute, 14:02" wäre dann gelogen. Es ist das `rollout_device.since`-Muster.
  `SiteProfileStateRepository.findBySite` liefert dafür seit dieser Stufe `StoredState(state, seit)`;
  `SiteProfilesDto.Profile.seit` ist **nur bei gespeichertem `an` gesetzt** — ein abgeleitet aktives
  Modell (jede Bestandsanlage) hat keine Zeile, und ein erfundenes Datum wäre schlimmer als keines.
- **Die Voraussetzung sagt jetzt, WAS SIE IST und WO man sie behebt** (`art` + `behebung` je
  Voraussetzung im Katalog, auf `SiteProfilesDto.Requirement`): `hardware` = was die Anlage physisch
  hergeben muss (kein Klick löst das), `einstellung` = ein Wert, den jemand einträgt.
  **⚠ Ein fehlendes `art` gilt als `hardware`** (`Voraussetzung.istHardware`) — die vorsichtigere
  Lesart: sie verspricht nie, ein Klick würde reichen. `behebung.ziel = voltpilot` trägt **kein
  Label** — ein admin-conditionaler Wert hat kein Klickziel, dort steht ein Satz.
- **Beweise:** rein `AnwendungKatalogTest` (+5: die Gruppe sind genau die drei Strategie-Modelle,
  nur Regal-Einträge tragen eine, Geschwister sind gegenseitig, höchstens ein Vorschlag je Gruppe,
  jede Voraussetzung trägt ihre Art und nur eine lösbare einen Weg) · Testcontainers
  `SiteProfileApiTest.exactlyOneOperatingModelRunsAndTheServerEndsTheOldOneCleanly` (echte DB +
  Keycloak: die Gruppe auf dem Draht, der Wechsel beendet einen WIRKLICH aktiven Flow und schliesst
  sein Tor, ein gruppenloses Modell bleibt unberührt, `seit` springt nur bei einem echten Wechsel,
  der Weg zurück in den Grundmodus) + `aLegacyPlantWithTwoActiveModelsIsLeftUntouchedUntilTheCustomerChooses`.
- **⚠ ALTBESTAND: einer Anlage mit zwei aktiven Modellen wird NICHTS abgeschaltet.** Es gibt keinen
  Reparaturlauf und keine Aufräum-Migration — das LESEN ändert nichts. Der Zustand entsteht im Feld
  aus STAMMDATEN (Direktvermarktung + hinterlegter Leistungspreis leiten beide Modelle ab, ohne dass
  je ein Schalter fiel); die Fläche BENENNT ihn und bittet um eine Wahl, und erst diese Wahl setzt
  die Exklusivität durch. Automatisch abzuschalten wäre eine Entscheidung über eine laufende
  Kundenanlage, die niemand getroffen hat.
- **NICHT in dieser Stufe:** die Kunden-Vorschau „was bringt der Wechsel" (Stufe 7 — bis dahin sagt
  die Wechsel-Karte ehrlich „Nicht abschätzbar") · der Batterie-Handeingriff (Stufe 4) · die
  Datenbereinigung (Stufe 9).

