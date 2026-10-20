import type { HelpArticle } from '../model';

export const everydayArticles: HelpArticle[] = [
  {
    id: 'summenwerte', category: 'alltag', title: 'Summenwerte bilden und verwenden',
    summary: 'Register zusammenzählen, den Stand prüfen und eine Rolle in der Anlagen-Übersicht wählen.',
    keywords: ['Summenwert', 'Register', 'Summe', 'Rolle', 'PV-Produktion', 'Verbrauch', 'Netz'],
    sections: [
      { id: 'anlegen', title: 'Von den Registern zum Summenwert', paragraphs: [
        'Öffnen Sie „Summenwert anlegen“ am Gerät, unter Verlauf → Messwerte (Summenwerte) oder beim Zusammenstellen einer Kennzahl. Wählen Sie passende Register derselben Anlage, prüfen Sie Plus, Minus und Faktoren und geben Sie dem Wert einen Namen.',
        'Jeder Live-Wert trägt seinen Stand. Noch nicht beobachtete Register werden einmal gelesen und erst beim Speichern beobachtet; die zusätzliche Datenmenge steht dabei. Fehlt ein aktueller Eingang, bleibt die Summe unvollständig.',
      ] },
      { id: 'rolle', title: 'Eine Rolle wirkt ab jetzt', paragraphs: [
        'Ohne Rolle bleibt die Anlagen-Übersicht unverändert. PV-Produktion, Verbrauch oder Netz verwenden den Summenwert als Anlagenzahl. Prüfen Sie beim Verbrauch, ob alle Verbraucher enthalten sind. Für das Netz kann genau ein Wert maßgeblich sein; ein vorhandener Wert wird nur nach Bestätigung ersetzt.',
        'Die Gerätekarte nennt Wert, Stand und Rolle. Über „Rolle ändern“ können Sie die Rolle entziehen. Der Summenwert bleibt erhalten, die Anlagen-Übersicht verwendet wieder den ursprünglichen Wert. Die Aufschlüsselung zählt dieselbe Summe auch bei mehreren beteiligten Geräten einmal.',
      ] },
      { id: 'rechte', title: 'Welche Änderungen sind möglich?', paragraphs: [
        'Leser sehen die Werte. Zum Anlegen und Ändern der Formel brauchen Sie das Formelrecht, für eine Rolle das Einrichtungsrecht und für weitere beobachtete Register die Berechtigung zur Messauswahl. Fehlt ein Knopf, lassen Sie Ihren Zugang prüfen.',
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
    keywords: ['Zeitplan', 'Schedule', 'Laden', 'Entladen', 'Batterie', 'Akku', 'SoC', 'Warum', 'Tagesuhr', 'Tagesband', 'Gestern', 'Morgen'],
    prerequisite: 'Ein Speicher beziehungsweise eine Anlage, für die ein Fahrplan angeboten wird.',
    sections: [
      { id: 'lesen', title: 'Der Tag in einem Bild', paragraphs: [
        "Ganz oben steht, was der Speicher gerade tut, darunter in Stichworten der Ladestand, ein Grund wie „voll“ und der nächste Wechsel. Folgt Ihr Gerät dem Plan nicht oder führt es bewusst nach, steht eine kurze Gerätezeile darunter; ein Tipp zeigt den ganzen Satz. Ein Tipp auf die oberste Zeile öffnet das Warum: einen Satz, die Waage und alle Gründe.",
        "Am Rechner zeigt das Tagesband den ganzen Tag: oben die Tätigkeiten des Speichers mit Uhrzeit, darunter der Ladestand – links von jetzt gemessen, rechts geplant –, unten Sonne und der Preis, der den Plan treibt. Ändert sich Ihr Strompreis über den Tag, etwa bei einem dynamischen Tarif oder mit Hoch- und Niedertarif, steht er dort; ist er fest und vermarkten Sie Ihren Strom direkt, der Börsenpreis. Bei festem Preis ohne Vermarktung entfällt die Preisspur. Mit der Maus zeigt eine Lupe jede Viertelstunde, ein Klick auf eine Tätigkeit ihr Warum.",
        "Die Tätigkeiten heißen überall gleich: Sonne speichern, Günstig aus dem Netz laden, Verbrauch decken, Warten und Einspeisung pausieren. Die Farbe sagt die Richtung des Speichers – grün lädt, beere gibt ab, grau wartet –, das Symbol wofür. Die Kacheln beantworten, was als Nächstes kommt, ob der Speicher bis zum Abend reicht und was die Steuerung heute bringen soll. „Ihr Tag“ listet alle Phasen, vergangene mit gemessenem Ladestand; „Gut zu wissen“ nennt Tarif, Grenzen und Hinweise und öffnet „Alle Werte im Diagramm“.",
      ], figure: 'fahrplan' },
      { id: 'uhr', title: 'Die Uhr am Telefon', paragraphs: [
        "Am Telefon geht die Uhr wie jede andere: 12 Stunden rund, der Zeiger steht auf der Uhrzeit von jetzt. Der Ring zeigt, was ab jetzt kommt, elf Stunden nach vorn und über Mitternacht hinaus; außen am Ring steht die Uhrzeit jedes Wechsels. Ein Tipp auf einen Abschnitt des Rings zeigt, warum der Speicher das dann tut.",
      ], figure: 'fahrplan-uhr' },
      { id: 'tage', title: 'Gestern, heute, morgen', paragraphs: [
        "Über dem Bild wählen Sie den Tag. Gestern zeigt den Plan, wie er galt, und den gemessenen Ladestand dazu; die Kachel nennt, was die Steuerung an diesem Tag gebracht hat. Am Telefon zeigt die Uhr dann den Vor- oder Nachmittag.",
        "Morgen zeigt den jüngsten Plan für den nächsten Tag. Er entsteht, sobald die Börsenpreise für morgen gegen 13 Uhr veröffentlicht sind, und wird bis dahin alle 15 Minuten neu gerechnet; vorher steht dort, wann er kommt. Was der Speicher gerade tut und ob Sie eingreifen müssen, steht nur bei Heute.",
      ] },
      { id: 'gruende', title: 'Warum die Batterie gerade so geplant ist', paragraphs: [
        "PV, Bedarf, Tarif, Reserven und Grenzen bestimmen den Plan. Ein günstiger Börsenpreis allein erlaubt noch kein Netzladen; ein hoher Preis verlangt keine vollständige Entladung. Die Waage im Warum stellt die zwei Werte je Kilowattstunde nebeneinander, zwischen denen entschieden wurde; „Alle Gründe und Zahlen“ öffnet die ausführliche Erklärung.",
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
        "Die Kachel „VoltPilot-Steuerung“ vergleicht Ihre Anlage mit demselben Speicher ohne smarte Steuerung, gleich groß wie gemessen und stur gefahren: Der lädt jeden Überschuss sofort und entlädt bei Bedarf sofort, ohne auf Preise zu achten. Der Betrag ist, was die Steuerung darüber hinaus gebracht hat. Er ist kein Teil des Ergebnisses, sondern ein Vergleich. Maßstab und Rechnung stehen im ⓘ der Kachel. Fehlen die Speicherdaten, steht dort ein Strich und der Weg zum Nachtragen.",
      ] },
      { id: 'speicherbestand', title: 'Warum die Tagesbilanz zwischendurch anders aussieht', paragraphs: [
        "Gespeicherte Energie kann ihren Nutzen erst später bringen. Lesen Sie deshalb Ergebnis und gegebenenfalls Bestandskonto zusammen. Der Zwischenstand am Mittag ist noch kein abgeschlossenes Tagesergebnis.",
      ] },
      { id: 'minus-tag', title: 'Warum die Steuerung an einem Tag unter Null liegt', paragraphs: [
        "Der Vergleichsspeicher rechnet über Mitternacht weiter; deshalb ergeben die Tage zusammen den Monat. Hat die Steuerung am Vorabend verkauft, was er für die Nacht behalten hätte, steht der Erlös am Vortag und der Nachtbezug am Folgetag. Unter einer Zahl unter Null steht deshalb der Grund, zum Beispiel „gestern verkauft“ mit beiden Tagen zusammen, und darunter der Monat bisher. Die Zeile zum Vorsprung nennt, wie viel Energie gerade mehr im Speicher liegt als beim Vergleichsspeicher; ihr Planwert wird nicht abgezogen. Der Vergleichsspeicher nutzt denselben Ladebereich, den Ihr Speicher gemessen erreicht, und auch der Fahrplan wird gegen ihn gerechnet. Greift keiner der besonderen Gründe, steht „anders geladen und entladen“: Die Steuerung hat Energie anders verschoben als der Vergleichsspeicher, und das hat sich an diesem Tag nicht ausgezahlt. Ein Grund, den die Daten nicht belegen, wird nie geraten.",
      ] },
      { id: 'winter', title: 'Warum im Winter', paragraphs: [
        "Bei wenig Sonne gibt es kaum Überschuss, den die Steuerung in teure Stunden verschieben könnte. Die Anlage bezieht dann den größten Teil ihres Stroms aus dem Netz, und das Ergebnis kann unter Null liegen: Das sind echte Stromkosten. Liegt die Erzeugung unter 60 % des Verbrauchs, sagt die Seite deshalb, was die Sonne trotzdem gedeckt hat, etwa „Wenig Sonne: 96 kWh erzeugt, 91 kWh selbst genutzt.“ Der Eigenverbrauch ist vermiedener Bezug. Für die Einordnung hilft der Monat oder das Jahr bisher.",
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
        "Oben steht der Börsenpreis der laufenden Viertelstunde und ein Wort dazu: günstig, mittel oder teuer im Vergleich zu den kommenden Stunden bis zum letzten bekannten Preis. Die zwei Kacheln nennen die günstigsten und die teuersten zwei Stunden ab jetzt.",
        "Im Bild markiert die dunkle Linie jetzt; Vergangenes ist blass. Ein Tipp auf einen Balken zeigt seine Viertelstunde oben, „Jetzt“ führt zurück. Eine Lücke steht für fehlende Preise; sie ist weder null noch eine Vorhersage. Woche, Monat und Jahr finden Sie unter „Rückblick“.",
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
    keywords: ['Wetter', 'Forecast', 'Vorhersage', 'Prognosequalität', 'Genauigkeit', 'Abweichung', 'Fahrplan'],
    sections: [
      { id: 'wetter', title: 'Wetter beschreibt die erwarteten Bedingungen', paragraphs: [
        "Oben steht das Wetter am Anlagenstandort: Symbol, Temperatur und ein Wort für den Himmel. Darunter steht, was Ihre Anlage gerade erzeugt (gemessen) und heute voraussichtlich erzeugt. Drei Karten zeigen die nächsten Tage; ein Tipp wählt den Tag für das Bild.",
        "Im Bild ist gemessener Sonnenstrom gefüllt und erwarteter schraffiert; die dunkle Linie markiert jetzt. Liegt keine Sonnenstrom-Prognose vor, zeigt das Bild die Sonnenstärke laut Wetterdienst und sagt das dazu. Lokales Wetter kann von der Vorhersage abweichen; bei unplausiblen Ortsangaben prüfen Sie den Standort.",
      ], figure: 'wetter' },
      { id: 'modelle', title: 'Prognose und Prognosequalität', paragraphs: [
        "Im Fahrplan steht unter „Gut zu wissen“, wie weit die Vorhersage zuletzt danebenlag: die mittlere Abweichung je Viertelstunde für Verbrauch und PV. Verglichen werden gespeicherte Vorhersagen mit Messungen; wenige ausgewertete Tage oder Datenlücken begrenzen den Vergleich. Welches Vorhersagemodell plant, betreut VoltPilot.",
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
        "Meine Anlagen beantwortet vier Fragen: Läuft alles? Was hat es heute gebracht? Was passiert gerade? Wie steht jede Anlage? Die Statuszeile nennt eine Anlage, die Aufmerksamkeit braucht, mit Link. Ein Tipp auf eine Anlage öffnet sie. Anpassen und Anlage anlegen stehen im ⋯-Menü; eine VoltPilot-Box oder ein Gerät fügen Sie im Aufbau der Anlage hinzu. Konten mit Betreiber-Ansicht sehen dieselbe Übersicht unter dem Namen Portfolio.",
      ], figure: 'portfolio' },
      { id: 'auswertung', title: 'Anlagenübergreifende Zahlen und einzelne Anlagen', paragraphs: [
        "Die Reiter Energie und Erlöse zeigen oben die Summen über alle Anlagen und darunter jede Anlage als Balken; die Tabelle nennt alle Werte je Anlage. Ein Tipp auf eine Anlage öffnet dieselbe Seite dieser Anlage im gleichen Zeitraum. Eine Anlage ohne Werte zählt nicht als Null, sondern steht mit ihrem Grund in der Liste.",
      ] },
      { id: 'kontrolle', title: 'Vor Änderungen den Namen prüfen', paragraphs: [
        "Vor Änderungen Anlagenname und Geltungsbereich im Dialog prüfen. Ein Endkundenkonto mit nur einer Anlage kann direkt im Cockpit starten.",
      ] },
    ], related: ['orientierung', 'cockpit', 'erloese'],
  },
];
