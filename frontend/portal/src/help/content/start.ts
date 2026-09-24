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
        "Am Rechner stehen die Bereiche in der Seitenleiste, innerhalb einer Anlage am Telefon unten. Über den Anlagennamen wechseln Sie den Standort. Je nach Ausstattung erscheinen weitere Reiter oder Ladevorgänge anstelle eines Speicher-Fahrplans.",
      ], figure: 'orientierung' },
      { id: 'mobil', title: 'Hilfe auf dem Telefon', paragraphs: [
        "Hilfe & Kontakt und Abmelden stehen im Konto-Menü hinter dem Avatar. Ein Hilfelink öffnet die passende Erklärung; beim Schließen bleibt Ihre Eingabe erhalten. Bei vergessenem Passwort hilft Ihr VoltPilot-Ansprechpartner.",
      ], figure: 'orientierung-mobil' },
    ],
    related: ['anlage-anlegen', 'portfolio', 'kontakt'],
  },
  {
    id: 'anlage-anlegen', category: 'start', title: 'Eine Anlage anlegen',
    summary: 'Standort, Registerdaten, Gerät und Betrieb Schritt für Schritt einrichten.',
    keywords: ['Standort', 'Einrichten', 'Onboarding', 'MaStR', 'Register', 'Adresse', 'PV', 'Speicher'],
    sections: [
      { id: 'starten', title: 'Mit dem richtigen Standort beginnen', paragraphs: [
        "Beim ersten Besuch startet die Einrichtung; weitere Standorte legen Sie über Anlage hinzufügen an. Wählen Sie einen eindeutigen Namen und den richtigen Standort für Wetter und PV-Prognose.",
      ], figure: 'anlage-anlegen' },
      { id: 'schritte', title: 'Die Einrichtung durchlaufen', paragraphs: [
        "Der Assistent zeigt den offenen Schritt. Übersprungene Angaben können später für einzelne Funktionen nötig sein.",
      ], steps: [
        'Anlage: Namen und Standort erfassen und die Anlage anlegen.',
        'Register: PV- und Speicherdaten über die passende MaStR-Nummer suchen. Die Vorschau prüfen, bevor Sie Werte übernehmen. Falls nötig, den angebotenen manuellen Weg verwenden.',
        'Gerät: die richtige VoltPilot-Geräte-ID mit dieser Anlage verbinden.',
        'Betrieb: den passenden Einsatzzweck und die angebotenen Betriebsmodelle prüfen. Fehlende Voraussetzungen werden direkt angezeigt.',
      ] },
      { id: 'pruefen', title: 'Woran Sie den erfolgreichen Abschluss erkennen', paragraphs: [
        "Prüfen Sie unter Anlage Geräte, Kapazität, Leistungsgrenzen und Tarif. Nach dem Verbinden müssen erste Messwerte eintreffen. Eine angelegte Anlage allein bestätigt weder Datenverbindung noch Steuerfreigabe.",
      ] },
    ],
    related: ['box-verbinden', 'einstellungen', 'betriebsmodelle'],
  },
  {
    id: 'box-verbinden', category: 'start', title: 'Die Box verbinden und erste Daten prüfen',
    summary: 'Die Geräte-ID zuordnen und erkennen, ob Messwerte wirklich ankommen.',
    keywords: ['Geräte-ID', 'edge', 'VP', 'Aufkleber', 'Claim', 'Verbinden', 'Erste Daten', 'Unbekannt'],
    prerequisite: 'Eine eingerichtete VoltPilot Box und eine Anlage im Portal.',
    sections: [
      { id: 'vorbereiten', title: 'Die richtige Geräte-ID verwenden', paragraphs: [
        "Die VoltPilot-Geräte-ID steht auf dem Aufkleber oder in der lokalen Web-App der Box. Verwenden Sie diese ID, nicht die Seriennummer des Wechselrichters. Schließen Sie zuerst die lokale Einrichtung ab.",
      ], figure: 'box-verbinden' },
      { id: 'verbinden', title: 'Verbinden und den Eingang kontrollieren', paragraphs: [], steps: [
        'Im Assistenten oder beim Hinzufügen eines VoltPilot-Geräts die gewünschte Anlage prüfen.',
        'Die Geräte-ID vollständig übertragen und verbinden. Beachten Sie die Hinweise direkt am Eingabefeld.',
        'Auf die Rückmeldung warten. Anschließend Geräteverbindung, Zeitpunkt des letzten Kontakts und erste Messwerte prüfen.',
      ], figure: 'box-verbinden-mobil', note: 'Eine bestätigte Zuordnung und eine aktive Datenverbindung sind zwei verschiedene Schritte. „Wartet auf Daten“ ist noch kein gemessener Betriebszustand.' },
      { id: 'fehler', title: 'Wenn die ID nicht angenommen wird', paragraphs: [
        "Bei unbekannter ID vergleichen Sie alle Zeichen mit dem Original. Prüfen Sie bei einer bereits verbundenen Box den angezeigten Standort. Gehört sie zu einem anderen Konto, hilft VoltPilot. Verändern Sie die ID nicht, um die Meldung zu umgehen.",
      ] },
    ],
    related: ['geraete', 'probleme', 'kontakt'],
  },
];
