import { describe, expect, it } from 'vitest';
import type { CurtailmentStatus } from './api';
import {
  CURTAIL_PLAN,
  CURTAIL_STALE_MS,
  curtailActionPhrase,
  curtailChipLabel,
  curtailExecutionNote,
  curtailRoleLabel,
  curtailTruth,
  curtailTruthForSlot,
  curtailWarnLine,
  hasCurtailEvidence,
  releaseNote,
} from './curtailment';
import { NBSP } from './format';

/**
 * Die Drei-Stufen-Wahrheit der Abregelung (Scout `vp-pilsting-abregeln`,
 * PR 3 von 4). Was hier am meisten wert ist:
 *
 *  - OHNE Beleg (kein Block, veralteter Block, kein Aktor) muss ALLES exakt
 *    beim Plan-Wortlaut aus Fix 1 bleiben - sonst hätte PR 3 genau den Fehler
 *    wiederholt, den er beendet: eine Behauptung ohne Nachweis.
 *  - Gegenwart („pausiert", „bestätigt") gibt es NUR bei angewandter UND
 *    bestätigter Begrenzung.
 *  - `allMatch: null` heißt „nichts angewandt", nicht „widersprochen".
 */

const NOW = new Date('2026-08-02T10:41:20Z');

function status(over: Partial<CurtailmentStatus> = {}): CurtailmentStatus {
  return {
    deviceId: 'd1',
    units: 2,
    certifiedUnits: 2,
    controlEnabled: true,
    active: true,
    appliedCapKw: 12.5,
    allMatch: true,
    possibleOverride: false,
    checkedAt: new Date(NOW.getTime() - 13_000).toISOString(),
    ...over,
  };
}

describe('curtailTruth · die Beleg-Lage', () => {
  it('ist ohne Block Stufe 1 - der Zustand vor PR 3', () => {
    expect(curtailTruth(null, NOW)).toEqual(CURTAIL_PLAN);
    expect(curtailTruth(undefined, NOW)).toEqual(CURTAIL_PLAN);
    expect(hasCurtailEvidence(CURTAIL_PLAN)).toBe(false);
  });

  it('macht aus „kein Aktor" nicht „0 von 0 freigegeben"', () => {
    // Ein Block ohne Einheiten beschreibt nichts, worüber man etwas sagen kann.
    expect(curtailTruth(status({ units: 0, certifiedUnits: 0 }), NOW)).toEqual(CURTAIL_PLAN);
  });

  it('behandelt einen VERALTETEN Block als keinen Beleg', () => {
    const old = status({
      checkedAt: new Date(NOW.getTime() - CURTAIL_STALE_MS - 1000).toISOString(),
    });
    const t = curtailTruth(old, NOW);
    expect(t.stufe).toBe('plan');
    expect(t.stale).toBe(true);
    // Und er behauptet auch keine Ursache mehr.
    expect(t.cause).toBeNull();
    expect(curtailExecutionNote(t)).toBeNull();
  });

  it('nennt bei Pilsting die echte Ursache: 0 von 2 freigegeben', () => {
    const t = curtailTruth(status({ certifiedUnits: 0, active: false, allMatch: null, appliedCapKw: null }), NOW);
    expect(t.stufe).toBe('nicht_umgesetzt');
    expect(t.cause).toBe('0 von 2 Wechselrichtern freigegeben');
    expect(hasCurtailEvidence(t)).toBe(true);
  });

  it('wertet auch eine TEILWEISE Freigabe als „setzt es noch nicht um"', () => {
    // Eine von zwei Einheiten drosselt - „vom Wechselrichter bestätigt" wäre
    // dann zu viel versprochen.
    const t = curtailTruth(status({ certifiedUnits: 1 }), NOW);
    expect(t.stufe).toBe('nicht_umgesetzt');
    expect(t.cause).toBe('1 von 2 Wechselrichtern freigegeben');
  });

  it('benennt den Not-Aus und „nichts angewandt" als eigene Ursachen', () => {
    expect(curtailTruth(status({ controlEnabled: false }), NOW).cause).toBe(
      'die Wechselrichter-Steuerung ist ausgeschaltet',
    );
    expect(
      curtailTruth(status({ active: false, allMatch: null, appliedCapKw: null }), NOW).cause,
    ).toBe('die Anlage wendet gerade keine Begrenzung an');
  });

  it('ist erst mit angewandter UND bestätigter Begrenzung Stufe 3', () => {
    const t = curtailTruth(status(), NOW);
    expect(t.stufe).toBe('ausgefuehrt');
    expect(t.appliedCapKw).toBe(12.5);
  });

  it('liest `allMatch: null` als „nichts bestätigt", nie als Widerspruch', () => {
    // Angewandt, aber (noch) keine Rücklese-Aussage: das ist keine Ausführung -
    // und es ist auch keine Übersteuerung.
    const t = curtailTruth(status({ allMatch: null }), NOW);
    expect(t.stufe).toBe('nicht_umgesetzt');
    expect(t.cause).toBe('die Begrenzung ist noch nicht bestätigt');
    expect(curtailTruth(status({ allMatch: false }), NOW).stufe).toBe('nicht_umgesetzt');
  });

  it('meldet die Übersteuerung als eigenen Zustand - die schärfste Aussage', () => {
    const t = curtailTruth(status({ possibleOverride: true, appliedCapKw: 0 }), NOW);
    expect(t.stufe).toBe('uebersteuert');
    // Eine angewandte 0 ist ein WERT, keine Abwesenheit.
    expect(t.appliedCapKw).toBe(0);
  });

  it('lässt die verhindernden Ursachen vor der Übersteuerung gewinnen', () => {
    // Ohne Freigabe wird gar nichts angewandt - dann gibt es auch nichts zu
    // übersteuern, und der nennbare Grund ist die fehlende Freigabe.
    expect(
      curtailTruth(status({ certifiedUnits: 0, possibleOverride: true }), NOW).stufe,
    ).toBe('nicht_umgesetzt');
  });
});

