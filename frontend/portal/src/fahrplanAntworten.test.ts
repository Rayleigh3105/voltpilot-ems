import { describe, expect, it } from 'vitest';
import { antwortBringt, antwortReicht, antwortWeiter, antworten } from './fahrplanAntworten';
import { tagModell, type TagSlot } from './fahrplanTag';
import { NBSP } from './format';
import { OHNE_VERGLEICH_SATZ, speicherAussage } from './speicherAussage';

const TAG = new Date(2026, 8, 24);
const JETZT = new Date(2026, 8, 24, 14, 10);
const MORGEN = new Date(2026, 8, 25).toISOString();

function viertel(i: number, over: Partial<TagSlot> = {}): TagSlot {
  return {
    start: new Date(TAG.getTime() + i * 15 * 60_000).toISOString(),
    batteryKw: 0,
    socPct: 50,
    priceEurMwh: 100,
    costEur: 0,
    baselineCostEur: 0,
    slotRole: 'warten',
    slotFlags: null,
    storedValueCtKwh: 28,
    importPriceCtKwh: 30,
    exportValueCtKwh: 8,
    pvKw: 0,
    loadKw: 0.5,
    ...over,
  };
}

function tag(laeufe: [string, number][], over: (i: number) => Partial<TagSlot> = () => ({})): TagSlot[] {
  const out: TagSlot[] = [];
  for (const [rolle, n] of laeufe) {
    for (let k = 0; k < n; k++) out.push(viertel(out.length, { slotRole: rolle, ...over(out.length) }));
  }
  return out;
}

/** 00:00 Warten · 05:45 Verbrauch decken · 10:00 Warten · 13:30 Günstig laden · 14:30 Sonne speichern · 17:30 Verbrauch decken bis Mitternacht. */
const LAUF: [string, number][] = [
  ['warten', 23],
  ['eigenverbrauch', 17],
  ['warten', 14],
  ['guenstig_laden', 4],
  ['pv_speichern', 12],
  ['eigenverbrauch', 26],
];

function modell(laeufe = LAUF, over: (i: number) => Partial<TagSlot> = () => ({})) {
  return tagModell({ slots: tag(laeufe, over), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });
}

describe('antwortWeiter · „Wie geht es weiter?"', () => {
  it('nennt die nächsten zwei Phasen mit Startzeit und dem einen Wortschatz', () => {
    const a = antwortWeiter(modell(), 56, true)!;
    expect(a.antwort).toBe('Ab 14:30 Sonne speichern, ab 17:30 Verbrauch decken.');
    expect(a.kurz).toEqual({ label: 'Als Nächstes', wert: '14:30 Sonne speichern', meta: 'dann 17:30 Verbrauch decken' });
    expect(a.zeit).toBeNull();
    expect(a.art).toBe('geplant');
    expect(a.ziel).toMatchObject({ von: 14 * 60 + 30, bis: 1440, ebene: 'taetigkeit' });
  });

  it('sagt „voll" nur, wo eine spätere Viertelstunde die Grenze als bindend trägt', () => {
    expect(antwortWeiter(modell(LAUF, (i) => ({ socPct: i === 69 ? 100 : 50 })), 56, true)!.zusatz).toBeNull();
    const voll = modell(LAUF, (i) => ({ slotFlags: i === 69 ? ['soc_max'] : null }));
    expect(antwortWeiter(voll, 56, true)!.zusatz).toBe('Voll ab 17:15 Uhr.');
    // Steht der Zeiger schon auf der vollen Viertelstunde, gibt es nichts anzukündigen.
    expect(antwortWeiter(voll, 69, false)!.zusatz).toBeNull();
  });

  it('trägt die Uhrzeit, wenn der Zeiger nicht auf jetzt steht', () => {
    expect(antwortWeiter(modell(), 8, false)!.zeit).toBe('02:00 Uhr');
  });

  it('endet in der letzten Phase mit Mitternacht statt einer erfundenen Folge', () => {
    const a = antwortWeiter(modell(), 80, false)!;
    expect(a.antwort).toBe('Verbrauch decken bis Mitternacht.');
    expect(a.ziel).toBeNull();
  });

  it('behauptet nichts über das Ende des geladenen Plans hinaus', () => {
    const kurz = modell([['warten', 40], ['eigenverbrauch', 20]]);
    const a = antwortWeiter(kurz, 50, false)!;
    expect(a.antwort).toBe('Verbrauch decken bis 15:00 Uhr.');
    expect(a.zusatz).toBe('Weiter reicht der Fahrplan noch nicht.');
  });

  it('schweigt ohne Warum-Ebene oder außerhalb des Tages', () => {
    expect(antwortWeiter(modell(LAUF, (i) => (i === 3 ? { slotRole: null } : {})), 56, true)).toBeNull();
    expect(antwortWeiter(modell(), 96, true)).toBeNull();
  });
});

