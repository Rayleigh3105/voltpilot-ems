import { describe, expect, it } from 'vitest';
import type { CommandHistory } from './api';
import type { BefehlZeile } from './befehle';
import {
  abfrage,
  aktiv,
  ausUrl,
  CHIPS,
  filterNamen,
  inUrl,
  LEER,
  leerMitFilter,
  mehrMoeglich,
  suche,
  sucheHinweis,
  trefferSatz,
  umschalten,
  vortag,
  type BefehlFilter,
} from './befehleFilter';

/**
 * Die REINE Ableitung der Befehls-SUCHE (Geräteseiten Revision B §6).
 *
 * Geprüft wird, was die Fläche nicht selbst entscheiden darf: welche Wörter
 * gelten, was der Zähler sagt, worin der Freitext sucht - und wo geschwiegen
 * wird, weil nichts belegt ist.
 */

const HEUTE = '2026-08-21';

function f(patch: Partial<BefehlFilter> = {}): BefehlFilter {
  return { ...LEER, ...patch };
}

function history(patch: Partial<CommandHistory> = {}): CommandHistory {
  return {
    recordingSince: '2026-08-01T00:00:00Z',
    accuracySeconds: 15,
    from: '2026-08-21T00:00:00Z',
    to: '2026-08-21T12:00:00Z',
    entityId: null,
    entityLabel: null,
    writes: true,
    truncated: false,
    total: 212,
    matched: 212,
    nextBefore: null,
    entries: [],
    control: null,
    curtailment: null,
    ...patch,
  } as CommandHistory;
}

function zeile(patch: Partial<BefehlZeile> = {}): BefehlZeile {
  return {
    id: 1,
    art: 'periode',
    zeit: '10:00–10:30',
    satz: 'Laden mit 4,3 kW — Fahrplan.',
    urteil: 'vom Gerät bestätigt',
    ton: 'ok',
    laufend: false,
    roh: [],
    herkunft: 'aus dem Gerätestatus abgeleitet',
    strom: 'Speicher',
    ...patch,
  };
}

describe('Zustand ↔ URL', () => {
  it('liest einen leeren Hash als „heute, ohne Einschränkung"', () => {
    expect(ausUrl('#/anlage/s-1/befehle')).toEqual(LEER);
  });

  it('trägt den ganzen Filter durch die Adresse - ein Support-Link ist vollständig', () => {
    const gesetzt = f({
      zeitraum: 'monat',
      stroeme: ['batterie', 'register'],
      herkunft: ['portal'],
      ergebnis: ['abweichend'],
      q: '0x00E7',
    });
    const url = inUrl('#/anlage/s-1/befehle?geraet=inverter', gesetzt);
    expect(url).toContain('geraet=inverter');
    expect(ausUrl(url)).toEqual(gesetzt);
  });

  it('lässt die Vorgabe WEG - eine Adresse ohne Filter sieht auch so aus', () => {
    expect(inUrl('#/anlage/s-1/befehle', LEER)).toBe('#/anlage/s-1/befehle');
  });

  it('räumt einen zurückgesetzten Filter aus der Adresse', () => {
    const gesetzt = inUrl('#/anlage/s-1/befehle', f({ stroeme: ['batterie'], q: 'x' }));
    expect(inUrl(gesetzt, LEER)).toBe('#/anlage/s-1/befehle');
  });

  /**
   * Eine URL kommt aus einem Lesezeichen oder einem Support-Link. Ein Wort, das
   * dieser Portal-Stand nicht kennt, wird VERWORFEN - der Rest des Links bleibt
   * gültig, statt in eine Server-Ablehnung zu laufen.
   */
  it('verwirft ein unbekanntes Wort und behält den Rest', () => {
    const gelesen = ausUrl('#/x?strom=batterie,quatsch&ergebnis=erfunden&zeitraum=irgendwann');
    expect(gelesen.stroeme).toEqual(['batterie']);
    expect(gelesen.ergebnis).toEqual([]);
    expect(gelesen.zeitraum).toBe('heute');
  });

  it('nimmt einen eigenen Zeitraum nur als vollständige Kalendertage', () => {
    const gut = ausUrl('#/x?zeitraum=eigen&von=2026-08-01&bis=2026-08-05');
    expect(gut).toMatchObject({ zeitraum: 'eigen', von: '2026-08-01', bis: '2026-08-05' });
    expect(ausUrl('#/x?zeitraum=eigen&von=gestern').von).toBeNull();
  });
});

