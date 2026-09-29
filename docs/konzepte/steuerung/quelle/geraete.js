/* Die Beispielanlage „Sonnenhof“ (fiktiv) mit den echten Komponententypen aus
   services/api/src/main/resources/entitytypes/catalog.json. Jedes Gerät trägt den Typ,
   die Anbindung, die Steuerform und seinen Auftrag in der neuen Sprache der Steuerung.
   Viertelstunden zählen ab heute 00:00 (0 … 95 heute, 96 … 191 morgen). */
const GERAETE = [
  {
    id: 'wb', typ: 'wallbox', vorlage: 'Wallbox', name: 'Wallbox Werkstatt', kurz: 'Werkstatt', gruppe: 'laden', icon: 'car',
    anschluss: 'go-e Charger · lokale HTTP-Schnittstelle', form: 'stufenlos', bereiche: [[1.4, 3.7], [4.2, 11]], gemessen: true,
    fahrzeug: { name: 'Kleinwagen', karte: '…07', da: [[32, 68], [128, 164]], bedarfKwh: 16, maxKw: 3.7, phasen: 1 },
    auftrag: { art: 'sonne', modus: 'nur' },
  },
  {
    id: 'lp', typ: 'ev-charger', vorlage: 'Ladepunkt', name: 'Ladepunkt Carport', kurz: 'Carport', gruppe: 'laden', icon: 'car',
    anschluss: 'KEBA P30 · OCPP 1.6', form: 'stufenlos', bereiche: [[4.2, 11]], gemessen: true,
    fahrzeug: { name: 'Familienauto', karte: '…41', da: [[0, 29], [71, 125], [167, 192]], bedarfKwh: 30 },
    auftrag: { art: 'frist', kwh: 30, bis: 124, quelle: 'guenstig' },
  },
  {
    id: 'hs', typ: 'heating-rod', vorlage: 'Heizstab', name: 'Heizstab Warmwasser', kurz: 'Heizstab', gruppe: 'waerme', icon: 'flame',
    anschluss: 'I/O-Modul · drei Schaltausgänge', form: 'stufig', stufen: [1, 2, 3], gemessen: true,
    fuehler: 'Warmwasser-Fühler (Modbus, °C)',
    auftrag: { art: 'sonne', ab: 1 }, ziel: { art: 'temp', grad: 60 },
  },
  {
    id: 'wp', typ: 'heat-pump-sgready', vorlage: 'Wärmepumpe', name: 'Wärmepumpe', kurz: 'Wärmepumpe', gruppe: 'waerme', icon: 'heatpump',
    anschluss: 'I/O-Modul · SG-Ready-Eingang 2', form: 'freigabe', gemessen: false, mehrKw: 1.5,
    auftrag: { art: 'sonne', ab: 2 },
  },
  {
    id: 'pool', typ: 'pump', vorlage: 'Poolpumpe', name: 'Poolpumpe', kurz: 'Pool', gruppe: 'garten', icon: 'waves',
    anschluss: 'Shelly Plus 1PM · misst', form: 'schalten', kw: 0.75, gemessen: true,
    auftrag: { art: 'frist', stunden: 6, von: 24, bis: 80, quelle: 'sonne', taeglich: true },
  },
  {
    id: 'poolwp', typ: 'generic-load', vorlage: 'Pool-Wärmepumpe', name: 'Pool-Wärmepumpe', kurz: 'Poolheizung', gruppe: 'garten', icon: 'thermo',
    anschluss: 'Shelly Plus 1PM · misst', form: 'schalten', kw: 1.2, gemessen: true,
    auftrag: { art: 'sonne', ab: 1.2 }, bedingungen: [{ art: 'nurwenn', text: 'Poolpumpe läuft', geraet: 'pool' }],
  },
  {
    id: 'klima', typ: 'generic-load', vorlage: 'Klimagerät', name: 'Klimagerät Büro', kurz: 'Klima', gruppe: 'haus', icon: 'snow',
    anschluss: 'Shelly Plug S · misst', form: 'schalten', kw: 1.1, gemessen: true,
    auftrag: { art: 'sonne', ab: 1.1 }, bedingungen: [{ art: 'nurwenn', text: 'Außentemperatur über 24 °C', temp: 24 }],
  },
  {
    id: 'wama', typ: 'generic-load', vorlage: 'Waschmaschine', name: 'Waschmaschine', kurz: 'Waschen', gruppe: 'haus', icon: 'washer',
    anschluss: 'Shelly Plug S · misst', form: 'programm', profil: [2.1, 2.0, 0.5, 0.4, 0.3, 0.6, 0.5, 0.3], gemessen: true,
    auftrag: { art: 'frist', stunden: 2, amStueck: true, bis: 68, quelle: 'sonne' },
  },
  {
    id: 'tr', typ: 'generic-load', vorlage: 'Wäschetrockner', name: 'Wäschetrockner', kurz: 'Trockner', gruppe: 'haus', icon: 'wind',
    anschluss: 'Shelly Plug S · misst', form: 'programm', profil: [2.2, 2.2, 2.1, 1.9, 1.6, 1.2, 0.8, 0.4], gemessen: true,
    auftrag: { art: 'frist', stunden: 2, amStueck: true, bis: 78, quelle: 'sonne' }, bedingungen: [{ art: 'danach', text: 'Waschmaschine fertig', geraet: 'wama' }],
  },
  {
    id: 'ir', typ: 'modbus-load', vorlage: 'Infrarotheizung', name: 'Infrarotheizung Werkstatt', kurz: 'Infrarot', gruppe: 'waerme', icon: 'heater',
    anschluss: 'Eigenes Schaltgerät · Modbus TCP', form: 'schalten', kw: 2, gemessen: false,
    auftrag: { art: 'zeiten', von: 26, bis: 34, tage: 'werktags' }, bedingungen: [{ art: 'nurwenn', text: 'Außentemperatur unter 12 °C', tempUnter: 12 }],
  },
];

