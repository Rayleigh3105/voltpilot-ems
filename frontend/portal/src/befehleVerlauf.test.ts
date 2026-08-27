import { describe, expect, it } from 'vitest';
import type { CommandEntry, CommandHistory } from './api';
import {
  AKTIONSZEILE_LABEL,
  aktionsZeile,
  bilanzSatz,
  neuesteZeile,
  neuesteZuerst,
  REGISTER_LABEL,
  SEITE,
  tagText,
  VERLAUF_TAGE,
  verlaufFenster,
} from './befehleVerlauf';

/** Mittags Berliner Zeit - so liegt der Kalendertag eindeutig. */
const JETZT = Date.parse('2026-08-19T10:00:00Z');

function periode(over: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: 1,
    stream: 'batterie',
    kind: 'periode',
    eventKind: null,
    startedAt: '2026-08-19T08:00:00Z',
    endedAt: '2026-08-19T09:00:00Z',
    mode: 'plan',
    path: 'remote',
    whyKind: 'fahrplan',
    whyRef: '-6.50',
    commandedKwFirst: -6.5,
    commandedKwLast: -6.5,
    commandedKwMin: -6.5,
    commandedKwMax: -6.5,
    verdict: 'bestaetigt',
    cycles: null,
    cyclesConfirmed: null,
    cyclesNoAnswer: null,
    cyclesMismatch: null,
    controlEnabled: true,
    released: true,
    foreignInfluence: false,
    entityId: 'e1',
    source: 'cloud_abgeleitet',
    detail: null,
    ...over,
  };
}

function history(over: Partial<CommandHistory> = {}): CommandHistory {
  return {
    recordingSince: '2026-05-22T00:00:00Z',
    accuracySeconds: 15,
    from: '2026-05-22T00:00:00Z',
    to: '2026-08-19T10:00:00Z',
    entityId: null,
    entityLabel: null,
    writes: true,
    truncated: false,
    entries: [],
    control: null,
    curtailment: null,
    ...over,
  };
}

/** Nur die Befehlszeilen einer Ansicht, in Anzeige-Reihenfolge. */
function ids(view: ReturnType<typeof neuesteZuerst>): number[] {
  return view.eintraege.filter((e) => e.art === 'zeile').map((e) => (e as { zeile: { id: number } }).zeile.id);
}

function tage(view: ReturnType<typeof neuesteZuerst>): string[] {
  return view.eintraege.filter((e) => e.art === 'tag').map((e) => (e as { text: string }).text);
}

describe('verlaufFenster - die Aufbewahrung IST das Fenster', () => {
  it('spannt 90 Berliner Kalendertage auf, `to` einschliesslich', () => {
    const f = verlaufFenster(JETZT);
    expect(f.to).toBe('2026-08-19');
    expect(f.from).toBe('2026-05-22');
    expect(VERLAUF_TAGE).toBe(90);
  });

  it('rechnet auf der PLATTFORM-Zone, nicht auf der des Browsers', () => {
    // 22:30 UTC ist in Berlin schon der Folgetag - der Server spannt sein
    // Fenster in genau dieser Zone auf.
    expect(verlaufFenster(Date.parse('2026-08-19T22:30:00Z')).to).toBe('2026-08-20');
  });
});

