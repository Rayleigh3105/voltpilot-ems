import type { HelpArticle } from '../model';

export const startArticles: HelpArticle[] = [
  {
    id: 'voltpilot', category: 'verstehen', title: 'Was macht VoltPilot?',
    summary: 'Ihre Energieanlage verstehen, den Betrieb planen und die tatsächlichen Ergebnisse nachvollziehen.',
    keywords: ['EMS', 'Energiemanagement', 'Überblick', 'Projekt', 'Optimierung', 'Cloud', 'Box'],
    sections: [
      { id: 'zusammenspiel', title: 'Eine Anlage, mehrere Aufgaben', paragraphs: [
        'Eine Solaranlage produziert Strom, wenn die Sonne scheint. Ihr Verbrauch folgt einem anderen Tagesablauf. Ein Speicher kann Energie zwischen diesen Zeiten verschieben; Ladepunkte und andere steuerbare Verbraucher bringen zusätzliche Möglichkeiten und Anforderungen mit.',
        'VoltPilot führt diese Informationen zusammen. Im Portal sehen Sie, was Ihre Anlage gerade tut, was als Nächstes geplant ist und welche Ergebnisse bereits gemessen wurden. Welche Ansichten erscheinen, hängt von den Geräten, Einstellungen und Betriebsmodellen Ihrer Anlage ab.',
      ], diagram: 'loop' },
      { id: 'aufgaben', title: 'Portal, Planung und Box', paragraphs: [
        'Das Portal ist Ihr Arbeitsplatz: Hier lesen Sie Messwerte, hinterlegen Angaben zur Anlage und verwalten die angebotenen Steuerungsmöglichkeiten. Die Planung verwendet Messwerte, Vorhersagen, Preise und die hinterlegten Grenzen.',
        'Die VoltPilot Box verbindet die Geräte vor Ort mit dem System. Sie übermittelt Messwerte und führt freigegebene Vorgaben aus. Ein angezeigter Fahrplan beschreibt deshalb zunächst eine Absicht. Ob sie tatsächlich umgesetzt wurde, zeigen die Rückmeldungen und Messwerte.',
      ] },
      { id: 'einstieg', title: 'So finden Sie sich zurecht', paragraphs: [
        'Beginnen Sie im Cockpit mit dem Zustand und den aktuellen Energieflüssen. Im Fahrplan sehen Sie die nächsten Schritte des Speichers. Unter Verlauf prüfen Sie zurückliegende Messwerte und – wenn verfügbar – Erlöse. Steuerung erklärt die aktiven Betriebsmodelle und Regeln. Unter Anlage finden Sie Geräte und Einstellungen.',
        'Die Hilfe erklärt auch Funktionen, die für Ihre Anlage noch nicht verfügbar sind. Die Voraussetzungen am Artikelanfang sagen Ihnen, welche Ausstattung oder Freigabe dafür benötigt wird.',
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
        'PV steht für Photovoltaik: Ihre Solarmodule liefern elektrische Energie. Diese kann die Verbraucher vor Ort versorgen, den Speicher laden oder in das Netz fließen. Reicht die Erzeugung nicht aus, kommen je nach Betriebszustand Energie aus dem Speicher und Strom aus dem Netz hinzu.',
        'Die Abbildung zeigt mögliche Wege, keine gleichzeitig gemessenen Flüsse. Im Cockpit beschreiben Richtung und Beschriftung den aktuellen Zustand Ihrer eigenen Anlage.',
      ], diagram: 'energy' },
      { id: 'einheiten', title: 'Leistung, Energie und Ladestand unterscheiden', paragraphs: [
        'Kilowatt (kW) beschreibt die Leistung zu einem Zeitpunkt. Kilowattstunden (kWh) beschreibt die Energiemenge über einen Zeitraum: Eine Leistung von 2 kW über eine Stunde entspricht 2 kWh. Der Ladestand in Prozent beschreibt, wie voll der Speicher im Verhältnis zu seiner Kapazität ist.',
        'Vergleichen Sie deshalb eine aktuelle kW-Anzeige nicht direkt mit einem Tageswert in kWh. Lesen Sie außerdem immer die Bezeichnung: Laden und Entladen beziehungsweise Netzbezug und Einspeisung sind verschiedene Richtungen.',
      ] },
      { id: 'messung', title: 'Ein Gesamtbild aus mehreren Messungen', paragraphs: [
        'Messwerte verschiedener Geräte müssen nicht im selben Augenblick eintreffen. Manche Größen werden aus anderen Messungen abgeleitet. Kleine Abweichungen oder zeitversetzte Änderungen sind deshalb nicht automatisch ein Fehler.',
        'Fehlt ein Messwert, ist das keine gemessene Null. Prüfen Sie den Datenstand und die Gerätezuordnung, bevor Sie aus einer Lücke auf einen ausgefallenen Verbraucher oder fehlende Erzeugung schließen.',
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
        'Am Morgen ist die Solarproduktion noch gering, während bereits Strom verbraucht wird. Mittags kann ein Überschuss entstehen. Am Abend nimmt die Erzeugung ab, der Verbrauch kann aber hoch bleiben. Der Speicher verbindet diese Zeiträume.',
        'Das ist ein vereinfachtes Beispiel, keine Empfehlung für feste Ladezeiten. Wetter, Tarif, Verbrauch, Reserven und das Betriebsmodell können zu einem anderen Verlauf führen.',
      ], diagram: 'day' },
      { id: 'vorausblick', title: 'Die Planung blickt voraus', paragraphs: [
        'Eine Vorhersage schätzt, wie viel PV-Strom und Verbrauch zu erwarten sind. Bei einem passenden Tarif kommen zeitabhängige Preise hinzu. Daraus entsteht ein Fahrplan innerhalb der hinterlegten Speicher- und Anschlussgrenzen.',
        'Ein Speicher muss deshalb nicht jeden Überschuss sofort aufnehmen und nicht bei jedem hohen Preis entladen. Er kann beispielsweise Raum für spätere PV-Erzeugung freihalten oder eine Reserve einhalten. Den konkreten Plan und seine Erläuterungen finden Sie im Fahrplan.',
      ], figure: 'fahrplan' },
      { id: 'nachsehen', title: 'Plan und Ergebnis zusammen lesen', paragraphs: [
        'Im Cockpit sehen Sie den aktuellen Zustand. Im Fahrplan prüfen Sie die geplanten Zeitabschnitte. Unter Messwerte sehen Sie später, was tatsächlich gemessen wurde. Unter Erlöse wird die wirtschaftliche Einordnung dargestellt, soweit die nötigen Daten vorliegen.',
        'Ändern sich Wetter oder Verbrauch, kann sich auch der nächste Fahrplan ändern. Eine frühere Vorhersage ist deshalb kein unveränderliches Versprechen. Vergleichen Sie Zeiträume, Datenstand und Einheiten, bevor Sie eine Abweichung bewerten.',
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
        'Melden Sie sich mit dem für Sie eingerichteten Konto an. Bei der Registrierung verwenden Sie Ihren Namen beziehungsweise Firmennamen, Ihre E-Mail-Adresse und ein Passwort. Nach der Anmeldung führt ein neues Konto in die Einrichtung der ersten Anlage.',
        'Die sichtbaren Anlagen gehören zum angemeldeten Konto. Wenn Sie eine erwartete Anlage nicht sehen, prüfen Sie zunächst, ob Sie das richtige Konto verwenden. Das erneute Anlegen einer bestehenden Anlage löst eine falsche Kontozuordnung nicht.',
      ] },
      { id: 'navigation', title: 'Ein Ort für jede Frage', paragraphs: [
        'Auf dem Rechner stehen die Bereiche in der Seitenleiste. Auf dem Telefon finden Sie innerhalb einer Anlage die verfügbaren Bereiche unten. Der Anlagenname oben dient zum Wechseln, wenn mehrere Anlagen vorhanden sind.',
        'Verlauf und Anlage haben je nach Ausstattung weitere Reiter. Eine reine Ladeanlage kann Ladevorgänge anstelle eines Speicher-Fahrplans zeigen. Auf der Portfolio-Ebene arbeiten Sie mit den Reitern der Übersicht.',
      ], figure: 'orientierung' },
      { id: 'mobil', title: 'Hilfe auf dem Telefon', paragraphs: [
        'Hilfe & Kontakt und Abmelden finden Sie im Konto-Menü hinter Ihrem Avatar. Ein Hilfelink innerhalb einer Ansicht öffnet die passende Erklärung. Auf dem Telefon füllt die Erklärung den Bildschirm; über Schließen gelangen Sie zu Ihrer unveränderten Eingabe zurück.',
        'Wenn Sie Ihr Passwort vergessen haben oder die Anmeldung dauerhaft scheitert, wenden Sie sich an Ihren VoltPilot-Ansprechpartner. Geben Sie niemals Ihr Passwort weiter.',
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
        'Eine Anlage fasst die zusammengehörigen Geräte und Energiedaten an einem Standort zusammen. Der erste Besuch öffnet den Einrichtungsassistenten. Weitere Anlagen legen Sie über Anlage hinzufügen an.',
        'Verwenden Sie einen Namen, den Sie später beim Wechseln sicher erkennen. Prüfen Sie den Standort sorgfältig: Er hilft dabei, passende Wetterdaten und PV-Vorhersagen zuzuordnen.',
      ], figure: 'anlage-anlegen' },
      { id: 'schritte', title: 'Die Einrichtung durchlaufen', paragraphs: [
        'Der Assistent zeigt Ihnen, welcher Schritt gerade offen ist. Angaben, die Sie überspringen, müssen gegebenenfalls später ergänzt werden, bevor alle Funktionen verfügbar sind.',
      ], steps: [
        'Anlage: Namen und Standort erfassen und die Anlage anlegen.',
        'Register: PV- und Speicherdaten über die passende MaStR-Nummer suchen. Die Vorschau prüfen, bevor Sie Werte übernehmen. Falls nötig, den angebotenen manuellen Weg verwenden.',
        'Gerät: die richtige VoltPilot-Geräte-ID mit dieser Anlage verbinden.',
        'Betrieb: den passenden Einsatzzweck und die angebotenen Betriebsmodelle prüfen. Fehlende Voraussetzungen werden direkt angezeigt.',
      ] },
      { id: 'pruefen', title: 'Woran Sie den erfolgreichen Abschluss erkennen', paragraphs: [
        'Die Anlage erscheint im Portal. Nach dem Verbinden sollte die Box Daten liefern; anschließend wird das Cockpit mit Messwerten gefüllt. Eine angelegte Anlage allein bedeutet noch nicht, dass eine Verbindung oder Steuerfreigabe besteht.',
        'Prüfen Sie unter Anlage die übernommenen Geräte und Einstellungen. Besonders Kapazität, Leistungsgrenzen und Tarifangaben sollten zur tatsächlichen Anlage passen. Für Änderungen, die nur VoltPilot vornehmen kann, nennt die Oberfläche den Ansprechpartner.',
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
        'Verwenden Sie die Geräte-ID des vorgesehenen VoltPilot-Geräts. Sie finden sie je nach Gerät auf dem Aufkleber oder in dessen lokaler Web-App. Die ID eines Wechselrichters oder dessen Hersteller-Seriennummer ist nicht automatisch die VoltPilot-Geräte-ID.',
        'Wenn die lokale Einrichtung noch nicht abgeschlossen ist, schließen Sie zunächst den dort angezeigten Einrichtungsweg ab. Im Portal ordnen Sie anschließend die Box Ihrer Anlage zu.',
      ], figure: 'box-verbinden' },
      { id: 'verbinden', title: 'Verbinden und den Eingang kontrollieren', paragraphs: [], steps: [
        'Im Assistenten oder beim Hinzufügen eines VoltPilot-Geräts die gewünschte Anlage prüfen.',
        'Die Geräte-ID vollständig übertragen und verbinden. Beachten Sie die Hinweise direkt am Eingabefeld.',
        'Auf die Rückmeldung warten. Anschließend Geräteverbindung, Zeitpunkt des letzten Kontakts und erste Messwerte prüfen.',
      ], figure: 'box-verbinden-mobil', note: 'Eine bestätigte Zuordnung und eine aktive Datenverbindung sind zwei verschiedene Schritte. „Wartet auf Daten“ ist noch kein gemessener Betriebszustand.' },
      { id: 'fehler', title: 'Wenn die ID nicht angenommen wird', paragraphs: [
        'Bei einer unbekannten ID prüfen Sie jeden Buchstaben und jedes Zeichen anhand der Originalanzeige. Eine bereits mit Ihrem Konto verbundene Box kann weiterhin ihrer bisherigen Anlage zugeordnet sein; prüfen Sie deshalb den angezeigten Standort.',
        'Gehört das Gerät zu einem anderen Konto, wenden Sie sich an VoltPilot. Erfinden Sie keine abgewandelte ID. Wenn die Zuordnung gelingt, aber Daten fehlen, prüfen Sie Stromversorgung und Verbindung der Box sowie die Geräteübersicht.',
      ] },
    ],
    related: ['geraete', 'probleme', 'kontakt'],
  },
];
