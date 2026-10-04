# Portal und Bedienmodell

Das Portal trennt Portfolio, einzelne Anlage und Plattformverwaltung. Welche Ansichten eine Anlage anbietet, ergibt sich aus ihren Komponenten und Betriebsfunktionen.

![Portal, Cloud-Planung und lokale Box](../frontend/portal/src/help/assets/portal-cloud-box.svg)

## Orientierung

```mermaid
flowchart TD
    Login["Anmeldung"] --> Auswahl["Portfolio oder einzelne Anlage"]
    Auswahl --> Cockpit["Cockpit: aktueller Zustand"]
    Auswahl --> Plan["Fahrplan: Plan, Ladevorgänge, Preise, Wetter"]
    Auswahl --> Verlauf["Verlauf: Energie, Erlöse, Messwerte"]
    Auswahl --> Steuerung["Steuerung: Geräte, Laden, Regeln"]
    Auswahl --> Anlage["Anlage: Aufbau und Einstellungen"]
    Login --> Admin["Plattformverwaltung bei entsprechender Rolle"]
    Hilfe["Hilfe: zentral oder im Kontext"] -.-> Auswahl
```

Leere Bereiche werden nicht angeboten. Eine reine Ladeanlage kann Ladevorgänge anstelle eines Speicherfahrplans anzeigen. Preise und Wetter stehen beim Fahrplan, den sie erklären; ohne Fahrplan bleiben sie im Verlauf. Der Verlauf trägt Energie (Route `messwerte`), Erlöse und die einzelnen Messwerte (`einzelwerte`); Lesezeichen mit `messwerte?m=` leiten dorthin um. Die Lastspitzen-Seite hat keinen Reiter mehr und wird aus der Erlöse-Karte geöffnet.

Die Verlauf-Seiten teilen einen Rahmen (`components/VerlaufRahmen`): Zeitleiste, eine Statuszeile (gemessen/bewertet, Auflösung, Datenlage), eine Kennzahlenzeile, Diagramm mit Tabellen-Zwilling und CSV. Lücken bleiben leer (`verlaufRaster.ts`), Erklärungen stehen im ⓘ. Am Telefon werden Kennzahlen und Tabellen zu Listen. Die Erlöse-Seite führt in der Kennzahlenzeile die leicht hervorgehobene Kachel „VoltPilot-Steuerung“ (`savedSteuerungEur` gegenüber demselben Speicher ohne smarte Steuerung, Rechnung im ⓘ); sie ist ein Vergleich, kein Anteil des Ergebnisses, und steht deshalb nicht in der Abrechnung. Darunter stehen nebeneinander „Preise im Zeitraum“ (Eigenverbrauch, Einspeisung und Netzbezug je kWh als Balken auf einer Skala, mit denselben Ø-Preisen wie die Abrechnung; `preisVergleich.ts`) und bei Direktvermarktung „So verdient Ihre Anlage“ (Ø aller Solaranlagen, eigene Anlage an der Börse, Erlös je kWh mit der tatsächlich angekommenen Marktprämie; `soVerdient.ts`). Beide nutzen `balkenliste.ts`: Namen und Zahlen stehen als Text, die Balken werden beim ersten Sichtbarwerden aufgedeckt, nie aus null gezogen. Die Portfolio-Reiter „Energie“ und „Erlöse“ (`#/portfolio/messwerte`, `#/portfolio/erloese`) nutzen denselben Rahmen: Kennzahlen über alle Anlagen, darunter der Anlagen-Vergleich als Balkenliste mit Tabellen-Zwilling (`portfolioSeite.ts`); der Zeitverlauf steht auf der Anlage. Die Übersicht der Flotten-Ebene („Meine Anlagen“, bei Betreibern „Portfolio“) zeigt für jede Betriebsart dieselben vier Blöcke (Statuszeile, Heute mit VoltPilot-Steuerung und Tageskurve, Jetzt, Anlagen-Karten; `kundenUebersicht.ts`); die Betriebsart wählt nur die Navigation (`betriebsart.ts`). Die Diagramme der Verlaufsseiten laden als eigenes Stück (`CHART_CHUNK`) und werden bei offener Anlage im Leerlauf vorgeladen. Unterseiten bleiben der gewählten Anlage zugeordnet; alte Routen werden gezielt umgeleitet.

