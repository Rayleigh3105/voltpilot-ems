import { HELP_TEXT } from '../../anlageNav';
import { GLOSSAR } from '../../glossar';
import type { HelpArticle } from '../model';

export const problemArticles: HelpArticle[] = [
  {
    id: 'probleme', category: 'probleme', title: 'Häufige Probleme eingrenzen',
    summary: 'Fehlende Messwerte, kein Fahrplan oder unerwartetes Verhalten: So gehen Sie vor.',
    keywords: ['Fehler', 'Hilfe', 'Offline', 'Keine Daten', 'Kein Fahrplan', 'Lädt nicht', 'Unbekannte ID', 'Verbindung', 'Störung'],
    sections: [
      { id: 'keine-daten', title: 'Es kommen keine Messwerte an', paragraphs: [
        'Prüfen Sie zuerst die geöffnete Anlage und den Datenstand. Bei einem neuen Gerät kann die Zuordnung bereits abgeschlossen sein, während noch keine Daten eintreffen. Bei einem bisher aktiven Gerät zeigt der letzte Kontakt, seit wann die Verbindung fehlt.',
        'Öffnen Sie Box und Gerät. Prüfen Sie die Stromversorgung und die bekannte Netzwerkverbindung vor Ort sowie die im Portal angezeigte Zuordnung. Wenn nur ein Messwert fehlt, prüfen Sie dessen Komponente und Quelle. Ein fehlender Messwert ist keine bestätigte Null.',
      ], figure: 'box' },
      { id: 'kein-fahrplan', title: 'Es gibt keinen Fahrplan', paragraphs: [
        'Prüfen Sie, ob die Anlage einen korrekt zugeordneten Speicher beziehungsweise die Voraussetzungen für diese Ansicht besitzt. Kontrollieren Sie dann die aktuellen Daten, den Ladestand und die Hinweise in Steuerung.',
        'Unterscheiden Sie einen fehlenden Plan von einem vorhandenen Plan ohne Ladeaktion. Notieren Sie bei einer Rückfrage den letzten sichtbaren Erstellungszeitpunkt und die angezeigte Ursache.',
      ] },
      { id: 'unerwartet', title: 'Der Speicher oder Verbraucher verhält sich anders als erwartet', paragraphs: [
        'Vergleichen Sie zuerst denselben Zeitpunkt in Fahrplan und Messwerten. Prüfen Sie anschließend aktives Betriebsmodell, Regeln, Reserven und technische Grenzen. Eine aktive Regel kann auf ihre Bedingung warten.',
        'Eine gesendete Vorgabe kann von der tatsächlichen Wirkung abweichen. Lesen Sie deshalb die Geräte-Rückmeldung und Befehls-Historie. Bei Ladepunkten zusätzlich Anschlusszustand, Freigabe und verfügbare Leistung prüfen.',
      ] },
      { id: 'zugang', title: 'Eine ID, Ansicht oder Anmeldung funktioniert nicht', paragraphs: [
        'Bei einer unbekannten Geräte-ID vergleichen Sie die Eingabe mit dem Aufkleber oder der lokalen Web-App. Bei einer Zuordnung zu einem anderen Konto hilft VoltPilot; eine abgewandelte ID ist kein Ersatz.',
        'Fehlt eine Ansicht, prüfen Sie ihre Voraussetzungen und die Ausstattung der Anlage. Bei einem allgemeinen Ladefehler nutzen Sie Erneut laden. Die Hilfe bleibt unabhängig von den Messdaten erreichbar. Bei einem vergessenen Passwort wenden Sie sich an Ihren Ansprechpartner.',
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
        'Nennen Sie die zum Konto gehörende E-Mail-Adresse über Ihren bekannten Kontaktweg. Teilen Sie niemals Ihr Passwort oder Anmeldecodes. Bei einem vergessenen Passwort unterstützt Sie VoltPilot beim Zurücksetzen.',
        'Für allgemeine Begriffe und die Bedienung können Sie zuerst die Suche dieses Hilfe-Centers nutzen. Die Artikel sind unabhängig von Ihren aktuellen Messdaten verfügbar.',
      ] },
    ], related: ['probleme', 'orientierung', 'glossar'],
  },
];