describe('antwortReicht · „Reicht der Speicher heute Abend?"', () => {
  it('reicht bis Mitternacht und nennt den Stand um Mitternacht', () => {
    const a = antwortReicht(modell(LAUF, (i) => ({ socPct: i === 95 ? 12 : 50 })))!;
    expect(a.antwort).toBe('Ja, bis Mitternacht.');
    expect(a.zusatz).toBe(`Um Mitternacht bleiben 12${NBSP}% im Speicher.`);
    expect(a.kurz).toEqual({ label: 'Heute Abend', wert: 'Reicht bis 24 Uhr', meta: `12${NBSP}% bleiben` });
    expect(a.ziel).toMatchObject({ von: 17 * 60 + 30, bis: 1440, punkt: 1440, ebene: 'ladestand' });
  });

  it('endet die Abend-Phase früher, sagt sie wann - und was dann bleibt', () => {
    const lauf: [string, number][] = [...LAUF.slice(0, 5), ['eigenverbrauch', 18], ['warten', 8]];
    const a = antwortReicht(modell(lauf, (i) => ({ socPct: i === 87 ? 20 : 50 })))!;
    expect(a.antwort).toBe('Ja, bis 22:00 Uhr.');
    expect(a.zusatz).toBe(`Danach bleiben 20${NBSP}% im Speicher.`);
  });

  it('sagt „leer" nur mit der bindenden Untergrenze - dann ohne „Ja"', () => {
    const lauf: [string, number][] = [...LAUF.slice(0, 5), ['eigenverbrauch', 18], ['warten', 8]];
    const a = antwortReicht(modell(lauf, (i) => ({ slotFlags: i === 88 ? ['soc_floor'] : null })))!;
    expect(a.antwort).toBe('Bis 22:00 Uhr.');
    expect(a.zusatz).toBe('Dann ist er leer, und Ihr Haus bezieht den Rest aus dem Netz.');
    expect(a.kurz).toMatchObject({ wert: 'Leer um 22:00', meta: 'danach Strom aus dem Netz' });
  });

  it('sagt ehrlich, wenn am Abend kein Entladen geplant ist', () => {
    const a = antwortReicht(modell([...LAUF.slice(0, 5), ['warten', 26]]))!;
    expect(a.antwort).toBe('Heute Abend ist kein Entladen geplant.');
    expect(a.ziel).toBeNull();
  });

  it('fragt nicht nach dem Abend, wenn der Plan vor dem Abend endet', () => {
    expect(antwortReicht(modell([['warten', 40], ['eigenverbrauch', 20]]))).toBeNull();
  });
});

