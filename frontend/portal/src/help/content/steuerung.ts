import type { HelpArticle } from '../model';

export const controlArticles: HelpArticle[] = [
  {
    id: 'betriebsmodelle', category: 'steuern', title: 'Betriebsmodelle und Voraussetzungen',
    summary: 'Was VoltPilot für Ihre Anlage tun kann und welche Voraussetzungen dafür erfüllt sein müssen.',
    keywords: ['Betriebsmodelle', 'Steuerung', 'Eigenverbrauch', 'Marktoptimierung', 'Direktvermarktung', 'Lastspitzenkappung'],
    sections: [
      { id: 'ziel', title: 'Das Betriebsziel Ihrer Anlage', paragraphs: [
        'Die Steuerung zeigt, welche Betriebsmodelle für Ihre Anlage verfügbar sind und welches aktiv ist. Der Eigenverbrauchs-Fahrplan bildet das Grundverhalten einer passenden Speicheranlage. Weitere Betriebsmodelle richten den Betrieb auf zusätzliche Ziele aus.',
        'Marktoptimierung berücksichtigt Marktchancen im Rahmen der hinterlegten Bedingungen, einschließlich einer entsprechend eingerichteten Direktvermarktung. Lastspitzenkappung zielt auf Leistungsspitzen. Atypische Netznutzung ist ein weiteres Betriebsmodell mit eigenen Voraussetzungen. Die jeweilige Karte erklärt Nutzen und Voraussetzungen. Das Ladepark-Lastmanagement schützt unabhängig davon den Anschluss; seine Grenzen stehen im Ladepark-Rahmen.',
      ], figure: 'steuerung' },
      { id: 'voraussetzungen', title: 'Fehlende Ausstattung oder fehlende Angabe?', paragraphs: [
        'Ein fehlender Speicher ist eine andere Voraussetzung als ein noch nicht hinterlegter Tarif. Die Anzeige unterscheidet, ob die Anlage technisch geeignet ist oder zunächst Angaben ergänzt werden müssen.',
        'Folgen Sie dem angebotenen Weg zu Einstellungen oder Geräten. Wenn VoltPilot einen Wert hinterlegen muss, wird das ausdrücklich genannt. Die Hilfe kann das Modell erklären, aber keine technische Eignung oder Freigabe herstellen.',
      ] },
      { id: 'wechsel', title: 'Ein Modell bewusst wechseln', paragraphs: [
        'Lesen Sie vor einem Wechsel die Folgenkarte. Speicher-Betriebsmodelle können sich gegenseitig ablösen, weil sie denselben Speicher beanspruchen. Verlassen Sie sich auf die angezeigte aktive Auswahl und nicht nur auf einen früher betätigten Schalter.',
        'Das Ladepark-Lastmanagement ist davon getrennt: Der Schutz des Anschlusses gehört nicht zur Auswahl eines konkurrierenden Speicher-Betriebsmodells. Eigene Regeln prüfen Sie zusätzlich in der Regeln-Ansicht.',
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
        'Eine Regel beschreibt ein gewünschtes Verhalten, zum Beispiel einen Verbraucher bei passenden Bedingungen zu betreiben. Wählen Sie unter Steuerung → Regeln die passende angebotene Vorlage oder den geführten Weg. Der Editor ist für Aufgaben gedacht, die mehr eigene Gestaltung benötigen.',
        'Legen Sie zuerst fest, welches Gerät gemeint ist, wann die Regel gelten soll und welches Ergebnis Sie erwarten. Eine klare Bezeichnung hilft später dabei, den Status und den Verlauf wiederzuerkennen.',
      ], figure: 'regeln' },
      { id: 'ablauf', title: 'Erstellen, prüfen, aktivieren', paragraphs: [], steps: [
        'Vorlage oder Regeltyp auswählen und das tatsächliche Zielgerät prüfen.',
        'Bedingungen, Zeitfenster und Zielwerte eintragen. Hinweise zu fehlenden Messwerten oder Fähigkeiten beheben.',
        'Die Zusammenfassung und die angebotene Prüfung beziehungsweise Simulation lesen. Im Editor auch die verbundenen Ein- und Ausgänge prüfen.',
        'Den Entwurf speichern und die Folgen vor einer Aktivierung bestätigen. Anschließend kontrollieren, ob die Regel tatsächlich als aktiv angezeigt wird.',
      ], figure: 'regeln-mobil', note: 'Ein gespeicherter Entwurf steuert noch nichts. Auch eine angenommene Aktivierung ist nicht dasselbe wie eine bereits gemessene Wirkung am Gerät.' },
      { id: 'kontrolle', title: 'Status und Verlauf gehören zur Regel', paragraphs: [
        'Eine aktive Regel kann auf eine Bedingung warten. Das bedeutet nicht zwangsläufig einen Fehler. Öffnen Sie den Status beziehungsweise das Protokoll, um den letzten Auslöser, die letzte Aktion und mögliche Hindernisse nachzuvollziehen.',
        'Nutzen Sie zum Unterbrechen die für diese Regel angebotene Pause oder Deaktivierung. Lesen Sie dabei die Folgen, besonders wenn mehrere Regeln oder ein Betriebsmodell denselben Speicher beanspruchen.',
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
        'Die Kapazität in kWh beschreibt die gespeicherte Energiemenge. Die Lade- und Entladeleistung in kW beschreibt, wie schnell Energie hinein- oder herausfließen kann. Der Ladestand in Prozent beschreibt den aktuellen Füllstand.',
        'Untergrenzen, Obergrenzen und Reserven begrenzen die nutzbare Energie. Eine Anzeige von beispielsweise 30 Prozent bedeutet deshalb nicht, dass die gesamte verbleibende Energie für jede Aufgabe frei verfügbar ist.',
      ], figure: 'einstellungen' },
      { id: 'reservierungen', title: 'Mehrere Aufgaben teilen sich einen Speicher', paragraphs: [
        'Betriebsmodelle und Regeln können Energie für unterschiedliche Aufgaben beanspruchen. Die Steuerung zeigt vorhandene Reservierungen und Hinweise dazu. Lesen Sie diese zusammen mit den Grenzen in den Einstellungen.',
        'Ein höherer Reservebedarf kann den Raum für andere Speicheraktionen verkleinern. Ob eine bestimmte Reserve an Ihrer Anlage greift, entnehmen Sie der tatsächlichen Konfiguration und den angezeigten Folgen einer Änderung.',
      ] },
      { id: 'erwartung', title: 'Warum er nicht bis ganz leer oder ganz voll fährt', paragraphs: [
        'Ein vermeintlich ungenutzter Teil des Speichers kann durch die hinterlegten Grenzen, eine Reservierung oder die weitere Tagesplanung erklärt sein. Auch das Gerät selbst kann die umsetzbare Leistung begrenzen.',
        'Prüfen Sie Fahrplan, aktuelle Messwerte und Einstellungen in dieser Reihenfolge. Ändern Sie Grenzen nur anhand der passenden Gerätedaten und der angebotenen Eingaben. Wenn ein Feld durch VoltPilot verwaltet wird, nutzen Sie den angegebenen Kontaktweg.',
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
        'Wenn mehrere große Verbraucher gleichzeitig laufen, kann die Netzbezugsleistung stark ansteigen. Die Lastspitzen-Ansicht hilft dabei, solche Zeiträume und die dazugehörige Zielgröße zu erkennen.',
        'Eine Leistungsspitze in kW ist etwas anderes als der Tagesverbrauch in kWh. Lesen Sie außerdem den angegebenen Mess- oder Auswertungszeitraum. Eine kurze Momentanspitze und ein gemittelter Leistungswert müssen unterschiedlich eingeordnet werden.',
      ], figure: 'lastspitzen' },
      { id: 'ziel', title: 'Wie das Betriebsmodell eingreift', paragraphs: [
        'Lastspitzenkappung nutzt die verfügbaren Möglichkeiten Ihrer Anlage, um den Netzbezug innerhalb des geplanten Ziels zu halten. Ein Speicher kann dabei Leistung bereitstellen, solange Energie und Entladeleistung ausreichen.',
        'Das Ziel ist keine unbegrenzte Garantie. Fehlende Energie, technische Grenzen, unvollständige Messungen oder ein unerwarteter Verbrauch können die Wirkung begrenzen. Die Steuerung nennt die Voraussetzungen des Betriebsmodells.',
      ] },
      { id: 'pruefung', title: 'Eine Überschreitung nachvollziehen', paragraphs: [
        'Wählen Sie den betroffenen Zeitraum und vergleichen Sie Netzleistung, Ziel und Speicherzustand. Prüfen Sie danach, ob das Modell aktiv war und die benötigten Daten vorlagen.',
        'Notieren Sie Zielwert, Zeitraum und die sichtbaren Hinweise für eine Rückfrage. Hinterlegte Anschluss- und Tarifdaten sollten zur tatsächlichen Anlage passen.',
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
        'Die Ladepark-Ansicht zeigt die gemeldeten Ladepunkte und ihre Zustände. Ein erreichbarer Ladepunkt lädt nicht zwangsläufig: Es kann kein Fahrzeug angeschlossen sein, eine Freigabe fehlen oder das Fahrzeug gerade keine Leistung anfordern.',
        'Lesen Sie deshalb Verbindungszustand, Ladezustand und Datenstand zusammen. Bei mehreren Anschlüssen achten Sie darauf, welcher Anschluss gemeint ist.',
      ], figure: 'ladevorgaenge' },
      { id: 'verteilung', title: 'Leistung innerhalb des Anschlusses verteilen', paragraphs: [
        'Das Lastmanagement verteilt die verfügbare Leistung im Rahmen der hinterlegten Anschlussgrenzen. Weitere Verbraucher an derselben Anlage können den verfügbaren Spielraum verkleinern. Eine Priorität beeinflusst die Verteilung, ersetzt aber keine physische Kapazität.',
        'Unter Steuerung → Ladepark-Rahmen sehen Sie die Anschlussgrenze und weitere gemeldete Werte. Der lokale Schutz des Anschlusses ist von der Auswahl eines Speicher-Betriebsmodells getrennt. Prüfen Sie Änderungen an Grenzen anhand der tatsächlichen Installation.',
      ], figure: 'ladepark' },
      { id: 'steuerart', title: 'Quelle und Reihenfolge festlegen', paragraphs: [
        'Unter Steuerung → Verbraucher finden Sie den Anlagen-Standard für Ladepunkte und die Steuerart jeder Säule. Der Standard legt fest, wie die folgenden Ladepunkte betrieben werden; eine abweichende Steuerart gilt für die jeweilige Säule. Lesen Sie auch die Einstellung für Zeiten ohne ausreichend Überschuss.',
        'Die Reihenfolge bei knapper Leistung ordnet Speicher und Verbraucher ein. Sie bestimmt den Vorrang innerhalb der verfügbaren Leistung. Anschlussgrenzen bleiben bestehen und eigene Regeln können der gewählten Steuerart vorgehen.',
      ] },
      { id: 'einzeln', title: 'Einen Ladepunkt genauer prüfen', paragraphs: [
        'Öffnen Sie den betreffenden Ladepunkt, um Verbindung, gemeldete Messungen und angebotene Aktionen zu sehen. Prüfen Sie bei einer Aktion deren Geltungsbereich und danach die Rückmeldung.',
        'Eine gesendete oder angenommene Aktion ist nicht automatisch bereits am Fahrzeug wirksam. Nutzen Sie den Zustandsverlauf und die Messwerte, um die tatsächliche Änderung nachzuvollziehen.',
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
        'Öffnen Sie Ladevorgänge, um die aktuelle Ladeleistung, die einzelnen Anschlüsse und ihre Zustände zu sehen. Auf einer Speicheranlage kann diese Ansicht als Reiter im Bereich Fahrplan erscheinen; auf einem reinen Ladepark bildet sie den eigenen Bereich.',
        'Prüfen Sie Ladepunkt, Anschluss, Beginn und den angezeigten Grund für Laden oder Warten. Ein laufender Vorgang hat noch kein endgültiges Endergebnis. Die momentane Ladeleistung in kW ist von einer über den Vorgang gemessenen Energiemenge in kWh zu unterscheiden.',
      ], figure: 'ladevorgaenge' },
      { id: 'details', title: 'Messungen und Ereignisse zusammen lesen', paragraphs: [
        'Öffnen Sie über Geräteseite den betreffenden Ladepunkt. Seine Detailansicht bietet – soweit Daten vorliegen – Vorgänge, Messwerte, Protokollereignisse und Aktionen. Damit lässt sich nachvollziehen, ob die Ladung unterbrochen wurde, eine Rückmeldung fehlt oder ein Gerät seinen Zustand geändert hat.',
        'Fehlende Daten sind keine bestätigte Ladung von null kWh. Beachten Sie Hinweise zu Lücken und den letzten Datenstand, insbesondere nach einer Verbindungsunterbrechung.',
      ] },
      { id: 'fragen', title: 'Bei einer unerwarteten Unterbrechung', paragraphs: [
        'Prüfen Sie zuerst, ob der Vorgang tatsächlich beendet ist oder nur keine aktuellen Messungen vorliegen. Sehen Sie anschließend Ladepunktzustand, Freigaben und verfügbare Leistung im Ladepark nach.',
        'Für eine Rückfrage helfen Name des Ladepunkts, Anschluss, Zeitraum und Status. Die Darstellung im Portal ist nicht automatisch eine abrechnungsfähige Laderechnung.',
      ] },
    ], related: ['ladepark', 'messwerte', 'kontakt'],
  },
];
