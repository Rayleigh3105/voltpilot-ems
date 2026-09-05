# Anlagen-Zentrale Stufe 3: die KONSOLIDIERUNG — ein Ding, ein Ort

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 142).


Die letzte Stufe des Konzepts `data/vp-anlagen-zentrale-konzept-h6`
(Konsolidierungs-Landkarte §9, Redirects §9.1, Admin-Additive §6.4/§13.4).
**Reine Portal-Arbeit — kein Endpunkt, keine Migration, kein neues Feld.** Jeder
Alt-Ort ist ÜBERFÜHRT, nicht dupliziert; kein Lesezeichen bricht.

- **Die Installateur-Ansicht ist AUFGELÖST (`pages/EntitaetenSection.tsx`
  entfällt).** Nachfolger ist `components/TechnischeKarten.tsx` — EIN Bauteil,
  EIN Wirt (`AnlagenModellSection`), drei Wohnorte: `TechnischeZeile` (der
  technische Rumpf IN der Komponenten-Zeile: Typ, Registry-Soll/Ist, Rollen,
  Regeln, „Steuert", Guards, „Technisch bearbeiten"/„Entfernen"),
  `RollenZuordnung` (eigene Karte unter der Liste), `AdoptDrawer` (an „Neues
  Gerät gefunden", NEBEN der geführten Übernahme) und `EntityDrawer` (die
  Admin-Tür „Komponente anlegen (technisch)").
  - ⚠ **Der Registry-Stand ist eine ANDERE Tatsache als der Komponenten-Stand**:
    die v2-Entitäts-Registry auf dem Gerät (`RegistryDrift`) vs. die gespeicherte
    Komponenten-Definition (`sollIstText`). Nie zusammenlegen.
  - ⚠ **`copy.test.ts` nimmt `components/TechnischeKarten.tsx` aus** (es spricht
    legitim „Entität"/„Messpunkt") — und prüft dafür, dass JEDER Wirt der
    technischen Sicht das EINE Tor `showTechnicalLayer()` trägt (das
    `AdminGeraetKarten`-Muster). Beide Wächter sind mutationsgeprüft.
- **Die zweite Vollansicht eines Geräts ist WEG** (`pages/admin/GeraetSeite.tsx`
  entfällt). `?geraet=<ref>` auf `#/geraete-registry` hat seither GENAU ZWEI
  Ausgänge, abgeleitet von der reinen `adminGeraet.geraetLinkAusgang`:
  weiterleiten auf `#/anlage/{siteId}/geraet/{ref}` (Mandant gesetzt) oder ein
  ehrlicher Satz über der Liste (unbekannt · gedruckt-noch-kein-Gerät ·
  verbunden-ohne-Anlage). **Solange das Inventar lädt, wird nicht geurteilt.**
  Die Zeile führt direkt; Klick und Deep-Link laufen durch dieselbe Stelle.
  - ⚠ **`geraetHash` ist ersatzlos entfallen, `parseGeraetRef` BLEIBT** — die
    Adresse wird nur noch GELESEN (Deep-Link-Vertrag), nie geschrieben. Ein
    No-Orphan-Test in `nav.test.ts` hält das fest.
  - Die Block-Abdeckung der entfallenen `GeraetSeite.test.tsx` ist nach
    `components/AdminGeraetKarten.test.tsx` umgezogen — sie prüft jetzt den
    BLOCK, unabhängig vom Wirt.
- **`komponenteHash(siteId, entityId)` (`…/modell?komponente=…`) ist der EINE Weg
  ZURÜCK auf eine Komponente** — Cockpit, Regel-Karte und Schaltbild fragen
  dasselbe und landen an derselben Zeile IN ihrer Geräte-Karte (von dort führt
  der Kartenkopf mit „Geräteseite ›" weiter). Der Sprung folgt dem HASH, nicht
  nur dem Mounten, läuft je Adresse GENAU EINMAL und hebt die Zeile kurz hervor
  (`.is-angesprungen`, eine ANTWORT auf den Klick, kein Zustand).
  - ⚠ **Am Cockpit-Board bewusst EINE Zeile unter dem Board statt eines zweiten
    Ziels je Zeile**: die Zeile bedeutet schon „Verlauf dieser Komponente", und
    zwei Klickziele in einer Zeile sind die Doppeldeutigkeit, die das Haus
    verbietet. Verlinkt wird dort, wo eine Komponente GENANNT wird, ohne schon
    ein Ziel zu haben — an den Regel-Chips (und nur an einer LEBENDEN
    Komponente, nie an „Entfernte Komponente" oder einem Nachweis-Chip).
- **Der Ladepunkt ist ein Gerät wie jedes andere:** die Säulen-Karte der
  Ladevorgänge-Seite führt auf ihre Geräteseite `cp-<ChargePointId>`; ihr
  früherer Aufklapper „Technische Angaben" ist genau diese Seite (Kennung,
  OCPP-Anbindung, vendor/model, Firmware, Stecker stehen dort). Ohne eindeutige
  Box (`boxRefOf` = null) bleibt der Aufklapper — ein Weg, der nirgends
  hinführt, wird nie angeboten. Die Ladevorgänge-Seite bleibt die
  VORGANGS-Sicht (wie die Befehle-Seite).
- **Der Assistent hat eine VIERTE Tür `ladesaeule`** („Weitere Säule anbinden"),
  und sie legt bewusst NICHTS an: eine Säule verbindet sich selbst, die Tür
  erklärt nur den Weg (`ANBINDEN_SCHRITTE`/`ANBINDEN_ALLOWLIST`).
  `templatesFuerTuer` gibt für `selbstbau` und `ladesaeule` `[]` zurück.
- **Der Wohnort der REGELN bleibt die Steuerung** (§13.3, D2): die Geräteseite
  sagt nur, WELCHE dieses Gerät nutzen, und verlinkt dorthin.

