import { describe, expect, it } from 'vitest';
import {
  BAUSTEINE,
  CANONICAL_DESKTOP,
  CANONICAL_PHONE,
  anpassenDokument,
  anpassenZeilen,
  baustein,
  bausteinLabel,
  eigeneAusSchichten,
  mitEigenen,
  layoutResolve,
  presetLayout,
  ortsHinweis,
  resetZiel,
  verschiebe,
  vorgabeBand,
  type BausteinId,
  type LayoutDocument,
} from './cockpitLayout';
import { LEAD_CANDIDATES } from './leadSlot';
import type { CockpitBlock, CockpitBlockId } from './surface';

/**
 * Die reine Hälfte des Layout-Speichers (Anwendungs-Programm Stufe 3). Alles
 * hier ist Docker-frei und ohne DOM — die Vektoren sind die Fälle, an denen
 * die Auflösung ehrlich bleibt oder nicht.
 */

const ALLE: BausteinId[] = [...CANONICAL_DESKTOP];

function blocks(...ids: CockpitBlockId[]): CockpitBlock[] {
  return ids.map((id, i) => ({ id, title: id, order: i * 10, from: null }));
}

function doc(partial: Partial<LayoutDocument> = {}): LayoutDocument {
  return { order: [], hidden: [], shown: [], lead: null, ...partial };
}

describe('Baustein-Katalog', () => {
  it('trägt genau die Cockpit-Bausteine der zwei kanonischen Listen', () => {
    const ids = BAUSTEINE.map((b) => b.id).sort();
    expect([...CANONICAL_DESKTOP].sort()).toEqual(ids);
    expect([...CANONICAL_PHONE].sort()).toEqual(ids);
  });

  it('Status und Zustand sind Pflicht — sonst nichts (E2)', () => {
    expect(BAUSTEINE.filter((b) => b.pflicht).map((b) => b.id)).toEqual(['status', 'zustand']);
  });

  it('jeder lead_block ist ein lead-fähiger Block der M0-Regel', () => {
    for (const b of BAUSTEINE) {
      if (b.lead_block) expect(LEAD_CANDIDATES).toContain(b.lead_block);
    }
  });

  it('nennt jeden Baustein bei einem deutschen Namen, nie bei seiner Id', () => {
    for (const b of BAUSTEINE) {
      expect(b.label).not.toEqual(b.id);
      expect(b.label.trim().length).toBeGreaterThan(0);
    }
    // Ein unbekanntes Wort behauptet keinen Namen, es gibt die Id zurück.
    expect(bausteinLabel('gibtsnicht')).toBe('gibtsnicht');
    expect(baustein('gibtsnicht')).toBeNull();
  });

  it('die Bühne und der Kopf sind unbeweglich, alles darunter beweglich', () => {
    expect(BAUSTEINE.filter((b) => !b.beweglich).map((b) => b.id)).toEqual([
      'status',
      'energiefluss',
      'geld',
      'steuerung',
    ]);
  });
});

describe('layoutResolve — ohne gespeicherte Zeile', () => {
  it('ist der Katalog-Standard, Zeichen für Zeichen', () => {
    const r = layoutResolve({ canonical: CANONICAL_DESKTOP, verfuegbar: ALLE });
    expect(r.order).toEqual(CANONICAL_DESKTOP);
    expect(r.hidden).toEqual([]);
    expect(r.quelle).toBe('katalog');
  });

  it('am Telefon gilt die Telefon-Reihenfolge (Fahrplan und Preis führen)', () => {
    const r = layoutResolve({ canonical: CANONICAL_PHONE, verfuegbar: ALLE });
    expect(r.order).toEqual(CANONICAL_PHONE);
    expect(r.order.indexOf('fahrplan')).toBeLessThan(r.order.indexOf('kacheln'));
  });

  it('überspringt still, was diese Anlage nicht hat', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ['status', 'energiefluss', 'kacheln', 'komponenten', 'zustand'],
    });
    expect(r.order).toEqual(['status', 'energiefluss', 'kacheln', 'komponenten', 'zustand']);
  });

  it('folgt der M0-Lead-Regel peak → Geld → Fluss', () => {
    expect(
      layoutResolve({
        canonical: CANONICAL_DESKTOP,
        verfuegbar: ALLE,
        blocks: blocks('energiefluss', 'erloes-komposition', 'peak-band'),
      }).lead,
    ).toBe('peak-band');
    expect(
      layoutResolve({
        canonical: CANONICAL_DESKTOP,
        verfuegbar: ALLE,
        blocks: blocks('energiefluss'),
      }).lead,
    ).toBe('energiefluss');
  });
});

