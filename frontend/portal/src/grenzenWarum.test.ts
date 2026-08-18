/**
 * „Grenzen als Gründe" — Erklärbarkeit Stufe 3 (Konzept
 * `data/vp-warum-erklaerbar-e2` §5.4 + §8).
 *
 * Geprüft wird vor allem die EHRLICHKEIT: jede Ursache hängt an ihrem
 * exportierten Fakt, der Urheber wird benannt, der Geräte-Satz wird
 * DURCHGEREICHT (nie neu formuliert), und der Block entsteht nur zu einer
 * Viertelstunde, die eine Grenze wirklich geformt hat.
 */

import { describe, expect, it } from 'vitest';

import type { CurtailmentStatus, ExportGuard } from './api';
import { deviceLimitLine } from './curtailment';
import {
  GRENZEN_TITEL,
  GRENZEN_VERWEIS,
  GRUND_REIHENFOLGE,
  URHEBER_LABEL,
  grenzenView,
  gruende,
  leitgrund,
  type GrenzenSlot,
} from './grenzenWarum';

const slot = (over: Partial<GrenzenSlot> = {}): GrenzenSlot => ({
  slotFlags: null,
  priceEurMwh: null,
  ...over,
});

const guard = (over: Partial<ExportGuard> = {}): ExportGuard => ({
  limitKw: 70,
  state: 'ueberwacht',
  reason: null,
  capKw: null,
  limiting: false,
  blind: false,
  effective: true,
  reach: null,
  ...over,
});

const status = (over: Partial<CurtailmentStatus> = {}): CurtailmentStatus => ({
  deviceId: 'd1',
  units: 2,
  certifiedUnits: 2,
  controlEnabled: true,
  active: false,
  appliedCapKw: null,
  allMatch: null,
  possibleOverride: false,
  checkedAt: '2026-08-18T10:00:00Z',
  exportGuard: null,
  deviceExportLimit: null,
  ...over,
});

/** Die Herzogau-Lage: das Gerät hält 33 kW, im Portal stehen 70 kW. */
const herzogau = status({
  exportGuard: guard(),
  deviceExportLimit: { limitKw: 33, register: '0x00e7', readAt: '2026-08-18T04:00:00Z' },
});

describe('gruende: jede Ursache hängt an ihrem exportierten Fakt', () => {
  it('sagt ohne Flag und ohne Negativpreis GAR NICHTS', () => {
    expect(gruende(slot())).toEqual([]);
    expect(gruende(slot({ slotFlags: ['curtailing', 'soc_max'], priceEurMwh: 40 }))).toEqual([]);
    expect(leitgrund(slot())).toBeNull();
  });

  it('nennt §14a mit seinem Urheber und sagt, dass das Gerät zusätzlich begrenzt', () => {
    const [g] = gruende(slot({ slotFlags: ['grid_limit_14a'] }));
    expect(g.id).toBe('netzgrenze_14a');
    expect(g.urheber).toBe('netzbetreiber');
    expect(g.urheberLabel).toBe(URHEBER_LABEL.netzbetreiber);
    expect(g.text).toContain('§ 14a');
    expect(g.text).toContain('Ihr Gerät begrenzt zusätzlich');
  });

  it('nennt die Einspeisegrenze mit ihrer Zahl - aber nur, wenn sie gepflegt ist', () => {
    const s = slot({ slotFlags: ['feed_in_cap'] });
    // Das FLAG ist der Fakt: die Ursache steht auch ohne gepflegte Grenze.
    expect(gruende(s)[0].text).toBe(
      'Ihre Anlage darf am Netzanschluss nur eine begrenzte Leistung einspeisen – der Plan begrenzt die PV auf diesen Wert.',
    );
    expect(gruende(s, { maxFeedInKw: 70 })[0].text).toContain('höchstens 70,0');
    // Eine unbrauchbare Zahl wird nie gerendert.
    expect(gruende(s, { maxFeedInKw: Number.NaN })[0].text).toContain('nur eine begrenzte Leistung');
  });

  it('beziffert den negativen Börsenpreis, wenn der Lauf ihn trägt', () => {
    expect(gruende(slot({ priceEurMwh: -21 }))[0].text).toContain('-2,1 ct/kWh');
    // Ein positiver Preis belegt ihn nicht.
    expect(gruende(slot({ priceEurMwh: 0 }))).toEqual([]);
  });

  it('führt den FREMDEN Auftrag vor unserer eigenen Ökonomie - und verschweigt nichts', () => {
    const alle = gruende(
      slot({ slotFlags: ['grid_limit_14a', 'feed_in_cap'], priceEurMwh: -21 }),
      { maxFeedInKw: 70 },
    );
    expect(alle.map((g) => g.id)).toEqual(GRUND_REIHENFOLGE);
    expect(leitgrund(slot({ slotFlags: ['feed_in_cap'], priceEurMwh: -21 }))?.id).toBe(
      'einspeisegrenze',
    );
  });
});

