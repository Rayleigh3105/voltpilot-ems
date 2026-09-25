import type { HelpArticle } from '../model';

export const plantArticles: HelpArticle[] = [
  {
    id: 'anlagenmodell', category: 'anlage', title: 'Den Aufbau Ihrer Anlage verstehen',
    summary: 'Wie Standort, Anlage, VoltPilot-Box und Geräte zusammengehören.',
    keywords: ['Aufbau', 'Standort', 'Komponente', 'Modell', 'Gerät', 'Box', 'Zuordnung', 'Messwert', 'Hinzufügen'],
    sections: [
      { id: 'ordnung', title: 'Vom Standort bis zum Messwert', paragraphs: [
        "Der Reiter „Aufbau“ zeigt Ihre Anlage als Baum: oben der Standort, darunter seine Anlagen, die VoltPilot-Boxen und die Geräte daran. Ein Gerät kann mehrere Komponenten liefern, etwa Speicher und Netzanschluss. Eine Datenverbindung allein erlaubt noch keine Steuerung.",
      ], figure: 'modell' },
      { id: 'pruefen', title: 'Die eigene Anlage wiedererkennen', paragraphs: [], steps: [
        'Unter Anlage den Reiter „Aufbau“ öffnen und die Namen im Baum prüfen.',
        'Ein Gerät antippen: Der Kurzblick zeigt, was es misst, und führt zur Geräteseite. Gerätetyp und Messgrößen mit der tatsächlichen Installation abgleichen.',
        'Neues über „Hinzufügen“ anlegen: ein Gerät, eine VoltPilot-Box oder eine weitere Anlage. Was die Box schon meldet, steht gestrichelt im Baum und lässt sich übernehmen.',
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
        "Die Einstellungen stehen als kurze Liste in vier Gruppen: Anlage, Strom & Geld, Speicher und Weiteres. Jede Zeile zeigt ihren aktuellen Wert; ein Tippen öffnet das Bearbeiten mit Erklärung und Einheit. Ein Schloss kennzeichnet Werte, die VoltPilot eingerichtet hat.",
      ], figure: 'einstellungen' },
      { id: 'geld', title: 'Bezug und Einspeisung getrennt erfassen', paragraphs: [
        "Bezugstarif und Einspeisevergütung gelten für entgegengesetzte Stromrichtungen. Übertragen Sie Werte aus Ihren Unterlagen mit korrekter Einheit und Tarifart. Falsche Angaben beeinflussen Planung und wirtschaftliche Einordnung.",
      ] },
      { id: 'speichern', title: 'Eine Änderung überprüfen', paragraphs: [
        "Kontrollieren Sie nach dem Speichern den übernommenen Wert und offene Voraussetzungen. Schalter wie „Netzladen“ wirken sofort; die Zeile nennt danach die Folge und bietet „Rückgängig“. Auswirkungen können erst nach neuer Planung oder Übertragung sichtbar werden.",
      ] },
    ], related: ['speicher', 'marktpreise', 'erloese'],
  },
];