describe('layoutResolve — die vier Schichten', () => {
  it('das Preset „privat" hebt den Energiefluss hervor, „gewerbe" ändert nichts', () => {
    const bs = blocks('energiefluss', 'erloes-komposition', 'peak-band');
    expect(
      layoutResolve({ canonical: CANONICAL_DESKTOP, verfuegbar: ALLE, blocks: bs, profil: 'privat' })
        .lead,
    ).toBe('energiefluss');
    const gewerbe = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ALLE,
      blocks: bs,
      profil: 'gewerbe',
    });
    expect(gewerbe.lead).toBe('peak-band');
    expect(gewerbe.quelle).toBe('katalog');
  });

  it('ein unbekanntes Profil sagt nichts (Bestandsanlage: NULL)', () => {
    expect(presetLayout(null)).toBeNull();
    expect(presetLayout('gibtsnicht')).toBeNull();
  });

  it('die Anlagen-Vorgabe schlägt die kunden-weite (E1)', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ALLE,
      tenantVorgabe: doc({ hidden: ['strompreis'] }),
      siteVorgabe: doc({ hidden: ['komponenten'] }),
    });
    expect(r.hidden.sort()).toEqual(['komponenten', 'strompreis']);
    expect(r.quelle).toBe('vorgabe-anlage');
  });

  it('der Kunde gewinnt: sein `shown` nimmt die Vorgabe zurück (E2)', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ALLE,
      siteVorgabe: doc({ hidden: ['strompreis', 'komponenten'] }),
      eigen: doc({ shown: ['strompreis'] }),
    });
    expect(r.hidden).toEqual(['komponenten']);
    expect(r.order).toContain('strompreis');
    expect(r.quelle).toBe('eigen');
  });

  it('ein Pflicht-Baustein bleibt sichtbar, auch wenn eine Vorgabe ihn ausblenden will', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ALLE,
      siteVorgabe: doc({ hidden: ['zustand', 'status', 'kacheln'] }),
    });
    expect(r.order).toContain('zustand');
    expect(r.order).toContain('status');
    expect(r.hidden).toEqual(['kacheln']);
  });

  it('ein leeres Dokument ist keine Schicht — die Quelle bleibt darunter', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ALLE,
      siteVorgabe: doc(),
      eigen: doc(),
    });
    expect(r.quelle).toBe('katalog');
    expect(r.order).toEqual(CANONICAL_DESKTOP);
  });
});

describe('layoutResolve — Reihenfolge', () => {
  it('ordnet die beweglichen Bausteine so an, wie der Kunde sie gelegt hat', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ALLE,
      eigen: doc({
        order: [
          'status',
          'energiefluss',
          'geld',
          'steuerung',
          'fahrplan',
          'komponenten',
          'kacheln',
          'strompreis',
          'zustand',
        ],
      }),
    });
    expect(r.order).toEqual([
      'status',
      'energiefluss',
      'geld',
      'steuerung',
      'fahrplan',
      'komponenten',
      'kacheln',
      'strompreis',
      'zustand',
    ]);
  });

  it('ein neu verfügbarer Baustein erscheint an seiner KANONISCHEN Stelle, nicht hinten', () => {
    // Gespeichert wurde, bevor es Kacheln gab.
    const ohneKacheln = CANONICAL_DESKTOP.filter((id) => id !== 'kacheln');
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ALLE,
      eigen: doc({ order: [...ohneKacheln] }),
    });
    expect(r.order).toEqual(CANONICAL_DESKTOP);
    expect(r.order[r.order.length - 1]).toBe('zustand');
  });

  it('kann den Kopf und die Bühne nicht zerlegen — auch nicht mit einem handgeschriebenen Dokument', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ALLE,
      eigen: doc({
        order: ['zustand', 'komponenten', 'geld', 'energiefluss', 'status', 'steuerung', 'kacheln', 'strompreis', 'fahrplan'],
      }),
    });
    expect(r.order.slice(0, 4)).toEqual(['status', 'energiefluss', 'geld', 'steuerung']);
    // Die BEWEGLICHEN folgen dem Wunsch.
    expect(r.order.slice(4)).toEqual(['zustand', 'komponenten', 'kacheln', 'strompreis', 'fahrplan']);
  });

  it('ignoriert einen Baustein, den es hier nicht gibt — die Präferenz bleibt gespeichert', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ['status', 'energiefluss', 'kacheln', 'zustand'],
      eigen: doc({ order: ['zustand', 'kacheln', 'handel-gibts-nicht', 'status', 'energiefluss'] }),
    });
    expect(r.order).toEqual(['status', 'energiefluss', 'zustand', 'kacheln']);
  });

  it('ein Lead, den es hier nicht gibt, fällt still auf die M0-Regel zurück', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ALLE,
      blocks: blocks('energiefluss'),
      eigen: doc({ lead: 'peak-band' }),
    });
    expect(r.lead).toBe('energiefluss');
  });

  it('ein erfundener Lead wird nie übernommen', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ALLE,
      blocks: blocks('energiefluss', 'erloes-komposition'),
      eigen: doc({ lead: 'gibtsnicht' }),
    });
    expect(r.lead).toBe('erloes-komposition');
  });

  it('der Kunde darf den Lead auf einen vorhandenen Block umlegen', () => {
    const r = layoutResolve({
      canonical: CANONICAL_DESKTOP,
      verfuegbar: ALLE,
      blocks: blocks('energiefluss', 'erloes-komposition', 'peak-band'),
      eigen: doc({ lead: 'energiefluss' }),
    });
    expect(r.lead).toBe('energiefluss');
  });
});

