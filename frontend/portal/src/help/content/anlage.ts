import type { HelpArticle } from '../model';

export const plantArticles: HelpArticle[] = [
  {
    id: 'anlagenmodell', category: 'anlage', title: 'Den Aufbau Ihrer Anlage verstehen',
    summary: 'Wie Anlage, VoltPilot-Box und Geräte zusammengehören und wie Sie ein Gerät hinzufügen.',
    keywords: ['Aufbau', 'Standort', 'Komponente', 'Modell', 'Gerät', 'Box', 'Zuordnung', 'Messwert', 'Hinzufügen', 'Katalog', 'Suche', 'Filter', 'Modbus', 'Ladesäule', 'Batterie'],
    sections: [
      { id: 'ordnung', title: 'Von der Anlage bis zum Messwert', paragraphs: [
        "Der Reiter „Aufbau“ zeigt Ihre Anlage als Tabelle: die Anlage, ihre VoltPilot-Boxen und die Geräte daran, jedes mit Art, Zustand und Wert. Die Suche findet Namen, Modelle und Kennungen; die Filter grenzen nach Art, Zustand, Box und Hersteller ein. Ein Gerät kann mehrere Komponenten liefern, etwa Speicher und Netzanschluss. Eine Datenverbindung allein erlaubt noch keine Steuerung.",
      ], figure: 'modell' },
      { id: 'pruefen', title: 'Die eigene Anlage wiedererkennen', paragraphs: [], steps: [
        'Unter Anlage den Reiter „Aufbau“ öffnen und die Namen in der Tabelle prüfen.',
        'Ein Gerät antippen: Der Kurzblick zeigt, was es misst, und führt zur Geräteseite. Gerätetyp und Messgrößen mit der tatsächlichen Installation abgleichen.',
        'Was die Box schon meldet, steht gestrichelt in der Tabelle und lässt sich übernehmen.',
      ] },
      { id: 'hinzufuegen', title: 'Ein Gerät hinzufügen', paragraphs: [
        "Ohne passende Vorlage stehen Ladesäulen mit OCPP, Batterien mit eigenem BMS und Modbus-Geräte als eigene Einträge im Katalog. Eine VoltPilot-Box oder eine weitere Anlage legen Sie über das Menü neben „Gerät hinzufügen“ an.",
      ], steps: [
        '„Gerät hinzufügen“ öffnet den Gerätekatalog. Suchen Sie nach Marke oder Modell, so wie es auf dem Typenschild steht, oder wählen Sie über Art und Marke.',
        'Nach der Wahl öffnet die Einrichten-Seite. Tragen Sie den Anschluss ein; die Box testet dann von selbst und zeigt echte Werte.',
        'Mit echten Werten geht „Speichern“. Danach springt der Aufbau auf das neue Gerät.',
      ], figure: 'geraet-hinzufuegen' },
      { id: 'einrichten', title: 'Die Einrichten-Seite lesen', paragraphs: [
        "Die Leiste links zeigt, was fertig ist, was jetzt dran ist und was danach kommt. Solange etwas fehlt, steht der Grund neben „Speichern“. Ein Test ohne gültige Werte speichert nichts; die Hinweise darunter nennen, was Sie prüfen können.",
      ], figure: 'geraet-einrichten' },
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
