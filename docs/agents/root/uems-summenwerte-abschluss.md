# Summenwerte mit Rolle — H-0 bis H-11

Ein Summenwert ist eine berechnete Messstelle, kein eigenes Objekt. Eine optionale
Rolle wirkt ab jetzt auf PV-Produktion, Verbrauch oder Netz in der Anlagen-Übersicht.
Der rollenlose Wert bleibt an seinen Geräten und unter Verlauf › Messwerte sichtbar.

## Zuständige Kapitel

- [Formel-Fundament](gesamtwert-berechnete-messstelle-formel-ap10.md): Quellen,
  Einheiten, Vorzeichen, Faktoren, Nullregel; [Fassungen](uems-formel-fassungen-je-tag.md).
- [Rollen und Cockpit](uems-rollen-zuordnung.md): H-1/H-2/H-3, eine Summe zählt
  einmal, Netz-Eindeutigkeit, Frische 300 s, Protokoll und Rohwert-Rückfall.
- [Gemeinsamer Assistent](uems-summenwert-assistent.md): H-5/H-6, fünf Schritte,
  Einmal-Lesen mit Stand, Beobachtung erst beim Speichern, Box über PushJeBox.
- [Gerätekarte und Rollen-Dialog](uems-summenwerte-geraetekarte.md): H-7/H-8/H-10,
  atomar Anlegen + Rolle, Geräte-Löschwege, Umbenennen/Formel/Archiv/Protokoll.
- [Portal-Einstiege und Anzeige](../portal/summenwert-assistent-und-karte.md).
- [Steuern-Regel](uems-steuern-still.md) und [Portal-Rechte](uems-portal-rechte.md).

## Rechte und Wörter (H-9)

Alle Schreibhebel lesen `rollen.ts`, die Kennungen kommen aus `rechte-matrix.json`:
Anlegen/Formel `messstelle.formel`, Rolle `geraet.einrichten`, Beobachtung weiterer
Register `mess_selektion.bearbeiten`, Umbenennen/Anhalten/Archivieren
`messstelle.bearbeiten`. Einmal-Lesen benötigt `messwerte.ansehen`; die Cockpit-
Aufschlüsselung liest nur. Der Kennzahl-Einstieg benötigt ebenfalls das Formelrecht.
Bereits geöffnete Geräte- und Verlauf-Dialoge dürfen nach Entzug nicht schreiben;
der Assistent prüft vor Speichern auch das Recht der zusätzlichen Beobachtung.

`copy.test.ts` hat keine Alttext-Ausnahmen für Gesamtwert/PV gesamt/Helfer mehr.
Technische Export-/API-Namen bleiben kompatibel; Kundennamen werden nicht geändert.
Die Summenwert-Flächen einschließlich Rollen-Folgensätzen und Alltag-Hilfe werden
gegen `STEUER_GELD_WOERTER` geprüft. IANA-Zeitzonen sind technische Optionen.
`migration.test.ts` erhält die alten Fingerabdrücke mit einzeln erklärten Nachfolgern.

## Entzug einer geräteübergreifenden Summe

Das Anlegen ordnet dieselbe Quelle jedem beteiligten Gerät zu. Beim Entziehen an
einem dieser Geräte entfernt `RollenZuordnungService.entziehen` unter derselben
Anlagensperre alle primären Zuordnungen **derselben Messstelle, Anlage und Rolle**.
Sonst blieb die Summe über das nächste Gerät im Cockpit aktiv. Kanal-Zuordnungen
und andere Summen bleiben unberührt; Protokoll je entferntem Gerät, Wiederholung
idempotent. Der Summenwert selbst wird weder archiviert noch gelöscht.

## Abnahme (H-11)

`e2e/summenwert-abnahme.spec.ts` verbindet die echten Komponenten Gerätekarte,
Assistent, Rollen-Dialog und Cockpit gegen zustandsabhängige API-Antworten:

- A1 Deye: 5,2 + 4,1 + 3,1 + Gen-Port 2 = 14,4 kW; Einmal-Lesen,
  Erzeugungsentscheidung, atomare Anfrage, Karte, Cockpit, Entzug und Rückfall.
- A2/A3 Ahrenberg: MS-06/07/08 = 213,5 kW; zuerst ohne Rolle (Cockpit gleich),
  danach Verbrauch zuordnen und entziehen. Nicht als vollständigen Verbrauch ausgeben.
- A4 Lindach: MS-17/18 = 32,3 kW; Peter darf anlegen, Claudia sieht keine
  Schreibhebel, Unterstützung ST-1 sieht ST-2 nicht; keine Steuer-/Geldwörter.
- A5 angenommener Zähler: Bezug 8 minus Abgabe 10 = −2 kW; Netz zeigt Abgabe.

Referenzzahlen werden aus `uems-referenzunternehmen.json` gelesen. Deye und A5
sind ausdrücklich zusätzliche Ankerfälle. API/DB separat:
`UemsSummenwertAbnahmeTest`, `SiteRollenApiTest`, `MessstelleFormelApiTest`.
Ergänzende Konzeptnachweise: `RollenZuordnungRegelnVectorsTest`,
`MessstelleFormelRegelnVectorsTest`, `DeviceMeasurementSelectionApiTest`
(Einmal-Lesen mit Probe-Stub) und `EntityRegistryServiceTest` (Löschwege).
Die neue Abnahme prüft Anlegen → Live-Stand → Karte → Cockpit → Entzug,
Netz-409, Mehrgeräte-Dedup, Protokoll und zeichengleichen Rohwert-Rückfall.
Keine Hardwarefreigabe, keine Änderung an Optimierer, Fahrplan oder Erlösen.

Portal-Pflichtläufe: `copy`, `migration`, `rechte`, `rollenRechte`,
`gesamtwert`, `gesamtwertQuelle`, `summenwertQuellen`, `uemsRollen`, `pvRolle`,
`verlauf`, `kennzahlAnlegen`, `uemsKeineRechnung`, `geraetSeite`, `komponenten`,
`registerAbbildung`, `uemsMessstelleFormel` und betroffene Komponententests;
Typecheck und Build. Fluss-Specs: `summenwert`, `summenwert-hybrid`,
`summenwert-geraetkarte`, `gesamtwert`, `cockpit-rollen`, `kennzahl-anlegen`,
`kennzahl-aendern`, `summenwert-abnahme`. Letztere zweimal mit 375/1440 px;
`SUMMENWERT_BILDER=<externer Ordner>` erzeugt echte Aufnahmen. Im Ansichts-HTML
als Data-URLs einbetten. Ein eigener temporärer Testport vermeidet Portkollisionen;
keinen fremden Server wiederverwenden oder beenden.