describe('Zustand → Server-Parameter', () => {
  it('bildet die vier Zeiträume auf das ab, was der Server kennt', () => {
    expect(abfrage(f(), HEUTE)).toMatchObject({ range: 'day', at: null });
    expect(abfrage(f({ zeitraum: 'gestern' }), HEUTE)).toMatchObject({
      range: 'day',
      at: '2026-08-20',
    });
    expect(abfrage(f({ zeitraum: 'woche' }), HEUTE).range).toBe('week');
    expect(abfrage(f({ zeitraum: 'monat' }), HEUTE).range).toBe('month');
  });

  it('schickt einen eigenen Zeitraum erst, wenn BEIDE Tage dastehen', () => {
    const halb = abfrage(f({ zeitraum: 'eigen', von: '2026-08-01' }), HEUTE);
    expect(halb.from).toBeNull();
    expect(halb.range).toBe('day');
    const ganz = abfrage(f({ zeitraum: 'eigen', von: '2026-08-01', bis: '2026-08-05' }), HEUTE);
    expect(ganz).toMatchObject({ from: '2026-08-01', to: '2026-08-05' });
  });

  it('schickt eine leere Auswahl als NICHTS, nie als leere Liste', () => {
    const q = abfrage(f(), HEUTE);
    expect(q.streams).toBeNull();
    expect(q.sources).toBeNull();
    expect(q.verdicts).toBeNull();
    expect(abfrage(f({ stroeme: ['batterie', 'register'] }), HEUTE).streams)
      .toBe('batterie,register');
  });

  it('rechnet den Vortag über Monats- und Jahresgrenzen', () => {
    expect(vortag('2026-03-01')).toBe('2026-02-28');
    expect(vortag('2026-01-01')).toBe('2025-12-31');
  });
});

describe('Der FREITEXT läuft über die ANGEZEIGTEN Sätze', () => {
  const zeilen = [
    zeile({ id: 1, satz: 'Laden mit 4,3 kW — Fahrplan.' }),
    zeile({
      id: 2,
      satz: 'Register geschrieben.',
      strom: 'Register',
      urteil: null,
      roh: [{ label: 'Eingetippte Adresse', wert: '0x00E7' }],
    }),
    zeile({ id: 3, satz: 'Einspeisung begrenzt auf 17,6 kW.', strom: 'Einspeise-Begrenzung' }),
  ];

  it('findet über den Satz, das Etikett und den Roh-Blick', () => {
    expect(suche(zeilen, 'laden').map((z) => z.id)).toEqual([1]);
    expect(suche(zeilen, '0x00e7').map((z) => z.id)).toEqual([2]);
    expect(suche(zeilen, 'einspeise').map((z) => z.id)).toEqual([3]);
  });

  it('verlangt ALLE Wörter, in beliebiger Reihenfolge', () => {
    expect(suche(zeilen, 'kw fahrplan').map((z) => z.id)).toEqual([1]);
    expect(suche(zeilen, 'fahrplan register')).toEqual([]);
  });

  it('lässt eine leere Eingabe alles stehen', () => {
    expect(suche(zeilen, '   ')).toHaveLength(3);
  });
});

