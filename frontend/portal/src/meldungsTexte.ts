/**
 * Die Meldungstexte, TS-Zwilling (Kunden-Alarmierung P1, Konzept vp-kunden-alarmierung-konzept §6.4).
 *
 * Die EINE Wahrheit ist `services/api/src/main/resources/wertekatalog/katalog.json`: `meldung_allgemein`
 * und je Eintrag `meldung`/`zustandsworte`. Dieser Zwilling spiegelt genau diese Teile inhaltlich,
 * `meldungsTexte.sync.test.ts` hält das fest. Gerendert wird mit `meldungsText.ts` - derselbe Text wie
 * in Mail und Push (Java `MeldungsText`), beide gegen `docs/contracts/v2/meldungs-text-vectors.json`.
 * Nicht von Hand auseinanderlaufen lassen: erst katalog.json ändern, dann hier nachziehen.
 */

export type TextVorlage = string | string[];

export interface MeldungsartTexte {
  gilt_bei: { zustaende?: string[]; herkunft?: string };
  titel: string;
  lage: TextVorlage;
  ursache?: TextVorlage;
  was_tun?: TextVorlage;
  push: TextVorlage;
  entwarnung_titel: string;
  entwarnung: TextVorlage;
  entwarnung_dauer?: TextVorlage;
}

export interface WertartTexte {
  zustandsworte?: Record<string, string>;
  meldung?: MeldungsartTexte;
}

export interface EigeneTexte {
  titel: Record<string, string>;
  lage: Record<string, string>;
  bedingung: Record<string, string>;
  wartezeit: string;
  ursache: TextVorlage;
  was_tun: TextVorlage;
  push: TextVorlage;
  entwarnung_titel: string;
  entwarnung: TextVorlage;
  entwarnung_dauer: TextVorlage;
}

export interface MeldungAllgemein {
  _hinweis: string;
  ort_ersatz: Record<string, string>;
  zustandswort_ersatz: string;
  titel: string;
  push_titel: string;
  push_zusatz: string;
  dringend_betreff: string;
  dringend_push: string;
  erinnerung_titel: string;
  erinnerung: string;
  link_meldung: string;
  link_einstellen: string;
  kennzeichen: string;
  eigene: EigeneTexte;
}