Der Bereich „Anlage“ hat zwei Reiter (Konzept „Anlage – neu gedacht“, Entscheide E1–E6):

- **Aufbau** (Route `modell`): eine Tabelle mit Gruppen Anlage → VoltPilot-Box → Gerät → Messwert, auch mit nur einer Box (Konzept „Aufbau und Gerätekatalog“, K1–K6). Spalten Gerät · Art · Zustand · Wert; die Suche findet Name, Modell und Kennung, die Filter grenzen nach Art, Zustand, Box und Hersteller ein (`aufbauTabelle.ts`). Am Telefon stehen die Filter hinter einem Knopf im Suchfeld, die Standortzeile entfällt. Ein Tippen öffnet den Kurzblick (zentriertes `Modal`, am Telefon Vollbild) mit allen Komponenten, Handlungen und dem Weg zur Geräteseite. Was eine Box meldet, aber noch nicht übernommen ist, steht gestrichelt in der Tabelle. Mit mehreren Boxen stehen die gemeldeten Geräte unter der führenden Box (`registry.deviceId`); die Ableitung ist `aufbauBaum.ts`.
- **Einstellungen** (Route `technik`): eine kurze Liste in vier Gruppen (Anlage, Strom & Geld, Speicher, Weiteres). Jede Zeile zeigt ihren Wert; Bearbeiten und „Wirkt auf …“ stehen im Blatt. Netzladen und der Umgang mit dem Speicher wirken direkt und bieten danach „Rückgängig“. Ein Schloss kennzeichnet Werte, die VoltPilot eingerichtet hat. `?abschnitt=` landet weiter auf der Gruppe; `abschnitt=geraet` führt in den Aufbau.

„Gerät hinzufügen“ (und „+ Gerät“ an einer Box) öffnet den Gerätekatalog (`GeraeteKatalog`, Ableitung `geraeteKatalog.ts`): Suche nach Marke oder Modell, die Arten als Filter, ohne Suche Art → Marke → Modell; was die Box meldet, steht obenan. Die Wege ohne Vorlage (Ladesäule mit OCPP, Batterie mit eigenem BMS, Modbus-Gerät) und eigene Vorlagen sind gewöhnliche Einträge; „Zähler“ macht ohne Zähler-Vorlage das gewählte Gerät zum Netz-Zähler. Nach der Wahl folgt die Einrichten-Seite (`Einrichten.tsx`): eine Seite mit Abschnitten statt Schritten, der Test mit echten Werten läuft von selbst, „Speichern“ erst mit Beleg und mit Grund im Fuß. Danach nennt der Aufbau, was entstanden ist, und springt darauf. VoltPilot-Box und Anlage stehen im Menü neben „Gerät hinzufügen“. Bearbeitet wird auf der Geräteseite. „Als App auf dem Handy“ steht im Konto-Menü. Die Prognosequalität ist ein Reiter nur für VoltPilot; Kunden sehen im Fahrplan unter „Worauf Ihr Plan achtet“ die mittlere Abweichung der Vorhersage je Viertelstunde, und `…/prognose` leitet sie in den Fahrplan.