describe('Der TREFFER-SATZ nennt beide Zahlen', () => {
  it('sagt nur die Gesamtzahl, solange kein Filter greift', () => {
    expect(trefferSatz(history(), LEER, 212)).toBe('212 Zeilen');
  });

  /** Ohne die 212 wäre ein scharfer Filter von einem leeren Zeitraum nicht zu unterscheiden. */
  it('nennt bei gesetztem Filter BEIDE Zahlen und die Filter-Namen', () => {
    const satz = trefferSatz(history({ matched: 14 }), f({ stroeme: ['batterie'], ergebnis: ['abweichend'] }), 14);
    expect(satz).toContain('14 von 212 Zeilen');
    expect(satz).toContain('Speicher');
    expect(satz).toContain('Das Gerät meldet etwas anderes');
  });

  it('nennt beim Freitext, WORIN gesucht wurde', () => {
    const satz = trefferSatz(history({ matched: 14 }), f({ q: '0x00E7' }), 3);
    expect(satz).toContain('3 von 14 durchsuchten Zeilen');
    expect(satz).toContain('„0x00E7"');
  });

  /** Ein älteres Backend meldet keine Zahlen - dann wird keine Bilanz erfunden. */
  it('sagt ohne Server-Zahlen GAR NICHTS', () => {
    const alt = history();
    delete (alt as { total?: number }).total;
    delete (alt as { matched?: number }).matched;
    expect(trefferSatz(alt, LEER, 0)).toBeNull();
    expect(trefferSatz(null, LEER, 0)).toBeNull();
  });
});

describe('Leere Ergebnisse nennen ihren Grund', () => {
  it('sagt bei gesetztem Filter, wie viele Zeilen der Zeitraum trägt', () => {
    const satz = leerMitFilter(history({ matched: 0 }), f({ ergebnis: ['abweichend'] }));
    expect(satz).toContain('212 Zeilen in diesem Zeitraum');
    expect(satz).toContain('Das Gerät meldet etwas anderes');
  });

  it('behauptet ohne Filter nichts - das gehört `befehle.leerSatz`', () => {
    expect(leerMitFilter(history(), LEER)).toBeNull();
  });

  it('sagt bei einem wirklich leeren Zeitraum genau das', () => {
    expect(leerMitFilter(history({ total: 0, matched: 0 }), f({ q: 'x' })))
      .toBe('In diesem Zeitraum liegt nichts vor.');
  });
});

describe('Die Suche SAGT, worin sie sucht', () => {
  it('nennt den Zeitraum, solange nichts gekappt ist', () => {
    expect(sucheHinweis(history(), 212)).toContain('212 Zeilen dieses Zeitraums');
  });

  it('sagt bei gekappter Liste, dass ältere noch nicht geladen sind', () => {
    expect(sucheHinweis(history({ truncated: true }), 500)).toContain('noch nicht geladen');
  });
});

describe('Kleinkram', () => {
  it('zählt die aktiven Filter für den Telefon-Knopf', () => {
    expect(aktiv(LEER)).toBe(0);
    expect(aktiv(f({ zeitraum: 'woche', stroeme: ['batterie'], q: 'x' }))).toBe(3);
  });

  it('schaltet einen Wert an und wieder aus', () => {
    expect(umschalten([], 'batterie')).toEqual(['batterie']);
    expect(umschalten(['batterie', 'register'], 'batterie')).toEqual(['register']);
  });

  it('bietet „mehr laden" nur an, wo der Server eine Seite dahinter meldet', () => {
    expect(mehrMoeglich(history())).toBe(false);
    expect(mehrMoeglich(history({ nextBefore: '2026-08-21T08:00:00Z' }))).toBe(true);
    expect(mehrMoeglich(null)).toBe(false);
  });

  it('nennt jeden gesetzten Filter beim Namen', () => {
    expect(filterNamen(f({ zeitraum: 'monat', herkunft: ['geraet'] })))
      .toEqual(['Dieser Monat', 'Vom Gerät gemeldet']);
  });

  /** Die drei Schnell-Chips sind die drei Fragen der Support-Fälle. */
  it('hat drei Schnell-Chips, die je genau EINEN Filter setzen', () => {
    expect(CHIPS).toHaveLength(3);
    CHIPS.forEach((c) => expect(Object.keys(c.patch)).toHaveLength(1));
  });
});