export const MELDUNG_ALLGEMEIN: MeldungAllgemein = {
  _hinweis: 'Kunden-Alarmierung P1 (Konzept vp-kunden-alarmierung-konzept §6.4): Texte jeder Meldung. Mail, Push und Portal rendern aus DIESER Quelle - Java MeldungsText, Portal meldungsText.ts (Zwilling meldungsTexte.ts), beide gegen docs/contracts/v2/meldungs-text-vectors.json. Platzhalter in {}; ein Feld darf eine Liste von Alternativen sein, es gilt die erste, deren Platzhalter alle belegt sind. Je Eintrag: \'meldung\' (feste Meldungsart, gilt bei \'gilt_bei\') und \'zustandsworte\' (Kundenwort je Zustand/Ereignis).',
  ort_ersatz: {
    anlage: 'Ihre Anlage',
    komponente: 'Ihre Anlage',
    einheit: 'Ihre Anlage',
    messstelle: 'Ihre Messstelle',
    kennzahl: 'Ihre Kennzahl',
    energieziel: 'Ihr Energieziel',
  },
  zustandswort_ersatz: 'ein anderer Zustand',
  titel: '{ort}: {titel}',
  push_titel: '{ort} · {titel}',
  push_zusatz: 'Tippen für Einzelheiten.',
  dringend_betreff: 'Dringend: ',
  dringend_push: 'Dringend · ',
  erinnerung_titel: 'Noch offen – {titel}',
  erinnerung: 'Diese Meldung ist seit {beginn} offen und noch nicht als gesehen markiert.',
  link_meldung: 'Ansehen: {link}',
  link_einstellen: 'Leiser stellen oder abmelden: {link}',
  kennzeichen: 'Meldung {kennzeichen}',
  eigene: {
    titel: {
      ueber: '{wertname} über {schwelle}',
      unter: '{wertname} unter {schwelle}',
      ausserhalb: '{wertname} außerhalb von {schwelle_unten} bis {schwelle_oben}',
      keine_daten: '{wertname}: keine Daten',
      zustand: '{wertname}: {zustandswort}',
      ereignis: '{wertname}',
      periode_ueber: '{wertname} über {schwelle}',
      periode_unter: '{wertname} unter {schwelle}',
      aenderung_hoeher: '{wertname} um mehr als {prozent} gestiegen',
      aenderung_niedriger: '{wertname} um mehr als {prozent} gesunken',
      aenderung_beide: '{wertname} um mehr als {prozent} verändert',
    },
    lage: {
      ueber: '{Satzname} liegt seit {beginn} bei {wert}.',
      unter: '{Satzname} liegt seit {beginn} bei {wert}.',
      ausserhalb: '{Satzname} liegt seit {beginn} bei {wert}.',
      keine_daten: 'Seit {beginn} kommen für {satzname} keine Werte an.',
      zustand: 'Seit {beginn}: {zustandswort}.',
      ereignis: 'Seit {beginn}: {zustandswort}.',
      periode_ueber: '{Satzname}: {wert}.',
      periode_unter: '{Satzname}: {wert}.',
      aenderung_hoeher: '{Satzname}: {wert}.',
      aenderung_niedriger: '{Satzname}: {wert}.',
      aenderung_beide: '{Satzname}: {wert}.',
    },
    bedingung: {
      ueber: ' über {schwelle}',
      unter: ' unter {schwelle}',
      ausserhalb: ' außerhalb von {schwelle_unten} bis {schwelle_oben}',
      keine_daten: ' ohne Werte',
      zustand: ': {zielworte}',
      ereignis: '',
      periode_ueber: ' über {schwelle}',
      periode_unter: ' unter {schwelle}',
      aenderung_hoeher: ' mit einem Anstieg um mehr als {prozent}',
      aenderung_niedriger: ' mit einem Rückgang um mehr als {prozent}',
      aenderung_beide: ' mit einer Änderung um mehr als {prozent}',
    },
    wartezeit: ', länger als {wartezeit}',
    ursache: [
      'Ihre Überwachung „{name}“ meldet bei {wertname}{bedingung}{wartezeit}.',
      'Sie haben eingestellt: melden bei {wertname}{bedingung}{wartezeit}.',
    ],
    was_tun: 'Sehen Sie sich den Wert an. Passt die Grenze nicht mehr, legen Sie die Überwachung unter Meldungen › Überwachungen neu an.',
    push: [
      'Aktuell {wert}.',
      'Seit {beginn}: {zustandswort}.',
      'Seit {beginn} keine Werte.',
    ],
    entwarnung_titel: '{wertname} wieder im Rahmen',
    entwarnung: 'Seit {ende} ist {satzname} wieder im gewünschten Bereich.',
    entwarnung_dauer: 'Die Abweichung dauerte {dauer}.',
  },
};

