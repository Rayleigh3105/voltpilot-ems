import type { HelpArticle } from '../model';

export const plantArticles: HelpArticle[] = [
  {
    id: 'anlagenmodell', category: 'anlage', title: 'Das Anlagen-Modell verstehen',
    summary: 'Wie Box, Geräte, Komponenten und Messwerte zusammengehören.',
    keywords: ['Komponente', 'Modell', 'Topologie', 'Gerät', 'Zuordnung', 'Messwert'],
    sections: [
      { id: 'ordnung', title: 'Vom Standort bis zum Messwert', paragraphs: [
        "Die Anlage ist Ihr Standort, die Box verbindet dessen Geräte. Komponenten ordnen Mess- und Steuerfähigkeiten zu; ein Gerät kann mehrere liefern. Eine Datenverbindung allein erlaubt noch keine Steuerung.",
      ], figure: 'modell' },
      { id: 'pruefen', title: 'Die eigene Anlage wiedererkennen', paragraphs: [], steps: [
        'Unter Anlage die Komponentenübersicht öffnen und die angezeigten Namen prüfen.',
        'Bei einer unklaren Zuordnung das Gerät beziehungsweise die Box öffnen. Gerätetyp und vorhandene Messgrößen mit der tatsächlichen Installation abgleichen.',
        'Beim Hinzufügen oder Bearbeiten das passende Modell und den angebotenen Verbindungsweg wählen. Anschließend den Synchronisationszustand und die eingehenden Werte prüfen.',
      ] },
      { id: 'unvollstaendig', title: 'Wenn das Modell unvollständig ist', paragraphs: [
        "Fehlende Komponenten oder Zuordnungen können Werte und Ansichten unvollständig machen. Prüfen Sie vorhandene Einträge, Synchronisation und Messwerte, bevor Sie ein Gerät erneut hinzufügen.",
      ] },
    ], related: ['geraete', 'box-verbinden', 'probleme'],
  },
  {
    id: 'geraete', category: 'anlage', title: 'Box, Geräte und Befehle prüfen',
    summary: 'Verbindung, Konfiguration und die tatsächliche Wirkung einer Aktion auseinanderhalten.',
    keywords: ['Offline', 'Online', 'Wechselrichter', 'Gerät', 'Box', 'Befehl', 'Verbindung', 'Synchronisation', 'Rückmeldung'],
    sections: [
      { id: 'box', title: 'Die Box ist der Verbindungsweg', paragraphs: [
        "Prüfen Sie auf der Box-Seite letzten Kontakt und Verbindung. Eine erreichbare Box garantiert keine Messung von jedem angeschlossenen Gerät. Öffnen Sie für Details die jeweilige Geräteseite.",
      ], figure: 'box' },
      { id: 'aenderung', title: 'Gespeichert, übertragen, wirksam', paragraphs: [
        "Gespeichert, übertragen und wirksam sind unterschiedliche Zustände. Prüfen Sie Synchronisation und Rückmeldung. Verbindungsdaten müssen zur Installation passen; beim Entfernen zählt der im Dialog beschriebene Umfang.",
      ], diagram: 'proof', figure: 'geraete' },
      { id: 'befehle', title: 'Die Befehls-Historie lesen', paragraphs: [
        "Öffnen Sie die Befehls-Historie am Gerät und prüfen Sie Zeitpunkt, Aktion und Rückmeldung. Ein Timeout ist kein bestätigter Erfolg. Kontrollieren Sie den Zustand, bevor Sie eine verzögert angezeigte Aktion wiederholen.",
      ] },
    ], related: ['anlagenmodell', 'probleme', 'kontakt'],
  },
  {
    id: 'einstellungen', category: 'anlage', title: 'Einstellungen und Tarife verstehen',
    summary: 'Die Angaben, auf denen Darstellung und Planung Ihrer Anlage beruhen.',
    keywords: ['Tarif', 'Strompreis', 'Vergütung', 'Anzulegender Wert', 'Bezugspreis', 'Netzladen', 'Standort', 'Kapazität', 'Einstellungen'],
    sections: [
      { id: 'finden', title: 'Mit der gesuchten Größe beginnen', paragraphs: [
        "Prüfen Sie den Anlagennamen und suchen Sie nach der gewünschten Einstellung. Feldbeschreibung und Einheit erklären die Eingabe. Die Ansicht zeigt auch, welche Werte VoltPilot verwaltet.",
      ], figure: 'einstellungen' },
      { id: 'geld', title: 'Bezug und Einspeisung getrennt erfassen', paragraphs: [
        "Bezugstarif und Einspeisevergütung gelten für entgegengesetzte Stromrichtungen. Übertragen Sie Werte aus Ihren Unterlagen mit korrekter Einheit und Tarifart. Falsche Angaben beeinflussen Planung und wirtschaftliche Einordnung.",
      ] },
      { id: 'speichern', title: 'Eine Änderung überprüfen', paragraphs: [
        "Kontrollieren Sie nach dem Speichern den übernommenen Wert und offene Voraussetzungen. Auswirkungen können erst nach neuer Planung oder Übertragung sichtbar werden. Bei unklaren Angaben nutzen Sie Feldhilfe und Ansprechpartner.",
      ] },
    ], related: ['speicher', 'marktpreise', 'erloese'],
  },
  {
    id: 'standort-zuordnung-korrigieren', category: 'anlage', title: 'Standort-Zuordnung korrigieren',
    summary: 'Eine falsche erste Zuordnung berichtigen, ohne Messwerte oder Steuerung zu verändern.',
    keywords: ['Standort', 'Zuordnung', 'korrigieren', 'rückwirkend', 'umziehen', 'archivieren'],
    sections: [
      { id: 'korrigieren-oder-umziehen', title: 'Korrigieren oder umziehen?', paragraphs: [
        'War die Anlage seit ihrem ersten Tag dem falschen Standort zugeordnet, wählen Sie „Zuordnung korrigieren“. Zieht die Anlage erst jetzt um, verwenden Sie weiterhin „Anderem Standort zuordnen“ und den tatsächlichen Umzugstag.',
      ] },
      { id: 'folgen-pruefen', title: 'Folgen vor dem Speichern prüfen', paragraphs: [
        'Bei der Korrektur ist „Gültig ab“ mit dem ersten Tag der Anlage vorbelegt. Sie können den Tag ändern. Die Vorschau zeigt, welche Zuordnungszeiträume rückwirkend geändert werden.',
        'Steuerung und Messwerte bleiben unberührt. Auch die Teilnahme der Anlage an ihren Funktionen bleibt bestehen.',
      ] },
      { id: 'alter-standort', title: 'Den bisherigen Standort erhalten oder archivieren', paragraphs: [
        'Es gibt keinen Zustand „wieder nicht zugeordnet“: Die Anlage gehört nach der Korrektur zu ihrem richtigen Standort.',
        'Ist der bisherige Standort danach leer, können Sie ihn archivieren. Dabei wird nichts gelöscht; seine Geschichte bleibt erhalten.',
      ] },
    ], related: ['einstellungen', 'anlagenmodell', 'probleme'],
  },
];
