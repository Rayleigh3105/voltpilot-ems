import { describe, expect, it } from 'vitest';
import type { ScheduleSlot } from './api';
import {
  bisMorgenFrueh,
  BLEIBT_GLEICH,
  DAUERN,
  endeVon,
  handeingriffFolgen,
  KEIN_FAHRPLAN,
  KEIN_PREIS,
  pauseBanner,
  PLAN_ZU_KURZ,
  planVerzicht,
  speicherAktionen,
  speicherKeinEingriff,
  verzichtSatz,
} from './handeingriff';

const NOW = new Date('2026-08-25T12:00:00Z');

function slot(startIso: string, batteryKw: number | null, preis: number | null): ScheduleSlot {
  return {
    start: startIso,
    batteryKw,
    gridKw: null,
    socPct: null,
    priceEurMwh: null,
    costEur: null,
    baselineCostEur: null,
    importPriceCtKwh: preis,
  } as unknown as ScheduleSlot;
}

/** Vier Viertelstunden ab 12:00 mit je 4 kW Entladung und 32 ct Bezugspreis. */
function stunde(batteryKw = -4, preis: number | null = 32): ScheduleSlot[] {
  return [0, 15, 30, 45].map((m) =>
    slot(new Date(NOW.getTime() + m * 60_000).toISOString(), batteryKw, preis));
}

describe('Die Zahl der Folgen-Karte wird NIE erfunden', () => {
  it('rechnet den Verzicht aus den Fahrplan-Slots des Fensters', () => {
    // 4 × 4 kW × 0,25 h = 4 kWh Entladung; 4 kWh × 32 ct = 1,28 €.
    const v = planVerzicht(stunde(), NOW, new Date(NOW.getTime() + 60 * 60_000));
    expect(v.entladenKwh).toBeCloseTo(4, 6);
    expect(v.geladenKwh).toBe(0);
    expect(v.eur).toBeCloseTo(1.28, 6);
    expect(v.grund).toBeNull();
    expect(verzichtSatz(v)).toContain('4,0\u00a0kWh geplante Entladung');
    expect(verzichtSatz(v)).toContain('1,28');
  });

  it('nennt „nicht abschätzbar" MIT Grund statt einer Null', () => {
    const ende = new Date(NOW.getTime() + 60 * 60_000);
    expect(planVerzicht(null, NOW, ende).grund).toBe(KEIN_FAHRPLAN);
    expect(planVerzicht([], NOW, ende).grund).toBe(KEIN_FAHRPLAN);
    for (const leer of [null, [], undefined]) {
      const v = planVerzicht(leer as ScheduleSlot[] | null, NOW, ende);
      expect(v.eur).toBeNull();
      expect(verzichtSatz(v)).toContain('nicht abschätzbar');
    }
  });

  it('⚠ ein Slot OHNE Preis macht die GANZE Zahl unbestimmbar', () => {
    // Sonst käme eine zu kleine Zahl heraus, die wie eine echte aussieht.
    const slots = stunde();
    slots[2] = slot(slots[2].start, -4, null);
    const v = planVerzicht(slots, NOW, new Date(NOW.getTime() + 60 * 60_000));
    expect(v.eur).toBeNull();
    expect(v.grund).toBe(KEIN_PREIS);
  });

  it('⚠ ein Plan, der das Fenster nicht abdeckt, liefert keine Teilsumme', () => {
    // Eine Stunde Plan, aber vier Stunden Eingriff.
    const v = planVerzicht(stunde(), NOW, new Date(NOW.getTime() + 4 * 60 * 60_000));
    expect(v.eur).toBeNull();
    expect(v.grund).toBe(PLAN_ZU_KURZ);
  });

  it('ein Fahrplan, der den Speicher ohnehin ruhen lässt, sagt genau das', () => {
    const v = planVerzicht(stunde(0), NOW, new Date(NOW.getTime() + 60 * 60_000));
    expect(v.eur).toBe(0);
    expect(v.grund).toBeNull();
    expect(verzichtSatz(v)).toContain('ohnehin nichts');
  });

  it('trennt geplante Ladung von geplanter Entladung', () => {
    const v = planVerzicht(stunde(6), NOW, new Date(NOW.getTime() + 60 * 60_000));
    expect(v.geladenKwh).toBeCloseTo(6, 6);
    expect(v.entladenKwh).toBe(0);
    expect(verzichtSatz(v)).toContain('geplante Ladung');
  });
});

