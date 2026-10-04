import type { HelpArticle } from '../model';

export const controlArticles: HelpArticle[] = [
  {
    id: 'geraete-steuern', category: 'steuern', title: 'Geräte steuern: Aus, Smart, Ein',
    summary: 'Was gerade läuft und warum, wer Sonnenstrom zuerst bekommt und wie Sie ein Gerät mit Ende ein- oder ausschalten.',
    keywords: ['Steuerung', 'Geräte', 'Smart', 'Eingriff', 'Reihenfolge', 'Sonnenstrom', 'Tagesbild', 'Szene', 'Urlaub', 'nur messen', 'Heizstab', 'Wärmepumpe', 'Pool'],
    sections: [
      { id: 'jetzt', title: 'Lesen, was jetzt läuft', paragraphs: [
        "Unter Steuerung → Geräte steht oben in einem Satz, was gerade läuft und warum, darunter, wohin der Sonnenstrom geht. Das Tagesbild zeigt bis jetzt Gemessenes, danach Plan und Erwartung. Ein Gerät ohne Leistungsmessung nennt seinen Zustand, aber keine erfundene Leistung.",
      ], figure: 'steuerung-geraete' },
      { id: 'smart', title: 'Aus, Smart, Ein', paragraphs: [
        "Jedes Gerät hat drei Zustände. Smart ist sein Auftrag, als Satz lesbar, etwa „Mit Sonnenstrom ab 1,0 kW“. Aus und Ein sind Ihr Eingriff: immer mit Ende, danach wieder Smart. Das Blatt nennt vorher die Folgen. Dass die Box den Eingriff angenommen hat, heißt noch nicht, dass das Gerät läuft; das zeigt erst die Messung.",
      ] },
      { id: 'reihenfolge', title: 'Wer bekommt Sonnenstrom zuerst?', paragraphs: [
        "Die Liste der Geräte ist die Reihenfolge für Sonnenstrom, samt Speicher. Mit „Ändern“ verschieben Sie Einträge; die neue Reihenfolge gilt ab dem Speichern. Geräte mit fester Zeit oder Frist stehen darunter, weil sie nicht auf Überschuss warten.",
      ] },
      { id: 'neu', title: 'Ein neu verbundenes Gerät', paragraphs: [
        "Geräte legen Sie in der Anlage an, nicht in der Steuerung. Hat ein Gerät noch keinen Auftrag, fragt die Steuerung einmal: Vorschlag übernehmen, anders einstellen oder nur messen. „Nur messen“ gilt, bis Sie unter „noch nicht gesteuert“ auf „Steuern“ tippen.",
      ] },
      { id: 'szenen', title: 'Szenen: ein Tipp, mehrere Geräte', paragraphs: [
        "Unter Regeln pausieren Szenen wie „Urlaub“ mehrere Geräte zugleich. Im Blatt wählen Sie die Geräte; die Szene gilt, bis Sie sie beenden, und setzt dann genau diese Geräte fort. Pausiert heißt: VoltPilot schaltet das Gerät nicht, es gilt sein sicherer Zustand. Eine Szene stellt keine Temperatur und keine Ladeart um.",
      ] },
    ], related: ['regeln', 'betriebsmodelle', 'ladepark'],
  },
  {
    id: 'betriebsmodelle', category: 'steuern', title: 'Betriebsmodelle und Voraussetzungen',
    summary: 'Was VoltPilot für Ihre Anlage tun kann und welche Voraussetzungen dafür erfüllt sein müssen.',
    keywords: ['Betriebsmodelle', 'Steuerung', 'Eigenverbrauch', 'Marktoptimierung', 'Direktvermarktung', 'Lastspitzenkappung'],
    sections: [
      { id: 'ziel', title: 'Das Betriebsziel Ihrer Anlage', paragraphs: [
        "Unter Steuerung → Geräte öffnet „Was immer gilt → Speicher“ das Blatt des Speichers. Dort stehen die Betriebsmodelle mit Nutzen und Voraussetzungen: Eigenverbrauch, Marktoptimierung, Lastspitzenkappung oder atypische Netznutzung. Die Verteilung auf Ladepunkte steht unter Steuerung → Laden.",
      ], figure: 'steuerung' },
      { id: 'voraussetzungen', title: 'Fehlende Ausstattung oder fehlende Angabe?', paragraphs: [
        "Prüfen Sie, ob Ausstattung fehlt oder nur eine Angabe wie der Tarif. Folgen Sie dem angebotenen Weg zu Geräten, Einstellungen oder VoltPilot. Eine Erklärung allein erteilt keine Gerätefreigabe.",
      ] },
      { id: 'wechsel', title: 'Ein Modell bewusst wechseln', paragraphs: [
        "Wählen Sie ein anderes Modell, nennt das Blatt vor dem Übernehmen die Folgen: welches Modell den Speicher übernimmt und welches endet. Der Wechsel gilt ab dem nächsten Fahrplan. Kontrollieren Sie danach die aktive Auswahl und eigene Regeln. Der lokale Schutz des Netzanschlusses bleibt davon getrennt.",
      ] },
    ], related: ['geraete-steuern', 'regeln', 'speicher', 'lastspitzen'],
  },
  {
    id: 'regeln', category: 'steuern', title: 'Regeln erstellen und kontrollieren',
    summary: 'Vom gewünschten Verhalten über die Prüfung bis zur aktiven Regel und ihrem Verlauf.',
    keywords: ['Automatik', 'Regeln', 'Vorlage', 'Baukasten', 'Satzbaukasten', 'Probelauf', 'Folgen', 'Aktivieren', 'Verbraucher', 'Szene'],
    prerequisite: 'Ein geeignetes Gerät und die für die jeweilige Regel angebotenen Freigaben.',
    sections: [
      { id: 'absicht', title: 'Mit einer konkreten Aufgabe beginnen', paragraphs: [
        "Unter Steuerung → Regeln beginnen Sie mit „Neue Regel“ oder einer Vorlage. Eine Regel ist ein Satz, etwa „Wenn der Börsenpreis unter 10 ct/kWh liegt: Heizstab einschalten.“ Jeder Baustein – Bedingung, Wert, Gerät und Aktion – lässt sich antippen und ändern.",
      ], figure: 'regeln' },
      { id: 'ablauf', title: 'Erstellen, prüfen, aktivieren', paragraphs: [], steps: [
        '„Neue Regel“ oder eine Vorlage wählen und das Gerät prüfen, das die Regel schalten soll.',
        'Bedingung und Wert antippen und einstellen. Bausteine, die die Box noch nicht ausführen kann, sind als „kommt noch“ markiert.',
        'Den Probelauf lesen: wann die Regel heute und morgen greifen würde und wie viel Energie das ungefähr bedeutet. Wo Preise oder Messwerte fehlen, steht das dabei.',
        'Mit „Weiter: Folgen“ die Folgen prüfen und die Regel aktivieren. Anschließend kontrollieren, ob sie unter „Ihre Regeln“ als an geführt wird.',
      ], figure: 'regeln-mobil', note: 'Eine aktive Regel ist eine Vorgabe an die Box. Ob das Gerät tatsächlich läuft, zeigt erst die gemessene Wirkung am Gerät.' },
      { id: 'kontrolle', title: 'Status und Verlauf gehören zur Regel', paragraphs: [
        "Jede Regel zeigt, ob sie gerade greift, wann sie heute schon gegriffen hat, und einen Streifen für den Tag. Eine aktive Regel kann auf ihre Bedingung warten. Ausschalten wirkt sofort und fragt nicht nach. „Heute passiert“ listet Regeln, Eingriffe und Szenen mit Uhrzeit.",
      ] },
    ], related: ['geraete-steuern', 'betriebsmodelle', 'probleme'],
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
        "Unter Steuerung → Laden steht jeder Ladepunkt mit seinem Zustand. Ein erreichbarer Ladepunkt lädt nicht automatisch: Fahrzeug, Freigabe oder Leistungsanforderung können fehlen. Lesen Sie Verbindungszustand, Ladezustand und Datenstand für den richtigen Anschluss.",
      ], figure: 'ladepark' },
      { id: 'verteilung', title: 'Leistung innerhalb des Anschlusses verteilen', paragraphs: [
        "Oben zeigt „Netzanschluss“, wie sich die Grenze auf Haus und Ladepunkte verteilt. Das Lastmanagement bleibt innerhalb dieser Grenze; andere Verbraucher verkleinern den Spielraum. Vorrang beeinflusst die Verteilung, erweitert aber keine physische Grenze.",
      ] },
      { id: 'einzeln', title: 'Einen Ladepunkt genauer prüfen', paragraphs: [
        "Je Ladepunkt wählen Sie „Womit laden“ – Sonne, Sonne mit Minimum oder günstig – und bei Bedarf ein Ladeziel, etwa „+30 kWh bis 7:00“. Kontrollieren Sie nach einer Aktion Rückmeldung und Messwerte; eine angenommene Vorgabe belegt noch keine Wirkung am Fahrzeug.",
      ] },
    ], related: ['ladevorgaenge', 'geraete-steuern', 'probleme'],
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
