import type { HelpArticle } from '../model';

export const startArticles: HelpArticle[] = [
  {
    id: 'voltpilot', category: 'verstehen', title: 'Was macht VoltPilot?',
    summary: 'Ihre Energieanlage verstehen, den Betrieb planen und die tatsächlichen Ergebnisse nachvollziehen.',
    keywords: ['EMS', 'Energiemanagement', 'Überblick', 'Projekt', 'Optimierung', 'Cloud', 'Box'],
    sections: [
      { id: 'zusammenspiel', title: 'Eine Anlage, mehrere Aufgaben', paragraphs: [
        "VoltPilot verbindet PV, Speicher und steuerbare Verbraucher. Im Portal sehen Sie den aktuellen Zustand, die nächsten geplanten Aktionen und die gemessenen Ergebnisse. Die verfügbaren Ansichten richten sich nach Ihrer Ausstattung.",
      ], diagram: 'loop' },
      { id: 'aufgaben', title: 'Portal, Planung und Box', paragraphs: [
        "Im Portal verwalten Sie die Anlage. Die Planung berücksichtigt Messwerte, Vorhersagen, Preise und Grenzen. Die Box verbindet die Geräte vor Ort und führt freigegebene Vorgaben aus.",
      ], diagram: 'system' },
      { id: 'einstieg', title: 'So finden Sie sich zurecht', paragraphs: [
        "Cockpit: aktueller Zustand. Fahrplan: nächste Speicheraktionen. Verlauf: Energie, Erlöse und einzelne Messwerte. Steuerung: Betriebsmodelle und Regeln. Anlage: Geräte und Einstellungen. Voraussetzungen für optionale Funktionen stehen am Artikelanfang.",
      ] },
    ],
    related: ['energiefluesse', 'beispieltag', 'orientierung'],
  },
  {
    id: 'energiefluesse', category: 'verstehen', title: 'So fließt Ihre Energie',
    summary: 'Erzeugung, Verbrauch, Speicher und Netz: Was die Pfeile und Zahlen bedeuten.',
    keywords: ['PV', 'Solar', 'Energiefluss', 'Batterie', 'Akku', 'Eigenverbrauch', 'Bezug', 'Einspeisung', 'kW', 'kWh'],
    sections: [
      { id: 'wege', title: 'Wo Strom herkommt und wohin er fließt', paragraphs: [
        "Solarstrom kann Verbraucher versorgen, den Speicher laden oder ins Netz fließen. Bei Bedarf ergänzen Speicher und Netz die Erzeugung. Die Illustration zeigt mögliche Wege; aktuelle Flüsse sehen Sie im Cockpit.",
      ], diagram: 'energy' },
      { id: 'einheiten', title: 'Leistung, Energie und Ladestand unterscheiden', paragraphs: [
        "kW ist die momentane Leistung, kWh die Energiemenge: 2 kW über eine Stunde ergeben 2 kWh. Der Ladestand in Prozent zeigt den Füllstand des Speichers. Laden und Entladen sowie Bezug und Einspeisung haben jeweils entgegengesetzte Richtungen.",
      ] },
      { id: 'messung', title: 'Ein Gesamtbild aus mehreren Messungen', paragraphs: [
        "Geräte melden zeitversetzt; manche Größen werden aus mehreren Messungen berechnet. Prüfen Sie deshalb Datenstand und Zuordnung. Ein fehlender Wert ist keine gemessene Null.",
      ], figure: 'cockpit' },
    ],
    related: ['cockpit', 'messwerte', 'glossar'],
  },
  {
    id: 'beispieltag', category: 'verstehen', title: 'Ein Tag mit VoltPilot',
    summary: 'Ein Beispiel verbindet Energieflüsse, Vorhersagen, Speicherplanung und die spätere Auswertung.',
    keywords: ['Tagesablauf', 'Warum', 'Planung', 'Batterie', 'Akku', 'Laden', 'Entladen'],
    prerequisite: 'Das Beispiel zeigt eine Anlage mit PV und Speicher. Netzladen setzt die passende Einstellung und technische Möglichkeit voraus.',
    sections: [
      { id: 'tag', title: 'Vom Morgen bis zum Abend', paragraphs: [
        "Morgens und abends kann der Speicher fehlenden Sonnenstrom ergänzen. Mittags kann er Energie für später aufnehmen. Das Beispiel zeigt mögliche Abläufe; Wetter, Tarif, Bedarf und Reserven bestimmen Ihren tatsächlichen Plan.",
      ], diagram: 'day' },
      { id: 'vorausblick', title: 'Die Planung blickt voraus', paragraphs: [
        "Die Planung verbindet PV- und Verbrauchsvorhersagen mit Preisen und Gerätegrenzen. Der Speicher kann Platz für spätere Erzeugung lassen oder Reserven halten. Die konkrete Begründung steht im Fahrplan.",
      ], figure: 'fahrplan' },
      { id: 'nachsehen', title: 'Plan und Ergebnis zusammen lesen', paragraphs: [
        "Vergleichen Sie Fahrplan und Messwerte für denselben Zeitraum. Das Cockpit zeigt den aktuellen Zustand, Erlöse die verfügbare wirtschaftliche Einordnung. Neue Daten können den nächsten Plan ändern.",
      ] },
    ],
    related: ['fahrplan', 'prognosen', 'erloese'],
  },
  {
    id: 'orientierung', category: 'start', title: 'Anmelden und im Portal zurechtfinden',
    summary: 'Konto, Anlagenwechsel und Navigation auf dem Rechner und dem Telefon.',
    keywords: ['Login', 'Anmeldung', 'Konto', 'Registrierung', 'Mobil', 'Handy', 'Menü', 'Passwort'],
    sections: [
      { id: 'konto', title: 'Ihr Konto und Ihre Anlagen', paragraphs: [
        "Melden Sie sich mit Ihrem Konto an oder registrieren Sie sich mit Name, E-Mail-Adresse und Passwort. Neue Konten starten mit der ersten Anlage. Fehlt eine bestehende Anlage, prüfen Sie zuerst das angemeldete Konto.",
      ] },
      { id: 'navigation', title: 'Ein Ort für jede Frage', paragraphs: [
        "Am Rechner stehen die Bereiche in der Seitenleiste, am Telefon in der Leiste unten. Ganz oben in der Seitenleiste führt der Eintrag mit „‹“ eine Ebene höher. Über den Anlagennamen wechseln Sie den Standort. Je nach Ausstattung erscheinen weitere Reiter oder Ladevorgänge anstelle eines Speicher-Fahrplans.",
      ], figure: 'orientierung' },
      { id: 'mobil', title: 'Hilfe auf dem Telefon', paragraphs: [
        "Hilfe & Kontakt, „Als App auf dem Handy“ und Abmelden stehen im Konto-Menü hinter dem Avatar. Ein Hilfelink öffnet die passende Erklärung; beim Schließen bleibt Ihre Eingabe erhalten. Bei vergessenem Passwort hilft Ihr VoltPilot-Ansprechpartner.",
      ], figure: 'orientierung-mobil' },
    ],
    related: ['anlage-anlegen', 'portfolio', 'kontakt'],
  },
  {
    id: 'anlage-anlegen', category: 'start', title: 'Eine Anlage anlegen',
    summary: 'Adresse, Box und Anlage in drei Schritten - danach geht es ins Cockpit.',
    keywords: ['Standort', 'Adresse', 'Einrichten', 'Onboarding', 'Kennung', 'Box', 'MaStR', 'Register', 'PV', 'Speicher', 'Entwurf'],
    sections: [
      { id: 'starten', title: 'Mit der Adresse beginnen', paragraphs: [
        "Die Einrichtung beginnt mit der Adresse: ein Feld mit Vorschlägen, Straße und Hausnummer genügen. Daraus folgen Standort, Kartenpunkt und Zeitzone - und damit Wetter und Sonnenprognose. Für eine weitere Anlage wählen Sie „Am selben Ort wie …“ oder „An einer anderen Adresse“; an einer anderen Adresse entsteht der Standort gleich mit.",
      ], figure: 'anlage-anlegen' },
      { id: 'schritte', title: 'Die drei Schritte', paragraphs: [
        "Die Leiste oben zeigt immer dieselben drei Schritte. Was Sie überspringen, ergänzen Sie später unter Anlage › Aufbau oder Einstellungen.",
      ], steps: [
        'Adresse: die Adresse wählen, den Pin bei Bedarf aufs Dach ziehen und den Namen prüfen.',
        'Box: die Kennung Ihrer VoltPilot-Box eintragen. Das Feld ergänzt „edge-“ und prüft jedes Zeichen. Ist die Box noch nicht da, verbinden Sie sie später im Aufbau.',
        'Anlage: bestätigen, was die Box gefunden hat, und die Leistung der Solarmodule ergänzen. Ohne Box tragen Sie Solar und Speicher als Zahlen ein. Mit der MaStR-Nummer holen Sie die Werte aus dem Register.',
      ], note: 'Was die Box meldet, ist noch nicht übernommen - erst „Stimmt so“ übernimmt es. Ob ein Gerät danach misst, zeigt das Cockpit an seinen Werten.' },
      { id: 'unterbrechen', title: 'Wenn etwas dazwischenkommt', paragraphs: [
        "Ihre Eingaben bleiben in diesem Browser-Tab erhalten: nach dem Neuladen oder einer neuen Anmeldung geht es am selben Schritt weiter. Eine verlorene Antwort legt nichts doppelt an. „Später einrichten“ oder das Schließen des Dialogs verwirft den Entwurf; was schon gespeichert ist, bleibt.",
      ] },
      { id: 'pruefen', title: 'Woran Sie den erfolgreichen Abschluss erkennen', paragraphs: [
        "Nach dem letzten Schritt öffnet das Cockpit Ihrer Anlage. Sobald die ersten Werte da sind, erscheint einmal die Karte „Ihre Anlage ist live.“ mit einem nächsten Schritt. Solange noch etwas fehlt, zeigt das Cockpit „Ihr Weg zum fertigen EMS“; hat ein Standort noch keine Adresse, fragt die Karte „Wo steht …?“ danach. Eine angelegte Anlage allein bestätigt weder Datenverbindung noch Steuerfreigabe.",
      ] },
    ],
    related: ['box-verbinden', 'einstellungen', 'betriebsmodelle'],
  },
  {
    id: 'box-verbinden', category: 'start', title: 'Die Box verbinden und erste Daten prüfen',
    summary: 'Die Geräte-ID zuordnen und erkennen, ob Messwerte wirklich ankommen.',
    keywords: ['Kennung', 'Geräte-ID', 'edge', 'VP', 'Aufkleber', 'Claim', 'Verbinden', 'Erste Daten', 'Unbekannt'],
    prerequisite: 'Eine eingerichtete VoltPilot Box und eine Anlage im Portal.',
    sections: [
      { id: 'vorbereiten', title: 'Die richtige Geräte-ID verwenden', paragraphs: [
        "Die Kennung zeigt Ihre Box in ihrer App unter „Einrichten“ (Referenz-ID dieses Geräts), sobald ein Wechselrichter oder eine Ladesäule Daten liefert. Verwenden Sie diese Kennung, nicht die Seriennummer des Wechselrichters. Schließen Sie zuerst die lokale Einrichtung ab.",
      ], figure: 'box-verbinden' },
      { id: 'verbinden', title: 'Verbinden und den Eingang kontrollieren', paragraphs: [], steps: [
        'Im Aufbau der Anlage „VoltPilot-Box hinzufügen“ wählen (beim Anlegen einer Anlage fragt der Assistent danach) und die gewünschte Anlage prüfen.',
        'Die Kennung vollständig übertragen und verbinden. Das Feld ergänzt „edge-“ und prüft jedes Zeichen; beachten Sie die Hinweise direkt am Eingabefeld.',
        'Auf die Rückmeldung warten. Anschließend Geräteverbindung, Zeitpunkt des letzten Kontakts und erste Messwerte prüfen.',
      ], figure: 'box-verbinden-mobil', note: 'Eine bestätigte Zuordnung und eine aktive Datenverbindung sind zwei verschiedene Schritte. „Wartet auf Daten“ ist noch kein gemessener Betriebszustand.' },
      { id: 'fehler', title: 'Wenn die ID nicht angenommen wird', paragraphs: [
        "Bei unbekannter Kennung vergleichen Sie alle Zeichen mit der App Ihrer Box. Prüfen Sie bei einer bereits verbundenen Box den angezeigten Standort. Gehört sie zu einem anderen Konto, hilft VoltPilot. Verändern Sie die ID nicht, um die Meldung zu umgehen.",
      ] },
    ],
    related: ['geraete', 'probleme', 'kontakt'],
  },
];