describe('releaseNote · Singular und Plural', () => {
  it('spricht von einem Wechselrichter, wenn es einer ist', () => {
    expect(releaseNote(0, 1)).toBe('0 von 1 Wechselrichter freigegeben');
    expect(releaseNote(2, 3)).toBe('2 von 3 Wechselrichtern freigegeben');
  });
});

describe('curtailTruthForSlot · der Beleg gilt nur für das JETZT', () => {
  const t = curtailTruth(status(), NOW);

  it('gilt für den laufenden Abregel-Slot', () => {
    expect(curtailTruthForSlot(t, 'abregeln').stufe).toBe('ausgefuehrt');
  });

  it('gilt NICHT für eine andere Rolle und nicht für einen anderen Slot', () => {
    expect(curtailTruthForSlot(t, 'verkaufen')).toEqual(CURTAIL_PLAN);
    // Eine angetippte Viertelstunde am Vormittag/Abend: was das Gerät JETZT
    // tut, sagt über sie nichts.
    expect(curtailTruthForSlot(t, 'abregeln', false)).toEqual(CURTAIL_PLAN);
    expect(curtailTruthForSlot(null, 'abregeln')).toEqual(CURTAIL_PLAN);
    expect(curtailTruthForSlot(t, null)).toEqual(CURTAIL_PLAN);
  });
});