**Ein Ort für Anlagen, Boxen und Geräte.** Am Standort heißt derselbe Baum „Standort › Aufbau“ (`#/standort/{id}/aufbau`, `pages/StandortAufbauPage.tsx`): Standort → Anlagen → VoltPilot-Boxen → Datenquellen und Geräte, eine Anlage aufgeklappt, „Öffnen ›“ an einer anderen bleibt im Standort (`?anlage=`). Die früheren Standort-Seiten „Boxen“ und „Anlagen“ sind darin aufgegangen; ihre Adressen leiten dorthin um (`canonicalStandortHash`). Jeder andere Einstieg – Menü der Standort-Übersicht, Messen-Assistent Schritt 2, Anlage einrichten, „Anlage anlegen“ im Kopf bei einer Anlage – führt mit `?neu=box|geraet|anlage` in den Aufbau und öffnet dort denselben Dialog (`aufbauHash`, `standortAufbauHash`). Ein Name je Handlung: „VoltPilot-Box hinzufügen“ meldet eine Box mit Geräte-ID an, „Gerät hinzufügen“ öffnet den Gerätekatalog; der Box-Tausch bleibt auf der Box-Seite. Unter jeder Box stehen ihre Datenquellen (Protokoll, Adresse, Geräte-IDs, Rückmeldung). Den Reiter und die Seite „Aufbau“ am Standort gibt es nur mit Messfunktion; ein Betriebskunde baut im Aufbau seiner Anlage (O18).

**Navigation aus einem Guss** (Konzept N1–N6). Jede Ebene hat höchstens fünf Einträge (`LEISTE_HOECHSTENS`), und Seitenleiste und Telefon-Leiste tragen dieselben (`ebenenEintraege`/`ebenenLeiste`, ab `EBENEN_LEISTE_AB` = 3): in der Anlage ihre fünf Bereiche wie bisher; am Standort Übersicht · Aufbau · Gebäude · Messstellen · Netzanschlüsse (das Kurzwort `LEISTE_KURZ`, z. B. „Anschlüsse“, nur in der Telefon-Leiste); am Unternehmen die Gruppen nach Arbeitsfragen (`UNTERNEHMEN_GRUPPEN`: Übersicht · Messen · Auswerten · Verbessern · Nachweisen), deren Frage als zweite Zeile unter dem aktiven Eintrag der Seitenleiste steht; in der Flotte ohne Standorte Übersicht · Standorte · Energie, mit Geld dazu Erlöse (`flottenEintraege`). Der oberste Eintrag der Seitenleiste ist der Weg eine Ebene höher („‹ Werk Ahrenberg“ in der Anlage, „‹ Ahrenberg“ am Standort unter einem Unternehmen; `AnlageNav.hoch`, `EbenenLeisteNav.hoch`). Über der Seite steht höchstens EINE Reiterreihe: am Unternehmen die Reiter der offenen Gruppe (`PortfolioTabs.gruppen`, ab zwei), sonst nur die Reiter, die kein Eintrag trägt (`PortfolioTabs.leisteSeiten`, `EbenenTabs`). „Messen“ trägt Messstellen · Kostenstellen · Prozesse · Bezugsgrößen (Kataloge einmal geladen in `messstellenOrganisation.ts`; die Seite zeigt dann keine eigene Reihe, `MessstellenPage.reiterOben`, und die Reihe wählt über die Fläche — mit ihrem Zeitraum, die Adresse ersetzt, `flaecheMelden`), „Verbessern“ die Reiter von „Ziele und Maßnahmen“ (`VerbesserungBereich.reiterOben`), „Nachweisen“ das Verzeichnis, die Berichte und die übrigen Reiter des Energiemanagements (`EnergiemanagementBereich.reiterOben`); die Wiedervorlage steht in der Übersicht (`ebenenAktiv(…, 'wiedervorlage')` = `uebersicht`). Eine Detailseite zeigt ihren Rückweg statt der Reihe (`istDetailseite`); Zeitraum-Umschalter sind keine Reiter. Die Kopfzeile nennt auf den Seiten einer Ebene immer den Ort, nie den Seitennamen (`kopfPfad`). Alle Adressen bleiben. Waagerecht scrollende Reiterleisten blenden an der Kante weich aus und holen den gewählten Reiter in die Mitte (`reiterRand.ts`).