describe('neuesteZuerst - die Reihenfolge', () => {
  it('dreht den Film um: die JUENGSTE Zeile steht oben', () => {
    const h = history({
      entries: [
        periode({ id: 1, startedAt: '2026-08-19T06:00:00Z', endedAt: '2026-08-19T07:00:00Z' }),
        periode({ id: 2, startedAt: '2026-08-19T07:00:00Z', endedAt: '2026-08-19T08:00:00Z' }),
        periode({ id: 3, startedAt: '2026-08-19T08:00:00Z', endedAt: null }),
      ],
    });
    expect(ids(neuesteZuerst([h], JETZT))).toEqual([3, 2, 1]);
  });

  it('setzt bei jedem Tageswechsel eine Datumszeile', () => {
    const h = history({
      entries: [
        periode({ id: 1, startedAt: '2026-08-17T08:00:00Z', endedAt: '2026-08-17T09:00:00Z' }),
        periode({ id: 2, startedAt: '2026-08-18T08:00:00Z', endedAt: '2026-08-18T09:00:00Z' }),
        periode({ id: 3, startedAt: '2026-08-19T08:00:00Z', endedAt: '2026-08-19T09:00:00Z' }),
      ],
    });
    const view = neuesteZuerst([h], JETZT);
    expect(tage(view)).toEqual(['Heute', 'Gestern', 'Montag, 17. August 2026']);
    // Die Datumszeile steht VOR ihrer ersten Zeile.
    expect(view.eintraege[0].art).toBe('tag');
  });

  it('gruppiert nach dem BEGINN - eine Periode ueber Mitternacht bekommt EIN Datum', () => {
    const h = history({
      entries: [
        // 22:00 BERLINER Zeit am 17., Ende 06:00 am 18.
        periode({ id: 1, startedAt: '2026-08-17T20:00:00Z', endedAt: '2026-08-18T04:00:00Z' }),
      ],
    });
    expect(tage(neuesteZuerst([h], JETZT))).toEqual(['Montag, 17. August 2026']);
  });

  it('mischt die Seiten und zaehlt die doppelt gelieferte Grenzzeile GENAU EINMAL', () => {
    // Der Server vergleicht `before` mit `<=`, die Grenzzeile kommt zweimal.
    const seite1 = history({
      entries: [
        periode({ id: 7, startedAt: '2026-08-19T06:00:00Z', endedAt: '2026-08-19T07:00:00Z' }),
        periode({ id: 8, startedAt: '2026-08-19T08:00:00Z', endedAt: '2026-08-19T09:00:00Z' }),
      ],
      nextBefore: '2026-08-19T06:00:00Z',
    });
    const seite2 = history({
      entries: [
        periode({ id: 6, startedAt: '2026-08-18T06:00:00Z', endedAt: '2026-08-18T07:00:00Z' }),
        periode({ id: 7, startedAt: '2026-08-19T06:00:00Z', endedAt: '2026-08-19T07:00:00Z' }),
      ],
      nextBefore: null,
    });
    const view = neuesteZuerst([seite1, seite2], JETZT);
    expect(ids(view)).toEqual([8, 7, 6]);
    expect(view.zeilen).toBe(3);
  });

  it('nennt den Cursor der AELTESTEN Seite - nie einen Knopf ins Leere', () => {
    const eine = history({ entries: [periode()], nextBefore: '2026-08-19T08:00:00Z' });
    expect(neuesteZuerst([eine], JETZT).mehrMoeglich).toBe(true);
    expect(neuesteZuerst([eine], JETZT).cursor).toBe('2026-08-19T08:00:00Z');

    const letzte = history({ entries: [periode({ id: 2 })], nextBefore: null });
    const view = neuesteZuerst([eine, letzte], JETZT);
    expect(view.mehrMoeglich).toBe(false);
    expect(view.cursor).toBeNull();
  });

  it('nennt einen unlesbaren Zeitpunkt beim Namen, statt ihn der Gruppe darueber zuzuschlagen', () => {
    const h = history({
      entries: [
        periode({ id: 1, startedAt: 'kaputt', endedAt: null }),
        periode({ id: 2 }),
      ],
    });
    expect(tage(neuesteZuerst([h], JETZT))).toContain('Zeitpunkt unbekannt');
  });

  it('datiert die ZEILEN nicht zusaetzlich - das Datum traegt die Gruppen-Zeile', () => {
    const h = history({
      entries: [periode({ id: 1, startedAt: '2026-08-17T08:00:00Z', endedAt: '2026-08-17T09:00:00Z' })],
    });
    const view = neuesteZuerst([h], JETZT);
    const zeile = view.eintraege.find((e) => e.art === 'zeile');
    expect((zeile as { zeile: { zeit: string } }).zeile.zeit).not.toMatch(/17\.08\./);
  });
});

