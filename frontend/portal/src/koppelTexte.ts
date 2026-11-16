/**
 * Der Wortlaut der Seiten nach dem Scan des Gehäuse-QR (Konzept vp-qr-einstieg, Abschnitt 4,
 * Attrappen M1 bis M12; entschieden 04.11.2026: QE-1 A, QE-2 A, QE-3 B, QE-4 A, QE-5 A).
 *
 * Liegt NICHT im Einstieg (Bündel-Wächter `test/bundle-smoke.sh`): die Anmeldekarte braucht nur den
 * Bandtext, der darum in `koppelBandText.ts` wohnt und hier weitergereicht wird.
 *
 * Grundregeln: Vor der Anmeldung steht hier nur, was im Code steht (die Kennung), nie, ob es die Box
 * gibt, wem sie gehört oder ob sie online ist. „meldet sich“ nur bei echtem Lebenszeichen.
 * Wörter: „VoltPilot-Box“/„Box“, „Kennung“, „verbinden“ (nie „koppeln“, „claim“, „Edge“).
 */

/** M1 · Empfang „Ihre VoltPilot-Box ist da“ (öffentlich, nur ohne Sitzung). */
export const EMPFANG = {
  kicker: 'VoltPilot-Box',
  titel: 'Ihre VoltPilot-Box ist da',
  einleitung:
    'Die Box verbindet Ihren Wechselrichter, Speicher und Zähler mit dem VoltPilot-Portal. Sie liest die Werte vor Ort und schickt sie verschlüsselt zu uns.',
  kennungTitel: 'Kennung aus dem QR-Code',
  kennungZeile: 'Steht auch unten auf Ihrer Box.',
  schritteTitel: 'So geht es weiter',
  schritte: [
    { titel: 'Konto erstellen oder anmelden', zeile: 'Dauert etwa eine Minute.' },
    { titel: 'Adresse Ihrer Anlage eintragen', zeile: 'Entfällt, wenn Ihr Konto schon eine Anlage hat.' },
    { titel: 'Box verbinden', zeile: 'Die Kennung ist schon eingetragen. Sie bestätigen nur noch.' },
  ],
  bereitTitel: 'Das halten Sie bereit',
  bereit: [
    'Ihre E-Mail-Adresse und ein Passwort mit mindestens 12 Zeichen',
    'Die Adresse, an der die Anlage steht',
    'Die Box mit Netzteil. Mit Netzwerkkabel zum Router oder über WLAN - Sie wählen es beim Verbinden. '
      + 'Einstecken können Sie sie auch später.',
  ],
  kontoErstellen: 'Konto erstellen',
  schonKonto: 'Ich habe schon ein Konto',
  zusage: 'Verbunden wird erst, wenn Sie es bestätigen. Vor der Anmeldung zeigen wir hier nur, was im Code steht.',
  amComputer: 'Lieber am Computer? Öffnen Sie portal.voltpilot.de und geben Sie die Kennung dort ein.',
} as const;

/** M2 · Code nicht lesbar (öffentlich, falsches Prüfzeichen im Link). */
export const UNLESBAR = {
  titel: 'Dieser Code ist nicht vollständig lesbar',
  erklaerung:
    'Das passiert, wenn die Kamera unscharf war oder der Druck beschädigt ist. Die Kennung steht auch in Klarschrift unten auf Ihrer Box, unter dem QR-Code.',
  feldHinweis: '„EDGE-“ und sieben Zeichen. 0, 1, I, L und O kommen nicht vor.',
  weiter: 'Weiter',
  ohneBox: 'Ohne Box weiter zur Anmeldung',
  zeichnung: 'Unterseite der Box (Zeichnung)',
} as const;

import { FELD_AUS_QR } from './koppelBandText';

export { bandText } from './koppelBandText';

/** M6 · Assistent Schritt 2 mit der Kennung aus dem QR-Code. */
export const SCHRITT_BOX = {
  ausQr: 'Die Kennung ist schon eingetragen, aus dem QR-Code. Vergleichen Sie sie mit dem Aufdruck unten auf der Box.',
  ohneQr: 'Tragen Sie die Kennung Ihrer Box ein. Sie steht unten auf der Box: „EDGE-“ und sieben Zeichen.',
  feldAusQr: FELD_AUS_QR,
  spaeter: 'Box ist noch nicht da – später verbinden',
  vormerken: 'Wir merken uns die Kennung bis morgen in diesem Browser.',
} as const;