Quellen: [Navigation](../frontend/portal/src/ebenenNav.ts), [Router](../frontend/portal/src/nav.ts), [Anlagenprojektion](../frontend/portal/src/surface.ts), [Aufbau-Baum](../frontend/portal/src/aufbauBaum.ts), [Aufbau-Tabelle](../frontend/portal/src/aufbauTabelle.ts), [Gerätekatalog](../frontend/portal/src/geraeteKatalog.ts).

### UEMS-Flächen im Portal

| Welt / Einstieg | Fachlicher Wegweiser |
|---|---|
| Standorte und Ortsstruktur | [Standort-Dialog](agents/root/uems-standort-dialog.md), [Ortsbaum](agents/root/uems-ortsbaum-portal.md) |
| Messstellen, Werte und Versionen | [Messstellenregister](agents/root/uems-messstellen-register-portal.md), [Tageskarte](agents/root/uems-tageskarte.md) |
| Bezugsgrößen, Eingabe, Ablesungen und CSV | [Bezugsgrößen-Abschluss](agents/root/uems-bezugsgroessen-abschluss.md) |
| Kennzahlen | [Kennzahlen-Abschluss](agents/root/uems-kennzahlen-abschluss.md) |
| Berichte | [Berichte-Abschluss](agents/root/uems-berichte-abschluss.md) |

Die vollständige, paketweise Übersicht steht im [UEMS-Wegweiser](agents/root/uems-uebersicht.md).

**Energiemanagement ohne Fachsprache** (Konzept unter `.lavish/uems-konzept/`, Entscheide D1–D6):

- Begriffe: unter dem Seitenkopf der UEMS-Bereiche erklärt `BegriffeZeile` die Wörter in einem Satz, mit Beispiel und dem Fachwort (ohne Normnummer, ohne Kürzel; `begriffe.ts`). Die Wörter selbst bleiben die des Glossars.
- Grenz- und Verantwortungs-Satz stehen einmal je Bereich im Hinweis „Was VoltPilot leistet“ (`GrenzSatz.tsx`: `GrenzSatzBereich` lässt die Sätze der Teile schweigen, `GrenzHinweis` trägt beide im vollen Wortlaut). Dialoge, Entscheidungsformulare und Berichte tragen die Sätze weiter selbst; `copy.test.ts` erkennt Baustein und Hinweis.
- Übersicht des Unternehmens: oben steht, was die Rolle zuerst fragt (`einstieg.ts`, ohne neue Rechte) — Energiemanager: Fahrplan „Ihr Energiemanagement“ (`fahrplan.ts`, `EnergiemanagementFahrplan.tsx`: sechs Schritte, je ein Satz aus gespeicherten Daten und eine Handlung; „Nicht abrufbar.“ statt 0; keine Zahl über das Ganze, keine Ampel, G4; stehen alle Schritte, entfällt er) und „Was steht an“ (die ersten Punkte der Wiedervorlage); Leser und „Einsicht“: „Belege finden“; Kundenadministrator wie bisher. Am Telefon stehen „Was steht an“, Abweichungen und Datenlage zuerst (`obenBausteine`, `UebersichtBausteine.nur/ohne`).
- Seitenleiste: mit mehreren Standorten heißt die Flotten-Ebene wie das Unternehmen (`flottenName`), sonst „Meine Anlagen“ bzw. „Portfolio“.

## Fachliche Grenzen

| Anzeige | Bedeutung |
|---|---|
| Aktueller Messwert | Gemessener Wert mit Datenalter; fehlend ist nicht null kW |
| Prognose | Erwartete Entwicklung, keine Messung |
| Fahrplan | Geplante Handlung; Guards können ihre Ausführung begrenzen |
| Bestätigter Auftrag | Annahme oder Geräteantwort; Wirkung braucht passende Rückmeldung |
| Erlöse / Ersparnis | Wirtschaftliche Einordnung eines Zeitraums mit den verfügbaren Daten |
| Gerätefreigabe | Modell-/gerätebezogene technische Freigabe, keine pauschale Herstellerzusage |