describe('neuesteZuerst - was die Liste SAGT', () => {
  it('sagt bei leerer Liste den Grund und schweigt, sobald eine Zeile da ist', () => {
    const leer = neuesteZuerst([history()], JETZT);
    expect(leer.leer).toBeTruthy();
    expect(neuesteZuerst([history({ entries: [periode()] })], JETZT).leer).toBeNull();
  });

  it('unterscheidet „noch nicht aufgezeichnet" von „nichts geschickt"', () => {
    const nie = neuesteZuerst([history({ recordingSince: null })], JETZT);
    expect(nie.leer).toContain('Aufzeichnung');
  });

  it('sagt den Deckel, statt still zu kappen', () => {
    expect(neuesteZuerst([history({ truncated: true, entries: [periode()] })], JETZT).deckel)
      .toBeTruthy();
    expect(neuesteZuerst([history({ entries: [periode()] })], JETZT).deckel).toBeNull();
  });

  it('nimmt die Bilanz vom SERVER und erfindet keine', () => {
    expect(neuesteZuerst([history({ total: 212, entries: [periode()] })], JETZT).bilanz)
      .toBe('212 Befehle in den letzten 90 Tagen');
    // Ein aelteres Backend meldet `total` nicht - dann steht dort NICHTS.
    expect(neuesteZuerst([history({ entries: [periode()] })], JETZT).bilanz).toBeNull();
  });

  it('bilanzSatz: Einzahl, keine Zahl aus einer 0 und nichts Erfundenes', () => {
    expect(bilanzSatz(1)).toBe('1 Befehl in den letzten 90 Tagen');
    expect(bilanzSatz(0)).toBeNull();
    expect(bilanzSatz(undefined)).toBeNull();
    expect(bilanzSatz(Number.NaN)).toBeNull();
  });

  it('neuesteZeile liefert die oberste Befehlszeile, sonst null', () => {
    const h = history({
      entries: [periode({ id: 1 }), periode({ id: 2, startedAt: '2026-08-19T09:00:00Z', endedAt: null })],
    });
    expect(neuesteZeile(neuesteZuerst([h], JETZT))?.id).toBe(2);
    expect(neuesteZeile(neuesteZuerst([history()], JETZT))).toBeNull();
  });

  it('tagText: Heute · Gestern · voller Wochentag · unbekannt', () => {
    expect(tagText('2026-08-19', JETZT)).toBe('Heute');
    expect(tagText('2026-08-18', JETZT)).toBe('Gestern');
    expect(tagText('2026-08-17', JETZT)).toBe('Montag, 17. August 2026');
    expect(tagText(null, JETZT)).toBe('Zeitpunkt unbekannt');
  });

  it('haelt die Seitengroesse bei 20', () => {
    expect(SEITE).toBe(20);
  });
});

describe('aktionsZeile - was ein Blatt absetzen kann', () => {
  it('bietet an einem Zaehler und einer Ladesaeule GAR NICHTS an', () => {
    expect(aktionsZeile({ gattung: 'zaehler', registerMoeglich: true })).toEqual([]);
    expect(aktionsZeile({ gattung: 'ladepunkt', registerMoeglich: true })).toEqual([]);
  });

  it('gibt der Box genau den Register-Weg', () => {
    const a = aktionsZeile({ gattung: 'box', registerMoeglich: true });
    expect(a.map((x) => x.key)).toEqual(['register']);
    expect(a[0].label).toBe(REGISTER_LABEL);
  });

  it('gibt dem Hybrid seine Speicher-Handlungen UND den Register-Weg', () => {
    const a = aktionsZeile({
      gattung: 'wechselrichter-speicher',
      speicher: ['speicher_laden', 'speicher_halten'],
      registerMoeglich: true,
    });
    expect(a.map((x) => x.art)).toEqual(['speicher', 'speicher', 'register']);
    expect(a[0].wert).toBe('speicher_laden');
  });

  it('gibt einem PV-Wechselrichter nur den Register-Weg', () => {
    expect(aktionsZeile({
      gattung: 'wechselrichter',
      speicher: ['speicher_laden'],
      registerMoeglich: true,
    }).map((x) => x.art)).toEqual(['register']);
    expect(aktionsZeile({ gattung: 'pv-melder', registerMoeglich: true }).map((x) => x.art))
      .toEqual(['register']);
  });

  it('gibt einem Verbraucher seine Sofortaktionen und dem Eigenbau beides', () => {
    expect(aktionsZeile({ gattung: 'verbraucher', verbraucher: ['start', 'stop'] })
      .map((x) => x.wert)).toEqual(['start', 'stop']);
    expect(aktionsZeile({ gattung: 'geraet', verbraucher: ['resume'], registerMoeglich: true })
      .map((x) => x.art)).toEqual(['verbraucher', 'register']);
  });

  it('bietet NICHTS an, was der Zustand nicht hergibt', () => {
    // Kein Schreibweg belegt ⇒ kein Register-Knopf; keine Handlung ⇒ leer.
    expect(aktionsZeile({ gattung: 'wechselrichter-speicher', speicher: [] })).toEqual([]);
    expect(aktionsZeile({ gattung: 'geraet', verbraucher: [], registerMoeglich: false }))
      .toEqual([]);
  });

  it('nennt die Handlungen mit ihren BESTEHENDEN Worten - es entsteht kein neues', () => {
    const a = aktionsZeile({ gattung: 'wechselrichter-speicher', speicher: ['speicher_halten'] });
    expect(a[0].label).toBe('Ladestand halten');
    expect(AKTIONSZEILE_LABEL).toBe('Befehl an dieses Gerät');
  });
});