/** M7 · Aufbau-Blatt mit QR-Band. */
export const BLATT = {
  band: (gedruckt: string) => `Aus dem QR-Code: ${gedruckt}`,
  bandZeile: 'Vergleichen Sie die Kennung mit dem Aufdruck unten auf der Box. Danach verbindet sich die Box selbst.',
  mehrereAnlagen: (anzahl: number) =>
    `Hier stehen ${anzahl === 2 ? 'zwei' : anzahl} Anlagen zur Wahl. Wählen Sie die, an der die Box steht.`,
} as const;

/** Wahl der Anlage, wenn das Konto mehrere hat (QE-2 A). */
export const WAHL = {
  titel: 'An welcher Anlage steht die Box?',
  zeile: (gedruckt: string) =>
    `Sie verbinden die Box ${gedruckt} aus dem QR-Code. Wählen Sie die Anlage, an der sie steht; verbunden wird erst im nächsten Schritt.`,
  spaeter: 'Später verbinden',
} as const;

/** M11 (`BoxFremdKonto`): der Weg zum Support bei einer fremden Box. */
export const ERGEBNIS = {
  support: 'Support kontaktieren',
} as const;

/**
 * Der Weg (vp-box-verbinden-konzept, E1 = B): fünf Stationen nach dem
 * Verbinden - Eingesteckt · Box startet · Anmeldung · Datenverbindung · Ihre
 * Anlage. Ersetzt M8/M9 (`ERGEBNIS`) vollständig; `boxweg/wegLage.ts` wählt
 * daraus nach den Umschaltpunkten aus Bericht Abschnitt 4.3.
 *
 * Grundregel wie oben: „meldet sich“ nur mit echtem Lebenszeichen; keine
 * Gerätesuche mehr in diesen Sätzen (N1 - eine neue Box sucht nicht von
 * selbst, und die Suche lebt seit Runde 1 nur noch im Cockpit).
 */
