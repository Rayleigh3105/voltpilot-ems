import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Netzanschluss } from '../api';
import { LADEQUELLE } from '../glossar';
import type { GeraetBild } from './bild';
import {
  FREIGABE_STUFE_TEXT, OPTION_SONNE_SPEICHER, UEBERSCHUSS_MODUS, grenzePruefung, hatSpeicherGrenze,
  heutigerAnschluss, ladeQuelle, ladeWahl, ladebudgetKw, lokalesDatum, smartSchritte, speicherZeile,
} from './laden';

function anschluss(bindungen: { anlage: string; ab: string; bis: string | null }[], vereinbart: string | number | null = '200'): Netzanschluss {
  return {
    id: 'na-2', kennzeichen: 'NA-2', name: 'Halle 2', standort: { id: 'st-1', kurzzeichen: 'ST-1' },
    malo: null, netzbetreiber: null, anschluss_kva: null, vereinbart_kw: vereinbart, messung: 'RLM',
    gueltig_ab: null, gueltig_bis: null, hinweise: [], angelegt_am: '2026-01-01T00:00:00Z',
    anlagen: bindungen.map((b, i) => ({ id: `b-${i}`, anlage: { id: b.anlage, name: null }, gueltig_ab: b.ab, gueltig_bis: b.bis })),
  };
}

describe('AP-01 IP-13 · heutiger Netzanschluss', () => {
  it('nimmt nur die heute laufende Bindung der Anlage, letzter Tag eingeschlossen', () => {
    const heute = '2026-10-20';
    expect(heutigerAnschluss([anschluss([{ anlage: 'a', ab: '2026-10-20', bis: null }])], 'a', heute))
      .toEqual({ zustand: 'gebunden', kennzeichen: 'NA-2', vereinbartKw: 200 });
    expect(heutigerAnschluss([anschluss([{ anlage: 'a', ab: '2026-01-01', bis: '2026-10-20' }])], 'a', heute).zustand).toBe('gebunden');
    expect(heutigerAnschluss([anschluss([{ anlage: 'a', ab: '2026-01-01', bis: '2026-10-19' }])], 'a', heute).zustand).toBe('ungebunden');
    expect(heutigerAnschluss([anschluss([{ anlage: 'a', ab: '2026-10-21', bis: null }])], 'a', heute).zustand).toBe('ungebunden');
    expect(heutigerAnschluss([anschluss([{ anlage: 'b', ab: '2026-01-01', bis: null }])], 'a', heute).zustand).toBe('ungebunden');
    expect(heutigerAnschluss([anschluss([{ anlage: 'a', ab: '2026-01-01', bis: null }], null)], 'a', heute))
      .toEqual({ zustand: 'gebunden', kennzeichen: 'NA-2', vereinbartKw: null });
  });

  it('liest das Datum in der Zeit des Browsers', () => {
    expect(lokalesDatum(new Date(2026, 9, 4, 23, 59))).toBe('2026-10-04');
  });
});

describe('AP-01 IP-13 · Grenzprüfung', () => {
  const gebunden = { zustand: 'gebunden', kennzeichen: 'NA-2', vereinbartKw: 200 } as const;

  it('folgt der Reihenfolge des Servers: Anschluss, vereinbarte Leistung, Grundlage, Ladebudget', () => {
    expect(grenzePruefung(180, { zustand: 'fehler' }, null, 96.5, 30)).toMatch(/nicht geprüft werden/);
    expect(grenzePruefung(220, gebunden, null, null, null)).toMatch(/^220\s?kW liegen über 200\s?kW vereinbarter Leistung — bitte prüfen\.$/);
    expect(grenzePruefung(180, gebunden, null, null, 30)).toBe('Für die Prüfung fehlen die Grundlast der letzten 7 Tage oder die Hausreserve.');
    expect(grenzePruefung(120, gebunden, null, 96.5, 30)).toMatch(/kein Ladebudget/);
    expect(grenzePruefung(180, gebunden, null, 96.5, 30)).toBeNull();
  });

  it('prüft ohne Bindung gegen den Übergangswert und schweigt, solange er fehlt', () => {
    expect(grenzePruefung(180, { zustand: 'ungebunden' }, null, 96.5, 30)).toBeNull();
    expect(grenzePruefung(180, { zustand: 'ungebunden' }, 150, 96.5, 30)).toMatch(/über 150\s?kW/);
    expect(grenzePruefung(180, { zustand: 'laden' }, null, 96.5, 30)).toBeNull();
    expect(grenzePruefung(null, gebunden, null, 96.5, 30)).toBeNull();
  });

  it('rechnet das Ladebudget nur mit Grundlast und Hausreserve', () => {
    expect(ladebudgetKw(180, 96.5, 30)).toBe(53.5);
    expect(ladebudgetKw(180, null, 30)).toBeNull();
  });
});


type Stand = Pick<GeraetBild, 'eingriff' | 'steuerart'>;
const stand = (eingriff: unknown, quelle: string | null): Stand =>
  ({ eingriff, steuerart: quelle == null ? null : { quelle, herkunft: 'standard' } }) as unknown as Stand;

