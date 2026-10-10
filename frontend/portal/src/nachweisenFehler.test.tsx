/**
 * Konzept Nachweisen n1, PR 0 (die Fehler zuerst): Rechte-Satz (Befund 2), PDF und CSV an jedem Stand (Befund 1), eine
 * Uhr (Befund 3), Vergleich ohne „null“ (Befund 5), das Wort der Vorlage (Inventur C6, B10), Datei-Abrufe mit dem
 * Kundenbereich (A16).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bericht } from './api';
import { freigebenErklaerung, freigebenWer, FREIGEBEN_NUR_MIT_RECHT, seitenHebel } from './berichtDialoge';
import { abschnitte, abzugAus, berichtTitel, darfAusgabe, ausgabeKnoepfe, type Abschnitt, type Ansicht } from './berichtSeite';
import { erklaerWoerter, ERKLAER_WOERTER_HOECHSTENS, woerter } from './components/nachweisen/erklaerung';
import { merkeAugenblick, routenHeute, tagDesAugenblicks, vergissAbruf } from './routenUhr';
import { ABZUG_NR1, berichtAm, detailAm, entwurfAm, standAm } from './test/berichtFixtures';
import * as B from './uemsBericht';

const am = (iso: string) => Date.parse(iso);
const NR1 = am('2026-11-13T08:00:00Z');
const INES = { standorte: new Map([[berichtAm(NR1).geltung_id, ['bericht.standort_abrufen', 'bericht.standort_freigeben', 'export.standort']]]), unternehmen: [] as string[] };
const CLAUDIA = { standorte: new Map([[berichtAm(NR1).geltung_id, ['bericht.standort_abrufen']]]), unternehmen: [] as string[] };

describe('Befund 2: kein Rechte-Satz am Stand, am Entwurf ohne Recht wer freigibt', () => {
  it('am freigegebenen Stand gibt es nichts freizugeben, also keinen Hinweis - auch nicht für Leser', () => {
    expect(seitenHebel(detailAm(NR1), null, CLAUDIA, NR1).ohneRecht).toBe(false);
    expect(seitenHebel(detailAm(NR1), null, INES, NR1).ohneRecht).toBe(false);
  });

  it('am Entwurf: mit Recht der Knopf, ohne Recht die Zeile statt des Knopfs', () => {
    expect(seitenHebel(detailAm(NR1), entwurfAm(NR1), INES, NR1)).toMatchObject({ ohneRecht: false });
    expect(seitenHebel(detailAm(NR1), entwurfAm(NR1), CLAUDIA, NR1)).toMatchObject({ freigeben: null, ohneRecht: true });
  });

  it('die Zeile nennt die Kundenadministratoren, höchstens acht Wörter; Grund und Weg im Erklär-Blatt', () => {
    expect(freigebenWer(['Jonas Wendlinger'])).toBe('Freigeben: Jonas Wendlinger');
    expect(freigebenWer([])).toBe(FREIGEBEN_NUR_MIT_RECHT);
    for (const zeile of [freigebenWer(['Jonas Wendlinger', 'Ines Kaltenbach']), FREIGEBEN_NUR_MIT_RECHT]) {
      expect(woerter(zeile)).toBeLessThanOrEqual(8);
    }
    const blatt = freigebenErklaerung(['Jonas Wendlinger']);
    expect(blatt.beiIhnen).toBe('Jonas Wendlinger gibt frei oder vergibt das Recht.');
    expect(blatt.klartext).toBe('Freigeben darf, wer bei Ihnen das Recht dazu hat. Vergeben kann es Ihr Kundenadministrator.');
    expect(freigebenErklaerung(['A B', 'C D'])).toMatchObject({
      klartext: 'Freigeben darf, wer bei Ihnen das Recht dazu hat. Vergeben können es Ihre Kundenadministratoren.',
      beiIhnen: 'A B und C D geben frei oder vergeben das Recht.',
    });
    expect(freigebenErklaerung([]).beiIhnen).toBeNull();
    expect(erklaerWoerter(blatt)).toBeLessThanOrEqual(ERKLAER_WOERTER_HOECHSTENS);
    expect(JSON.stringify(blatt)).not.toContain('Dafür fehlt Ihnen das Recht');
  });
});

describe('Befund 1: PDF und CSV an jedem Stand', () => {
  const b = berichtAm(NR1);
  const stand: Ansicht = { art: 'stand', stand: standAm(1, NR1) };

  it('PDF nach dem Lesen, CSV mit `export.standort` an der Geltung; ein Entwurf ist nie eine Datei', () => {
    expect(ausgabeKnoepfe(b, stand, darfAusgabe(b, INES)).map((k) => [k.text, k.datei])).toEqual([
      ['PDF', 'bericht-BR-2026-0001-nr1.pdf'],
      ['CSV', 'bericht-BR-2026-0001-nr1.csv'],
    ]);
    expect(ausgabeKnoepfe(b, stand, darfAusgabe(b, CLAUDIA)).map((k) => k.text)).toEqual(['PDF']);
    expect(ausgabeKnoepfe(b, { art: 'entwurf', entwurf: entwurfAm(NR1) }, darfAusgabe(b, INES))).toEqual([]);
  });

  it('ohne Selbstauskunft bleibt das CSV unbekannt; die Managementbewertung hat keins, die Bewertung braucht ihr Recht', () => {
    expect(ausgabeKnoepfe(b, stand, darfAusgabe(b, null)).map((k) => k.text)).toEqual(['PDF']);
    const mb: Bericht = { ...b, vorlage: B.MANAGEMENTBEWERTUNG, geltung_art: 'unternehmen' };
    expect(darfAusgabe(mb, { standorte: new Map(), unternehmen: ['export.unternehmen'] })('export.unternehmen')).toBe(false);
    const bewertung: Bericht = { ...b, vorlage: 'energetische_bewertung', geltung_art: 'unternehmen' };
    expect(darfAusgabe(bewertung, { standorte: new Map(), unternehmen: ['bewertung.abrufen'] })('export.unternehmen')).toBe(true);
    expect(darfAusgabe(bewertung, { standorte: new Map(), unternehmen: ['export.unternehmen'] })('export.unternehmen')).toBe(false);
  });
});

describe('C6/B10: das Wort der Vorlage im Titel', () => {
  const b = berichtAm(NR1);
  it('Monatsbericht nach dem Zeitraum, sonst der Name der Vorlage', () => {
    expect(berichtTitel(b)).toBe('Monatsbericht Werk Ahrenberg Oktober 2026');
    expect(berichtTitel({ ...b, vorlage: B.MANAGEMENTBEWERTUNG, zeitraum_art: 'jahr', geltung_name: 'Kunststoffwerk Ahrenberg GmbH', zeitraum_text: '2028' }))
      .toBe('Managementbewertung Kunststoffwerk Ahrenberg GmbH 2028');
    expect(berichtTitel({ ...b, vorlage: 'energetische_bewertung', zeitraum_art: 'datengrundlage', geltung_name: 'Kunststoffwerk Ahrenberg GmbH', zeitraum_text: B.zeitraumName('datengrundlage', '2025-10/2026-09') }))
      .toBe('Energetische Bewertung Kunststoffwerk Ahrenberg GmbH Oktober 2025 bis September 2026');
    expect(berichtTitel({ ...b, vorlage: B.LEISTUNGSVERGLEICH })).toBe('Leistungsvergleich Werk Ahrenberg Oktober 2026');
  });
});

describe('Befund 5: eine Quelle ohne Wert hat keine Version', () => {
  it('keine „Version null“ in der Zeile und keine „Version 0“ im Quellenverzeichnis', () => {
    const roh = structuredClone(ABZUG_NR1) as unknown as { werte: Array<Record<string, unknown>> };
    const ohne = roh.werte.find((w) => w.quelle === 'MS-12')!;
    Object.assign(ohne, { menge: null, version: null, berechnet_am: null, zustand: 'keine Werte', fassung: null, endgueltig_ab: null });
    const liste = abschnitte(abzugAus(roh as never)).abschnitte;
    const ms = liste.find((a): a is Extract<Abschnitt, { art: 'messstellen' }> => a.art === 'messstellen')!;
    const z = ms.zeilen.find((x) => x.schluessel === 'MS-12')!;
    expect(z.version).toBeNull();
    expect(z.nachweis.herkunft.join(' | ')).not.toMatch(/null|undefined|gerechnet/);
    const quellen = liste.find((a): a is Extract<Abschnitt, { art: 'quellen' }> => a.art === 'quellen')!;
    expect(String(quellen.zeilen.find((q) => q.kennzeichen === 'MS-12')?.stand)).not.toMatch(/Version (0|null)/);
  });
});

describe('Befund 3: eine Uhr', () => {
  afterEach(() => vergissAbruf());

  it('der Tag eines Augenblicks der Route in der Zone des Unternehmens, nie der UTC-Tag', () => {
    expect(tagDesAugenblicks('2029-04-30T22:30:00Z')).toBe('2029-05-01');
    expect(tagDesAugenblicks('2029-04-30T12:38:00+02:00')).toBe('2029-04-30');
    expect(tagDesAugenblicks('kein Zeitpunkt')).toBeNull();
  });

  it('die Dialoge lesen den gemerkten Tag der Route statt des Browsers', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    try {
      expect(routenHeute()).toBe('2026-10-07');
      merkeAugenblick('2029-04-30T10:38:00Z');
      expect(routenHeute()).toBe('2029-04-30');
    } finally {
      vi.useRealTimers();
    }
  });

  it('die Freigabe-Vorschau der Seite misst am `abruf` der Route', () => {
    const d = detailAm(am('2026-10-20T08:00:00Z'));
    expect(Date.parse(d.abruf)).toBe(am('2026-10-20T08:00:00Z'));
  });
});

describe('C11: ein Unternehmensbericht hat eine Zeile „Unternehmen“', () => {
  it('die Geltung „Unternehmen“ wiederholt die Zeile nicht; am Standort bleibt sie', () => {
    const roh = structuredClone(ABZUG_NR1) as unknown as { kopf: { geltung: Record<string, unknown> } };
    roh.kopf.geltung = { art: 'unternehmen', kennzeichen: 'U-1', name_zum_datenstand: 'Kunststoffwerk Ahrenberg GmbH' };
    const kopf = (liste: Abschnitt[]) => liste.find((a): a is Extract<Abschnitt, { art: 'kopf' }> => a.art === 'kopf')!.zeilen.map((z) => z.name);
    const namen = kopf(abschnitte(abzugAus(roh as never)).abschnitte);
    expect(namen.filter((n) => n === 'Unternehmen')).toHaveLength(1);
    expect(new Set(namen).size).toBe(namen.length);
    expect(kopf(abschnitte(abzugAus(ABZUG_NR1)).abschnitte)).toContain('Standort');
  });
});