export const WEG = {
  stationLabel: {
    eingesteckt: 'Eingesteckt',
    startet: 'Box startet',
    anmeldung: 'Anmeldung',
    datenverbindung: 'Datenverbindung',
    software: 'Software',
    anlage: 'Ihre Anlage',
  },
  /** Qualifiziert die Station „Eingesteckt“, solange sie nur eine Annahme ist (das Portal weiß es nicht). */
  eingestecktSie: 'Sie',
  chipStartet: (zeit: string) => `Startet · ${zeit}`,
  chipAngemeldet: (zeit: string) => `Angemeldet · ${zeit}`,
  titelStartet: 'Ihre Box startet',
  satzStartet: 'Meist ist sie 2½ Minuten nach dem Einstecken online.',
  satzLaenger: 'Das ist noch normal.',
  titelLaenger: 'Heute dauert es länger als meist',
  titelHoertNichts: 'Wir hören noch nichts von Ihrer Box',
  satzPruefen: 'Das dauert länger als meist. Bitte prüfen Sie Netzteil, Netzwerkkabel und Router.',
  satzSupport: 'Das ist länger als normal - bitte prüfen Sie die drei Punkte unten.',
  titelImInternet: 'Ihre Box ist im Internet',
  satzGleich: 'Gleich meldet sie sich mit ihren ersten Daten.',
  satzLiefSchon: 'Sie lief schon, bevor Sie verbunden haben. In spätestens 1½ Minuten ist sie online.',
  titelDatensperre: 'Die Datenverbindung kommt nicht durch',
  satzDatensperre: 'Ihre Box ist angemeldet, aber ihre Daten erreichen uns nicht. Das deutet auf eine Firewall oder ein Gastnetz hin.',
  datensperreHilfe: (gedruckt: string) =>
    `Prüfen Sie, ob Ihr Hauptrouter die Verbindung zulässt (Port 8883), oder schreiben Sie uns mit der Kennung ${gedruckt}.`,
  onlineTitel: 'Ihre Box ist online',
  onlineSatz: 'Weiter geht es mit Ihrer Anlage.',
  stillTitel: 'Box verbunden – sie meldet sich gerade nicht',
  stillSatz: 'Sie meldete sich schon einmal und ist gerade still. Das kann an Strom oder Internet liegen.',
  /**
   * Erstverbindung S2 (E4 = B): die Station „Software“ - der Weg wartet, bis die Box die neue Software
   * bestätigt hat. Kein „Weiter“, solange sie läuft; „Später einrichten“ bleibt als Ausweg.
   */
  softwarePruefTitel: 'Ihre Box sucht nach neuer Software',
  softwarePruefSatz: 'Einen Moment bitte - das dauert meist unter einer Minute.',
  softwareTitel: 'Ihre Box holt die neueste Software',
  softwareSatz: 'Bitte kurz warten. Ihre Box startet dabei einmal neu.',
  softwareSchritte: { laden: 'Laden', neustart: 'Neu starten', pruefen: 'Prüfen' },
  softwareSchrittTelefon: { laden: 'Lädt', neustart: 'Startet neu', pruefen: 'Prüft' },
  softwareRest: (min: number) => `noch etwa ${min} Min.`,
  softwareChip: (zeit: string) => `Software · ${zeit}`,
  softwareFertigTitel: 'Ihre Box ist auf dem neuesten Stand',
  softwareSpaeter: 'kommt später',
  softwareSpaeterSatz: 'Die neue Software kommt später. Darum kümmern wir uns.',
  softwareLaengerTitel: 'Das dauert länger als üblich',
  softwareLaengerSatz: 'Die neue Software läuft im Hintergrund weiter. Sie können schon weitermachen.',
  weiter: 'Weiter: Ihre Anlage',
  spaeter: 'Später anschließen – weiter zur Anlage',
  letzterKontakt: (zeile: string) => `Letzter Kontakt ${zeile}`,
  letzterKontaktKeiner: 'Letzter Kontakt: noch keiner',
  pruefenTitel: 'Bitte prüfen',
  pruefen: [
    'Das Netzteil steckt in der Buchse „5V“ und in der Steckdose.',
    'Ein Netzwerkkabel führt von der Buchse „WAN“ zu Ihrem Router.',
    'Ihr Router ist mit dem Internet verbunden.',
  ],
  frage3: 'Steht unten auf Ihrer Box dieselbe Kennung?',
  erwarteteKennung: (gedruckt: string) => `Erwartete Kennung: ${gedruckt}`,
  support: 'Support kontaktieren',
  zuLange: (gedruckt: string, anlage: string) =>
    `Seit 15 Minuten kein Lebenszeichen von der Box, die jetzt zur Anlage „${anlage}“ gehört. Schreiben Sie uns mit der Kennung ${gedruckt}, wir sehen nach.`,
  /**
   * Box verbinden S4 ("Andere Kennung", E4 = A): steht die falsche Kennung im Feld (Entscheid 5c-
   * Fall vom 10.11.), gibt dieser Knopf die nie gemeldete Box frei und verbindet die richtige in
   * einem Schritt. Entscheiden tut der Server (409 mit Gründen, nichts geändert, wenn die Box sich
   * inzwischen doch gemeldet hat oder ihren Schlüssel abgeholt hat).
   */
  andereKennungFrage: 'Steht oben eine andere Kennung als erwartet?',
  andereKennungKnopf: 'Andere Kennung',
  andereKennungAbbrechen: 'Abbrechen',
  andereKennungSenden: 'Jetzt verbinden',
  andereKennungHinweis: 'Diese Kennung gibt die Box oben frei und verbindet die neue - wie beim ersten Verbinden.',
  andereKennungGemeldetFehler:
    'Diese Box hat sich inzwischen selbst gemeldet - sie lässt sich nicht mehr durch eine andere ersetzen.',
} as const;

/**
 * „Wie soll Ihre Box ins Internet?" (Konzept vp-edge-light-wlan-s5, E5=A): die
 * Wahl zwischen Netzwerkkabel und WLAN, direkt nach dem Verbinden mit der
 * Kennung (Bericht Abschnitt 0.1, Bildschirm 1). „Mit Netzwerkkabel" führt
 * unverändert in den bisherigen Weg (`WEG`); „Über WLAN" zuerst zu
 * `WLAN_EINRICHTEN`.
 */
export const VERBINDUNG_WAHL = {
  titel: 'Wie soll Ihre Box ins Internet?',
  kabelTitel: 'Mit Netzwerkkabel',
  kabelZeile: 'Die Box steht nahe am Router.',
  wlanTitel: 'Über WLAN',
  wlanZeile: 'Kein Kabel bis zum Router.',
  hinweis: 'Sie können das später jederzeit wechseln.',
} as const;