describe('Smart an einem Ladepunkt', () => {
  it('macht aus dem Anlagen-Standard „sofort“ die Steuerart Sonne zuerst - sonst bliebe die Karte auf Schnell', () => {
    const g = stand(null, 'sofort');
    expect(ladeWahl(g as GeraetBild)).toBe('schnell');
    expect(smartSchritte(g)).toEqual({ eingriffBeenden: false, steuerart: 'min' });
  });

  it('beendet „Jetzt voll laden“ und lässt eine gewählte Sonnen-Steuerart stehen', () => {
    const g = stand({ art: 'an', bisMs: null }, 'ueberschuss');
    expect(ladeWahl(g as GeraetBild)).toBe('schnell');
    expect(smartSchritte(g)).toEqual({ eingriffBeenden: true, steuerart: null });
  });

  it('erledigt Eingriff UND Steuerart in einem Klick', () => {
    expect(smartSchritte(stand({ art: 'aus', bisMs: null }, 'sofort'))).toEqual({ eingriffBeenden: true, steuerart: 'min' });
  });

  it('tut nichts, wenn der Ladepunkt schon smart lädt', () => {
    const g = stand(null, 'ueberschuss');
    expect(ladeWahl(g as GeraetBild)).toBe('smart');
    expect(smartSchritte(g)).toEqual({ eingriffBeenden: false, steuerart: null });
    expect(smartSchritte(stand(null, null))).toEqual({ eingriffBeenden: false, steuerart: null });
  });
});

// ---------------------------------------------------------------------------
// „Sonne + Speicher“ (06.10.2026)
// ---------------------------------------------------------------------------

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const vektoren = JSON.parse(readFileSync(resolve(V2, 'sonne-speicher-vectors.json'), 'utf8')) as {
  ueberschuss_modus: string[];
  option_id: string;
  box_modes: string[];
  cloud_reasons: string[];
  reserve_kwh: { standard: number; max: number };
};

const mitSteuerart = (steuerart: Record<string, unknown> | null): GeraetBild =>
  ({ eingriff: null, steuerart }) as unknown as GeraetBild;

describe('Sonne + Speicher: das Vokabular ist das der Vertragsvektoren', () => {
  it('schreibt genau die Überschuss-Modi, die API, Box und Optimierer kennen', () => {
    expect(Object.values(UEBERSCHUSS_MODUS).sort()).toEqual([...vektoren.ueberschuss_modus].sort());
    expect(UEBERSCHUSS_MODUS.speicher).toBe('speicher');
    expect(OPTION_SONNE_SPEICHER).toBe(vektoren.option_id);
  });

  it('hat für jede Stufe, die die API durchreicht, einen Satz - und keinen erfundenen', () => {
    // `aus` meldet die Box nie (es ist die Abwesenheit der Quelle).
    const woerter = [...vektoren.box_modes.filter((m) => m !== 'aus'), ...vektoren.cloud_reasons];
    for (const w of woerter) expect(FREIGABE_STUFE_TEXT[w], w).toBeTruthy();
    expect(Object.keys(FREIGABE_STUFE_TEXT).sort()).toEqual([...woerter].sort());
  });

  it('nennt die Quelle mit dem Glossar-Wort', () => {
    expect(LADEQUELLE.speicher).toBe('Sonne + Speicher');
  });
});

describe('Sonne + Speicher: die Quelle lesen', () => {
  it('liest den Modus speicher als eigene Quelle, ohne die vorhandenen zu verschieben', () => {
    expect(ladeQuelle(mitSteuerart({ quelle: 'ueberschuss', ueberschussModus: 'speicher' }))).toBe('speicher');
    expect(ladeQuelle(mitSteuerart({ quelle: 'ueberschuss', ueberschussModus: 'pausieren' }))).toBe('sonne');
    expect(ladeQuelle(mitSteuerart({ quelle: 'ueberschuss', ueberschussModus: 'mindestleistung' }))).toBe('min');
    // Gespeicherte Einstellungen ohne Modus bleiben „Nur Sonne“.
    expect(ladeQuelle(mitSteuerart({ quelle: 'ueberschuss' }))).toBe('sonne');
    expect(ladeQuelle(mitSteuerart({ quelle: 'guenstig' }))).toBe('guenstig');
  });
});