/** Je Wertart: Kundenwort je Zustand und, für feste Meldungsarten, ihre Texte. */
export const WERTART_TEXTE: Record<string, WertartTexte> = {
  "box.erreichbar": {
    zustandsworte: {
      erreichbar: 'erreichbar',
      nicht_erreichbar: 'nicht erreichbar',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['nicht_erreichbar'],
      },
      titel: 'Box meldet sich nicht',
      lage: 'Ihre VoltPilot-Box sendet seit {beginn} keine Daten.',
      ursache: 'Meist ist das Internet oder der Strom an der Box unterbrochen. Die Anlage läuft vor Ort weiter.',
      was_tun: 'Prüfen Sie, ob die Box Strom hat und Ihr Router mit dem Internet verbunden ist.',
      push: 'Seit {beginn} keine Daten.',
      entwarnung_titel: 'Box meldet sich wieder',
      entwarnung: 'Seit {ende} kommen wieder Daten.',
      entwarnung_dauer: 'Die Unterbrechung dauerte {dauer}.',
    },
  },
  "datenquelle.liefert_daten": {
    zustandsworte: {
      ok: 'liefert Daten',
      stale: 'liefert keine Daten',
      never: 'liefert noch keine Daten',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['stale', 'never'],
      },
      titel: 'Gerät liefert keine Daten',
      lage: [
        'Seit {beginn} fehlen Daten. {satz}',
        'Ein Gerät an Ihrer Anlage liefert seit {beginn} keine Daten.',
      ],
      ursache: 'Meist ist das Gerät ausgeschaltet oder seine Verbindung zur Box unterbrochen.',
      was_tun: 'Prüfen Sie, ob das Gerät eingeschaltet und mit der Box verbunden ist.',
      push: 'Seit {beginn} fehlen Daten eines Geräts.',
      entwarnung_titel: 'Gerät liefert wieder Daten',
      entwarnung: 'Seit {ende} kommen wieder Daten.',
      entwarnung_dauer: 'Die Lücke dauerte {dauer}.',
    },
  },
  "box.luecke": {
    zustandsworte: {
      data_gap: 'Datenlücke',
    },
  },
  "box.neustarts": {
    zustandsworte: {
      box_restart: 'Neustart der Box',
    },
  },
  "anlage.preis.jetzt": {
    meldung: {
      gilt_bei: {
        herkunft: 'ab_werk',
      },
      titel: 'Strom gerade günstig',
      lage: 'Der Börsenpreis liegt seit {beginn} bei {wert}, unter dem Schnitt der letzten 30 Tage ({schwelle}).',
      ursache: 'Meist gibt es gerade viel Wind- oder Sonnenstrom im Netz.',
      was_tun: 'Haben Sie einen dynamischen Stromtarif, lohnt es sich jetzt, Waschmaschine, Spülmaschine oder das Laden des Autos zu starten.',
      push: 'Börsenpreis {wert}, günstiger als üblich.',
      entwarnung_titel: 'Strom nicht mehr günstig',
      entwarnung: 'Seit {ende} liegt der Börsenpreis wieder über dem Schnitt der letzten 30 Tage.',
      entwarnung_dauer: 'Die günstige Zeit dauerte {dauer}.',
    },
  },
  "anlage.netz.lastspitze_laufend": {
    meldung: {
      gilt_bei: {
        herkunft: 'ab_werk',
      },
      titel: 'Lastspitze droht',
      lage: 'Das laufende Viertelstunden-Mittel des Netzbezugs liegt seit {beginn} bei {wert}, über der Warnschwelle von {schwelle}.',
      ursache: 'Die Warnschwelle liegt bei 95 % der bisher höchsten Spitze in diesem Abrechnungszeitraum; eine neue Spitze erhöht den Leistungspreis.',
      was_tun: 'Schalten Sie große Verbraucher jetzt ab oder verschieben Sie sie, bis die Viertelstunde vorbei ist.',
      push: 'Netzbezug {wert} – große Verbraucher jetzt abschalten.',
      entwarnung_titel: 'Viertelstunden-Mittel wieder unter der Warnschwelle',
      entwarnung: 'Seit {ende} liegt das Viertelstunden-Mittel wieder unter der Warnschwelle.',
      entwarnung_dauer: 'Die Lage dauerte {dauer}.',
    },
  },
  "energieziel.kurs": {
    zustandsworte: {
      noch_keine_aussage: 'noch keine Aussage',
      auf_kurs: 'auf Kurs',
      knapp_dahinter: 'knapp dahinter',
      nicht_auf_kurs: 'nicht auf Kurs',
    },
  },
  "messstelle.beobachtung": {
    zustandsworte: {
      liefert: 'liefert Werte',
      liefert_nicht_seit: 'liefert keine Werte',
      wartet_auf_erste_daten: 'wartet auf erste Werte',
      keine_datenquelle: 'ohne Datenquelle',
    },
  },
  "messstelle.monat_unvollstaendig": {
    zustandsworte: {
      vollstaendig: 'vollständig',
      unvollstaendig: 'unvollständig',
    },
  },
  "erzeuger.fernsteuerung_nicht_bereit": {
    zustandsworte: {
      bereit: 'bereit',
      nicht_bereit: 'nicht bereit',
      kein_direktvermarkter: 'kein Direktvermarkter',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['nicht_bereit'],
      },
      titel: 'Fernsteuerung nicht bereit',
      lage: [
        'Seit {beginn}: {satz}',
        'Eine Erzeugungseinheit ist seit {beginn} nicht bereit für den Direktvermarkter.',
      ],
      ursache: 'Solange die Einheit nicht bereit ist, kann der Direktvermarkter sie nicht steuern; das kann Erlöse kosten.',
      was_tun: 'Prüfen Sie die Einheit vor Ort. Hält das an, sagen Sie Ihrem Installateur Bescheid.',
      push: 'Seit {beginn} nicht bereit für den Direktvermarkter.',
      entwarnung_titel: 'Fernsteuerung wieder bereit',
      entwarnung: 'Seit {ende} ist die Einheit wieder bereit für den Direktvermarkter.',
      entwarnung_dauer: 'Das dauerte {dauer}.',
    },
  },
  "erzeuger.daten_veraltet": {
    zustandsworte: {
      aktuell: 'aktuell',
      veraltet: 'veraltet',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['veraltet'],
      },
      titel: 'Anlagensteuerung liefert keine aktuellen Werte',
      lage: [
        'Seit {beginn}: {satz}',
        'Die Anlagensteuerung liefert seit {beginn} keine aktuellen Werte.',
      ],
      ursache: 'Meist ist die Verbindung zwischen Box und Anlagensteuerung unterbrochen.',
      was_tun: 'Prüfen Sie Strom und Netzwerkkabel der Anlagensteuerung. Hält das an, sagen Sie Ihrem Installateur Bescheid.',
      push: 'Seit {beginn} keine aktuellen Werte.',
      entwarnung_titel: 'Anlagensteuerung liefert wieder aktuelle Werte',
      entwarnung: 'Seit {ende} kommen wieder aktuelle Werte.',
      entwarnung_dauer: 'Das dauerte {dauer}.',
    },
  },
  "erzeuger.anlage_folgt_nicht": {
    zustandsworte: {
      folgt: 'folgt der Vorgabe',
      folgt_nicht: 'folgt der Vorgabe nicht',
      nicht_begrenzt: 'nicht begrenzt',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['folgt_nicht'],
      },
      titel: 'Anlage folgt der Vorgabe nicht',
      lage: [
        'Seit {beginn}: {satz}',
        'Die Anlage folgt seit {beginn} der Vorgabe nicht.',
      ],
      ursache: 'Meist setzt ein Wechselrichter die Vorgabe der Anlagensteuerung nicht um.',
      was_tun: 'Prüfen Sie Wechselrichter und Anlagensteuerung. Hält das an, sagen Sie Ihrem Installateur Bescheid.',
      push: 'Seit {beginn} folgt die Anlage der Vorgabe nicht.',
      entwarnung_titel: 'Anlage folgt der Vorgabe wieder',
      entwarnung: 'Seit {ende} folgt die Anlage wieder der Vorgabe.',
      entwarnung_dauer: 'Das dauerte {dauer}.',
    },
  },
  "erzeuger.netzbetreiber_abgeschaltet": {
    zustandsworte: {
      abgeschaltet: 'abgeschaltet',
      nicht_abgeschaltet: 'nicht abgeschaltet',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['abgeschaltet'],
      },
      titel: 'Netzbetreiber hat abgeschaltet',
      lage: [
        'Seit {beginn}: {satz}',
        'Die Anlage ist seit {beginn} abgeschaltet.',
      ],
      ursache: 'Der Netzbetreiber hat die Einspeisung gestoppt, meist wegen der Lage im Stromnetz.',
      was_tun: 'Sie müssen nichts tun; die Freigabe kommt vom Netzbetreiber.',
      push: 'Seit {beginn} abgeschaltet.',
      entwarnung_titel: 'Netzbetreiber hat wieder freigegeben',
      entwarnung: 'Seit {ende} ist die Anlage nicht mehr abgeschaltet.',
      entwarnung_dauer: 'Die Abschaltung dauerte {dauer}.',
    },
  },
  "erzeuger.fernwirk_verbindung_weg": {
    zustandsworte: {
      verbunden: 'verbunden',
      getrennt: 'getrennt',
      keine_fernwirktechnik: 'keine Fernwirktechnik',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['getrennt'],
      },
      titel: 'Fernwirk-Verbindung weg',
      lage: [
        'Seit {beginn}: {satz}',
        'Die Fernwirk-Verbindung zum Netzbetreiber steht seit {beginn} nicht.',
      ],
      ursache: 'Ohne diese Verbindung erreichen Vorgaben des Netzbetreibers die Anlage nicht.',
      was_tun: 'Prüfen Sie die Fernwirktechnik vor Ort. Hält das an, sagen Sie Ihrem Installateur Bescheid.',
      push: 'Seit {beginn} keine Fernwirk-Verbindung.',
      entwarnung_titel: 'Fernwirk-Verbindung steht wieder',
      entwarnung: 'Seit {ende} steht die Fernwirk-Verbindung wieder.',
      entwarnung_dauer: 'Die Unterbrechung dauerte {dauer}.',
    },
  },
  "erzeuger.programmstand_veraltet": {
    zustandsworte: {
      aktuell: 'aktuell',
      aelter: 'älter als erwartet',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['aelter'],
      },
      titel: 'Programmstand veraltet',
      lage: [
        'Seit {beginn}: {satz}',
        'Die Anlagensteuerung läuft seit {beginn} mit einem älteren Programmstand als erwartet.',
      ],
      ursache: 'Ein älterer Programmstand kann Vorgaben anders umsetzen als erwartet.',
      was_tun: 'Lassen Sie den Programmstand von Ihrem Installateur aktualisieren.',
      push: 'Älterer Programmstand als erwartet.',
      entwarnung_titel: 'Programmstand aktuell',
      entwarnung: 'Seit {ende} läuft der erwartete Programmstand.',
    },
  },
  "ladepunkt.wallbox_meldet_sich_nicht": {
    zustandsworte: {
      erreichbar: 'erreichbar',
      nicht_erreichbar: 'nicht erreichbar',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['nicht_erreichbar'],
      },
      titel: 'Wallbox meldet sich nicht',
      lage: 'Ihre Wallbox meldet sich seit {beginn} nicht bei der Box.',
      ursache: 'Meist hat die Wallbox keinen Strom oder ihre Netzwerkverbindung ist unterbrochen.',
      was_tun: 'Prüfen Sie, ob die Wallbox eingeschaltet ist und ihre Sicherung nicht ausgelöst hat.',
      push: 'Seit {beginn} keine Verbindung zur Wallbox.',
      entwarnung_titel: 'Wallbox meldet sich wieder',
      entwarnung: 'Seit {ende} ist die Wallbox wieder erreichbar.',
      entwarnung_dauer: 'Die Unterbrechung dauerte {dauer}.',
    },
  },
  "ladepunkt.ziel_wird_knapp": {
    zustandsworte: {
      reicht: 'reicht',
      knapp: 'knapp',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['knapp'],
      },
      titel: 'Ladeziel wird knapp',
      lage: 'Seit {beginn} steckt ein Auto, lädt aber nicht, und bis zur Abfahrtszeit sind es weniger als zwei Stunden.',
      ursache: 'Meist hat das Auto das Laden angehalten oder die Wallbox wartet auf günstigeren Strom.',
      was_tun: 'Brauchen Sie das Ladeziel sicher, stellen Sie das Laden auf „Sofort laden“.',
      push: 'Auto lädt nicht, Abfahrt in weniger als zwei Stunden.',
      entwarnung_titel: 'Auto lädt wieder oder ist abgesteckt',
      entwarnung: 'Seit {ende} lädt das Auto wieder oder ist abgesteckt.',
    },
  },
  "ladepunkt.auto_angesteckt": {
    zustandsworte: {
      angesteckt: 'angesteckt',
      nicht_angesteckt: 'nicht angesteckt',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['angesteckt'],
      },
      titel: 'Auto angesteckt',
      lage: 'Seit {beginn} ist ein Auto an der Wallbox angesteckt.',
      ursache: 'Diese Meldung haben Sie selbst eingeschaltet.',
      was_tun: 'Nichts zu tun; VoltPilot lädt nach Ihrer Einstellung.',
      push: 'Auto angesteckt seit {beginn}.',
      entwarnung_titel: 'Auto abgesteckt',
      entwarnung: 'Seit {ende} ist kein Auto mehr angesteckt.',
      entwarnung_dauer: 'Es war {dauer} angesteckt.',
    },
  },
  "ladepunkt.ladung_fertig": {
    zustandsworte: {
      laedt: 'lädt',
      fertig: 'fertig',
      nicht_angesteckt: 'nicht angesteckt',
    },
    meldung: {
      gilt_bei: {
        zustaende: ['fertig'],
      },
      titel: 'Auto fertig geladen',
      lage: 'Die Ladung ist seit {beginn} abgeschlossen.',
      ursache: 'Diese Meldung haben Sie selbst eingeschaltet.',
      was_tun: 'Nichts zu tun; das Auto ist bereit.',
      push: 'Fertig geladen seit {beginn}.',
      entwarnung_titel: 'Auto abgesteckt oder lädt wieder',
      entwarnung: 'Seit {ende} ist das Auto abgesteckt oder lädt wieder.',
    },
  },
};