describe('Anpassen-Modus', () => {
  const resolved = layoutResolve({
    canonical: CANONICAL_DESKTOP,
    verfuegbar: ALLE,
    blocks: blocks('energiefluss', 'erloes-komposition'),
    eigen: doc({ hidden: ['strompreis'] }),
  });

  it('zeigt erst die sichtbaren, dann die ausgeblendeten Zeilen', () => {
    const zeilen = anpassenZeilen(resolved);
    expect(zeilen.filter((z) => z.sichtbar).map((z) => z.id)).toEqual(resolved.order);
    expect(zeilen.filter((z) => !z.sichtbar).map((z) => z.id)).toEqual(['strompreis']);
  });

  it('bietet Tastatur-Alternativen zum Ziehen — und nur für Bewegliches', () => {
    const zeilen = anpassenZeilen(resolved);
    const kopf = zeilen.find((z) => z.id === 'status')!;
    expect(kopf.beweglich).toBe(false);
    expect(kopf.kannHoch).toBe(false);
    expect(kopf.kannRunter).toBe(false);
    const erste = zeilen.find((z) => z.id === 'kacheln')!;
    expect(erste.kannHoch).toBe(false);
    expect(erste.kannRunter).toBe(true);
    const letzte = zeilen.find((z) => z.id === 'zustand')!;
    expect(letzte.kannRunter).toBe(false);
  });

  it('markiert den führenden Baustein mit dem Stern', () => {
    const zeilen = anpassenZeilen({ ...resolved, lead: 'erloes-komposition' });
    expect(zeilen.find((z) => z.id === 'geld')!.lead).toBe(true);
    expect(zeilen.find((z) => z.id === 'energiefluss')!.lead).toBe(false);
  });

  it('verschiebt nur unter den beweglichen — die Bühne bleibt stehen', () => {
    const nachOben = verschiebe(CANONICAL_DESKTOP, 'strompreis', 'hoch');
    expect(nachOben.slice(0, 4)).toEqual(['status', 'energiefluss', 'geld', 'steuerung']);
    expect(nachOben.slice(4)).toEqual(['strompreis', 'kacheln', 'fahrplan', 'komponenten', 'zustand']);
  });

  it('verschiebt einen unbeweglichen Baustein gar nicht', () => {
    expect(verschiebe(CANONICAL_DESKTOP, 'energiefluss', 'runter')).toEqual(CANONICAL_DESKTOP);
    expect(verschiebe(CANONICAL_DESKTOP, 'kacheln', 'hoch')).toEqual(CANONICAL_DESKTOP);
    expect(verschiebe(CANONICAL_DESKTOP, 'zustand', 'runter')).toEqual(CANONICAL_DESKTOP);
  });

  it('das gespeicherte Dokument nennt die volle Reihenfolge und nie einen Pflicht-Baustein als versteckt', () => {
    const d = anpassenDokument({
      arrangement: CANONICAL_DESKTOP,
      hidden: ['strompreis', 'zustand'],
      lead: 'energiefluss',
    });
    expect(d.order).toEqual(CANONICAL_DESKTOP);
    expect(d.hidden).toEqual(['strompreis']);
    expect(d.lead).toBe('energiefluss');
  });

  it('nimmt eine geerbte Ausblendung ausdrücklich zurück (sonst käme der Kunde nie an sie heran)', () => {
    const d = anpassenDokument({
      arrangement: CANONICAL_DESKTOP,
      hidden: ['komponenten'],
      lead: null,
      geerbtVersteckt: ['komponenten', 'strompreis'],
    });
    expect(d.hidden).toEqual(['komponenten']);
    expect(d.shown).toEqual(['strompreis']);
  });

  it('ein wieder eingeblendeter Baustein kehrt an seinen Platz zurück, nicht ans Ende', () => {
    const arrangement = verschiebe(CANONICAL_DESKTOP, 'komponenten', 'hoch');
    const d = anpassenDokument({ arrangement, hidden: [], lead: null });
    const r = layoutResolve({ canonical: CANONICAL_DESKTOP, verfuegbar: ALLE, eigen: d });
    expect(r.order).toEqual(arrangement);
  });
});

