import type { HelpArticle } from '../model';

export const everydayArticles: HelpArticle[] = [
  {
    id: 'cockpit', category: 'alltag', title: 'Das Cockpit lesen',
    summary: 'Zustand, Energieflüsse und aktuelle Messwerte Ihrer Anlage auf einen Blick.',
    keywords: ['Dashboard', 'Übersicht', 'Live', 'Energiefluss', 'Status', 'Warnung', 'Anpassen'],
    sections: [
      { id: 'blick', title: 'Zuerst Zustand und Datenstand prüfen', paragraphs: [
        'Das Cockpit beantwortet die Frage: Was passiert gerade in meiner Anlage? Beginnen Sie mit dem Zustands-Hinweis und dem Zeitpunkt der Daten. Ein alter Messwert beschreibt einen früheren Zustand, auch wenn seine Zahl plausibel aussieht.',
        'Die angezeigten Bausteine folgen Ihrer Ausstattung und den verfügbaren Messungen. Eine PV-Anlage mit Speicher sieht deshalb anders aus als ein Ladepark. Unter Anpassen können Sie die angebotenen Cockpit-Bausteine ordnen oder ausblenden.',
      ], figure: 'cockpit' },
      { id: 'lesen', title: 'Von den Flüssen zu den Einzelwerten', paragraphs: [
        'Lesen Sie Erzeugung, Verbrauch, Netzfluss und Speicher zusammen. Pfeile, Bezeichnungen und Einheiten helfen bei der Richtung: Ein voller Speicher ist ein Ladestand, Laden oder Entladen ist eine Leistung.',
        'Die Komponentenansicht schlüsselt Messwerte nach Geräten auf. Bei mehreren PV-Quellen hilft die Aufteilung, den Gesamtwert einzuordnen. Der kompakte Verlauf zeigt, ob die aktuelle Situation gerade entstanden ist oder schon länger besteht.',
      ] },
      { id: 'weiter', title: 'Was tun bei einem Hinweis?', paragraphs: [
        'Öffnen Sie den Hinweis und lesen Sie seine Ursache. Für die nächste geplante Speicheraktion wechseln Sie zum Fahrplan. Für länger zurückliegende Werte nutzen Sie Verlauf → Messwerte. Geräteverbindung und Zuordnung prüfen Sie unter Anlage.',
        'Eine fehlende Zahl sollte zunächst als fehlende Information behandelt werden. Prüfen Sie Datenstand und Quelle, bevor Sie die Steuerung ändern.',
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
        'Der Fahrplan zeigt geplante Speicheraktionen entlang einer Zeitachse. Lesen Sie zunächst den gewählten Zeitraum, den Erstellungszeitpunkt und die Erklärung zur aktuellen Aktion. Die Planung kann sich ändern, wenn neue Daten oder geänderte Vorgaben vorliegen.',
        'Preis und Leistung stehen in getrennten Diagrammflächen. Achten Sie auf deren Einheiten und die gemeinsame Zeitachse. Laden, Entladen und der erwartete Ladestand beschreiben verschiedene Größen; ihre Kurven gehören jeweils zur angegebenen Skala.',
      ], figure: 'fahrplan' },
      { id: 'gruende', title: 'Warum die Batterie gerade so geplant ist', paragraphs: [
        'PV- und Verbrauchsprognosen, Tarif, vorhandene Energie und die hinterlegten Grenzen beeinflussen den Plan. Ein günstiger Preis allein ist deshalb noch keine Zusage zum Netzladen. Das muss erlaubt, technisch möglich und innerhalb des übrigen Plans sinnvoll sein.',
        'Ebenso bedeutet ein hoher Preis nicht, dass der Speicher vollständig entladen wird. Reserven, Leistungsgrenzen oder der weitere erwartete Bedarf können dagegenstehen. Lesen Sie die angebotenen Erklärungen und Ebenen des Plans, bevor Sie Einstellungen ändern.',
      ] },
      { id: 'kontrolle', title: 'Plan ist nicht gleich Ausführung', paragraphs: [
        'Ein gespeicherter Fahrplan beweist noch nicht, dass ein Gerät genau so gearbeitet hat. Prüfen Sie für den aktuellen Zustand das Cockpit und die Geräte-Rückmeldungen, für vergangene Zeiträume die Messwerte.',
        'Wenn kein Plan vorhanden ist, prüfen Sie zunächst Datenverbindung, Speicherzuordnung und die Hinweise in Steuerung. Ein fehlender Plan darf nicht als geplanter Stillstand gelesen werden.',
      ] },
    ], related: ['beispieltag', 'speicher', 'probleme'],
  },
  {
    id: 'messwerte', category: 'alltag', title: 'Messwerte und Zeiträume vergleichen',
    summary: 'Messreihen auswählen, Zeiträume wechseln und Datenlücken richtig lesen.',
    keywords: ['Historie', 'Verlauf', 'Messungen', 'Diagramm', 'Vergleich', 'Tag', 'Woche', 'Monat', 'Jahr'],
    sections: [
      { id: 'auswahl', title: 'Die richtige Frage eingrenzen', paragraphs: [
        'Unter Verlauf → Messwerte sehen Sie den zeitlichen Verlauf Ihrer Anlage. Wählen Sie zuerst den Zeitraum und anschließend die Messgröße beziehungsweise die angebotenen Reihen. Auf der Portfolio-Ebene bezieht sich die Auswertung auf die dort gewählten Anlagen.',
        'Eine aktuelle Leistung, eine Energiesumme und ein Durchschnitt beantworten unterschiedliche Fragen. Lesen Sie Einheit und Zeitbezug an jeder Kennzahl. Größere Zeiträume können zusammengefasste Werte zeigen und dadurch weniger einzelne Schwankungen erkennen lassen.',
      ], figure: 'messwerte' },
      { id: 'vergleich', title: 'Zwei Zeiträume sinnvoll vergleichen', paragraphs: [
        'Nutzen Sie die angebotene Vergleichsansicht, um einen weiteren Zeitraum daneben oder als zusätzliche Reihe zu sehen. Die Vergleichsbezeichnung sagt, welcher Zeitraum gemeint ist. Vergleichen Sie möglichst dieselbe Größe mit derselben Einheit.',
        'Ein Unterschied erklärt seine Ursache noch nicht. Wetter, Nutzung, neue Geräte oder eine geänderte Einstellung können einen Verlauf verändern. Für eine Speicherentscheidung hilft zusätzlich der Blick in Fahrplan und Steuerung.',
      ] },
      { id: 'luecken', title: 'Lücken und Datenstand beachten', paragraphs: [
        'Ein unterbrochener Verlauf bedeutet nicht automatisch, dass die Leistung null war. Es können Messungen fehlen oder später eintreffen. Prüfen Sie die Geräteverbindung und die Hinweise zur Abdeckung.',
        'Wenn ein erwarteter Messwert nicht auswählbar ist, prüfen Sie die Komponente und ihre Zuordnung unter Anlage. Notieren Sie bei einer Rückfrage die Messgröße und den betroffenen Zeitraum.',
      ] },
    ], related: ['glossar', 'anlagenmodell', 'probleme'],
  },
  {
    id: 'erloese', category: 'alltag', title: 'Erlöse und Einsparungen einordnen',
    summary: 'Die wirtschaftliche Ansicht mit Zeitraum, Vergleich und Speicherbestand lesen.',
    keywords: ['Geld', 'Euro', 'Kosten', 'Einsparung', 'Ertrag', 'Bilanz', 'Bestandskonto', 'Vergütung'],
    prerequisite: 'Eine Anlage mit den nötigen Mess- und Preisdaten und einer verfügbaren Erlöse-Ansicht.',
    sections: [
      { id: 'zeitraum', title: 'Welche Aussage zeigt die Zahl?', paragraphs: [
        'Die Erlöse-Ansicht ordnet den Energieverlauf wirtschaftlich ein. Prüfen Sie zuerst Zeitraum und Kennzahlenbezeichnung: Einspeiseerlös, Bezugskosten, Einsparung und ein Planwert sind nicht dieselbe Aussage.',
        'Die Berechnung hängt von den hinterlegten Angaben und den verfügbaren Messungen ab. Lesen Sie die Erläuterung der jeweiligen Kennzahl. Die Portalansicht ist keine Stromrechnung oder Abrechnung Ihres Vertragspartners.',
      ], figure: 'erloese' },
      { id: 'speicherbestand', title: 'Warum die Tagesbilanz zwischendurch anders aussieht', paragraphs: [
        'Wird Energie im Speicher zurückgehalten, fehlt sie in diesem Moment beispielsweise bei der Einspeisung. Ihr Nutzen kann erst später entstehen. Deshalb zeigt die wirtschaftliche Betrachtung neben dem laufenden Ergebnis gegebenenfalls auch den Wert des Speicherbestands.',
        'Lesen Sie die ausgewiesene Bilanz und das Bestandskonto zusammen mit den Erklärungen der Ansicht. Ein Zwischenstand mitten am Tag ist nicht automatisch das Ergebnis des abgeschlossenen Tages.',
      ] },
      { id: 'nachvollziehen', title: 'Eine auffällige Zahl prüfen', paragraphs: [
        'Grenzen Sie den betroffenen Tag ein und vergleichen Sie Energieverlauf, Speicherbewegung und Preise im Tagesbild. Prüfen Sie danach Tarifangaben und Datenabdeckung. Eine Änderung von Tarifdaten kann die Einordnung beeinflussen.',
        'Für eine Rückfrage sind Zeitraum, Name der Kennzahl und die dazugehörige Erklärung hilfreicher als eine einzelne ausgeschnittene Zahl.',
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
        'Die Preisansicht zeigt veröffentlichte Marktpreise für den gewählten Zeitraum und Markt. Lesen Sie Datum, Zeitachse und Einheit. Ein günstiges Zeitfenster ist ein Abschnitt der Kurve, keine Zusage für den gesamten Tag.',
        'Noch nicht veröffentlichte oder fehlende Preise sind unbekannt. Eine Lücke ist deshalb weder ein Preis von null noch eine Prognose. Nutzen Sie die angebotene Zeitraum-Navigation, um vorhandene Tage zu betrachten.',
      ], figure: 'marktpreise' },
      { id: 'tarif', title: 'Börsenpreis ist nicht Ihr vollständiger Bezugspreis', paragraphs: [
        'Je nach hinterlegtem Tarif kommen zum Börsenanteil weitere Preisbestandteile hinzu. Ein negativer Marktpreis bedeutet deshalb nicht automatisch, dass Ihr vollständiger Bezugspreis negativ ist.',
        'Die für Ihre Anlage hinterlegten Werte finden Sie in den Einstellungen. Für Aussagen zu Ihrem Vertrag sind dessen Angaben maßgeblich. Die Hilfe erklärt die Darstellung im Portal, nicht die Bedingungen eines bestimmten Vertrags.',
      ] },
      { id: 'plan', title: 'Was die Planung daraus macht', paragraphs: [
        'Preise sind ein Eingang der Planung. Speicherstand, Wirkungsgrad, Verbrauch, PV-Vorhersage und Grenzen gehören ebenfalls dazu. Ob tatsächlich geladen werden soll, lesen Sie im Fahrplan.',
        'Prüfen Sie bei einer unerwarteten Aktion zuerst den passenden Zeitraum und die hinterlegten Tarif- und Netzladeangaben, statt allein die höchste oder niedrigste Stelle der Preiskurve zu betrachten.',
      ] },
    ], related: ['fahrplan', 'einstellungen', 'beispieltag'],
  },
  {
    id: 'prognosen', category: 'alltag', title: 'Wetter und Prognosen verstehen',
    summary: 'Vorhersagen für PV und Verbrauch sowie deren spätere Bewertung einordnen.',
    keywords: ['Wetter', 'Forecast', 'Vorhersage', 'Prognosequalität', 'Genauigkeit', 'Modell', 'Schatten'],
    sections: [
      { id: 'wetter', title: 'Wetter beschreibt die erwarteten Bedingungen', paragraphs: [
        'Die Wetteransicht bezieht sich auf den Standort Ihrer Anlage. Einstrahlung und weitere Wettergrößen helfen bei der Einschätzung der erwarteten PV-Produktion. Das ist eine Vorhersage, keine Messung Ihrer Solarmodule.',
        'Prüfen Sie bei unplausiblen Ortsangaben zuerst den Standort der Anlage. Auch bei richtiger Zuordnung können Wolken oder lokale Bedingungen von der Vorhersage abweichen.',
      ], figure: 'wetter' },
      { id: 'modelle', title: 'Prognose und Prognosequalität', paragraphs: [
        'Die Planung verwendet Vorhersagen für Produktion und Verbrauch. Die Prognosequalität stellt gegenüber, wie gut Modelle in ausgewerteten Zeiträumen zu den tatsächlichen Messungen gepasst haben.',
        'Ein aktives Modell liefert die verwendete Vorhersage. Ein Kandidat im Schattenbetrieb wird daneben bewertet und beeinflusst die Planung noch nicht. Wenige ausgewertete Tage oder fehlende Messungen begrenzen die Aussagekraft eines Vergleichs.',
      ], figure: 'prognose' },
      { id: 'bewertung', title: 'Abweichungen mit ihrer Einheit lesen', paragraphs: [
        'Die Ansicht bezeichnet die verwendete Fehlermetrik ausdrücklich. Eine durchschnittliche Abweichung in kW ist keine Genauigkeit in Prozent. Vergleichen Sie Modelle für dieselbe Größe und einen vergleichbaren Zeitraum.',
        'Wenn Ihnen ein Modellwechsel angeboten wird, lesen Sie die Bestätigung und ihre Folgen. Ein besserer historischer Vergleich ist keine Garantie für jeden zukünftigen Tag.',
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
        'Die Übersicht heißt abhängig von Ihrem Konto Portfolio oder Meine Anlagen. Sie zeigt die Anlagen, auf die Sie Zugriff haben, und hilft dabei, auffällige Zustände sowie Ergebnisse über mehrere Standorte zu erkennen.',
        'Öffnen Sie eine Anlage, um ihren Zustand genauer zu prüfen. Im Kopf der geöffneten Anlage erkennen Sie, an welchem Standort Sie gerade arbeiten. Über den Anlagenwechsler können Sie zu einer anderen Anlage gelangen.',
      ], figure: 'portfolio' },
      { id: 'auswertung', title: 'Gesamtwerte und einzelne Anlagen', paragraphs: [
        'Messwerte und Erlöse auf Portfolio-Ebene haben einen anderen Umfang als die entsprechenden Ansichten einer einzelnen Anlage. Prüfen Sie deshalb Auswahl und Zeitraum, bevor Sie Zahlen miteinander vergleichen.',
        'Nicht jede Anlage besitzt dieselben Geräte oder Betriebsmodelle. Eine fehlende Erlöse-Ansicht oder ein anderer zweiter Navigationsbereich kann durch diese Ausstattung erklärt sein.',
      ] },
      { id: 'kontrolle', title: 'Vor Änderungen den Namen prüfen', paragraphs: [
        'Einstellungen und Regeln einer geöffneten Anlage beziehen sich auf diesen Standort. Prüfen Sie vor jeder Änderung den Namen im Kopf und den Geltungsbereich im Dialog.',
        'Ein Endkundenkonto mit nur einer Anlage kann direkt in deren Cockpit starten. Eine separate Portfolio-Seite ist dann für die tägliche Arbeit nicht erforderlich.',
      ] },
    ], related: ['orientierung', 'cockpit', 'erloese'],
  },
];