describe('antwortBringt · „Was bringt es heute?" (Messlatte E6)', () => {
  const tagesGeld = { range: 'day', from: TAG.toISOString(), to: MORGEN };

  it('übernimmt die Steuerungs-Aussage der Erlöse-Welt unverändert', () => {
    const aussage = speicherAussage(
      { ...tagesGeld, savedEur: 1.25, savedSpeicherEur: 0.85, savedSteuerungEur: 0.4, steuerungSplitReason: null },
      { now: JETZT },
    );
    const a = antwortBringt(aussage)!;
    expect(a.antwort).toBe(aussage!.wert);
    expect(a.antwort).toContain('0,40');
    expect(a.zusatz).toBe(aussage!.satz);
    expect(a.zusatz).toContain('demselben Speicher ohne smarte Steuerung');
    expect(a.art).toBe('gemessen');
    expect(a.nachtrag).toBe(false);
    expect(a.notiz).toBeNull();
  });

  it('führt am laufenden Tag mit dem Plan des Tages - der Zwischenstand steht leise darunter', () => {
    const aussage = speicherAussage(
      { ...tagesGeld, savedEur: -0.2, savedSpeicherEur: -0.17, savedSteuerungEur: -0.03, steuerungSplitReason: null },
      { now: JETZT, steuerungGeplantEur: 6.39 },
    );
    const a = antwortBringt(aussage)!;
    expect(aussage!.geplantWert).toBe(`+${NBSP}6,39${NBSP}€`);
    expect(a.kurz).toEqual({ label: 'Heute geplant', wert: aussage!.geplantWert, meta: `bisher ${aussage!.wert}` });
    expect(aussage!.wert).toContain('0,03');
    expect(a.art).toBe('geplant');
    expect(a.antwort).toBe(`Geplant für heute: +${NBSP}6,39${NBSP}€ gegenüber demselben Speicher ohne smarte Steuerung.`);
    // Der Satz der Messung bleibt der Zusatz, unverändert.
    expect(a.zusatz).toBe(aussage!.satz);
  });

  it('nennt ohne Planwert und für einen ganzen Tag die gemessene Zahl', () => {
    const aussage = speicherAussage(
      { ...tagesGeld, savedEur: 1.25, savedSpeicherEur: 0.85, savedSteuerungEur: 0.4, steuerungSplitReason: null },
      { now: JETZT },
    );
    expect(antwortBringt(aussage)!.kurz).toMatchObject({ label: 'Heute', wert: aussage!.wert });
    expect(antwortBringt(aussage, 'gestern')!.kurz.label).toBe('Gestern');
  });

  it('nennt dazu die Energie, die für später im Speicher liegt (E6)', () => {
    const aussage = speicherAussage(
      {
        ...tagesGeld,
        savedEur: 1.25,
        savedSpeicherEur: 0.85,
        savedSteuerungEur: 0.4,
        steuerungSplitReason: null,
        speicherDeltaKwh: 4.2,
        speicherWertEur: 1.1,
        speicherWertCtKwh: 26.2,
      },
      { now: JETZT },
    );
    const a = antwortBringt(aussage)!;
    expect(a.notiz).toBe(aussage!.bestand);
    expect(a.notiz).toContain('4,2');
  });

  it('zeigt ohne Speicher-Stammdaten den Grund mit Nachtrag-Weg, nie eine 0', () => {
    const aussage = speicherAussage(
      { ...tagesGeld, savedEur: 1.25, savedSpeicherEur: null, savedSteuerungEur: null, steuerungSplitReason: 'no_battery_data' },
      { now: JETZT },
    );
    const a = antwortBringt(aussage)!;
    expect(a.antwort).toBe('Noch kein Vergleich');
    expect(a.zusatz).toBe(OHNE_VERGLEICH_SATZ);
    expect(a.nachtrag).toBe(true);
  });

  it('entfällt, wenn es nichts zu sagen gibt (älteres Backend, keine Kasse)', () => {
    expect(antwortBringt(speicherAussage({ ...tagesGeld, savedEur: 1.25 }, { now: JETZT }))).toBeNull();
    expect(antwortBringt(null)).toBeNull();
  });

  it('bleibt ohne die Sonnen-Erzählung (dritter Parameter weggelassen/null) unverändert', () => {
    const aussage = speicherAussage(
      { ...tagesGeld, savedEur: 1.25, savedSpeicherEur: 0.85, savedSteuerungEur: 0.4, steuerungSplitReason: null },
      { now: JETZT },
    );
    expect(antwortBringt(aussage)).toEqual(antwortBringt(aussage, 'heute', null));
  });
});