describe('Ortshinweis — ein Baustein ohne eigenen Stapel-Knoten', () => {
  it('nennt für Kopf und Bühne, WO er steht — und für alles andere nichts', () => {
    expect(ortsHinweis('status')).toContain('Kopf');
    expect(ortsHinweis('geld')).toContain('Bühne');
    expect(ortsHinweis('steuerung')).toContain('Bühne');
    for (const id of ['kacheln', 'fahrplan', 'strompreis', 'komponenten', 'zustand'] as const) {
      expect(ortsHinweis(id)).toBeNull();
    }
  });
});

describe('Reset-Ansage (E2: der Knopf SAGT, worauf er fällt)', () => {
  it('fällt auf die Vorgabe des Betreibers, wenn es eine gibt', () => {
    expect(resetZiel({ siteVorgabe: doc({ hidden: ['strompreis'] }) })).toEqual({
      ziel: 'vorgabe-anlage',
      satz: 'Ihre Anordnung wird verworfen — es gilt wieder die Vorgabe Ihres Betreibers.',
    });
    expect(resetZiel({ tenantVorgabe: doc({ lead: 'energiefluss' }) }).ziel).toBe('vorgabe-kunde');
  });

  it('fällt auf das Preset, wenn ein Profil gesetzt ist', () => {
    const z = resetZiel({ profil: 'privat' });
    expect(z.ziel).toBe('preset');
    expect(z.satz).toContain('für Ihr Profil');
  });

  it('fällt sonst auf den VoltPilot-Standard — auch bei „gewerbe" (dessen Preset sagt nichts)', () => {
    expect(resetZiel({}).ziel).toBe('katalog');
    expect(resetZiel({ profil: 'gewerbe' }).ziel).toBe('katalog');
  });

  it('das Admin-Band nennt den Kunden und sagt, dass er abweichen darf', () => {
    expect(vorgabeBand('Nordwind GmbH')).toContain('Nordwind GmbH');
    expect(vorgabeBand(null)).toContain('abweichen');
  });
});

