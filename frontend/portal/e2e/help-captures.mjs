/** Each callout is anchored to a real DOM element, never hand-positioned. */
const plant = (sub = '') => '#/anlage/help-site' + (sub ? '/' + sub : '');
const point = (selector, text) => ({ selector, text });
export const captures = [
  { id: 'cockpit', title: 'Cockpit: Energie und Zustand', hash: plant(), root: 'main', points: [
    point('main h1', 'Der Anlagenname zeigt, welchen Standort Sie gerade betrachten.'),
    point('text=PV-Erzeugung', 'Die Energieanzeige beschreibt die aktuelle Erzeugung und die weiteren Flüsse.'),
    point('h2:has-text("Unterm Strich")', 'Das Ergebnis bezieht sich auf den hier gewählten Zeitraum.'),
  ] },
  { id: 'orientierung', title: 'Navigation auf dem Rechner', hash: plant(), viewportOnly: true, points: [
    point('.vp-anlagenav', 'Die Bereiche führen zu den täglichen Aufgaben dieser Anlage.'),
    point('.vp-topbar-anlage', 'Der Anlagenname oben ist zugleich der Anlagenwechsler.'),
    point('.vp-avatar-btn', 'Das Konto-Menü enthält Hilfe & Kontakt, die App-Einrichtung und Abmelden.'),
  ] },
  { id: 'orientierung-mobil', title: 'Navigation auf dem Telefon', hash: plant(), mobile: true, viewportOnly: true, menu: true, points: [
    point('.vp-topbar-anlage', 'Hier erkennen und wechseln Sie die geöffnete Anlage.'),
    point('.vp-avatarmenu-item', 'Hilfe & Kontakt öffnet das vollständige Hilfe-Center.'),
    point('.vp-bottombar', 'Die verfügbaren Bereiche bleiben unten erreichbar.'),
  ] },
  { id: 'anlage-anlegen', title: 'Eine Anlage einrichten', query: 'state=empty', hash: '#/uebersicht', root: 'main', maxHeight: 1400, points: [
    point('.vp-anlage-flow input', 'Geben Sie der Anlage einen wiedererkennbaren Namen.'),
    point('.leaflet-container', 'Der Standort hilft bei der Zuordnung der Wettervorhersage.'),
    point('button:has-text("Weiter")', 'Mit Weiter speichern Sie diesen Schritt und gelangen zu den Registerdaten.'),
  ] },
  { id: 'box-verbinden', title: 'Die Geräte-ID zuordnen', query: 'scene=claim', root: '.vp-modal', points: [
    point('input', 'Übertragen Sie die vollständige VoltPilot-Geräte-ID.'),
    point('[role="combobox"]', 'Prüfen Sie die Anlage, der die Box zugeordnet werden soll.'),
    point('.dfoot button:has-text("Gerät hinzufügen")', 'Das Hinzufügen ordnet die Box zu; die Datenverbindung prüfen Sie anschließend.'),
  ] },
  { id: 'box-verbinden-mobil', title: 'Geräte-ID auf dem Telefon eingeben', query: 'scene=claim', mobile: true, root: '.vp-modal', points: [
    point('input', 'Die Geräte-ID bleibt während der Eingabe sichtbar.'),
    point('[role="combobox"]', 'Die gewählte Anlage bestimmt den Standort der Zuordnung.'),
    point('.dfoot button:has-text("Gerät hinzufügen")', 'Die Abschlussaktion bleibt am unteren Rand erreichbar.'),
  ] },
  { id: 'fahrplan', title: 'Fahrplan: der Tag im Bild', hash: plant('fahrplan'), root: 'main', maxHeight: 1500, points: [
    point('.vp-tb-tage', 'Gestern, heute, morgen: der Plan, wie er gestern galt, der von heute und, sobald die Börsenpreise da sind, der für morgen.'),
    point('.vp-tb-band', 'Das Jetzt-Band: was der Speicher gerade tut, warum, und ob Sie etwas tun müssen.'),
    point('.vp-bf', 'Von oben nach unten: der Preis, der den Plan treibt, Sonne und Verbrauch, der Ladestand als Linie zwischen leer und voll und die Tätigkeit. Mit der Maus zeigt eine Lupe jede Viertelstunde.'),
    point('.vp-antw', 'Die Antworten gelten für die gewählte Viertelstunde. Ein Klick markiert ihre Stelle im Bild.'),
    point('section[aria-label="Worauf Ihr Plan achtet"]', 'Tarif, Grenzen und Hinweise, mit denen der Plan rechnet. Hier öffnet sich auch das Diagramm mit allen Werten.'),
  ] },
  { id: 'fahrplan-uhr', title: 'Fahrplan am Telefon: die Tagesuhr', hash: plant('fahrplan'), mobile: true, viewportOnly: true, klick: 'Beenden', points: [
    point('.vp-tb-tage', 'Hier wechseln Sie zwischen gestern, heute und morgen.'),
    point('.vp-uhr', 'Ein Tag ist ein Kreis: außen Sonne und Strompreis, der breite Ring zeigt, was der Speicher tun soll, innen der Ladestand.'),
    point('.vp-tb-werte', 'Die Werte am Zeiger. Ein Tipp hebt den passenden Ring hervor und erklärt ihn.'),
    point('.vp-antw', 'Ein Tipp auf eine Antwort dreht den Zeiger an ihre Stelle.'),
  ] },
  { id: 'messwerte', title: 'Energie: Zeitraum, Mengen und Verlauf', hash: plant('messwerte'), root: 'main', maxHeight: 1750, points: [
    point('button:has-text("Woche")', 'Wählen Sie den Zeitrahmen passend zu Ihrer Frage.'),
    point('[aria-label^="Energie ·"]', 'Diese Mengen summieren die Energie im gewählten Zeitraum, jede mit ihrem Vergleich.'),
    point('text=Leistung im Tagesverlauf', 'Die Felder teilen eine Zeitachse; jedes hat seine eigene Einheit.'),
  ] },
  { id: 'erloese', title: 'Erlöse: Ergebnis und Abrechnung', hash: plant('erloese'), root: 'main', maxHeight: 1500, points: [
    point('button:has-text("Woche")', 'Der Zeitrahmen gilt für die gezeigte wirtschaftliche Auswertung.'),
    point('[aria-label^="Erlöse ·"]', 'Das Ergebnis steht vorn; daneben die Posten, aus denen es entsteht.'),
    point('section[aria-label="Abrechnung"]', 'Die Abrechnung zeigt je Posten Menge, Durchschnittspreis und Betrag.'),
  ] },
  { id: 'marktpreise', title: 'Börsenpreise im Tagesverlauf', hash: plant('marktpreise'), root: 'main', maxHeight: 1500, points: [
    point('main h1', 'Marktpreise beschreiben die Börse, nicht automatisch Ihren vollständigen Tarif.'),
    point('text=Ø im Zeitraum', 'Die Kennzahl gehört zum ausgewählten Zeitraum und ihrer angegebenen Einheit.'),
    point('main canvas', 'Die Zeitachse zeigt die günstigen und teuren Abschnitte des Tages.'),
  ] },
  { id: 'wetter', title: 'Wetter und erwartete PV-Leistung', hash: plant('wetter'), root: 'main', points: [
    point('main h1', 'Die Vorhersage bezieht sich auf den Standort der geöffneten Anlage.'),
    point('text=erwartete Spitze heute', 'Diese Leistung ist vorhergesagt, nicht bereits gemessen.'),
    point('main canvas', 'Der Verlauf macht die erwarteten Änderungen über den Tag sichtbar.'),
  ] },
  { id: 'prognose', title: 'Wie gut die Vorhersage zuletzt traf', hash: plant('fahrplan'), root: '[aria-label="Worauf Ihr Plan achtet"]', points: [
    point('h3:has-text("Worauf Ihr Plan achtet")', 'Hier stehen die Angaben, mit denen der Fahrplan rechnet - auch die Vorhersage.'),
    point('text=Vorhersage, letzte 7 Tage', 'Die Zeile nennt, wie weit Verbrauch und PV zuletzt im Schnitt je Viertelstunde danebenlagen - in kW, nicht in Prozent.'),
    point('text=Prognosen:', 'Vorhersagen sind Annahmen; der Fahrplan wird laufend neu gerechnet.'),
  ] },
  { id: 'portfolio', title: 'Anlagen im Portfolio', hash: '#/portfolio', root: 'main', points: [
    point('.vp-ku-status', 'Die Statuszeile sagt, ob alles läuft, und nennt eine Anlage, die Aufmerksamkeit braucht.'),
    point('[aria-label="Heute"]', 'Heute zeigt das Ergebnis des Tages und den Verlauf von Erzeugung und Verbrauch aller Anlagen.'),
    point('[aria-label="Ihre Anlagen"]', 'Jede Anlage steht als Karte und führt mit einem Tipp in die Anlage.'),
  ] },
  { id: 'steuerung', title: 'Betriebsmodelle der Anlage', hash: plant('steuerung'), root: '[aria-label="Betriebsmodelle"]', points: [
    point('[aria-label="Betriebsmodelle"] h3', 'Hier wählen Sie das übergeordnete Betriebsziel des Speichers.'),
    point('[aria-label="Betriebsmodelle"] >> text=Marktoptimierung', 'Die Karte erklärt das jeweilige Modell und seine Voraussetzungen.'),
    point('[aria-label="Betriebsmodelle"] >> text=Lastspitzenkappung', 'Vor einem Wechsel lesen Sie die angezeigten Folgen für die aktuelle Betriebsweise.'),
  ] },
  { id: 'regeln', title: 'Eine Regel im Baukasten erstellen', query: 'scene=rule', root: '.vp-modal', points: [
    point('.vp-guided input', 'Ein aussagekräftiger Name hilft beim späteren Wiederfinden der Regel.'),
    point('text=WENN', 'Bedingungen bestimmen, wann die Regel gilt.'),
    point('button:has-text("Weiter zur Prüfung")', 'Prüfen Sie die Zusammenfassung, bevor Sie die Regel aktivieren.'),
  ] },
  { id: 'regeln-mobil', title: 'Der Regelbaukasten auf dem Telefon', query: 'scene=rule', mobile: true, root: '.vp-modal', points: [
    point('.vp-guided input', 'Auch auf dem Telefon wird die Regel über dieselben Eingaben erstellt.'),
    point('text=WENN', 'Die Bedingungen stehen vor der auszuführenden Aktion.'),
    point('button:has-text("Weiter zur Prüfung")', 'Der nächste Schritt führt zur Prüfung, nicht unmittelbar zur Aktivierung.'),
  ] },
  { id: 'lastspitzen', title: 'Lastspitze und vermiedene Leistung', hash: plant('lastspitzen'), root: 'main', points: [
    point('text=Gehaltene Spitze in diesem Abrechnungsjahr', 'Die gemessene Spitze gehört zur genannten Abrechnungsperiode.'),
    point('text=Vermiedene Spitze', 'Der Vergleich beschreibt die Differenz gegenüber dem dargestellten Betrieb ohne Speicher.'),
    point('main canvas', 'Der Verlauf ordnet die Spitzen über die vorhandenen Perioden ein.'),
  ] },
  { id: 'ladepark', title: 'Der Ladepark-Rahmen', hash: plant('steuerung'), root: '.vp-ladepark', points: [
    point('.vp-ladepark h4:has-text("Ladepark-Rahmen")', 'Der Rahmen beschreibt die Grenzen, innerhalb derer das Lastmanagement verteilt.'),
    point('.vp-ladepark input', 'Die Anschlussgrenze muss zur tatsächlichen Installation passen.'),
    point('.vp-ladepark-rahmen', 'Die weiteren Werte zeigen die Rückmeldung der Box; nur hinterlegte Werte werden ausdrücklich so bezeichnet.'),
  ] },
  { id: 'ladevorgaenge', title: 'Aktuelle Ladeleistung und Ladevorgänge', hash: plant('ladevorgaenge'), root: 'main', points: [
    point('h2:has-text("Ladeleistung")', 'Das Budget setzt Gebäude, Laden und Anschlussgrenze in Beziehung.'),
    point('h2:has-text("Ladevorgänge")', 'Jeder Anschluss nennt seinen aktuellen Zustand und den Grund.'),
    point('h2:has-text("Ladesäulen")', 'Über die jeweilige Geräteseite gelangen Sie zu weiteren Details.'),
  ] },
  { id: 'modell', title: 'Aufbau: Anlagen, Boxen und Geräte', hash: plant('modell'), root: 'main', maxHeight: 1400, points: [
    point('.vp-auf-suche', 'Die Suche findet Namen, Modelle und Kennungen; die Filter daneben grenzen nach Art, Zustand, Box und Hersteller ein.'),
    point('.vp-auf-t-zeile.is-box', 'Die VoltPilot-Box verbindet die Geräte darunter mit VoltPilot.'),
    point('[data-aufbau-geraet]', 'Ein Tippen auf ein Gerät öffnet den Kurzblick mit allen Werten.'),
    point('.vp-auf-neu-haupt', '„Gerät hinzufügen“ öffnet den Gerätekatalog; im Menü daneben legen Sie eine Box oder Anlage an.'),
  ] },
  { id: 'geraet-hinzufuegen', title: 'Gerät hinzufügen: der Gerätekatalog', hash: plant('modell'), root: '.vp-modal',
    aktionen: [{ klick: 'Gerät hinzufügen' }], points: [
    point('.vp-kat-suche', 'Suchen Sie nach Marke oder Modell, so wie es auf dem Typenschild steht.'),
    point('.vp-kat-arten', 'Die Arten grenzen den Katalog ein. Unter „Zähler“ steht, wie Sie ohne eigene Zähler-Vorlage am Hausanschluss messen.'),
    point('.vp-kat-eintrag.is-marke', 'Ohne Suche führt der Weg über die Marke zum Modell.'),
    point('.vp-kat-eintrag.is-weg', 'Geräte ohne Vorlage, etwa eine Ladesäule mit OCPP, stehen als eigene Einträge.'),
  ] },
  { id: 'geraet-einrichten', title: 'Gerät einrichten: eine Seite mit Test', hash: plant('modell'), root: '.vp-modal',
    aktionen: [
      { klick: 'Gerät hinzufügen' },
      { fuellen: ['Katalog durchsuchen', '12k'] },
      { klick: /SUN-12K/ },
      { fuellen: ['IP-Adresse des Datenloggers', '192.168.178.28'] },
      { fuellen: ['Datenlogger-Seriennummer', '2712345678'] },
      { warten: 'text=Diese Messwerte kommen gerade an' },
      { zeigen: '.vp-assist-test' },
    ], points: [
    point('.vp-assist-test', 'Der Test läuft von selbst, sobald der Anschluss vollständig ist, und zeigt echte Werte.'),
    point('#anlegen-name', 'Der Name ist frei wählbar; leer lassen ist in Ordnung.'),
    point('[data-testid="einrichten-speichern"]', 'Gespeichert wird erst mit echten Werten. Solange etwas fehlt, steht der Grund daneben.'),
  ] },
  { id: 'box', title: 'Verbindung und Zustand der Box', hash: plant('box/VP-DEMO-0001'), root: 'main', points: [
    point('main h1', 'Prüfen Sie Namen und Geräte-ID der Box.'),
    point('[data-testid="geraet-zustand"]', 'Der Punkt neben dem Namen zeigt die Verbindung und wie alt der letzte Kontakt ist.'),
    point('[data-testid="baustein-aktivitaet"] h2', 'Die Aktivität unterscheidet Aktionen und ihre Rückmeldungen.'),
  ] },
  { id: 'geraete', title: 'Gerät und Rückmeldungen', hash: plant('geraet/VP-DEMO-0001/inverter'), root: 'main', points: [
    point('main h1', 'Diese Ansicht gehört zum einzelnen Gerät hinter der Box.'),
    point('.vp-buehne-zahlzeile', 'Der Ladestand ist eine Messgröße; die Einheit steht direkt am Wert.'),
    point('[data-testid="baustein-aktivitaet"] h2', 'Gesendete Befehle und ihre Rückmeldung helfen bei der Prüfung der Wirkung.'),
  ] },
  { id: 'einstellungen', title: 'Einstellungen der Anlage', hash: plant('technik'), root: 'main', points: [
    point('#technik-anlage h3', 'Jede Zeile zeigt ihren aktuellen Wert; ein Tippen öffnet das Bearbeiten.'),
    point('[role="switch"]', 'Einfache Schalter wirken sofort und lassen sich rückgängig machen.'),
    point('#technik-speicher h3', 'Beim Speicher stehen Kapazität und der Umgang mit dem Speicher.'),
  ] },
];