describe('Die Dauer ist eine Wahl, nie eine Vorgabe', () => {
  it('bietet die fünf Dauern des Konzepts an, „bis morgen früh" inklusive', () => {
    expect(DAUERN.map((d) => d.key)).toEqual(['30m', '1h', '2h', '4h', 'morgen']);
    expect(DAUERN.find((d) => d.key === 'morgen')!.minutes).toBeNull();
  });

  it('löst jede Dauer zu einem absoluten Ende auf', () => {
    const zweiStunden = DAUERN.find((d) => d.key === '2h')!;
    expect(endeVon(zweiStunden, NOW).getTime()).toBe(NOW.getTime() + 2 * 60 * 60_000);
    const morgen = endeVon(DAUERN.find((d) => d.key === 'morgen')!, NOW);
    expect(morgen.getTime()).toBeGreaterThan(NOW.getTime());
    expect(morgen.getHours()).toBe(6);
    expect(bisMorgenFrueh(NOW).getDate()).toBe(new Date(NOW).getDate() + 1);
  });
});

describe('Die Folgen-Karte (§3.5: vier feste Blöcke)', () => {
  const verzicht = planVerzicht(stunde(), NOW, new Date(NOW.getTime() + 60 * 60_000));

  it('„Ladestand halten" nennt Stand, Ende, Verzicht und den Rückweg', () => {
    const k = handeingriffFolgen({
      aktion: 'speicher_halten', endeText: '18:00 Uhr', socPct: 72, verzicht,
    });
    const alles = k.bloecke.flatMap((b) => b.zeilen).join(' ');
    expect(alles).toContain('lädt und entlädt nicht');
    expect(alles).toContain('72');
    expect(alles).toContain('18:00 Uhr');
    expect(alles).toContain('geplante Entladung');
    expect(alles).toContain('früher beenden');
    expect(k.bloecke.map((b) => b.key))
      .toEqual(['passiert', 'fahrplan', 'risiko', 'gleich', 'ende']);
  });

  it('„Speicher jetzt laden" sagt die EEG-Regel, ohne sie zu versprechen', () => {
    const k = handeingriffFolgen({
      aktion: 'speicher_laden', endeText: '15:00 Uhr', leistungKw: 11, verzicht,
    });
    const alles = k.bloecke.flatMap((b) => b.zeilen).join(' ');
    expect(alles).toContain('11,0\u00a0kW');
    // Die Entscheidung fällt auf dem Gerät - der Satz behauptet nie, dass aus
    // dem Netz geladen WIRD.
    expect(alles).toContain('nur geladen, wenn Ihre Anlage das darf');
    expect(alles).toContain('Solar-Überschuss');
  });

  it('„Automatik pausieren" nennt den Eigenverbrauch und den sicheren Zustand', () => {
    const k = handeingriffFolgen({ aktion: 'pause', endeText: '06:00 Uhr', verzicht });
    const alles = k.bloecke.flatMap((b) => b.zeilen).join(' ');
    expect(alles).toContain('Fahrplan und Regeln ruhen');
    expect(alles).toContain('Eigenverbrauch');
    expect(alles).toContain('sicheren Zustand');
  });

  it('⚠ „Das bleibt gleich" nennt genau die Grenzen, die ein Eingriff strukturell nicht erreicht', () => {
    for (const aktion of ['speicher_halten', 'speicher_laden', 'pause', 'resume'] as const) {
      const k = handeingriffFolgen({ aktion, endeText: '18:00 Uhr', verzicht });
      const gleich = k.bloecke.find((b) => b.key === 'gleich')!;
      expect(gleich.zeilen).toEqual(BLEIBT_GLEICH);
      expect(gleich.zeilen.join(' ')).toContain('§ 14a');
      expect(gleich.zeilen.join(' ')).toContain('Einspeisegrenze');
    }
  });

  it('die Rücknahme braucht keine Fahrplan-Vorschau', () => {
    const k = handeingriffFolgen({ aktion: 'resume', endeText: '—', verzicht });
    expect(k.bloecke.map((b) => b.key)).toEqual(['passiert', 'gleich', 'ende']);
  });

  it('behauptet ohne Ladestand und ohne Leistung keine Zahl', () => {
    const halten = handeingriffFolgen({
      aktion: 'speicher_halten', endeText: '18:00 Uhr', socPct: null, verzicht,
    });
    expect(halten.bloecke[0].zeilen[0]).not.toMatch(/\(\s*\)/);
    const laden = handeingriffFolgen({
      aktion: 'speicher_laden', endeText: '18:00 Uhr', leistungKw: null, verzicht,
    });
    expect(laden.bloecke[0].zeilen[0]).not.toContain('bis zu ');
  });
});

