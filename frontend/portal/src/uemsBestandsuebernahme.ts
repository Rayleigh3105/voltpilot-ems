import { lokalerTag, type Tag } from './uemsOrtsbaum';

/**
 * Die REINE Regel der BESTANDSÜBERNAHME der Standorte (UEMS AP-02 IP-9;
 * Entscheide E5 = A, E9, E10 = A; Abnahme A5/A6, §6.3): was ein
 * Kundenbereich, der schon vor dem Unternehmens-Energiemanagement Anlagen
 * hatte, bei der Einführung bekommt — und was nie.
 *
 * 1. Kein Unternehmen, keine Anlage oder schon ein Standort — auch ein
 *    archivierter (die Rücknahme bleibt stehen): nichts.
 * 2. Schon Vorschläge: der Kundenbereich bleibt auf dem Vorschau-Weg — nur
 *    eine Anlage ohne Vorschlag bekommt ihren, nie einen Standort.
 * 3. GENAU EINE Anlage: ein Standort mit ihrem Namen, Entwurf, es fehlt:
 *    Adresse (nie eine erfundene, E10), in der Zeitzone des Unternehmens, und
 *    die Zuordnung ab dem TAG ihres Anlegens in dieser Zeitzone (E9).
 * 4. MEHRERE Anlagen: je Anlage ein Vorschlag „ein Standort gleichen Namens"
 *    ab demselben Tag — keine Zuordnung (E5, A6).
 *
 * Der Name folgt der Namensregel des Standorts: ohne Randleerzeichen,
 * höchstens 120 Zeichen (nach Unicode-Zeichen gezählt und gekürzt); ein leerer
 * Anlagenname wird das Kundenwort „Standort".
 *
 * Kein Ergebnis hängt an „heute". Der Zwilling im Server ist
 * `services/api .../uems/BestandsuebernahmeAbleitung`; beide fahren die Familie
 * `bestandsuebernahme` der Vektor-Datei `docs/contracts/v2/ortsbaum-vectors.json`.
 * **Wer die Regel ändert, ändert beide Seiten und die Vektor-Datei.**
 *
 * ⚠ Noch ruft im Portal niemand an: die Vorschau-Fläche kommt mit IP-10.
 */

export const BESTANDSUEBERNAHME_ARTEN = ['nichts', 'standort_anlegen', 'vorschlagen'] as const;
export type BestandsuebernahmeArt = (typeof BESTANDSUEBERNAHME_ARTEN)[number];

/** Warum — in der Reihenfolge, in der die Regel fragt. */
export const BESTANDSUEBERNAHME_GRUENDE = [
  'kein_unternehmen',
  'keine_anlage',
  'hat_standort',
  'vorschau_offen',
  'eine_anlage',
  'mehrere_anlagen',
] as const;
export type BestandsuebernahmeGrund = (typeof BESTANDSUEBERNAHME_GRUENDE)[number];

/** Das Kundenwort, wenn die Anlage keinen Namen hat — nie eine Ablehnung. */
export const NAME_OHNE_ANLAGENNAME = 'Standort';

/** Dieselbe Obergrenze wie der Name eines Standorts. */
export const NAME_HOECHSTENS = 120;

export interface BestandsAnlage {
  kennzeichen: string;
  name: string | null;
  /** Der Zeitpunkt des Anlegens, ISO-8601 mit Versatz. */
  angelegtUm: string;
}

export interface BestandsStandort {
  kennzeichen: string;
  archiviert: boolean;
}

export interface BestandsEingang {
  /** `null` = der Kundenbereich hat kein Unternehmen. */
  unternehmen: { zeitzone: string } | null;
  anlagen: BestandsAnlage[];
  standorte: BestandsStandort[];
  /** Die Kennzeichen der Anlagen, die schon einen Vorschlag haben. */
  vorschlaege: string[];
}

export interface NeuerStandort {
  name: string;
  zustand: 'entwurf';
  esFehlt: string[];
  zeitzone: string;
}

export interface BestandsZuordnung {
  anlage: string;
  gueltigAb: Tag;
}

export interface StandortVorschlag {
  anlage: string;
  name: string;
  gueltigAb: Tag;
}

export interface BestandsPlan {
  art: BestandsuebernahmeArt;
  grund: BestandsuebernahmeGrund;
  standort: NeuerStandort | null;
  zuordnung: BestandsZuordnung | null;
  vorschlaege: StandortVorschlag[];
}

/** Der Name des Standorts aus dem Namen der Anlage — die Namensregel, nie eine Ablehnung. */
export function standortName(anlagenName: string | null): string {
  let n = (anlagenName ?? '').trim();
  const zeichen = Array.from(n);
  if (zeichen.length > NAME_HOECHSTENS) {
    n = zeichen.slice(0, NAME_HOECHSTENS).join('').trim();
  }
  return n === '' ? NAME_OHNE_ANLAGENNAME : n;
}

function vorschlag(a: BestandsAnlage, zone: string): StandortVorschlag {
  return { anlage: a.kennzeichen, name: standortName(a.name), gueltigAb: lokalerTag(a.angelegtUm, zone) };
}

function nichts(grund: BestandsuebernahmeGrund): BestandsPlan {
  return { art: 'nichts', grund, standort: null, zuordnung: null, vorschlaege: [] };
}

export function bestandsuebernahme(e: BestandsEingang): BestandsPlan {
  if (e.unternehmen === null) return nichts('kein_unternehmen');
  if (e.anlagen.length === 0) return nichts('keine_anlage');
  if (e.standorte.length > 0) return nichts('hat_standort');
  const zone = e.unternehmen.zeitzone;
  if (e.vorschlaege.length > 0) {
    const neu = e.anlagen.filter((a) => !e.vorschlaege.includes(a.kennzeichen)).map((a) => vorschlag(a, zone));
    return neu.length === 0
      ? nichts('vorschau_offen')
      : { art: 'vorschlagen', grund: 'vorschau_offen', standort: null, zuordnung: null, vorschlaege: neu };
  }
  if (e.anlagen.length === 1) {
    const a = e.anlagen[0];
    return {
      art: 'standort_anlegen',
      grund: 'eine_anlage',
      standort: { name: standortName(a.name), zustand: 'entwurf', esFehlt: ['adresse'], zeitzone: zone },
      zuordnung: { anlage: a.kennzeichen, gueltigAb: lokalerTag(a.angelegtUm, zone) },
      vorschlaege: [],
    };
  }
  return {
    art: 'vorschlagen',
    grund: 'mehrere_anlagen',
    standort: null,
    zuordnung: null,
    vorschlaege: e.anlagen.map((a) => vorschlag(a, zone)),
  };
}