describe('grenzenView: der Block der geformten Viertelstunde', () => {
  it('entsteht nicht auf einer Viertelstunde, die keine Grenze geformt hat', () => {
    expect(grenzenView(slot(), { curtailment: herzogau })).toBeNull();
    expect(grenzenView(slot({ slotFlags: ['soc_max'] }), { curtailment: herzogau })).toBeNull();
  });

  it('entsteht ROLLEN-UNABHÄNGIG, sobald eine Grenze gebunden hat', () => {
    // Ein verkaufender Slot am Einspeise-Cap stellt dieselbe Frage.
    const v = grenzenView(slot({ slotFlags: ['feed_in_cap'] }), { maxFeedInKw: 70 });
    expect(v?.gruende.map((g) => g.id)).toEqual(['einspeisegrenze']);
    expect(v?.verweis).toBe(GRENZEN_VERWEIS);
  });

  it('reicht den Geräte-Satz WÖRTLICH durch (EIN Wortlaut, keine zweite Formulierung)', () => {
    const v = grenzenView(slot({ slotFlags: ['curtailing'] }), { curtailment: herzogau });
    expect(v?.geraet).toBe(deviceLimitLine(herzogau));
    expect(v?.geraet).toContain('33,0');
    expect(v?.geraet).toContain('70,0');
    // Ein gedrosselter Slot ohne belegten Grund trägt trotzdem die fremde Wahrheit.
    expect(v?.gruende).toEqual([]);
  });

  it('lastet dem Gerät nie UNSERE eigene Kappe an', () => {
    const eigeneKappe = status({
      exportGuard: guard({ capKw: 30 }),
      deviceExportLimit: { limitKw: 33, register: '0x00e7', readAt: '2026-08-18T04:00:00Z' },
    });
    expect(grenzenView(slot({ slotFlags: ['curtailing'] }), { curtailment: eigeneKappe })).toBeNull();
  });

  it('behauptet ohne s0-Block nichts über das Gerät', () => {
    const v = grenzenView(slot({ slotFlags: ['grid_limit_14a'] }));
    expect(v?.geraet).toBeNull();
    expect(v?.gruende).toHaveLength(1);
  });

  it('hat einen Titel, der nur die Grenzen am Netzanschluss verspricht', () => {
    expect(GRENZEN_TITEL).toBe('Grenzen am Netzanschluss');
  });

  it('lässt den Grund aus, den der Satz der Karte schon trägt (nichts zweimal)', () => {
    const s = slot({ slotFlags: ['feed_in_cap', 'curtailing'], priceEurMwh: -21 });
    // Ohne Hinweis: beide Gründe.
    expect(grenzenView(s, { maxFeedInKw: 70 })?.gruende.map((g) => g.id)).toEqual([
      'einspeisegrenze',
      'negativpreis',
    ]);
    // Der Leitgrund steht im Satz darüber - der Block trägt nur den Rest.
    expect(
      grenzenView(s, { maxFeedInKw: 70 }, 'einspeisegrenze')?.gruende.map((g) => g.id),
    ).toEqual(['negativpreis']);
    // Bleibt danach GAR NICHTS und gibt es keine Geräte-Grenze, entfällt der Block.
    expect(grenzenView(slot({ slotFlags: ['feed_in_cap'] }), null, 'einspeisegrenze')).toBeNull();
    // … mit Geräte-Grenze bleibt er, denn die ist eine EIGENE Aussage.
    expect(
      grenzenView(slot({ slotFlags: ['feed_in_cap'] }), { curtailment: herzogau }, 'einspeisegrenze')
        ?.geraet,
    ).toContain('33,0');
  });
});