/* Der Speicher steht in derselben Reihenfolge wie die Geräte (heute: Rangliste mit „Speicher zuerst“). */
const SPEICHER = { id: 'sp', name: 'Speicher Scheune', kwh: 10, kw: 5, soc0: 0.34, reserve: 0.1, modell: 'eigenverbrauch' };

/* Reihenfolge für Sonnenstrom: wer zuerst bekommt. Nur Aufträge mit Sonne nehmen daran teil. */
const REIHENFOLGE = ['sp', 'wb', 'hs', 'wp', 'pool', 'poolwp', 'klima', 'lp', 'wama', 'tr', 'ir'];

/* Regeln in der neuen Sprache: Wenn … dann … (Ausnahmen vom Auftrag). */
const REGELN = [
  { id: 'r1', name: 'Negativpreise mitnehmen', an: true, wenn: [{ v: 'preis', op: 'unter', w: 0 }], dann: { g: 'hs', a: 'voll' }, heute: 0 },
  { id: 'r2', name: 'Bei Frost kein Pool', an: true, wenn: [{ v: 'temp', op: 'unter', w: 3 }], dann: { g: 'pool', a: 'sperren' } },
  { id: 'r3', name: 'Speicher schützen', an: false, wenn: [{ v: 'soc', op: 'unter', w: 20 }], dann: { g: 'klima', a: 'sperren' } },
];

/* Vorlagen für neue Regeln (Rezepte). */
const VORLAGEN = [
  { id: 'v-billig', titel: 'Günstigen Strom nutzen', satz: 'Wenn der Börsenpreis unter 10 ct/kWh liegt, Gerät einschalten.', icon: 'euro', farbe: 'price', wenn: [{ v: 'preis', op: 'unter', w: 10 }], dann: { g: 'hs', a: 'an' } },
  { id: 'v-neg', titel: 'Negativpreise mitnehmen', satz: 'Wenn Strom an der Börse unter null kostet, Heizstab voll einschalten.', icon: 'down', farbe: 'neg', wenn: [{ v: 'preis', op: 'unter', w: 0 }], dann: { g: 'hs', a: 'voll' } },
  { id: 'v-rang', titel: 'Die günstigsten Stunden', satz: 'In den 3 günstigsten Stunden des Tages einschalten.', icon: 'trend', farbe: 'price', wenn: [{ v: 'rang', op: 'unter', w: 3 }], dann: { g: 'wama', a: 'an' } },
  { id: 'v-hitze', titel: 'Nur bei Hitze kühlen', satz: 'Klimagerät nur, wenn es draußen über 24 °C hat.', icon: 'thermo', farbe: 'pv', wenn: [{ v: 'temp', op: 'ueber', w: 24 }], dann: { g: 'klima', a: 'an' } },
  { id: 'v-soc', titel: 'Speicher schützen', satz: 'Wenn der Speicher unter 20 % ist, Gerät sperren.', icon: 'battery', farbe: 'batt', wenn: [{ v: 'soc', op: 'unter', w: 20 }], dann: { g: 'poolwp', a: 'sperren' } },
  { id: 'v-nacht', titel: 'Nachts Ruhe', satz: 'Zwischen 22 und 7 Uhr nie einschalten.', icon: 'moon', farbe: 'navy', wenn: [{ v: 'zeit', op: 'zwischen', w: [88, 28] }], dann: { g: 'pool', a: 'sperren' } },
];

