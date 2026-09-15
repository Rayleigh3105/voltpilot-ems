import { HELP_TEXT } from '../../ebenenNav';
import { GLOSSAR } from '../../glossar';
import type { HelpArticle } from '../model';

export const problemArticles: HelpArticle[] = [
  {
    id: 'probleme', category: 'probleme', title: 'Häufige Probleme eingrenzen',
    summary: 'Fehlende Messwerte, kein Fahrplan oder unerwartetes Verhalten: So gehen Sie vor.',
    keywords: ['Fehler', 'Hilfe', 'Offline', 'Keine Daten', 'Kein Fahrplan', 'Lädt nicht', 'Unbekannte ID', 'Verbindung', 'Störung'],
    sections: [
      { id: 'keine-daten', title: 'Es kommen keine Messwerte an', paragraphs: [
        "Anlagenname, Datenstand und letzten Kontakt prüfen. Danach Stromversorgung, Netzwerk und Box-Zuordnung kontrollieren. Fehlt nur eine Größe, prüfen Sie deren Komponente und Quelle. Fehlend bedeutet nicht null.",
      ], figure: 'box' },
      { id: 'kein-fahrplan', title: 'Es gibt keinen Fahrplan', paragraphs: [
        "Speicherzuordnung, aktuelle Daten, Ladestand und Hinweise unter Steuerung prüfen. Ein fehlender Plan unterscheidet sich von einem vorhandenen Plan ohne Ladeaktion. Notieren Sie Planzeitpunkt und Ursache.",
      ] },
      { id: 'unerwartet', title: 'Der Speicher oder Verbraucher verhält sich anders als erwartet', paragraphs: [
        "Vergleichen Sie Plan und Messwerte zum selben Zeitpunkt. Prüfen Sie Betriebsmodell, Regeln, Reserven und Geräteantwort. Bei Ladepunkten zusätzlich Anschlusszustand, Freigabe und verfügbare Leistung kontrollieren.",
      ] },
      { id: 'zugang', title: 'Eine ID, Ansicht oder Anmeldung funktioniert nicht', paragraphs: [
        "Geräte-ID mit dem Original vergleichen; bei fremder Kontozuordnung hilft VoltPilot. Fehlende Ansichten anhand ihrer Voraussetzungen prüfen. Bei Ladefehlern Erneut laden nutzen, bei vergessenem Passwort den Ansprechpartner kontaktieren.",
      ] },
    ], related: ['box-verbinden', 'fahrplan', 'kontakt'],
  },
  {
    id: 'glossar', category: 'probleme', title: 'Begriffe einfach erklärt',
    summary: 'Die wichtigsten Wörter und Einheiten im Portal – mit Verweisen zu den passenden Erklärungen.',
    keywords: ['Glossar', 'Lexikon', 'SoC', 'kW', 'kWh', 'PV', 'Batterie', 'Akku', 'EMS', 'Fachwörter', ...GLOSSAR.flatMap((entry) => [entry.label, entry.fachwort ?? '', ...entry.synonyms])],
    sections: [
      { id: 'energie', title: 'Energie und Leistung', paragraphs: [
        'PV / Photovoltaik: Erzeugung von elektrischem Strom aus Sonnenlicht. Eigenverbrauch: der Anteil der erzeugten Energie, der an der Anlage selbst genutzt wird. Netzbezug: Strom fließt aus dem Netz zur Anlage. Einspeisung: Strom fließt von der Anlage ins Netz.',
        'kW / Kilowatt: Leistung zu einem Zeitpunkt. kWh / Kilowattstunde: Energiemenge über einen Zeitraum. SoC / Ladestand: Füllstand des Speichers in Prozent. Kapazität: Energiemenge, die ein Speicher aufnehmen kann; die tatsächlich nutzbare Menge hängt auch von seinen Grenzen ab.',
      ] },
      { id: 'planung', title: 'Planung und Steuerung', paragraphs: [
        'Prognose: eine Vorhersage, etwa für Verbrauch oder PV-Produktion. Fahrplan: geplante Aktionen über kommende Zeitabschnitte. Ist-Wert: tatsächlich gemessener Wert. Reserve: Energie beziehungsweise ein Anteil des Speichers, der für eine Aufgabe zurückgehalten wird.',
        'Betriebsmodell: das gewählte übergeordnete Betriebsziel. Regel: eine definierte Aktion unter bestimmten Bedingungen. Entwurf: gespeicherte, noch nicht aktive Regel. Schattenbetrieb: ein Modell wird bewertet, ohne die laufende Planung zu bestimmen.',
      ] },
      { id: 'preise', title: 'Preise und Ergebnisse', paragraphs: [
        'Dynamischer Tarif: ein Tarif mit zeitabhängiger Preisbildung. Day-Ahead-Preis: veröffentlichter Börsenpreis für einen Lieferzeitraum des folgenden Tages. Bezugspreis: Preis für eingekauften Strom gemäß den hinterlegten Bestandteilen.',
        'Erlös: wirtschaftlicher Ertrag einer betrachteten Position. Einsparung: Vorteil gegenüber dem jeweils erläuterten Vergleich. Bestandskonto: Einordnung der im Speicher zurückgehaltenen Energie. Lastspitze: ein hoher Leistungswert im betrachteten Mess- oder Auswertungszeitraum.',
      ] },
      { id: 'technik', title: 'Anlage und Verbindung', paragraphs: [
        'Anlage: der zusammengehörige Standort im Portal. Box: das VoltPilot-Gerät zur Anbindung vor Ort. Komponente: ein im Anlagen-Modell zugeordneter Teil mit bestimmten Mess- oder Steuerfähigkeiten. Messwert: eine konkrete gemessene Größe.',
        'Synchronisation: Übertragung und Abgleich einer Konfiguration. Befehl: eine an ein Gerät gerichtete Aktion. Bestätigung: eine Rückmeldung zu dieser Aktion; sie ist von der später gemessenen Wirkung zu unterscheiden. OCPP: ein Kommunikationsverfahren zur Anbindung von Ladepunkten.',
      ] },
    ], related: ['energiefluesse', 'fahrplan', 'einstellungen'],
  },
  {
    id: 'kontakt', category: 'probleme', title: 'Kontakt und Unterstützung',
    summary: 'Den richtigen Ansprechpartner erreichen und eine Rückfrage gut vorbereiten.',
    keywords: ['Support', 'Kontakt', 'Passwort', 'Zurücksetzen', 'Ansprechpartner', 'Hilfe'],
    sections: [
      { id: 'ansprechpartner', title: 'Ihr direkter Kontakt', paragraphs: [
        HELP_TEXT,
        'Verwenden Sie die Kontaktdaten, die Sie bei der Einrichtung oder im persönlichen Austausch erhalten haben. In diesem Hilfe-Center wird keine Nachricht automatisch versendet.',
      ] },
      { id: 'vorbereiten', title: 'Diese Angaben helfen bei einer Rückfrage', paragraphs: [], steps: [
        'Name der Anlage und des betroffenen Geräts oder Ladepunkts nennen.',
        'Datum, Uhrzeit und den betroffenen Zeitraum angeben.',
        'Beschreiben, was Sie erwartet haben und was stattdessen angezeigt oder gemessen wurde.',
        'Den Wortlaut des Hinweises sowie gegebenenfalls den letzten Kontakt, Planzeitpunkt oder Befehlsstatus notieren.',
        'Wenn hilfreich, einen Screenshot der betreffenden Ansicht mit ihrem Zeitraum vorbereiten. Prüfen Sie vorher, welche persönlichen Angaben darauf sichtbar sind.',
      ] },
      { id: 'konto', title: 'Bei Fragen zum Konto', paragraphs: [
        "Nennen Sie Ihre Konto-E-Mail über den bekannten Kontaktweg. Teilen Sie keine Passwörter oder Anmeldecodes. Beim Zurücksetzen unterstützt Sie VoltPilot; allgemeine Bedienfragen beantwortet auch die Hilfesuche.",
      ] },
    ], related: ['probleme', 'orientierung', 'glossar'],
  },
];