describe('Wortlaut · Gegenwart nur mit Beleg', () => {
  const plan = CURTAIL_PLAN;
  const nichtUmgesetzt = curtailTruth(status({ certifiedUnits: 0, active: false, allMatch: null }), NOW);
  const ausgefuehrt = curtailTruth(status(), NOW);
  const uebersteuert = curtailTruth(status({ possibleOverride: true }), NOW);

  it('hält den Rollen-Titel im Konjunktiv, solange nichts belegt ist', () => {
    expect(curtailRoleLabel(plan)).toBe('Einspeisung pausieren (Negativpreis) — geplant');
    expect(curtailRoleLabel(plan, true)).toBe('Einspeisung pausieren (Negativpreis)');
    expect(curtailRoleLabel(nichtUmgesetzt)).toBe('Einspeisung pausieren (Negativpreis) — geplant');
    expect(curtailRoleLabel(ausgefuehrt)).toBe('Einspeisung pausiert (Negativpreis)');
    expect(curtailRoleLabel(uebersteuert)).toBe(
      'Einspeisung pausieren (Negativpreis) — nicht gehalten',
    );
  });

  it('sagt „pausiert gerade" erst bei belegter Ausführung', () => {
    expect(curtailActionPhrase(plan)).toBe('soll gerade die Einspeisung pausieren');
    expect(curtailActionPhrase(nichtUmgesetzt)).toBe('soll gerade die Einspeisung pausieren');
    expect(curtailActionPhrase(ausgefuehrt)).toBe('pausiert gerade die Einspeisung');
  });

  it('markiert den Bindungs-Chip erst mit Beleg als aktiv', () => {
    expect(curtailChipLabel(plan)).toBe('Drosselung geplant');
    expect(curtailChipLabel(nichtUmgesetzt)).toBe('Drosselung geplant');
    expect(curtailChipLabel(ausgefuehrt)).toBe('Drosselung aktiv');
  });

  it('schweigt ohne Beleg und nennt sonst genau eine Aussage', () => {
    expect(curtailExecutionNote(plan)).toBeNull();
    expect(curtailExecutionNote(nichtUmgesetzt)).toBe(
      'Ihre Anlage setzt das noch nicht um (0 von 2 Wechselrichtern freigegeben).',
    );
    expect(curtailExecutionNote(ausgefuehrt)).toBe(
      `Die Einspeisung ist auf 12,5${NBSP}kW begrenzt — vom Wechselrichter bestätigt.`,
    );
    // Ohne bekannte Begrenzung wird keine Zahl erfunden.
    expect(
      curtailExecutionNote(curtailTruth(status({ appliedCapKw: null }), NOW)),
    ).toBe('Die Einspeisung ist begrenzt — vom Wechselrichter bestätigt.');
    expect(curtailExecutionNote(uebersteuert)).toContain('übersteuert');
  });
});

describe('curtailWarnLine · der bernsteine Satz', () => {
  const nichtUmgesetzt = curtailTruth(status({ certifiedUnits: 0, active: false, allMatch: null }), NOW);

  it('bleibt ohne Beleg der Fix-1-Satz - inklusive beider Möglichkeiten', () => {
    expect(curtailWarnLine(CURTAIL_PLAN, 16.6)).toBe(
      `Ihre Anlage speist gerade 16,6${NBSP}kW ein – die Drosselung ist auf dieser Anlage ` +
        'noch nicht freigegeben oder nicht bestätigt.',
    );
    // Ohne messbaren Widerspruch sagt Stufe 1 gar nichts.
    expect(curtailWarnLine(CURTAIL_PLAN, null)).toBeNull();
    expect(curtailWarnLine(CURTAIL_PLAN, 0)).toBeNull();
  });

  it('nennt mit Beleg die Ursache - mit und ohne Messwert', () => {
    expect(curtailWarnLine(nichtUmgesetzt, 16.6)).toBe(
      `Ihre Anlage speist gerade 16,6${NBSP}kW ein – sie setzt die Drosselung noch nicht um ` +
        '(0 von 2 Wechselrichtern freigegeben).',
    );
    // Der Beleg trägt sich auch ohne Messung: die Ursache ist bekannt.
    expect(curtailWarnLine(nichtUmgesetzt, null)).toBe(
      'Ihre Anlage setzt die geplante Drosselung noch nicht um ' +
        '(0 von 2 Wechselrichtern freigegeben).',
    );
  });

  it('warnt bei bestätigter Ausführung NICHT über eine Rest-Einspeisung', () => {
    // Eine Begrenzung ist ein Deckel, keine Null - und der nicht abregelbare
    // Anteil der Anlage speist weiter ein. Die Aussage trägt dann die
    // Bestätigungs-Zeile, nicht eine Warnung.
    expect(curtailWarnLine(curtailTruth(status(), NOW), 4.2)).toBeNull();
  });

  it('warnt bei Übersteuerung - das ist die gemessene Gegenrede', () => {
    expect(curtailWarnLine(curtailTruth(status({ possibleOverride: true }), NOW), 16.6)).toContain(
      'hält die Begrenzung aber nicht',
    );
  });
});