describe('Anwendungs-Programm Stufe 5 · die eigenen Auswertungen im Layout', () => {
  const kachel = {
    id: 'eigen:k1',
    titel: 'Wärmepumpe jetzt',
    darstellung: 'kachel' as const,
    entityId: 'e1',
    channel: 'power_kw',
    aggregat: 'jetzt' as const,
  };
  const chart = { ...kachel, id: 'eigen:k2', titel: 'Verlauf', darstellung: 'chart' as const };

  it('die Schichten werden vereinigt, `eigen` gewinnt bei gleichem Schlüssel', () => {
    // Eine Kachel, die nur die VORGABE definiert, bleibt erhalten - ohne die
    // Vereinigung wäre sie unsichtbar, sobald der Kunde einmal etwas anordnet.
    const gewonnen = eigeneAusSchichten({
      siteVorgabe: { order: [], hidden: [], shown: [], lead: null, custom: [kachel, chart] },
      eigen: {
        order: [],
        hidden: [],
        shown: [],
        lead: null,
        custom: [{ ...kachel, titel: 'Mein Name' }],
      },
    });
    expect(gewonnen.map((d) => d.id)).toEqual(['eigen:k1', 'eigen:k2']);
    expect(gewonnen[0].titel).toBe('Mein Name');
  });

  it('ohne eine einzige Definition ändert sich NICHTS', () => {
    expect(eigeneAusSchichten({})).toEqual([]);
    expect(mitEigenen(CANONICAL_DESKTOP, [])).toEqual(CANONICAL_DESKTOP);
  });

  it('eine eigene Auswertung steht hinter ihrem kanonischen Anker', () => {
    const c = mitEigenen(CANONICAL_DESKTOP, [kachel, chart]);
    const i = c.indexOf('kacheln');
    expect(c.slice(i + 1, i + 3)).toEqual(['eigen:k1', 'eigen:k2']);
  });

  it('ohne den Anker hängen sie ans Ende - ein Anker, den es nicht gibt, ordnet nichts', () => {
    const c = mitEigenen(['status', 'zustand'] as BausteinId[], [kachel]);
    expect(c[c.length - 1]).toBe('eigen:k1');
  });

  it('ihr NAME ist der Titel des Kunden, nie ein Katalog-Label', () => {
    expect(bausteinLabel('eigen:k1', [kachel])).toBe('Wärmepumpe jetzt');
    // Ohne Definition (eine verwaiste Zeile) wird nichts erfunden.
    expect(bausteinLabel('eigen:k1', [])).toBe('Eigene Auswertung');
    // Und ein Katalog-Baustein ist unberührt.
    expect(bausteinLabel('kacheln', [kachel])).toBe('Kennzahlen');
  });

  it('ihre Zeile ist beweglich, nie Pflicht, ohne Stern - und trägt `eigen`', () => {
    const zeilen = anpassenZeilen({
      arrangement: ['status', 'eigen:k1'] as BausteinId[],
      hidden: [],
      lead: null,
      eigene: [kachel],
    });
    const z = zeilen.find((x) => x.id === 'eigen:k1')!;
    expect(z.label).toBe('Wärmepumpe jetzt');
    expect(z.eigen).toBe(true);
    expect(z.pflicht).toBe(false);
    expect(z.beweglich).toBe(true);
    expect(z.leadBlock).toBeNull();
    // Ein Katalog-Baustein trägt die Marke NICHT.
    expect(zeilen.find((x) => x.id === 'status')!.eigen).toBe(false);
    // Und sie braucht keinen Orts-Hinweis: sie rendert sich selbst.
    expect(ortsHinweis('eigen:k1')).toBeNull();
  });

  it('⚠ die Definitionen überleben ein Speichern bei ABGESCHALTETER Anwendung', () => {
    // Der Fall, den der DOM-Test aufgedeckt hat: ist „Eigene Auswertung" aus,
    // stehen die Schlüssel in keiner Anordnung mehr - ihre DEFINITIONEN müssen
    // trotzdem mit, sonst löscht ein Speichern genau das, was ein
    // Wiedereinschalten zurückbringen soll.
    const doc = anpassenDokument({
      arrangement: [...CANONICAL_DESKTOP],
      hidden: [],
      lead: null,
      eigene: [kachel, chart],
    });
    expect(doc.custom).toHaveLength(2);
    // Kein Schlüssel in der Reihenfolge - der Server lehnte ihn sonst ab.
    expect(doc.order).not.toContain('eigen:k1');
  });

  it('ein Schlüssel ohne Definition wird NIE gespeichert', () => {
    const doc = anpassenDokument({
      arrangement: ['status', 'eigen:geist'] as BausteinId[],
      hidden: ['eigen:geist'] as BausteinId[],
      lead: null,
      eigene: [],
    });
    expect(doc.order).toEqual(['status']);
    expect(doc.hidden).toEqual([]);
    expect('custom' in doc).toBe(false);
  });

  it('eine Auflösung MIT ihnen zeigt sie, ohne sie nicht', () => {
    const canonical = mitEigenen(CANONICAL_DESKTOP, [kachel]);
    const eigen: LayoutDocument = {
      order: [],
      hidden: [],
      shown: [],
      lead: null,
      custom: [kachel],
    };
    const mit = layoutResolve({
      canonical,
      verfuegbar: [...CANONICAL_DESKTOP, 'eigen:k1'] as BausteinId[],
      eigen,
    });
    expect(mit.order).toContain('eigen:k1');
    // Ein Dokument, das NUR Kacheln definiert, ist trotzdem eine Schicht.
    expect(mit.quelle).toBe('eigen');
    // Ist sie nicht verfügbar (Anwendung aus), wird sie still übersprungen.
    expect(
      layoutResolve({ canonical, verfuegbar: CANONICAL_DESKTOP, eigen }).order,
    ).not.toContain('eigen:k1');
  });
});
