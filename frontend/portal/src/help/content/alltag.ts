import type { HelpArticle } from '../model';

export const everydayArticles: HelpArticle[] = [
  {
    id: 'summenwerte', category: 'alltag', title: 'Summenwerte bilden und verwenden',
    summary: 'Register zusammenzählen, den Stand prüfen und eine Rolle in der Anlagen-Übersicht wählen.',
    keywords: ['Summenwert', 'Register', 'Summe', 'Rolle', 'PV-Produktion', 'Verbrauch', 'Netz'],
    sections: [
      { id: 'anlegen', title: 'Von den Registern zum Summenwert', paragraphs: [
        'Öffnen Sie „Summenwert anlegen“ am Gerät oder unter Verlauf → Messwerte (Summenwerte). Wählen Sie passende Register derselben Anlage, prüfen Sie Plus, Minus und Faktoren und geben Sie dem Wert einen Namen.',
        'Jeder Live-Wert trägt seinen Stand. Noch nicht beobachtete Register werden einmal gelesen und erst beim Speichern beobachtet; die zusätzliche Datenmenge steht dabei. Fehlt ein aktueller Eingang, bleibt die Summe unvollständig.',
      ] },
      { id: 'rolle', title: 'Eine Rolle wirkt ab jetzt', paragraphs: [
        'Ohne Rolle bleibt die Anlagen-Übersicht unverändert. PV-Produktion, Verbrauch oder Netz verwenden den Summenwert als Anlagenzahl. Prüfen Sie beim Verbrauch, ob alle Verbraucher enthalten sind. Für das Netz kann genau ein Wert maßgeblich sein; ein vorhandener Wert wird nur nach Bestätigung ersetzt.',
        'Die Gerätekarte nennt Wert, Stand und Rolle. Über „Rolle ändern“ können Sie die Rolle entziehen. Der Summenwert bleibt erhalten, die Anlagen-Übersicht verwendet wieder den ursprünglichen Wert. Die Aufschlüsselung zählt dieselbe Summe auch bei mehreren beteiligten Geräten einmal.',
      ] },
      { id: 'rechte', title: 'Welche Änderungen sind möglich?', paragraphs: [
        'Sie können einen Summenwert umbenennen, seine Rolle ändern oder ihn archivieren. Beim Archivieren bleiben die bisherigen Werte erhalten. Für eine andere Zusammenstellung legen Sie einen neuen Summenwert an.',
      ] },
    ], related: ['messwerte', 'cockpit'],
  },
  {
    id: 'cockpit', category: 'alltag', title: 'Das Cockpit lesen',
    summary: 'Zustand, Energieflüsse und aktuelle Messwerte Ihrer Anlage auf einen Blick.',
    keywords: ['Dashboard', 'Übersicht', 'Live', 'Energiefluss', 'Status', 'Warnung', 'Anpassen'],
    sections: [
      { id: 'blick', title: 'Zuerst Zustand und Datenstand prüfen', paragraphs: [
        "Prüfen Sie zuerst Zustand und Datenstand. Die Bausteine folgen Ihrer Ausstattung; unter Anpassen können Sie die angebotenen Bausteine ordnen oder ausblenden. Alte Messwerte beschreiben einen früheren Zustand.",
      ], figure: 'cockpit' },
      { id: 'lesen', title: 'Von den Flüssen zu den Einzelwerten', paragraphs: [
        "Lesen Sie Erzeugung, Verbrauch, Netz und Speicher zusammen. Pfeile zeigen die Richtung, Einheiten unterscheiden Leistung und Ladestand. Komponenten und kompakter Verlauf helfen, die Anlagenzahl einzuordnen.",
      ] },
      { id: 'weiter', title: 'Was tun bei einem Hinweis?', paragraphs: [
        "Öffnen Sie einen Hinweis für seine Ursache. Geplante Aktionen stehen im Fahrplan, vergangene Messungen unter Verlauf → Energie und Geräteverbindungen unter Anlage. Prüfen Sie bei fehlenden Zahlen zuerst Quelle und Datenstand.",
      ] },
    ], related: ['energiefluesse', 'fahrplan', 'probleme'],
  },
  {
    id: 'fahrplan', category: 'alltag', title: 'Den Fahrplan verstehen',
    summary: 'Wann Ihr Speicher laden oder entladen soll und wie Sie Plan und Ausführung auseinanderhalten.',
    keywords: ['Zeitplan', 'Schedule', 'Laden', 'Entladen', 'Batterie', 'Akku', 'SoC', 'Warum'],
    prerequisite: 'Ein Speicher beziehungsweise eine Anlage, für die ein Fahrplan angeboten wird.',
    sections: [
      { id: 'lesen', title: 'Ein Plan über mehrere Zeitabschnitte', paragraphs: [
        "Der Fahrplan zeigt geplante Speicheraktionen. Prüfen Sie Zeitraum und Erstellungszeitpunkt. Preis, Leistung und Ladestand haben eigene Skalen entlang derselben Zeitachse; neue Daten können den Plan ändern.",
      ], figure: 'fahrplan' },
      { id: 'gruende', title: 'Warum die Batterie gerade so geplant ist', paragraphs: [
        "PV, Bedarf, Tarif, Reserven und Grenzen bestimmen den Plan. Ein günstiger Börsenpreis allein erlaubt noch kein Netzladen; ein hoher Preis verlangt keine vollständige Entladung. Nutzen Sie die Erklärungen im Fahrplan.",
      ] },
      { id: 'kontrolle', title: 'Plan ist nicht gleich Ausführung', paragraphs: [
        "Ein Plan belegt eine Absicht. Geräteantworten und Messwerte zeigen, was daraus wurde. Fehlt der Plan, prüfen Sie Verbindung, Speicherzuordnung und die Hinweise unter Steuerung.",
      ], diagram: 'proof' },
    ], related: ['beispieltag', 'speicher', 'probleme'],
  },
  {
    id: 'messwerte', category: 'alltag', title: 'Messwerte und Zeiträume vergleichen',
    summary: 'Messreihen auswählen, Zeiträume wechseln und Datenlücken richtig lesen.',
    keywords: ['Historie', 'Verlauf', 'Messungen', 'Diagramm', 'Vergleich', 'Tag', 'Woche', 'Monat', 'Jahr'],
    sections: [
      { id: 'auswahl', title: 'Die richtige Frage eingrenzen', paragraphs: [
        "Unter Verlauf → Energie stehen die Energiemengen des Zeitraums, am Tag die Leistung in Feldern über einer Zeitachse; Verlauf → Messwerte vergleicht bis zu drei einzelne Messwerte. Wählen Sie zuerst den Zeitraum. Auf Portfolio-Ebene gilt die gewählte Anlagenauswahl. Achten Sie auf Einheit und Zusammenfassung: Leistung, Energiesumme und Durchschnitt beantworten unterschiedliche Fragen.",
      ], figure: 'messwerte' },
      { id: 'vergleich', title: 'Zwei Zeiträume sinnvoll vergleichen', paragraphs: [
        "Die Vergleichsansicht nennt den zusätzlichen Zeitraum. Vergleichen Sie dieselbe Größe und Einheit. Wetter, Nutzung, neue Geräte und Einstellungen können Unterschiede erklären.",
      ] },
      { id: 'luecken', title: 'Lücken und Datenstand beachten', paragraphs: [
        "Eine Lücke ist keine gemessene Null; Daten können fehlen oder später eintreffen. Prüfen Sie Verbindung und Abdeckung. Fehlt eine auswählbare Größe, prüfen Sie Komponente und Zuordnung unter Anlage.",
      ] },
    ], related: ['summenwerte', 'glossar', 'anlagenmodell', 'probleme'],
  },
  {
    id: 'erloese', category: 'alltag', title: 'Erlöse und Einsparungen einordnen',
    summary: 'Die wirtschaftliche Ansicht mit Zeitraum, Vergleich und Speicherbestand lesen.',
    keywords: ['Geld', 'Euro', 'Kosten', 'Einsparung', 'Ertrag', 'Bilanz', 'Bestandskonto', 'Vergütung', 'Mehrwert', 'Steuerung'],
    prerequisite: 'Eine Anlage mit den nötigen Mess- und Preisdaten und einer verfügbaren Erlöse-Ansicht.',
    sections: [
      { id: 'zeitraum', title: 'Welche Aussage zeigt die Zahl?', paragraphs: [
        "Prüfen Sie Zeitraum und Kennzahl: Einspeiseerlös, Bezugskosten, Einsparung und Planwert haben unterschiedliche Bedeutungen. Die Berechnung hängt von Tarifangaben und Messungen ab; sie ersetzt keine Rechnung Ihres Vertragspartners.",
      ], figure: 'erloese' },
      { id: 'mehrwert', title: 'Was bringt die VoltPilot-Steuerung?', paragraphs: [
        "Die Kachel „VoltPilot-Steuerung“ vergleicht Ihre Anlage mit demselben Speicher ohne smarte Steuerung: Der lädt jeden Überschuss sofort und entlädt bei Bedarf sofort, ohne auf Preise zu achten. Der Betrag ist, was die Steuerung darüber hinaus gebracht hat. Er ist kein Teil des Ergebnisses, sondern ein Vergleich. Maßstab und Rechnung stehen im ⓘ der Kachel. Fehlen die Speicherdaten, steht dort ein Strich und der Weg zum Nachtragen.",
      ] },
      { id: 'speicherbestand', title: 'Warum die Tagesbilanz zwischendurch anders aussieht', paragraphs: [
        "Gespeicherte Energie kann ihren Nutzen erst später bringen. Lesen Sie deshalb Ergebnis und gegebenenfalls Bestandskonto zusammen. Der Zwischenstand am Mittag ist noch kein abgeschlossenes Tagesergebnis.",
      ] },
      { id: 'nachvollziehen', title: 'Eine auffällige Zahl prüfen', paragraphs: [
        "Grenzen Sie den Tag ein und vergleichen Sie Energieverlauf, Speicherbewegung und Preise. Prüfen Sie anschließend Tarif und Datenabdeckung. Für Rückfragen nennen Sie Zeitraum, Kennzahl und deren Erklärung.",
      ] },
    ], related: ['einstellungen', 'messwerte', 'marktpreise'],
  },
  {
    id: 'marktpreise', category: 'alltag', title: 'Marktpreise richtig lesen',
    summary: 'Zeitabhängige Börsenpreise und Ihren tatsächlichen Tarif auseinanderhalten.',
    keywords: ['Strompreis', 'Börse', 'Spotpreis', 'Day Ahead', 'Dynamisch', 'Negative Preise', 'ct/kWh'],
    prerequisite: 'Die Marktpreise-Ansicht ist für entsprechend konfigurierte Anlagen verfügbar.',
    sections: [
      { id: 'diagramm', title: 'Preis und Zeit gehören zusammen', paragraphs: [
        "Die Ansicht zeigt veröffentlichte Preise für Zeitraum und Markt. Prüfen Sie Datum und Einheit. Eine Lücke steht für fehlende Preise; sie ist weder null noch eine Vorhersage.",
      ], figure: 'marktpreise' },
      { id: 'tarif', title: 'Börsenpreis ist nicht Ihr vollständiger Bezugspreis', paragraphs: [
        "Zum Börsenanteil können weitere Tarifbestandteile kommen. Ein negativer Börsenpreis bedeutet deshalb nicht automatisch einen negativen Bezugspreis. Prüfen Sie Einstellungen und Vertragsangaben.",
      ] },
      { id: 'plan', title: 'Was die Planung daraus macht', paragraphs: [
        "Der Fahrplan berücksichtigt neben Preisen auch Ladestand, Wirkungsgrad, Bedarf, PV und Grenzen. Prüfen Sie bei unerwarteten Aktionen den Zeitraum sowie Tarif- und Netzladeangaben.",
      ] },
    ], related: ['fahrplan', 'einstellungen', 'beispieltag'],
  },
  {
    id: 'prognosen', category: 'alltag', title: 'Wetter und Prognosen verstehen',
    summary: 'Vorhersagen für PV und Verbrauch sowie deren spätere Bewertung einordnen.',
    keywords: ['Wetter', 'Forecast', 'Vorhersage', 'Prognosequalität', 'Genauigkeit', 'Modell', 'Schatten'],
    sections: [
      { id: 'wetter', title: 'Wetter beschreibt die erwarteten Bedingungen', paragraphs: [
        "Die Wetteransicht schätzt Bedingungen am Anlagenstandort; sie misst keine Solarproduktion. Bei unplausiblen Ortsangaben prüfen Sie den Standort. Lokales Wetter kann von der Vorhersage abweichen.",
      ], figure: 'wetter' },
      { id: 'modelle', title: 'Prognose und Prognosequalität', paragraphs: [
        "Das aktive Modell liefert Prognosen, ein Kandidat im Schattenbetrieb wird nur bewertet. Prognosequalität vergleicht gespeicherte Vorhersagen mit Messungen. Wenige ausgewertete Tage oder Datenlücken begrenzen den Vergleich.",
      ], figure: 'prognose' },
      { id: 'bewertung', title: 'Abweichungen mit ihrer Einheit lesen', paragraphs: [
        "Lesen Sie Fehlermetrik und Einheit: Eine Abweichung in kW ist keine Prozentgenauigkeit. Vergleichen Sie dieselbe Größe und denselben Zeitraum. Ein historisch besseres Modell garantiert keinen besseren einzelnen Tag.",
      ] },
    ], related: ['beispieltag', 'fahrplan', 'messwerte'],
  },
  {
    id: 'portfolio', category: 'alltag', title: 'Mehrere Anlagen im Blick behalten',
    summary: 'Vom Portfolio beziehungsweise Meine Anlagen in die einzelne Anlage wechseln.',
    keywords: ['Flotte', 'Betreiber', 'Meine Anlagen', 'Übersicht', 'Standorte', 'Wechseln'],
    prerequisite: 'Mehrere Anlagen oder ein Konto mit Betreiber-Ansicht.',
    sections: [
      { id: 'ueberblick', title: 'Die gemeinsame Übersicht', paragraphs: [
        "Portfolio beziehungsweise Meine Anlagen zeigt Ihre zugänglichen Standorte. Öffnen Sie eine Anlage für Details; der Name im Kopf zeigt den aktuellen Standort. Über den Anlagenwechsler gelangen Sie zu einem anderen.",
      ], figure: 'portfolio' },
      { id: 'auswertung', title: 'Anlagenübergreifende Zahlen und einzelne Anlagen', paragraphs: [
        "Anlagenübergreifende Zahlen und einzelne Anlagen haben unterschiedliche Geltungsbereiche. Prüfen Sie Auswahl und Zeitraum. Andere Geräte oder Betriebsmodelle erklären, warum Ansichten zwischen Anlagen abweichen.",
      ] },
      { id: 'kontrolle', title: 'Vor Änderungen den Namen prüfen', paragraphs: [
        "Vor Änderungen Anlagenname und Geltungsbereich im Dialog prüfen. Ein Endkundenkonto mit nur einer Anlage kann direkt im Cockpit starten.",
      ] },
    ], related: ['orientierung', 'cockpit', 'erloese'],
  },
];
