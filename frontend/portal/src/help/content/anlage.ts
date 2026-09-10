import type { HelpArticle } from '../model';

export const plantArticles: HelpArticle[] = [
  {
    id: 'anlagenmodell', category: 'anlage', title: 'Das Anlagen-Modell verstehen',
    summary: 'Wie Box, Geräte, Komponenten und Messwerte zusammengehören.',
    keywords: ['Komponente', 'Modell', 'Topologie', 'Gerät', 'Zuordnung', 'Messwert'],
    sections: [
      { id: 'ordnung', title: 'Vom Standort bis zum Messwert', paragraphs: [
        'Die Anlage beschreibt Ihren Standort. Die Box verbindet dessen Geräte mit VoltPilot. Ein Gerät kann mehrere Aufgaben und Messgrößen liefern, zum Beispiel PV-Leistung und Speicherladestand. Das Anlagen-Modell ordnet diese Informationen zu.',
        'Diese Zuordnung bestimmt mit, welche Darstellungen und Steuerungsmöglichkeiten das Portal sinnvoll anbieten kann. Ein Gerät mit einer Datenverbindung besitzt dadurch noch nicht automatisch jede mögliche Steuerfähigkeit.',
      ], figure: 'modell' },
      { id: 'pruefen', title: 'Die eigene Anlage wiedererkennen', paragraphs: [], steps: [
        'Unter Anlage die Komponentenübersicht öffnen und die angezeigten Namen prüfen.',
        'Bei einer unklaren Zuordnung das Gerät beziehungsweise die Box öffnen. Gerätetyp und vorhandene Messgrößen mit der tatsächlichen Installation abgleichen.',
        'Beim Hinzufügen oder Bearbeiten das passende Modell und den angebotenen Verbindungsweg wählen. Anschließend den Synchronisationszustand und die eingehenden Werte prüfen.',
      ] },
      { id: 'unvollstaendig', title: 'Wenn das Modell unvollständig ist', paragraphs: [
        'Fehlt eine Komponente oder ihre Zuordnung, kann ein Gesamtwert unvollständig sein oder eine Ansicht fehlen. Prüfen Sie zunächst die vorhandenen Einträge, bevor Sie ein Gerät ein zweites Mal hinzufügen.',
        'Eine gespeicherte Änderung muss gegebenenfalls noch an der Box ankommen. Achten Sie auf Rückmeldungen wie ausstehende Synchronisation und auf die tatsächlichen Messwerte. Bei einer unklaren technischen Zuordnung hilft Ihr VoltPilot-Ansprechpartner.',
      ] },
    ], related: ['geraete', 'box-verbinden', 'probleme'],
  },
  {
    id: 'geraete', category: 'anlage', title: 'Box, Geräte und Befehle prüfen',
    summary: 'Verbindung, Konfiguration und die tatsächliche Wirkung einer Aktion auseinanderhalten.',
    keywords: ['Offline', 'Online', 'Wechselrichter', 'Gerät', 'Box', 'Befehl', 'Verbindung', 'Synchronisation', 'Rückmeldung'],
    sections: [
      { id: 'box', title: 'Die Box ist der Verbindungsweg', paragraphs: [
        'Die Box-Seite beschreibt das VoltPilot-Gerät, das die Anlage anbindet. Prüfen Sie den letzten Kontakt und die angebotenen Informationen zur Verbindung. Eine erreichbare Box bedeutet nicht automatisch, dass jedes angeschlossene Gerät ebenfalls Daten liefert.',
        'Öffnen Sie für einen einzelnen Wechselrichter, Zähler oder Ladepunkt die zugehörige Geräteseite. Dort finden Sie die jeweils gemeldeten Daten und die dafür angebotenen Einstellungen.',
      ], figure: 'box' },
      { id: 'aenderung', title: 'Gespeichert, übertragen, wirksam', paragraphs: [
        'Bei Konfigurationsänderungen sind mehrere Schritte zu unterscheiden: Das Portal nimmt die Änderung an, die Box erhält sie und das Gerät muss sie umsetzen können. Prüfen Sie daher den Synchronisationszustand und anschließend die Rückmeldung.',
        'Ein neuer Name kann die Orientierung erleichtern. Verbindungsparameter und Gerätetyp müssen dagegen zur tatsächlichen Installation passen. Lesen Sie beim Löschen oder Entfernen ausdrücklich den beschriebenen Umfang.',
      ], figure: 'geraete' },
      { id: 'befehle', title: 'Die Befehls-Historie lesen', paragraphs: [
        'Die Befehls-Historie erreichen Sie über das jeweilige Gerät. Ein gesendeter Befehl, eine Bestätigung und eine gemessene Wirkung sind unterschiedliche Nachweise. Ein Zeitablauf ohne Bestätigung sollte nicht als erfolgreicher Abschluss gelesen werden.',
        'Prüfen Sie Gerät, Zeitpunkt, Aktion und Rückmeldung zusammen. Wiederholen Sie eine Aktion nicht allein deshalb, weil eine Anzeige kurz verzögert reagiert. Nutzen Sie zuerst die vorhandenen Zustands- und Verlaufsinformationen.',
      ] },
    ], related: ['anlagenmodell', 'probleme', 'kontakt'],
  },
  {
    id: 'einstellungen', category: 'anlage', title: 'Einstellungen und Tarife verstehen',
    summary: 'Die Angaben, auf denen Darstellung und Planung Ihrer Anlage beruhen.',
    keywords: ['Tarif', 'Strompreis', 'Vergütung', 'Anzulegender Wert', 'Bezugspreis', 'Netzladen', 'Standort', 'Kapazität', 'Einstellungen'],
    sections: [
      { id: 'finden', title: 'Mit der gesuchten Größe beginnen', paragraphs: [
        'Die Einstellungen gehören zur geöffneten Anlage. Prüfen Sie zunächst deren Namen. Die Gruppen und die Einstellungssuche helfen, Angaben wie Strompreis, Reserve oder Standort zu finden.',
        'Die Ansicht zeigt, welche Werte bearbeitbar sind und welche durch VoltPilot gepflegt werden. Lesen Sie die Erklärung am Feld und dessen Einheit, bevor Sie eine Zahl übertragen.',
      ], figure: 'einstellungen' },
      { id: 'geld', title: 'Bezug und Einspeisung getrennt erfassen', paragraphs: [
        'Der Bezugstarif beschreibt, was eingekaufter Strom kostet. Die Vergütungsangaben beschreiben die andere Richtung, also eingespeisten Strom. Ein Börsenpreis ist nicht automatisch identisch mit einem vollständigen Bezugspreis oder einem vertraglichen Vergütungswert.',
        'Übertragen Sie Angaben anhand Ihrer Unterlagen in die dafür vorgesehenen Felder. Prüfen Sie besonders Einheiten und die Art des Tarifs. Eine falsche Preisangabe kann zu einer unpassenden wirtschaftlichen Einordnung und Planung führen.',
      ] },
      { id: 'speichern', title: 'Eine Änderung überprüfen', paragraphs: [
        'Nach dem Speichern muss die Ansicht den übernommenen Wert bestätigen. Prüfen Sie Hinweise auf noch fehlende Angaben oder technische Voraussetzungen. Ein geänderter Parameter kann sich erst mit der nächsten passenden Planung oder Übertragung auf den Betrieb auswirken.',
        'Wenn Ihnen die Bedeutung eines Werts oder seine Zuständigkeit unklar ist, nutzen Sie die Erklärung und Ihren VoltPilot-Kontakt. Die Hilfe gibt keine pauschalen empfohlenen Leistungs-, Reserve- oder Tarifwerte vor.',
      ] },
    ], related: ['speicher', 'marktpreise', 'erloese'],
  },
];
