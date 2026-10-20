/** Each callout is anchored to a real DOM element, never hand-positioned. */
const plant = (sub = '') => '#/anlage/help-site' + (sub ? '/' + sub : '');
const point = (selector, text) => ({ selector, text });
/** Die Beispielanlage der Steuerung (`e2e/steuerung.*`) lebt am 29.09.2026, 13:10 Uhr. */
const STEUERUNG_UHR = '2026-09-29T11:10:00Z';
export const captures = [
  { id: 'cockpit', title: 'Cockpit: Energie und Zustand', hash: plant(), root: 'main', points: [
    point('main h1', 'Der Anlagenname zeigt, welchen Standort Sie gerade betrachten.'),
    point('.vp-lp-k-pv', 'Die Energieanzeige beschreibt die aktuelle Erzeugung und die weiteren Flüsse.'),
    point('.vp-tl', 'Ein Tipp auf die Tagesleiste zeigt eine andere Viertelstunde, ‹ › gehen je 15 Minuten weiter.'),
    point('.vp-steuer', 'Die Steuerzeile nennt Auftrag, Bestätigung und Wirkung; „Warum?“ öffnet die Gründe.'),
  ] },
  { id: 'orientierung', title: 'Navigation auf dem Rechner', hash: plant(), viewportOnly: true, points: [
    point('.vp-anlagenav', 'Die Bereiche führen zu den täglichen Aufgaben dieser Anlage.'),
    point('[data-testid="seitenleiste-hoch"]', 'Der Eintrag mit „‹“ ganz oben führt eine Ebene höher.'),
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
    point('.dfoot button:has-text("VoltPilot-Box hinzufügen")', 'Das Hinzufügen ordnet die Box zu; die Datenverbindung prüfen Sie anschließend.'),
  ] },
  { id: 'box-verbinden-mobil', title: 'Geräte-ID auf dem Telefon eingeben', query: 'scene=claim', mobile: true, root: '.vp-modal', points: [
    point('input', 'Die Geräte-ID bleibt während der Eingabe sichtbar.'),
    point('[role="combobox"]', 'Die gewählte Anlage bestimmt den Standort der Zuordnung.'),
    point('.dfoot button:has-text("VoltPilot-Box hinzufügen")', 'Die Abschlussaktion bleibt am unteren Rand erreichbar.'),
  ] },
  { id: 'fahrplan', title: 'Fahrplan: der Tag im Bild', hash: plant('fahrplan'), root: 'main', maxHeight: 1500, points: [
    point('.vp-tb-tage', 'Gestern, heute, morgen: der Plan, wie er gestern galt, der von heute und, sobald die Börsenpreise da sind, der für morgen.'),
    point('.vp-tb-jetzt', 'Was der Speicher gerade tut, in Stichworten - und daneben, was als Nächstes kommt, ob er bis zum Abend reicht und was es bringen soll.'),
    point('.vp-tband', 'Oben die Tätigkeiten mit Uhrzeit, darunter der Ladestand - links gemessen, rechts geplant -, unten Sonne und Preis. Mit der Maus zeigt eine Lupe jede Viertelstunde.'),
    point('section[aria-label="Gut zu wissen"]', 'Tarif, Grenzen und Hinweise, mit denen der Plan rechnet. Hier öffnet sich auch das Diagramm mit allen Werten.'),
  ] },
  { id: 'fahrplan-uhr', title: 'Fahrplan am Telefon: die Uhr', hash: plant('fahrplan'), mobile: true, viewportOnly: true, points: [
    point('.vp-tb-tage', 'Hier wechseln Sie zwischen gestern, heute und morgen.'),
    point('.vp-tb-status', 'Was der Speicher gerade tut. Ein Tipp zeigt, warum.'),
    point('.vp-uhr', 'Die Uhr geht wie jede andere. Der Ring zeigt, was ab jetzt kommt.'),
    point('.vp-antw', 'Reicht der Speicher bis zum Abend, und was soll es heute bringen?'),
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
  // Um 5 Uhr früh liegt in der Beispielreihe noch der ganze Tag vor jetzt - mit genug Spanne für drei Stufen.
  { id: 'marktpreise', title: 'Börsenpreis jetzt und in den nächsten Stunden', uhr: '2026-09-10T03:00:00Z', hash: plant('marktpreise'), root: 'main', maxHeight: 1500, points: [
    point('.vp-pz-antwort', 'Oben steht der Börsenpreis jetzt und wie er im Vergleich zu den kommenden Stunden liegt.'),
    point('.vp-pz-kachel', 'Die zwei Kacheln schauen nur nach vorn: die günstigsten und die teuersten zwei Stunden.'),
    point('.vp-pz-bild', 'Die dunkle Linie markiert jetzt. Ein Tipp auf einen Balken zeigt seine Viertelstunde oben.'),
  ] },
  { id: 'wetter', title: 'Wetter und Sonnenstrom', hash: plant('wetter'), root: 'main', points: [
    point('.vp-pz-antwort', 'Oben steht das Wetter jetzt; darunter, was die Anlage gerade und heute erzeugt.'),
    point('.vp-wt-tage', 'Die Karten zeigen die nächsten Tage. Ein Tipp wählt den Tag für das Bild.'),
    point('.vp-pz-bild', 'Gemessen ist gefüllt, erwartet schraffiert; die dunkle Linie markiert jetzt.'),
  ] },
  { id: 'prognose', title: 'Wie gut die Vorhersage zuletzt traf', hash: plant('fahrplan'), root: '[aria-label="Gut zu wissen"]', points: [
    point('h3:has-text("Gut zu wissen")', 'Hier stehen die Angaben, mit denen der Fahrplan rechnet - auch die Vorhersage.'),
    point('text=Treffsicherheit:', 'Die Zeile nennt, wie weit Verbrauch und PV zuletzt im Schnitt je Viertelstunde danebenlagen - in kW, nicht in Prozent.'),
    point('text=Neu geplant:', 'Vorhersagen sind Annahmen; der Fahrplan wird alle 15 Minuten neu gerechnet.'),
  ] },
  { id: 'portfolio', title: 'Anlagen im Portfolio', hash: '#/portfolio', root: 'main', points: [
    point('.vp-ku-status', 'Die Statuszeile sagt, ob alles läuft, und nennt eine Anlage, die Aufmerksamkeit braucht.'),
    point('[aria-label="Heute"]', 'Heute zeigt das Ergebnis des Tages und den Verlauf von Erzeugung und Verbrauch aller Anlagen.'),
    point('[aria-label="Ihre Anlagen"]', 'Jede Anlage steht als Karte und führt mit einem Tipp in die Anlage.'),
  ] },
  { id: 'steuerung', title: 'Betriebsmodelle im Blatt des Speichers', seite: 'steuerung', uhr: STEUERUNG_UHR, hash: plant('steuerung'), root: '.stn-blatt .sheet',
    aktionen: [{ klick: /^Speicher: / }, { klick: /^Marktoptimierung/ }, { zeigen: '.stn-blatt .ok-note' }], points: [
    point('.stn-blatt h3:has-text("Betriebsmodell")', 'Hier wählen Sie das übergeordnete Betriebsziel des Speichers.'),
    point('.stn-blatt .art:has-text("Lastspitzenkappung")', 'Jede Wahl nennt Nutzen und Voraussetzungen; was fehlt, ist nicht wählbar.'),
    point('.stn-blatt .ok-note', 'Vor dem Wechsel stehen die Folgen: welches Modell übernimmt und welches endet.'),
  ] },
  { id: 'steuerung-geraete', title: 'Steuerung: was läuft und wer zuerst dran ist', seite: 'steuerung', uhr: STEUERUNG_UHR, hash: plant('steuerung'), root: '.stn', maxHeight: 1600, points: [
    point('[aria-label="Jetzt"]', 'Oben steht in einem Satz, was läuft und warum, darunter, wohin der Sonnenstrom geht.'),
    point('#devs .dev .rk', 'Die Liste ist die Reihenfolge für Sonnenstrom; ein Tipp auf ein Gerät öffnet Aus, Smart und Ein.'),
    point('.stn button:has-text("Ändern")', 'Mit „Ändern“ verschieben Sie Geräte und Speicher.'),
    point('[aria-label="Tagesbild"]', 'Das Tagesbild zeigt bis jetzt Gemessenes, danach Plan und Erwartung.'),
  ] },
  { id: 'regeln', title: 'Eine Regel im Satzbaukasten', seite: 'steuerung', uhr: STEUERUNG_UHR, hash: plant('regeln'), root: '.stn-blatt .sheet',
    aktionen: [{ klick: /Neue Regel/ }], points: [
    point('[aria-label="Regel als Satz"]', 'Die Regel steht als Satz; jeder Baustein lässt sich antippen und ändern.'),
    point('.stn-blatt >> text=Probelauf', 'Der Probelauf zeigt, wann die Regel heute und morgen greifen würde.'),
    point('.stn-blatt button:has-text("Weiter: Folgen")', 'Vor dem Aktivieren stehen die Folgen, nicht sofort die Aktivierung.'),
  ] },
  { id: 'regeln-mobil', title: 'Der Satzbaukasten auf dem Telefon', seite: 'steuerung', uhr: STEUERUNG_UHR, hash: plant('regeln'), mobile: true, root: '.stn-blatt .sheet',
    aktionen: [{ klick: /Neue Regel/ }], points: [
    point('[aria-label="Regel als Satz"]', 'Auch auf dem Telefon ist die Regel ein Satz aus antippbaren Bausteinen.'),
    point('.stn-blatt .tok.val', 'Ein Tipp auf den Wert öffnet seinen Regler.'),
    point('.stn-blatt button:has-text("Weiter: Folgen")', 'Der nächste Schritt führt zu den Folgen, nicht unmittelbar zur Aktivierung.'),
  ] },
  { id: 'lastspitzen', title: 'Lastspitze und vermiedene Leistung', hash: plant('lastspitzen'), root: 'main', points: [
    point('text=Gehaltene Spitze in diesem Abrechnungsjahr', 'Die gemessene Spitze gehört zur genannten Abrechnungsperiode.'),
    point('text=Vermiedene Spitze', 'Der Vergleich beschreibt die Differenz gegenüber dem dargestellten Betrieb ohne Speicher.'),
    point('main canvas', 'Der Verlauf ordnet die Spitzen über die vorhandenen Perioden ein.'),
  ] },
  { id: 'ladepark', title: 'Laden: Netzanschluss und Ladepunkte', seite: 'steuerung', uhr: STEUERUNG_UHR, hash: plant('laden'), root: '.stn', maxHeight: 1400, points: [
    point('[aria-label="Netzanschluss"]', 'Der Netzanschluss teilt sich auf Haus und Ladepunkte; verteilt wird nur innerhalb der Grenze.'),
    point('[aria-label="Wallbox Werkstatt"] [aria-label="Womit laden"]', 'Je Ladepunkt wählen Sie, womit geladen wird.'),
    point('[aria-label="Ladepunkt Carport"] .lziel', 'Ein Ladeziel sagt, wie viel bis wann geladen sein soll.'),
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