Geräteansichten führen über stabile Box-/Gerätereferenzen. Die physische Zielkomponente muss bei Registerzugriffen ausdrücklich bestimmt sein; eine Registeradresse allein ist kein Ziel.

## Steuerung und Geräte

Die Steuerung hat drei Reiter ([Konzept](konzepte/steuerung/README.md), [Umsetzung](agents/portal/steuerung-neu-drei-reiter.md)): **Geräte** (in einem Satz, was jetzt läuft und warum; das Tagesbild mit Gemessenem, Plan und Erwartung; die Geräte als Reihenfolge für Sonnenstrom; je Gerät Aus · Smart · Ein mit Ende; „Was immer gilt“ mit Speicher und Betriebsmodell), **Laden** (Netzanschluss, je Ladepunkt „Womit laden“ und Ladeziel, Fahrzeuge; nur mit Ladepunkt) und **Regeln** (Satzbaukasten mit Probelauf und Folgen, Vorlagen, Szenen, „Heute passiert“). Geräte legt die Steuerung nicht an: ein neu verbundenes Gerät fragt einmal nach seinem Auftrag oder bleibt auf Wunsch „nur gemessen“. Geräteeigenschaften und Messpunktauswahl gehören an die jeweilige Komponente. Änderungen müssen ihre wirkliche Wirkung und Voraussetzungen nennen; Annahme durch die Box, Geräteantwort und gemessene Wirkung bleiben getrennt.

Die Plattform-Geräteverwaltung öffnet mit Updates; Registrierung ist ein weiterer Reiter. Gemeldete Version, zugewiesenes Ziel und neuestes Release sind unterschiedliche Angaben. Eine bestätigte Installation ist nicht automatisch das neueste verfügbare Release.

## Hilfe und Abbildungen

`#/hilfe` öffnet die globale Hilfe; `#/hilfe/<artikel>` verlinkt direkt. Die kontextuelle Hilfe bleibt über einem Formular geöffnet, ohne dessen Eingaben zu verlieren. Sie darf nicht von erfolgreichen Anlagenabfragen oder abgeschlossenem Onboarding abhängen.

Die Hilfe verwendet dieselben Artikel im Zentrum und Dialog. Screenshots zeigen echte React-Komponenten mit eingefrorenen Beispieldaten; Erklärnummern sind separat zugängliche Beschriftungen. Workflow: [Hilfe bearbeiten](../frontend/portal/src/help/README.md).

## UI-Regeln für Änderungen

- Gemeinsame Komponenten, Tokens und Icons aus dem vorhandenen Designsystem verwenden.
- `VpPicker` für die vorhandene Auswahlinteraktion nutzen; API- und UI-Validierung zusammen halten.
- Fehler am Feld zeigen, erstes fehlerhaftes Feld fokussieren; `Input` reicht den Ref weiter.
- Schließen von Dialogn und Screenshot-Dialogen stellt den Fokus wieder her. Verschachtelte Overlays dürfen kein darunterliegendes Formular schließen.
- Auf Mobilgeräten Headerhöhe aus dem Layout entstehen lassen; keine geratenen Sticky-Offsets. Tabellen innerhalb ihres Rahmens scrollen lassen.
- Help-/Geräte-/Anlagen-Links einschließlich Queryparametern und Zurücknavigation erhalten.
- Messwerte und geplante Geldwerte nicht durch Farben allein unterscheiden; Beschriftung, Einheit und Datenstand nennen.

Tests: Navigation und `AppShell`, gezielte Komponenten-Tests sowie die Browserfälle `help`, `shell-layout`, `mobile-ui` und `box-updates`. Der [Portal-README](../frontend/portal/README.md) nennt die Befehle.