describe('Welche Handlungen eine Speicher-Zeile anbietet', () => {
  it('bietet beide Eingriffe an einer steuerbaren Anlage', () => {
    expect(speicherAktionen({ laufend: false, steuerbar: true, pausiert: false }))
      .toEqual(['speicher_laden', 'speicher_halten']);
    expect(speicherKeinEingriff({ laufend: false, steuerbar: true, pausiert: false }))
      .toBeNull();
  });

  it('bietet bei einem laufenden Eingriff nur den Rückweg', () => {
    expect(speicherAktionen({ laufend: true, steuerbar: true, pausiert: false }))
      .toEqual(['resume']);
  });

  it('⚠ ein LAUFENDER Eingriff bietet seinen Rückweg IMMER an', () => {
    // Wer eingegriffen hat, muss ihn zurücknehmen können - auch wenn die
    // Anlage inzwischen nicht mehr steuerbar wirkt oder pausiert. Eine
    // gefangene Handlung wäre schlimmer als gar keine.
    for (const rest of [{ steuerbar: false, pausiert: false },
      { steuerbar: true, pausiert: true },
      { steuerbar: false, pausiert: true }]) {
      expect(speicherAktionen({ laufend: true, ...rest })).toEqual(['resume']);
      expect(speicherKeinEingriff({ laufend: true, ...rest })).toBeNull();
    }
  });

  it('⚠ ein Knopf, der nichts bewirken kann, wird NICHT angeboten — der Grund steht da', () => {
    expect(speicherAktionen({ laufend: false, steuerbar: false, pausiert: false })).toEqual([]);
    expect(speicherKeinEingriff({ laufend: false, steuerbar: false, pausiert: false }))
      .toContain('steuert diesen Speicher noch nicht');
    // Während einer Anlagen-Pause ist die Pause DER Eingriff.
    expect(speicherAktionen({ laufend: false, steuerbar: true, pausiert: true })).toEqual([]);
    expect(speicherKeinEingriff({ laufend: false, steuerbar: true, pausiert: true }))
      .toContain('pausiert gerade');
  });
});

describe('Das Banner der Anlagen-Pause', () => {
  it('nennt Ende und Restzeit', () => {
    expect(pauseBanner('06:00 Uhr', '3 Std. 12 Min.'))
      .toBe('Automatik pausiert bis 06:00 Uhr (noch 3 Std. 12 Min.)');
  });

  it('behauptet ohne Restzeit keine', () => {
    expect(pauseBanner('06:00 Uhr', null)).toBe('Automatik pausiert bis 06:00 Uhr');
  });
});