describe('Sonne + Speicher: die Erklärzeile zeigt nur Belegtes', () => {
  const NOW_MS = Date.parse('2026-10-06T10:00:00Z');
  const frisch = '2026-10-06T09:59:00Z';

  it('12:00, sonnig: die Box gibt frei - Leistung, Untergrenze und Ladestand aus ihrer Meldung', () => {
    const z = speicherZeile({ active: true, kw: 3.8, floorSocPct: 22, socPct: 80, mode: 'frei', note: 'Satz der Box' }, 22, frisch, NOW_MS);
    expect(z).toContain('bis 3,8 kW');
    expect(z).toContain('bis 22 % entladen');
    expect(z).toContain('(jetzt 80 %)');
  });

  it('nennt keinen Ladestand, den die Box nicht gemeldet hat - unbekannt ist keine Null', () => {
    const z = speicherZeile({ active: true, kw: 2, floorSocPct: 40, socPct: null, mode: 'frei' }, null, frisch, NOW_MS);
    expect(z).not.toContain('jetzt');
    expect(z).not.toMatch(/\b0 %/);
  });

  it('beobachteter Speicher: dieselben Zahlen, und ehrlich, dass VoltPilot ihn nicht steuert', () => {
    const z = speicherZeile({ active: true, kw: 3.8, floorSocPct: 30, socPct: 80, mode: 'frei_beobachtet', note: 'Satz der Box' }, 30, frisch, NOW_MS);
    expect(z).toContain('bis 3,8 kW');
    expect(z).toContain('bei 30 %');
    expect(z).toContain('(jetzt 80 %)');
    expect(z).toContain('steuert den Speicher dabei nicht, sondern beobachtet ihn');
    expect(z).toContain('nimmt die Box die Freigabe zurück');
    // Die Zeile des GESTEUERTEN Speichers behauptet das nicht.
    const gesteuert = speicherZeile({ active: true, kw: 3.8, floorSocPct: 30, socPct: 80, mode: 'frei' }, 30, frisch, NOW_MS);
    expect(gesteuert).not.toContain('beobachtet');
    // Ohne Zahlen der Satz des Vokabulars - nie eine erfundene Leistung.
    expect(speicherZeile({ active: true, mode: 'frei_beobachtet' }, null, frisch, NOW_MS)).toBe(FREIGABE_STUFE_TEXT.frei_beobachtet);
  });

  it('gesteuerter Speicher ohne bestätigte Rückmeldung: der Satz der Box', () => {
    const satz = 'VoltPilot steuert den Speicher, aber ohne bestätigte Rückmeldung des Wechselrichters ist offen, was er gerade ausführt – es lädt nur mit Sonnenstrom.';
    expect(speicherZeile({ active: false, mode: 'speicherpfad', note: satz }, 30, frisch, NOW_MS)).toBe(satz);
  });

  it('20:00: an der Untergrenze bleibt der Speicher für das Haus', () => {
    const z = speicherZeile({ active: false, floorSocPct: 64.5, socPct: 64, mode: 'an_der_grenze' }, 64.5, frisch, NOW_MS);
    expect(z).toContain('Untergrenze von 64,5 %');
    expect(z).toContain('nur mit Sonnenstrom');
  });

  it('veraltete oder fehlende Prognose: der Satz der Box, sonst der des Vokabulars', () => {
    const satz = 'Die Prognose für Last oder Sonne ist veraltet oder fehlt – ohne sie keine Freigabe, nur Sonnenstrom.';
    expect(speicherZeile({ active: false, mode: 'prognose_veraltet', note: satz }, null, frisch, NOW_MS)).toBe(satz);
    expect(speicherZeile({ active: false, mode: 'prognose_veraltet' }, null, frisch, NOW_MS)).toBe(FREIGABE_STUFE_TEXT.prognose_veraltet);
    // Ohne Freigabe erzählt die Zeile auch keine Untergrenze des Plans.
    expect(speicherZeile({ active: false, mode: 'kein_plan' }, 30, frisch, NOW_MS)).toBe(FREIGABE_STUFE_TEXT.kein_plan);
  });

  it('eine veraltete Meldung der Box gilt nicht als aktuell', () => {
    const z = speicherZeile({ active: true, kw: 3, floorSocPct: 20, socPct: 70, mode: 'frei' }, 20, '2026-10-06T09:30:00Z', NOW_MS);
    expect(z).toContain('nicht bekannt');
    expect(z).not.toContain('3,0 kW');
    expect(z).toContain('Laut Fahrplan dürfte er jetzt bis 20 % entladen');
  });

  it('ohne Meldung der Box spricht der Fahrplan - als Plan, nicht als Wirkung', () => {
    const z = speicherZeile(null, 35, frisch, NOW_MS);
    expect(z).toContain('Laut Fahrplan darf der Speicher jetzt bis 35 % entladen');
    expect(z).toContain('meldet sie noch nicht');
    expect(speicherZeile(null, null, null, NOW_MS)).toBe('Lädt mit Sonnenstrom und gibt dazu, was der Speicher bis zur nächsten Sonne nicht braucht.');
  });
});

describe('Sonne + Speicher: das Band der Untergrenze', () => {
  it('zeigt das Band nur, wenn der Fahrplan im Fenster eine Untergrenze trägt', () => {
    const g: (number | null)[] = [null, null, 30, null];
    expect(hatSpeicherGrenze(undefined, 0, 4)).toBe(false);
    expect(hatSpeicherGrenze(g, 0, 2)).toBe(false);
    expect(hatSpeicherGrenze(g, 0, 3)).toBe(true);
  });
});