describe('antwortBringt · die Sonnen-Erzählung (Konzept vp-fahrplan-eigenverbrauch-konzept §4.3/§4.5, E2 = A)', () => {
  it('zeigt „Aus eigenem Strom X %" statt Geld - unabhängig von der Steuerungs-Aussage', () => {
    // Keine Steuerungs-Aussage da (`null`) - die Autarkie-Kachel braucht sie nicht.
    const a = antwortBringt(null, 'heute', { pct: 91, quelle: 'gemischt' })!;
    expect(a).not.toBeNull();
    expect(a.kurz).toEqual({ label: 'Aus eigenem Strom', wert: '91 %', meta: 'heute, Rest geplant' });
    expect(a.antwort).toContain('91 %');
    expect(a.details).toBe('sonnenstrom');
    // „Geld bleibt auf der Erlöse-Seite" (E2-Begründung): kein Link mehr dorthin.
    expect(a.details).not.toBe('erloese');
  });

  it('sagt ehrlich, wenn der Teil bisher rein geplant ist (keine Messung heute)', () => {
    const a = antwortBringt(null, 'heute', { pct: 100, quelle: 'geplant' })!;
    expect(a.kurz.meta).toBe('geplant');
    expect(a.zusatz).toMatch(/rein geplant/);
  });

  it('gilt nur für heute - gestern und morgen bleiben bei ihrer bisherigen Antwort', () => {
    expect(antwortBringt(null, 'morgen', { pct: 80, quelle: 'gemischt' })).toBeNull();
    const tagesGeld = { range: 'day' as const, from: TAG.toISOString(), to: MORGEN };
    const aussage = speicherAussage(
      { ...tagesGeld, savedEur: 1.25, savedSpeicherEur: 0.85, savedSteuerungEur: 0.4, steuerungSplitReason: null },
      { now: JETZT },
    );
    // Gestern hat die Autarkie-Kachel (noch) keine eigene Fassung - die
    // bestehende Geld-Antwort entscheidet, wie bisher, auch wenn `autarkie` gesetzt ist.
    expect(antwortBringt(aussage, 'gestern', { pct: 80, quelle: 'gemischt' })).toEqual(antwortBringt(aussage, 'gestern'));
  });
});

describe('antworten · Reihenfolge', () => {
  it('stellt weiter, reicht, bringt in fester Folge und lässt Fehlendes weg', () => {
    expect(antworten({ tag: modell(), auswahl: 56, istJetzt: true, speicher: null }).map((a) => a.key)).toEqual([
      'weiter',
      'reicht',
    ]);
  });
});

describe('antworten · je Tag des Tagesschalters (wie im Prototyp)', () => {
  const VORTAG = new Date(2026, 8, 23);
  const tagesGeld = (from: Date, to: Date) => ({
    range: 'day',
    from: from.toISOString(),
    to: to.toISOString(),
    savedEur: 2.1,
    savedSpeicherEur: 1.4,
    savedSteuerungEur: 0.7,
    steuerungSplitReason: null,
  });

  it('fragt gestern in der Vergangenheit - und nicht, ob er gereicht hat (das weiß nur die Messung)', () => {
    const aussage = speicherAussage(tagesGeld(VORTAG, TAG), { now: JETZT });
    const liste = antworten({ tag: modell(), auswahl: 56, istJetzt: false, speicher: aussage, art: 'gestern' });
    expect(liste.map((a) => a.frage)).toEqual(['Wie ging es weiter?', 'Was hat es gebracht?']);
    // Dieselbe Aussage wie auf der Erlöse-Seite: der ganze Tag, kein Zwischenstand.
    expect(liste[1].zusatz).toContain('an diesem Tag');
    expect(liste[1].art).toBe('gemessen');
  });

  it('fragt morgen nach dem Abend - ohne Geldzahl, für morgen gibt es keine gemessene', () => {
    const aussage = speicherAussage(tagesGeld(TAG, new Date(MORGEN)), { now: JETZT });
    const liste = antworten({ tag: modell(), auswahl: 56, istJetzt: false, speicher: aussage, art: 'morgen' });
    expect(liste.map((a) => a.frage)).toEqual(['Wie geht es weiter?', 'Reicht der Speicher morgen Abend?']);
    const ohneAbend = modell([['warten', 96]]);
    expect(antwortReicht(ohneAbend, 'morgen')?.antwort).toBe('Morgen Abend ist kein Entladen geplant.');
    expect(antwortBringt(aussage, 'morgen')).toBeNull();
  });
});
