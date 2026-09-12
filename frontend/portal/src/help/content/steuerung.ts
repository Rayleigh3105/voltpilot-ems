import type { HelpArticle } from '../model';

export const controlArticles: HelpArticle[] = [
  {
    id: 'betriebsmodelle', category: 'steuern', title: 'Betriebsmodelle und Voraussetzungen',
    summary: 'Was VoltPilot für Ihre Anlage tun kann und welche Voraussetzungen dafür erfüllt sein müssen.',
    keywords: ['Betriebsmodelle', 'Steuerung', 'Eigenverbrauch', 'Marktoptimierung', 'Direktvermarktung', 'Lastspitzenkappung'],
    sections: [
      { id: 'ziel', title: 'Das Betriebsziel Ihrer Anlage', paragraphs: [
        "Die Karten unter Steuerung erklären Nutzen, Voraussetzungen und aktiven Zustand: Eigenverbrauch, Marktoptimierung, Lastspitzenkappung oder atypische Netznutzung. Ladepark-Lastmanagement verteilt Leistung auf Ladepunkte.",
      ], figure: 'steuerung' },
      { id: 'voraussetzungen', title: 'Fehlende Ausstattung oder fehlende Angabe?', paragraphs: [
        "Prüfen Sie, ob Ausstattung fehlt oder nur eine Angabe wie der Tarif. Folgen Sie dem angebotenen Weg zu Geräten, Einstellungen oder VoltPilot. Eine Erklärung allein erteilt keine Gerätefreigabe.",
      ] },
      { id: 'wechsel', title: 'Ein Modell bewusst wechseln', paragraphs: [
        "Lesen Sie vor dem Wechsel die Folgenkarte: Speicher-Betriebsmodelle können sich ablösen. Kontrollieren Sie danach die aktive Auswahl und eigene Regeln. Der lokale Schutz des Ladeanschlusses bleibt davon getrennt.",
      ] },
    ], related: ['regeln', 'speicher', 'lastspitzen'],
  },
  {
    id: 'regeln', category: 'steuern', title: 'Regeln erstellen und kontrollieren',
    summary: 'Vom gewünschten Verhalten über die Prüfung bis zur aktiven Regel und ihrem Verlauf.',
    keywords: ['Automatik', 'Regeln', 'Vorlage', 'Baukasten', 'Editor', 'Entwurf', 'Aktivieren', 'Verbraucher', 'Pausieren'],
    prerequisite: 'Ein geeignetes Gerät und die für die jeweilige Regel angebotenen Freigaben.',
    sections: [
      { id: 'absicht', title: 'Mit einer konkreten Aufgabe beginnen', paragraphs: [
        "Wählen Sie unter Steuerung → Regeln eine Vorlage oder den geführten Weg; für individuelle Aufgaben gibt es den Editor. Legen Sie Zielgerät, Bedingung und gewünschte Aktion fest und benennen Sie die Regel eindeutig.",
      ], figure: 'regeln' },
      { id: 'ablauf', title: 'Erstellen, prüfen, aktivieren', paragraphs: [], steps: [
        'Vorlage oder Regeltyp auswählen und das tatsächliche Zielgerät prüfen.',
        'Bedingungen, Zeitfenster und Zielwerte eintragen. Hinweise zu fehlenden Messwerten oder Fähigkeiten beheben.',
        'Die Zusammenfassung und die angebotene Prüfung beziehungsweise Simulation lesen. Im Editor auch die verbundenen Ein- und Ausgänge prüfen.',
        'Den Entwurf speichern und die Folgen vor einer Aktivierung bestätigen. Anschließend kontrollieren, ob die Regel tatsächlich als aktiv angezeigt wird.',
      ], figure: 'regeln-mobil', note: 'Ein gespeicherter Entwurf steuert noch nichts. Auch eine angenommene Aktivierung ist nicht dasselbe wie eine bereits gemessene Wirkung am Gerät.' },
      { id: 'kontrolle', title: 'Status und Verlauf gehören zur Regel', paragraphs: [
        "Eine aktive Regel kann auf ihre Bedingung warten. Status und Protokoll zeigen Auslöser, Aktionen und Hindernisse. Zum Unterbrechen nutzen Sie Pause oder Deaktivierung und prüfen die angezeigten Folgen.",
      ] },
    ], related: ['betriebsmodelle', 'speicher', 'probleme'],
  },
  {
    id: 'speicher', category: 'steuern', title: 'Speichergrenzen und Reserven',
    summary: 'Kapazität, Ladeleistung, Ladestand und reservierte Energie auseinanderhalten.',
    keywords: ['Batterie', 'Akku', 'SoC', 'Reserve', 'Reservierung', 'Kapazität', 'Netzladen', 'Schonung', 'Grenzen'],
    prerequisite: 'Eine Anlage mit Speicher.',
    sections: [
      { id: 'groessen', title: 'Die Größen Ihres Speichers', paragraphs: [
        "Kapazität wird in kWh, Lade- und Entladeleistung in kW angegeben. Der Ladestand zeigt den Füllstand. Grenzen und Reserven bestimmen, welcher Teil davon für eine Aufgabe nutzbar ist.",
      ], figure: 'einstellungen' },
      { id: 'reservierungen', title: 'Mehrere Aufgaben teilen sich einen Speicher', paragraphs: [
        "Reservierungen halten Energie für bestimmte Aufgaben zurück. Mehr Reserve lässt weniger Raum für andere Aktionen. Prüfen Sie die Reservierungen unter Steuerung zusammen mit den Einstellungen.",
      ], diagram: 'storage' },
      { id: 'erwartung', title: 'Warum er nicht bis ganz leer oder ganz voll fährt', paragraphs: [
        "Prüfen Sie Fahrplan, Messwerte und Einstellungen. Grenzen, Reserven, Tagesplanung und das Gerät können die Nutzung begrenzen. Ändern Sie technische Werte nur anhand der passenden Gerätedaten.",
      ] },
    ], related: ['fahrplan', 'regeln', 'einstellungen'],
  },
  {
    id: 'lastspitzen', category: 'steuern', title: 'Lastspitzen erkennen und begrenzen',
    summary: 'Die Leistungsansicht und das Ziel der Lastspitzenkappung verstehen.',
    keywords: ['Peak Shaving', 'Lastspitzenkappung', 'Leistungspreis', 'Gewerbe', 'Netzleistung', 'Spitzenlast'],
    prerequisite: 'Eine dafür geeignete und konfigurierte Anlage; die Ansicht erscheint mit Lastspitzenkappung.',
    sections: [
      { id: 'leistung', title: 'Leistungsspitzen sind keine Energiesummen', paragraphs: [
        "Gleichzeitige Verbraucher erhöhen den Netzbezug. Die Ansicht zeigt Netzleistung und Ziel. Beachten Sie den Zeitraum: Eine Momentanspitze und ein Viertelstundenmittel sind verschiedene Größen; beide werden in kW angegeben.",
      ], figure: 'lastspitzen' },
      { id: 'ziel', title: 'Wie das Betriebsmodell eingreift', paragraphs: [
        "Der Speicher kann Bezugsspitzen abfangen, solange Energie und Leistung reichen. Das Ziel ist keine unbegrenzte Garantie; Verbrauch, Gerätegrenzen und fehlende Messungen können die Wirkung begrenzen.",
      ] },
      { id: 'pruefung', title: 'Eine Überschreitung nachvollziehen', paragraphs: [
        "Vergleichen Sie im betroffenen Zeitraum Netzleistung, Ziel und Speicherzustand. Prüfen Sie, ob das Modell aktiv war und Daten vorlagen. Notieren Sie Zielwert und Hinweise für eine Rückfrage.",
      ] },
    ], related: ['betriebsmodelle', 'speicher', 'messwerte'],
  },
  {
    id: 'ladepark', category: 'steuern', title: 'Einen Ladepark betreiben',
    summary: 'Ladepunkte, verfügbare Leistung und Anschlussgrenzen gemeinsam betrachten.',
    keywords: ['Wallbox', 'Ladesäule', 'OCPP', 'Lastmanagement', 'Elektroauto', 'Ladepunkt', 'Priorität'],
    prerequisite: 'Eine Anlage mit angebundenen Ladepunkten.',
    sections: [
      { id: 'ueberblick', title: 'Verbindung und Laden sind verschiedene Zustände', paragraphs: [
        "Ein erreichbarer Ladepunkt lädt nicht automatisch: Fahrzeug, Freigabe oder Leistungsanforderung können fehlen. Lesen Sie Verbindungszustand, Ladezustand und Datenstand für den richtigen Anschluss.",
      ], figure: 'ladepark' },
      { id: 'verteilung', title: 'Leistung innerhalb des Anschlusses verteilen', paragraphs: [
        "Das Lastmanagement verteilt die verfügbare Leistung innerhalb der Anschlussgrenzen. Andere Verbraucher verkleinern den Spielraum. Priorität beeinflusst die Verteilung, erweitert aber keine physische Grenze.",
      ] },
      { id: 'einzeln', title: 'Einen Ladepunkt genauer prüfen', paragraphs: [
        "Öffnen Sie den Ladepunkt und prüfen Sie Daten und angebotene Aktionen. Kontrollieren Sie nach einer Aktion Rückmeldung und Messwerte; eine angenommene Vorgabe belegt noch keine Wirkung am Fahrzeug.",
      ] },
    ], related: ['ladevorgaenge', 'geraete', 'probleme'],
  },
  {
    id: 'ladevorgaenge', category: 'steuern', title: 'Ladevorgänge nachvollziehen',
    summary: 'Aktuelle Ladungen beobachten und Vorgänge in der Detailansicht eines Ladepunkts nachvollziehen.',
    keywords: ['Laden', 'Auto', 'Ladesitzung', 'Transaktion', 'Wallbox', 'Ladehistorie'],
    prerequisite: 'Angebundene Ladepunkte und verfügbare Ladevorgangsdaten.',
    sections: [
      { id: 'finden', title: 'Den passenden Vorgang auswählen', paragraphs: [
        "Ladevorgänge zeigt Ladeleistung, Anschlüsse und Zustände. Bei Speicheranlagen kann die Ansicht im Fahrplan liegen; reine Ladeparks haben einen eigenen Bereich. Prüfen Sie Anschluss, Beginn und den Grund für Laden oder Warten.",
      ], figure: 'ladevorgaenge' },
      { id: 'details', title: 'Messungen und Ereignisse zusammen lesen', paragraphs: [
        "Über Geräteseite öffnen Sie Vorgänge, Messwerte und Protokoll des Ladepunkts. Momentane kW und geladene kWh sind verschiedene Größen. Datenlücken bestätigen keine Ladung von null kWh.",
      ] },
      { id: 'fragen', title: 'Bei einer unerwarteten Unterbrechung', paragraphs: [
        "Prüfen Sie, ob die Ladung beendet ist oder aktuelle Daten fehlen. Kontrollieren Sie Ladepunktzustand, Freigabe und Leistung. Für Rückfragen nennen Sie Anschluss und Zeitraum. Die Ansicht ist keine Laderechnung.",
      ] },
    ], related: ['ladepark', 'messwerte', 'kontakt'],
  },
];