/* Szenen: ein Tipp, mehrere Geräte. Neu. */
const SZENEN = [
  { id: 'urlaub', name: 'Urlaub', icon: 'plane', kurz: 'Warmwasser nur 45 °C, Pool aus', wirkung: { hs: { ziel: 45 }, pool: 'aus', poolwp: 'aus', klima: 'aus', ir: 'aus', wama: 'aus', tr: 'aus' } },
  { id: 'weg', name: 'Unterwegs', icon: 'door', kurz: 'Tagsüber niemand da', wirkung: { klima: 'aus', ir: 'aus' } },
  { id: 'spar', name: 'Sparen', icon: 'leaf', kurz: 'Nur Sonne und günstig', wirkung: { lp: { quelle: 'guenstig' }, wb: { modus: 'nur' } } },
];

/* Gerätevorlagen in der Sprache der Kunden. typ = Komponententyp aus catalog.json.
   status: da = geht heute, teil = Typ da, einzelne Bausteine neu, neu = braucht Neues. */
const KATALOG = [
  { id: 'wallbox', gruppe: 'Laden', icon: 'car', name: 'Wallbox (go-e)', typ: 'wallbox', status: 'teil', kurz: 'stufenlos 1,4–11 kW',
    text: 'Lädt stufenlos; die Box kann zwischen 1- und 3-phasig umschalten, wenn das freigeschaltet ist.',
    kann: ['Laden an/aus', 'Strom 6–16 A', '1-/3-phasig', 'misst Leistung'], nicht: ['Ladestand des Autos'],
    smart: 'Nur Sonne oder Sonne + Minimum; mit Ladeziel „+30 kWh bis 7:00“ auch günstig aus dem Netz.',
    weg: 'Lokale HTTP-Schnittstelle der go-e (API v2). Heute wird sie über den Gerätekatalog zur „Steuerbaren Last“ und fehlt im Ladepark; das Konzept legt sie als Wallbox an.' },
  { id: 'ocpp', gruppe: 'Laden', icon: 'car', name: 'Ladepunkt (OCPP)', typ: 'ev-charger', status: 'da', kurz: 'jede OCPP-1.6-Wallbox',
    text: 'Verbindet sich selbst mit der VoltPilot-Box und erscheint von allein.',
    kann: ['Ladegrenze in kW', 'Pausieren', 'Start/Stopp', 'Ladekarten', 'misst Leistung und Energie'], nicht: ['Phasen umschalten'],
    smart: 'Nur Sonne, Sonne + Minimum oder günstig; Ladeziel +kWh bis Uhrzeit.',
    weg: 'OCPP 1.6J an ws://<Box>:8887/ocpp/<Kennung>; nur freigegebene Ladepunkte dürfen sich verbinden.' },
  { id: 'ebike', gruppe: 'Laden', icon: 'bike', name: 'E-Bike- oder Rollerlader', typ: 'generic-load', status: 'teil', kurz: 'Steckdose mit Messung',
    text: 'Ein Ladegerät an einer schaltbaren Steckdose.', kann: ['ein/aus', 'misst Leistung'], nicht: [],
    smart: 'Mit Sonnenstrom, sonst spätestens bis 7 Uhr fertig (Frist für steuerbare Lasten ist neu).',
    weg: 'Shelly Plug S im WLAN; der Passwortschutz der Shelly-Oberfläche muss aus sein.' },
  { id: 'heizstab', gruppe: 'Wärme und Kälte', icon: 'flame', name: 'Heizstab', typ: 'heating-rod', status: 'teil', kurz: 'Warmwasser oder Puffer',
    text: 'Heizt Wasser mit Strom. Mit Stufen kann er dem Überschuss folgen.',
    kann: ['ein/aus', 'Stufen 1/2/3 kW', 'misst Leistung'], nicht: ['stufenlos (my-PV, Ohmpilot): noch kein Treiber'],
    smart: 'Mit Sonnenstrom bis 60 °C Warmwasser; Negativpreise mitnehmen. Das Temperaturziel ist neu.',
    weg: 'Schütze je Stufe am I/O-Modul oder ein eigenes Modbus-Schaltgerät; Temperatur über einen Modbus-Fühler.' },
  { id: 'wp', gruppe: 'Wärme und Kälte', icon: 'heatpump', name: 'Wärmepumpe (SG-Ready)', typ: 'heat-pump-sgready', status: 'da', kurz: 'Anheben per Kontakt',
    text: 'VoltPilot gibt der Wärmepumpe ein Signal, mehr zu heizen, wenn Strom übrig oder günstig ist.',
    kann: ['Anheben (SG-Ready Zustand 3)'], nicht: ['Sperre (Zustand 1 gehört dem Netzbetreiber)', 'Anlaufbefehl (Zustand 4)', 'Leistung ohne eigenen Zähler'],
    smart: 'Anheben bei Sonne ab 2 kW Überschuss, mindestens 30 Min, danach 20 Min Sperrzeit.',
    weg: 'Relais am I/O-Modul auf den SG-Ready-Eingang 2 der Wärmepumpe.' },
  { id: 'wwwp', gruppe: 'Wärme und Kälte', icon: 'droplet', name: 'Warmwasser-Wärmepumpe', typ: 'heat-pump-sgready', status: 'teil', kurz: 'PV-Kontakt oder Stecker',
    text: 'Viele Geräte haben einen PV-Eingang; sonst über eine Steckdose.', kann: ['Anheben (PV-Kontakt)', 'ein/aus (Stecker)'], nicht: [],
    smart: 'Anheben bei Sonne; einmal die Woche mittags auf 65 °C (Legionellen).', weg: 'PV-Kontakt über einen Schaltausgang, sonst Shelly Plug.' },
  { id: 'infrarot', gruppe: 'Wärme und Kälte', icon: 'heater', name: 'Infrarot- oder Elektroheizung', typ: 'generic-load', status: 'teil', kurz: 'ein/aus',
    text: 'Direkt elektrisch heizen, etwa in Werkstatt oder Bad.', kann: ['ein/aus', 'misst Leistung mit Zähler'], nicht: [],
    smart: 'Werktags 6:30–8:30, nur unter 12 °C draußen. Wetter als Bedingung ist neu.', weg: 'Schaltaktor (Shelly, I/O-Modul) oder eigenes Modbus-Schaltgerät.' },
  { id: 'klima', gruppe: 'Wärme und Kälte', icon: 'snow', name: 'Klimagerät', typ: 'generic-load', status: 'teil', kurz: 'Steckdose oder Kontakt',
    text: 'Kühlt, wenn die Sonne ohnehin scheint.', kann: ['ein/aus', 'misst Leistung'], nicht: ['Solltemperatur einstellen'],
    smart: 'Mit Sonnenstrom, nur über 24 °C draußen.', weg: 'Shelly Plug S oder Freigabekontakt des Geräts.' },
  { id: 'nachtspeicher', gruppe: 'Wärme und Kälte', icon: 'layers', name: 'Nachtspeicherheizung', typ: 'generic-load', status: 'teil', kurz: 'Aufladefreigabe',
    text: 'Lädt Wärme in Steine, wenn Strom günstig ist.', kann: ['Freigabe an/aus'], nicht: [],
    smart: 'In den 4 günstigsten Stunden laden. „Günstigste Stunden“ als Baustein ist neu.', weg: 'Freigabekontakt über das I/O-Modul.' },
  { id: 'wama', gruppe: 'Haushalt', icon: 'washer', name: 'Waschmaschine', typ: 'generic-load', status: 'teil', kurz: 'Programm am Stück',
    text: 'Startvorwahl am Gerät, VoltPilot gibt den Strom frei.', kann: ['Strom freigeben', 'misst Leistung', 'erkennt „fertig“ (neu)'], nicht: ['Programm selbst starten'],
    smart: 'Fertig bis 17:00, Sonne zuerst. Eine Frist für steuerbare Lasten ist neu.', weg: 'Shelly Plug S mit Messung.' },
  { id: 'trockner', gruppe: 'Haushalt', icon: 'wind', name: 'Wäschetrockner', typ: 'generic-load', status: 'neu', kurz: 'nach der Waschmaschine',
    text: 'Startet, wenn die Waschmaschine fertig ist.', kann: ['Strom freigeben', 'misst Leistung'], nicht: [],
    smart: 'Danach: startet nach der Waschmaschine, spätestens fertig 19:30. „Danach“ ist neu.', weg: 'Shelly Plug S mit Messung.' },
  { id: 'spueler', gruppe: 'Haushalt', icon: 'dish', name: 'Spülmaschine', typ: 'generic-load', status: 'teil', kurz: 'Programm am Stück',
    text: 'Läuft über Nacht in den günstigsten Stunden.', kann: ['Strom freigeben', 'misst Leistung'], nicht: [],
    smart: 'Fertig bis 7:00, nur günstige Stunden.', weg: 'Shelly Plug S mit Messung.' },
  { id: 'kuehl', gruppe: 'Haushalt', icon: 'snowflake', name: 'Gefriertruhe', typ: 'generic-load', status: 'neu', kurz: 'vorsichtig schalten',
    text: 'Kann mit Sonne tiefer kühlen und abends kurz ruhen.', kann: ['ein/aus', 'misst Leistung'], nicht: ['lange ausschalten'],
    smart: 'Mit Sonne vorkühlen, höchstens 2 Std am Stück aus. „Höchstens aus“ ist neu.', weg: 'Shelly Plug S; Temperaturfühler empfohlen.' },
  { id: 'pool', gruppe: 'Garten, Pool und Wasser', icon: 'waves', name: 'Poolpumpe', typ: 'pump', status: 'teil', kurz: 'Laufzeit pro Tag',
    text: 'Filtert eine bestimmte Zeit am Tag.', kann: ['ein/aus', 'misst Leistung'], nicht: [],
    smart: '6 Std am Tag zwischen 6 und 20 Uhr, Sonne zuerst. Sonne für Pumpen ist neu.', weg: 'Shelly Plus 1PM im Schaltkasten.' },
  { id: 'poolwp', gruppe: 'Garten, Pool und Wasser', icon: 'thermo', name: 'Pool-Wärmepumpe', typ: 'generic-load', status: 'neu', kurz: 'nur mit Pumpe',
    text: 'Heizt das Becken, darf aber nur laufen, wenn die Pumpe Wasser bewegt.', kann: ['ein/aus', 'misst Leistung'], nicht: [],
    smart: 'Mit Sonnenstrom, nur wenn die Poolpumpe läuft. Ein Gerät als Bedingung ist neu.', weg: 'Shelly Plus 1PM.' },
  { id: 'zirk', gruppe: 'Garten, Pool und Wasser', icon: 'history', name: 'Zirkulationspumpe', typ: 'pump', status: 'da', kurz: 'feste Zeiten',
    text: 'Hält warmes Wasser in der Leitung.', kann: ['ein/aus'], nicht: [], smart: 'Feste Zeiten 6–8 und 18–21 Uhr.', weg: 'Schaltausgang am I/O-Modul.' },
  { id: 'brunnen', gruppe: 'Garten, Pool und Wasser', icon: 'sprout', name: 'Bewässerung oder Brunnenpumpe', typ: 'pump', status: 'teil', kurz: 'früh am Morgen',
    text: 'Gießt, bevor die Sonne hoch steht.', kann: ['ein/aus'], nicht: [], smart: 'Feste Zeit 5:30–6:00, nicht nach Regen. Wetter als Bedingung ist neu.', weg: 'Shelly Plus 1 oder I/O-Modul.' },
  { id: 'ladepark', gruppe: 'Betrieb und Gewerbe', icon: 'car', name: 'Ladepark', typ: 'ev-charger', status: 'da', kurz: 'viele Ladepunkte',
    text: 'Mehrere Ladepunkte an einem Anschluss.', kann: ['faire Verteilung', 'Vorrang-Ladepunkte', 'Rotation', 'Anschluss einhalten'], nicht: [],
    smart: 'Sonne zuerst, Netzanschluss nie überschreiten, Firmenwagen vor Gästen.', weg: 'OCPP-Ladepunkte an der Box; Rahmen im Reiter Laden.' },
  { id: 'kaelte', gruppe: 'Betrieb und Gewerbe', icon: 'snowflake', name: 'Kühlraum oder Kälteanlage', typ: 'modbus-load', status: 'neu', kurz: 'Kälte als Speicher',
    text: 'Mit Sonne tiefer kühlen, bei drohender Lastspitze kurz ruhen.', kann: ['ein/aus oder Sollwert', 'Rücklesen'], nicht: [],
    smart: 'Mit Sonne auf −22 °C, bei Lastspitze bis 20 Min aus. Lastabwurf ist neu.', weg: 'Eigenes Modbus-Schaltgerät mit Watchdog.' },
  { id: 'druckluft', gruppe: 'Betrieb und Gewerbe', icon: 'gauge', name: 'Druckluft-Kompressor', typ: 'modbus-load', status: 'teil', kurz: 'Kessel als Speicher',
    text: 'Füllt den Kessel, wenn Strom da ist.', kann: ['ein/aus', 'Rücklesen'], nicht: [], smart: 'Mit Sonnenstrom; nie während der Lastspitze.', weg: 'Eigenes Modbus-Schaltgerät.' },
  { id: 'lueftung', gruppe: 'Betrieb und Gewerbe', icon: 'fan', name: 'Lüftung', typ: 'modbus-load', status: 'teil', kurz: 'Stufen per Register',
    text: 'Lüftet in Stufen.', kann: ['Sollwert', 'Rücklesen'], nicht: [], smart: 'Feste Zeiten; eine Stufe höher bei Sonne.', weg: 'Modbus-Register mit Sollwert.' },
  { id: 'prozess', gruppe: 'Betrieb und Gewerbe', icon: 'factory', name: 'Prozesswärme', typ: 'heating-rod', status: 'da', kurz: 'großer Heizstab',
    text: 'Heißes Wasser für den Betrieb.', kann: ['ein/aus', 'Stufen'], nicht: [], smart: 'Sonne zuerst, fertig bis Schichtbeginn.', weg: 'Schütze am I/O-Modul.' },
  { id: 'modbus', gruppe: 'Eigenbau und Sonstiges', icon: 'cpu', name: 'Eigenes Schaltgerät (Modbus)', typ: 'modbus-load', status: 'da', kurz: 'Coil oder Register',
    text: 'Alles, was ein Modbus-Register zum Schalten hat.', kann: ['ein/aus oder Sollwert', 'Rücklesen', 'Watchdog'], nicht: [],
    smart: 'Wie jedes Gerät, nach der Freigabe mit 30-Sekunden-Schalttest.', weg: 'Anlage › Aufbau › Selbst anbinden › Steuern freigeben.' },
  { id: 'io', gruppe: 'Eigenbau und Sonstiges', icon: 'plug', name: 'Freier Schaltausgang', typ: 'io-module', status: 'da', kurz: 'Relais am I/O-Modul',
    text: 'Ein Ausgang am Ebyte-M31-Modul, einem Gerät fest zugeordnet.', kann: ['ein/aus'], nicht: ['Messung ohne Zähler'], smart: 'Wie das Gerät dahinter.', weg: 'I/O-Modul im Aufbau, Watchdog vor dem ersten Einschalten.' },
  { id: 'last', gruppe: 'Eigenbau und Sonstiges', icon: 'zap', name: 'Steuerbare Last (allgemein)', typ: 'generic-load', status: 'da', kurz: 'ein/aus, Grenze',
    text: 'Für alles, was keine eigene Vorlage hat.', kann: ['ein/aus', 'Grenze in kW oder %'], nicht: [], smart: 'Mit Sonnenstrom oder günstig.', weg: 'Shelly, I/O-Modul oder Modbus.' },
  { id: 'speicher', gruppe: 'Anlage selbst', icon: 'battery', name: 'Batteriespeicher', typ: 'battery-hybrid', status: 'da', kurz: 'Betriebsmodell',
    text: 'Steht mit in der Reihenfolge und hat ein Betriebsmodell.', kann: ['laden/entladen (Sollwert)', 'Grenze', 'Reserve'], nicht: [],
    smart: 'Eigenverbrauch, Marktoptimierung oder Lastspitzenkappung; Vorrang bis zu einem Ladestand vor den Autos.', weg: 'Hybrid-Wechselrichter im Aufbau.' },
  { id: 'pv', gruppe: 'Anlage selbst', icon: 'sun', name: 'PV-Wechselrichter', typ: 'producer', status: 'da', kurz: 'abregeln',
    text: 'Wird nur gedrosselt, etwa bei negativen Preisen oder einer Einspeisegrenze.', kann: ['Grenze in kW oder %'], nicht: [],
    smart: 'Schutz, keine Regel: Negativpreis-Abregelung und Einspeisegrenze laufen immer mit.', weg: 'Wechselrichter im Aufbau.' },
];