/**
 * Über WLAN (Bericht Abschnitt 0.1, Bildschirme 2W/2W'): die Box bleibt ohne
 * Netzwerkkabel, der Kunde verbindet sein Handy oder seinen Computer mit dem
 * Einrichtungs-WLAN der Box und trägt dort die Kennung ein, die hier steht.
 */
export const WLAN_EINRICHTEN = {
  titel: 'Über WLAN',
  schritte: [
    'Nur das Netzteil einstecken - kein Netzwerkkabel.',
    'Am Handy oder Computer das WLAN „VoltPilot-Einrichtung“ wählen.',
    'Die Seite der Box öffnet sich. Tragen Sie dort die Kennung unten ein.',
  ],
  kennungTitel: 'Kennung',
  kennungZeile: 'Dieselbe Kennung steht auch unten auf der Box.',
  zurueck: 'Zurück',
  weiter: 'Weiter',
} as const;

/**
 * Die Art der Verbindung (Konzept vp-edge-light-wlan-s5, E1=B): wie der Weg
 * (`BoxWeg.tsx`) und die Box-Seite (`BoxSeiteSection.tsx`) zeigen, was die Box
 * über `linkKind`/`signalDbm` meldet (die Fakten dazu liefert `boxVerbindung.ts`).
 */
export const VERBINDUNG = {
  kabel: 'Netzwerkkabel',
  wlanGut: 'WLAN · Empfang gut',
  wlanSchwach: 'WLAN · Empfang schwach',
  schwachHinweis: 'Der WLAN-Empfang ist schwach. Rücken Sie die Box näher an den Router, wenn möglich.',
  stillWlanHinweis:
    'Passwort oder Router gewechselt? Nach 10 Minuten ohne WLAN öffnet die Box wieder das WLAN '
    + '„VoltPilot-Einrichtung“. Geben Sie dort Ihre Kennung und das neue Passwort ein.',
} as const;

/** M10 · Diese Box gehört schon zu Ihnen. */
export const SCHON_DEINS = {
  titel: 'Diese Box gehört schon zu Ihnen',
  zeile: (gedruckt: string, anlage: string) => `${gedruckt} ist mit Ihrer Anlage „${anlage}“ verbunden. Es ist nichts mehr zu tun.`,
  ansehen: 'Box ansehen',
  cockpit: 'Zum Cockpit',
} as const;

/** M11 · Box mit anderem Konto verbunden (QE-5 A). Nennt kein fremdes Konto. */
export const FREMD = {
  titel: 'Diese Box ist schon mit einem anderen Konto verbunden',
  datenschutz: 'Mit welchem, zeigen wir aus Datenschutzgründen nicht.',
  gruendeTitel: 'Häufige Gründe:',
  gruende: [
    'Ihr Installateur hat die Box in seinem Konto eingerichtet.',
    'Die Box war vorher bei jemand anderem in Betrieb.',
    'Jemand aus Ihrem Unternehmen hat sie schon verbunden. Bitten Sie die Person, Sie einzuladen.',
  ],
  wegTitel: 'So geht es weiter',
  weg: 'Schreiben Sie uns mit der Kennung. Wir klären, wem die Box gehört, und melden uns bei Ihnen.',
  kennungZeile: 'Steht unten auf der Box.',
  andere: 'Andere Kennung eingeben',
} as const;

/** M12 · ohne Recht zum Verbinden. Namen nur aus der eigenen Selbstauskunft. */
export const OHNE_RECHT = {
  titel: 'Für das Verbinden fehlt Ihnen das Recht',
  zeile: 'In diesem Konto verbinden Kundenadministratoren die Boxen.',
  bitte: (gedruckt: string) => `Bitten Sie eine dieser Personen, die Box ${gedruckt} zu verbinden:`,
  niemand: (gedruckt: string) =>
    `Bitten Sie Ihren Kundenadministrator, die Box ${gedruckt} zu verbinden. Die Kennung steht auch unten auf der Box.`,
  kennungZeile: 'Steht auch unten auf der Box.',
  uebersicht: 'Zur Übersicht',
} as const;

export const KOPIEREN = { knopf: 'Kopieren', kopiert: 'Kopiert' } as const;
