import { describe, expect, it } from 'vitest';
import { curtailTruth } from './curtailment';
import { NBSP } from './format';
import {
  FALLBACK_14A_NOTE,
  FORECAST_FOOTNOTE,
  KNOWN_ROLES,
  bindingChips,
  dayAvgPriceCt,
  driverLabel,
  hasWhyLayer,
  phaseEurAmount,
  phaseEurLine,
  phaseEurNote,
  phaseRange,
  phaseWhy,
  phases,
  roleLabel,
  slotContextRows,
  slotWhy,
  surplusWhy,
  type PlanPhase,
  type WhySlot,
} from './fahrplanWhy';

/** Sequential 15-min slots starting at a LOCAL wall-clock hour (TZ-stable). */
function mkSlots(
  roles: (string | null)[],
  overrides: (i: number) => Partial<WhySlot> = () => ({}),
  startHour = 0,
): WhySlot[] {
  const base = new Date(2026, 6, 23, startHour, 0, 0).getTime();
  return roles.map((role, i) => ({
    start: new Date(base + i * 15 * 60_000).toISOString(),
    batteryKw: 0,
    priceEurMwh: null,
    costEur: null,
    baselineCostEur: null,
    slotRole: role,
    slotFlags: null,
    storedValueCtKwh: null,
    gridValueCtKwh: null,
    peakPressureEurKw: null,
    ...overrides(i),
  }));
}

function rep(role: string, n: number): string[] {
  return Array.from({ length: n }, () => role);
}

describe('hasWhyLayer (the null-degradation gate)', () => {
  it('is true only when EVERY slot carries a known role', () => {
    expect(hasWhyLayer(mkSlots(rep('warten', 4)))).toBe(true);
    expect(hasWhyLayer(mkSlots(['warten', null, 'warten']))).toBe(false);
    expect(hasWhyLayer(mkSlots(['warten', 'zukunfts_rolle']))).toBe(false);
    expect(hasWhyLayer([])).toBe(false);
  });

  it('covers exactly the §6 role vocabulary', () => {
    expect([...KNOWN_ROLES].sort()).toEqual(
      [
        'abregeln',
        'reserve_halten',
        'warten',
        'pv_speichern',
        'guenstig_laden',
        'spitze_kappen',
        'verkaufen',
        'eigenverbrauch',
      ].sort(),
    );
  });
});

describe('phases: grouping', () => {
  it('groups consecutive same-role slots into ordered phases', () => {
    const slots = mkSlots([
      ...rep('warten', 8),
      ...rep('eigenverbrauch', 8),
      ...rep('pv_speichern', 16),
      ...rep('warten', 4),
      ...rep('eigenverbrauch', 12),
    ]);
    const ph = phases(slots);
    expect(ph.map((p) => p.role)).toEqual([
      'warten',
      'eigenverbrauch',
      'pv_speichern',
      'warten',
      'eigenverbrauch',
    ]);
    expect(ph.map((p) => p.slotCount)).toEqual([8, 8, 16, 4, 12]);
    expect(ph[1].startIdx).toBe(8);
    expect(ph[1].endIdx).toBe(15);
    expect(ph[2].kind).toBe('charge');
    expect(ph[4].kind).toBe('discharge');
    expect(ph[0].kind).toBe('idle');
    // The phase's time range covers first slot start .. last slot end.
    expect(ph[0].from).toBe(slots[0].start);
    expect(new Date(ph[0].to).getTime()).toBe(new Date(slots[8].start).getTime());
  });

  it('smooths a micro-run (<3 slots) between same-role neighbors', () => {
    const ph = phases(mkSlots([...rep('pv_speichern', 10), ...rep('warten', 2), ...rep('pv_speichern', 10)]));
    expect(ph).toHaveLength(1);
    expect(ph[0].role).toBe('pv_speichern');
    expect(ph[0].slotCount).toBe(22);
  });

  it('smoothing cascades until stable', () => {
    const ph = phases(
      mkSlots([
        ...rep('pv_speichern', 4),
        ...rep('warten', 2),
        ...rep('pv_speichern', 1),
        ...rep('warten', 2),
        ...rep('pv_speichern', 4),
      ]),
    );
    expect(ph).toHaveLength(1);
    expect(ph[0].slotCount).toBe(13);
  });

  it('keeps a short run between DIFFERENT-role neighbors (a real transition)', () => {
    const ph = phases(
      mkSlots([...rep('eigenverbrauch', 6), ...rep('warten', 2), ...rep('pv_speichern', 6)]),
    );
    expect(ph.map((p) => p.role)).toEqual(['eigenverbrauch', 'warten', 'pv_speichern']);
  });

  it('keeps a short run at the plan edge', () => {
    const ph = phases(mkSlots([...rep('warten', 2), ...rep('pv_speichern', 8)]));
    expect(ph.map((p) => p.role)).toEqual(['warten', 'pv_speichern']);
  });

  it('yields NOTHING when any slot lacks a known role (null-degradation)', () => {
    expect(phases(mkSlots([...rep('pv_speichern', 4), null]))).toEqual([]);
    expect(phases(mkSlots(['pv_speichern', 'brandneue_rolle']))).toEqual([]);
    expect(phases([])).toEqual([]);
  });
});

describe('phases: €-attribution', () => {
  it('sums baseline − cost − wear over the priced slots', () => {
    const ph = phases(
      mkSlots(rep('eigenverbrauch', 4), () => ({
        costEur: 0.2,
        baselineCostEur: 0.5,
        wearCostEur: 0.05,
      })),
    );
    expect(ph).toHaveLength(1);
    expect(ph[0].eur).toBeCloseTo(4 * (0.5 - 0.2 - 0.05), 10);
  });

  it('treats absent wear as 0 (matches the page savings framing)', () => {
    const ph = phases(
      mkSlots(rep('eigenverbrauch', 4), () => ({ costEur: 0.2, baselineCostEur: 0.5 })),
    );
    expect(ph[0].eur).toBeCloseTo(1.2, 10);
  });

  it('is null (never a fake 0) when no slot carries cost data', () => {
    const ph = phases(mkSlots(rep('eigenverbrauch', 4)));
    expect(ph[0].eur).toBeNull();
  });

  it('skips unpriced slots inside a priced phase', () => {
    const ph = phases(
      mkSlots(rep('eigenverbrauch', 4), (i) =>
        i === 0 ? {} : { costEur: 0.1, baselineCostEur: 0.4 },
      ),
    );
    expect(ph[0].eur).toBeCloseTo(0.9, 10);
  });
});

describe('phases: mode driver (§7)', () => {
  it('spitze_kappen belongs to the Lastspitzenkappung', () => {
    const ph = phases(mkSlots(rep('spitze_kappen', 4)));
    expect(ph[0].driver).toBe('lastspitze');
  });

  it('μ-pressure marks any phase as Lastspitzenkappung', () => {
    const ph = phases(mkSlots(rep('guenstig_laden', 4), (i) => ({ peakPressureEurKw: i === 1 ? 2.5 : 0 })));
    expect(ph[0].driver).toBe('lastspitze');
  });

  it('reserve flags decide the reserve owner', () => {
    expect(
      phases(mkSlots(rep('reserve_halten', 4), () => ({ slotFlags: ['soc_floor', 'reserve_peak'] })))[0]
        .driver,
    ).toBe('lastspitze');
    expect(
      phases(mkSlots(rep('reserve_halten', 4), () => ({ slotFlags: ['reserve_backup'] })))[0].driver,
    ).toBe('notstrom');
    expect(phases(mkSlots(rep('reserve_halten', 4)))[0].driver).toBeNull();
  });

  it('maps market and self-consumption roles to their home modes', () => {
    expect(phases(mkSlots(rep('guenstig_laden', 4)))[0].driver).toBe('markt');
    expect(phases(mkSlots(rep('verkaufen', 4)))[0].driver).toBe('markt');
    expect(phases(mkSlots(rep('pv_speichern', 4)))[0].driver).toBe('eigenverbrauch');
    expect(phases(mkSlots(rep('eigenverbrauch', 4)))[0].driver).toBe('eigenverbrauch');
    expect(phases(mkSlots(rep('warten', 4)))[0].driver).toBeNull();
    expect(phases(mkSlots(rep('abregeln', 4)))[0].driver).toBeNull();
  });

  it('driverLabel speaks customer German', () => {
    expect(driverLabel('eigenverbrauch')).toBe('Eigenverbrauch');
    expect(driverLabel('markt')).toBe('Marktvermarktung');
    expect(driverLabel('lastspitze')).toBe('Lastspitzenkappung');
    expect(driverLabel('notstrom')).toBe('Notstrom');
    expect(driverLabel(null)).toBeNull();
  });
});

describe('slotWhy (per-slot customer sentence)', () => {
  const base: WhySlot = {
    start: new Date(2026, 6, 23, 18, 0).toISOString(),
    batteryKw: -3,
    priceEurMwh: 315,
    costEur: null,
    baselineCostEur: null,
    storedValueCtKwh: 28.3,
    slotFlags: null,
  };

  it('eigenverbrauch names the BEZUGSPREIS, not the spot price', () => {
    expect(
      slotWhy(
        {
          ...base,
          slotRole: 'eigenverbrauch',
          importPriceCtKwh: 41.2,
          importPriceSource: 'preisblatt',
        },
        'eigenverbrauch',
      ),
    ).toBe(
      'Deckt den Verbrauch aus dem Speicher: Netzstrom kostet Sie jetzt 41,2 ct/kWh (Börsenpreis 31,5 + Netzentgelte/Abgaben 9,7) – mehr als der Wert gespeicherter Energie (≈ 28,3 ct/kWh).',
    );
  });

  // The live Pilsting constellation (report vp-netzbezug-nacht-s3 §6): with the
  // bare spot this read "21,2 wäre teurer als 21,5" - false in itself, and the
  // NORMAL case (16-23 of 23 sentences contradictory in the replayed run).
  it('is contradiction-free for the live constellation spot 21,2 / λ 21,5 / Bezug 32,5', () => {
    const sentence = slotWhy(
      {
        ...base,
        slotRole: 'eigenverbrauch',
        priceEurMwh: 212,
        storedValueCtKwh: 21.5,
        importPriceCtKwh: 32.5,
        importPriceSource: 'preisblatt',
      },
      'direktvermarktung',
    );
    expect(sentence).toBe(
      'Deckt den Verbrauch aus dem Speicher: Netzstrom kostet Sie jetzt 32,5 ct/kWh (Börsenpreis 21,2 + Netzentgelte/Abgaben 11,3) – mehr als der Wert gespeicherter Energie (≈ 21,5 ct/kWh).',
    );
    // The claim it makes is the one the numbers support.
    expect(sentence).not.toContain('Börsenpreis 21,2 ct/kWh');
    expect(32.5).toBeGreaterThan(21.5);
  });

  it('states the grid price without a comparison when the claim would not hold', () => {
    // λ above the grid price (a rare boundary): naming the number is honest,
    // asserting "mehr als" would not be.
    expect(
      slotWhy(
        {
          ...base,
          slotRole: 'eigenverbrauch',
          storedValueCtKwh: 33,
          importPriceCtKwh: 32.5,
          importPriceSource: 'preisblatt',
        },
        'eigenverbrauch',
      ),
    ).toBe(
      'Deckt den Verbrauch aus dem Speicher: Netzstrom kostet Sie jetzt 32,5 ct/kWh (Börsenpreis 31,5 + Netzentgelte/Abgaben 1,0).',
    );
  });

  it('breaks the price down per source, and never invents components', () => {
    const at = (importPriceSource: string, importPriceCtKwh: number) =>
      slotWhy(
        { ...base, slotRole: 'eigenverbrauch', importPriceCtKwh, importPriceSource },
        'eigenverbrauch',
      );
    // A flat retail price has no spot share.
    expect(at('fest', 34)).toContain('34,0 ct/kWh (Ihr Festpreis-Tarif)');
    // Bare spot: import IS the spot price - said so, no fabricated components.
    expect(at('spot', 31.5)).toContain('31,5 ct/kWh (Börsenpreis)');
    // Unknown source (a future rule): the number alone, no breakdown.
    expect(at('sonstiges', 31.5)).toContain('Netzstrom kostet Sie jetzt 31,5 ct/kWh –');
  });

  it('degrades to a number-free sentence when numbers are missing', () => {
    // No Bezugspreis (a run predating the field) - the spot price is NEVER
    // passed off as "Netzstrom", even though it is present here.
    const old = slotWhy({ ...base, slotRole: 'eigenverbrauch' }, 'eigenverbrauch');
    expect(old).toBe('Deckt den Verbrauch aus dem Speicher und vermeidet teuren Netzbezug.');
    expect(old).not.toContain('31,5');
    expect(
      slotWhy({ ...base, slotRole: 'eigenverbrauch', priceEurMwh: null }, 'eigenverbrauch'),
    ).toBe('Deckt den Verbrauch aus dem Speicher und vermeidet teuren Netzbezug.');
    expect(
      slotWhy({ ...base, slotRole: 'pv_speichern', storedValueCtKwh: null }, 'eigenverbrauch'),
    ).toBe('Überschüssiger Solarstrom wird für die teuren Stunden gespeichert.');
  });

  it('pv_speichern names the later value', () => {
    expect(slotWhy({ ...base, slotRole: 'pv_speichern' }, 'eigenverbrauch')).toBe(
      'Überschüssiger Solarstrom wird gespeichert statt eingespeist – gespeicherte Energie ist später ≈ 28,3 ct/kWh wert.',
    );
  });

  it('guenstig_laden compares the BEZUGSPREIS against the stored value', () => {
    expect(
      slotWhy(
        {
          ...base,
          slotRole: 'guenstig_laden',
          priceEurMwh: 58,
          importPriceCtKwh: 15.8,
          importPriceSource: 'preisblatt',
        },
        'eigenverbrauch',
      ),
    ).toBe(
      'Lädt günstig aus dem Netz: Netzstrom kostet Sie jetzt 15,8 ct/kWh (Börsenpreis 5,8 + Netzentgelte/Abgaben 10,0) – weniger als der Wert gespeicherter Energie (≈ 28,3 ct/kWh).',
    );
    // Without the Bezugspreis the sentence stays number-free (never spot).
    const old = slotWhy(
      { ...base, slotRole: 'guenstig_laden', priceEurMwh: 158 },
      'eigenverbrauch',
    );
    expect(old).toBe('Lädt günstig aus dem Netz für die teuren Stunden.');
    expect(old).not.toContain('15,8');
  });

  it('verkaufen words per plant kind', () => {
    expect(slotWhy({ ...base, slotRole: 'verkaufen' }, 'direktvermarktung')).toBe(
      'Verkauft zum Spitzenpreis: Börsenpreis 31,5 ct/kWh liegt über dem Wert gespeicherter Energie (≈ 28,3 ct/kWh).',
    );
    expect(slotWhy({ ...base, slotRole: 'verkaufen' }, 'eigenverbrauch')).toContain('Speist ein');
  });

  // §4 geschärft: jeder Ruhe-Satz sagt, was ALS NÄCHSTES passiert.
  it('warten reads its detail from the binding flags', () => {
    expect(slotWhy({ ...base, slotRole: 'warten', slotFlags: ['soc_max'] }, 'eigenverbrauch')).toBe(
      'Der Speicher ist voll. Er entlädt wieder, sobald es sich lohnt – meist am Abend, wenn der Strompreis steigt.',
    );
    expect(
      slotWhy({ ...base, slotRole: 'warten', slotFlags: ['soc_floor'] }, 'eigenverbrauch'),
    ).toBe(
      'Der Speicher hat seine Schutz-Reserve erreicht. Er lädt automatisch wieder, sobald Ihre PV mehr liefert als das Haus braucht – oder der Strompreis günstig genug ist.',
    );
    expect(slotWhy({ ...base, slotRole: 'warten' }, 'eigenverbrauch')).toBe(
      'Gerade lohnt sich weder Laden noch Entladen: Der Preisunterschied ist kleiner als Umwandlungsverluste und Batterie-Verschleiß. Nichtstun ist jetzt das Wirtschaftlichste.',
    );
  });

  it('reserve_halten names the reserve owner from the flags', () => {
    expect(
      slotWhy({ ...base, slotRole: 'reserve_halten', slotFlags: ['reserve_backup'] }, 'eigenverbrauch'),
    ).toBe('Der Speicher hält Ladung als Notstrom-Reserve zurück – so wie in Ihren Einstellungen festgelegt.');
    expect(
      slotWhy({ ...base, slotRole: 'reserve_halten', slotFlags: ['reserve_peak'] }, 'eigenverbrauch'),
    ).toBe('Der Speicher hält Ladung als Reserve für die Lastspitzenkappung zurück.');
  });

  it('abregeln names the negative price when present - als PLAN, nie als Tatsache', () => {
    expect(slotWhy({ ...base, slotRole: 'abregeln', priceEurMwh: -21 }, 'eigenverbrauch')).toBe(
      'Einspeisen würde beim negativen Börsenpreis (-2,1 ct/kWh) Geld kosten – der Plan sieht vor, die PV zu drosseln, statt draufzuzahlen.',
    );
    expect(slotWhy({ ...base, slotRole: 'abregeln', priceEurMwh: null }, 'eigenverbrauch')).toBe(
      'Einspeisen würde bei negativen Preisen Geld kosten – der Plan sieht vor, die PV zu drosseln, statt draufzuzahlen.',
    );
  });

  it('behauptet die Drosselung nirgends im Indikativ (Ausführung ist unbelegt)', () => {
    for (const price of [-21, null]) {
      const s = slotWhy({ ...base, slotRole: 'abregeln', priceEurMwh: price }, 'eigenverbrauch')!;
      expect(s).not.toMatch(/wird gedrosselt|wird abgeregelt|pausiert gerade/);
    }
  });

  it('spitze_kappen explains the peak target', () => {
    expect(slotWhy({ ...base, slotRole: 'spitze_kappen' }, 'eigenverbrauch')).toContain(
      'Spitzen-Ziel',
    );
  });

  it('is null for missing/unknown roles (never fabricated)', () => {
    expect(slotWhy({ ...base, slotRole: null }, 'eigenverbrauch')).toBeNull();
    expect(slotWhy({ ...base, slotRole: 'phantasie' }, 'eigenverbrauch')).toBeNull();
  });
});

describe('surplusWhy (Teil 4b: Überschuss geht ins Netz statt in die Batterie)', () => {
  // A slot that EXPORTS (gridKw < 0). All the surplus reasons key on that.
  const exporting: WhySlot = {
    start: new Date(2026, 6, 23, 12, 0).toISOString(),
    batteryKw: 0,
    gridKw: -16.6,
    priceEurMwh: 40,
    costEur: null,
    baselineCostEur: null,
    slotRole: 'warten',
    slotFlags: null,
    exportValueCtKwh: 9.2,
    storedValueCtKwh: 7.8,
  };

  it('does NOT fire when the slot imports or has no grid value', () => {
    expect(surplusWhy({ ...exporting, gridKw: 4.3 }, 'eigenverbrauch')).toBeNull();
    expect(surplusWhy({ ...exporting, gridKw: null }, 'eigenverbrauch')).toBeNull();
    // A tiny export inside the deadband does not count either.
    expect(surplusWhy({ ...exporting, gridKw: -0.03 }, 'eigenverbrauch')).toBeNull();
  });

  it('does NOT fire on a curtailment slot (negative price is a different story)', () => {
    expect(surplusWhy({ ...exporting, slotRole: 'abregeln', priceEurMwh: -21 }, 'eigenverbrauch')).toBeNull();
  });

  it('a) names the max-power charge that overflows to the grid', () => {
    expect(
      surplusWhy(
        { ...exporting, batteryKw: 20, slotFlags: ['charge_cap'], slotRole: 'pv_speichern' },
        'eigenverbrauch',
      ),
    ).toBe(
      `Der Speicher lädt bereits mit seiner maximalen Leistung (20,0${NBSP}kW). Was Ihre PV darüber hinaus liefert, wird eingespeist und vergütet.`,
    );
  });

  it('b) names the full battery feeding surplus in', () => {
    expect(surplusWhy({ ...exporting, slotFlags: ['soc_max'] }, 'eigenverbrauch')).toBe(
      'Der Speicher ist voll – Ihr Überschuss wird eingespeist und vergütet. Er entlädt wieder, sobald es sich lohnt, meist am Abend.',
    );
  });

  it('c) a resting battery waiting to charge later names the charge time (priority over d)', () => {
    const nextCharge = new Date(2026, 6, 23, 12, 0).toISOString();
    // 12:00 local (constructed with local wall-clock) → toLocaleTimeString.
    expect(surplusWhy(exporting, 'eigenverbrauch', nextCharge)).toBe(
      'Der Speicher wartet absichtlich: Er lädt laut Fahrplan ab 12:00 Uhr, wenn Speichern am wertvollsten ist. Bis dahin wird Ihr Überschuss eingespeist und vergütet.',
    );
  });

  it('d) selling pays more than storing - DV names the ct values', () => {
    expect(surplusWhy(exporting, 'direktvermarktung')).toBe(
      'Ihr Solar-Überschuss wird gerade verkauft statt gespeichert: Die Einspeisung bringt jetzt 9,2 ct/kWh – mehr, als der Strom später aus dem Speicher wert wäre (≈ 7,8 ct/kWh nach Verlusten und Verschleiß).',
    );
  });

  it('d) EEG variant stays number-free and says „einspeisen", not „verkaufen"', () => {
    const s = surplusWhy(exporting, 'eigenverbrauch')!;
    expect(s).toBe(
      'Ihr Solar-Überschuss wird gerade eingespeist statt gespeichert: Die Einspeisevergütung bringt jetzt mehr, als der Strom später einsparen würde.',
    );
    expect(s).not.toContain('verkauft');
  });

  it('is null (falls back to slotWhy) when no case applies', () => {
    // Resting + exporting but feed-in does NOT pay more, and no later charge.
    expect(
      surplusWhy({ ...exporting, exportValueCtKwh: 5, storedValueCtKwh: 8 }, 'eigenverbrauch'),
    ).toBeNull();
    // Missing the numbers for case d.
    expect(
      surplusWhy({ ...exporting, exportValueCtKwh: null }, 'eigenverbrauch'),
    ).toBeNull();
    // Charging (not at cap, not full) while exporting: no surplus reason.
    expect(surplusWhy({ ...exporting, batteryKw: 3, slotRole: 'pv_speichern' }, 'eigenverbrauch')).toBeNull();
  });
});

describe('slotContextRows', () => {
  it('builds price (with Ø), PV, SoC and stored-value rows', () => {
    const slots = mkSlots(rep('eigenverbrauch', 2), (i) => ({
      priceEurMwh: i === 0 ? 100 : 300,
      pvKw: 3.2,
      socPct: 78.4,
      storedValueCtKwh: 28.3,
    }));
    const rows = slotContextRows(slots[1], slots);
    expect(rows).toEqual([
      { label: 'Börsenpreis', value: '30,0 ct/kWh · Ø 20,0 ct/kWh' },
      { label: 'PV-Prognose', value: '3,2 kW' },
      { label: 'Ladestand danach', value: '78 %' },
      { label: 'Wert gespeicherter Energie', value: '≈ 28,3 ct/kWh' },
    ]);
  });

  it('omits rows whose value is absent (— discipline)', () => {
    const slots = mkSlots(rep('warten', 1));
    expect(slotContextRows(slots[0], slots)).toEqual([]);
  });

  it('dayAvgPriceCt is null without prices', () => {
    expect(dayAvgPriceCt(mkSlots(rep('warten', 3)))).toBeNull();
  });
});

describe('bindingChips', () => {
  it('maps known codes to calm German chips', () => {
    expect(bindingChips(['soc_max', 'grid_limit_14a', 'solar_only'])).toEqual([
      'Speicher voll',
      'Netzgrenze §14a',
      'Nur Solarladen (EEG)',
    ]);
    expect(bindingChips(['reserve_backup', 'reserve_peak', 'peak_defining', 'curtailing', 'feed_in_cap', 'soc_floor'])).toEqual([
      'Notstrom-Reserve',
      'Reserve für Lastspitze',
      'Bestimmt die Lastspitze',
      'Drosselung geplant',
      'Einspeisegrenze',
      'Speicher am Minimum',
    ]);
  });

  it('collapses charge_cap + discharge_cap into one chip', () => {
    expect(bindingChips(['charge_cap', 'discharge_cap'])).toEqual(['Maximale Leistung']);
  });

  it('ignores unknown codes and handles null', () => {
    expect(bindingChips(['zukunft_flag'])).toEqual([]);
    expect(bindingChips(null)).toEqual([]);
    expect(bindingChips(undefined)).toEqual([]);
  });
});

describe('phaseEurLine + phaseRange + labels', () => {
  const mkPhase = (over: Partial<PlanPhase>): PlanPhase => ({
    role: 'eigenverbrauch',
    startIdx: 0,
    endIdx: 3,
    slotCount: 4,
    from: new Date(2026, 6, 23, 17, 45).toISOString(),
    to: new Date(2026, 6, 23, 22, 0).toISOString(),
    eur: 3.35,
    kind: 'discharge',
    driver: 'eigenverbrauch',
    ...over,
  });

  it('discharge phases read +X €', () => {
    expect(phaseEurLine(mkPhase({}))).toBe(`+3,35${NBSP}€`);
  });

  it('charge phases word a negative € honestly as Einkauf', () => {
    expect(phaseEurLine(mkPhase({ kind: 'charge', eur: -1.2 }))).toBe(
      `Einkauf −1,20${NBSP}€ – zahlt sich in den Entladephasen aus`,
    );
    expect(phaseEurAmount(mkPhase({ kind: 'charge', eur: -1.2 }))).toBe(`−1,20${NBSP}€`);
    expect(phaseEurNote(mkPhase({ kind: 'charge', eur: -1.2 }))).toBe(
      'Einkauf, der sich in den Entladephasen auszahlt',
    );
    // A positive charge phase carries no Einkauf note.
    expect(phaseEurNote(mkPhase({ kind: 'charge', eur: 0.8 }))).toBeNull();
    expect(phaseEurNote(mkPhase({ eur: -1.2 }))).toBeNull();
  });

  it('a non-charge negative stays sign-honest', () => {
    expect(phaseEurLine(mkPhase({ eur: -0.4 }))).toBe(`−0,40${NBSP}€`);
  });

  it('null / noise hides the line', () => {
    expect(phaseEurLine(mkPhase({ eur: null }))).toBeNull();
    expect(phaseEurLine(mkPhase({ eur: 0.001 }))).toBeNull();
  });

  it('phaseRange formats the local time window', () => {
    expect(phaseRange(mkPhase({}))).toBe('17:45–22:00 Uhr');
  });

  it('phaseWhy summarizes each role in one calm sentence', () => {
    expect(phaseWhy(mkPhase({ role: 'eigenverbrauch' }), 'eigenverbrauch')).toBe(
      'Der Speicher deckt den Verbrauch und vermeidet teuren Netzbezug.',
    );
    expect(phaseWhy(mkPhase({ role: 'pv_speichern', kind: 'charge' }), 'eigenverbrauch')).toContain(
      'in den Speicher statt in die Einspeisung',
    );
    // A grid-charge phase under peak pressure honestly explains the flatness.
    expect(
      phaseWhy(mkPhase({ role: 'guenstig_laden', kind: 'charge', driver: 'lastspitze' }), 'eigenverbrauch'),
    ).toContain('keine neue Lastspitze');
    expect(
      phaseWhy(mkPhase({ role: 'guenstig_laden', kind: 'charge', driver: 'markt' }), 'eigenverbrauch'),
    ).toContain('für die teuren Stunden danach');
    expect(phaseWhy(mkPhase({ role: 'verkaufen' }), 'direktvermarktung')).toBe(
      'Der Speicher verkauft zum Spitzenpreis.',
    );
    expect(phaseWhy(mkPhase({ role: 'verkaufen' }), 'eigenverbrauch')).toBe(
      'Der Speicher speist zum hohen Preis ein.',
    );
    expect(
      phaseWhy(mkPhase({ role: 'reserve_halten', kind: 'idle', driver: 'notstrom' }), 'eigenverbrauch'),
    ).toBe('Der Speicher hält Ladung als Notstrom-Reserve zurück.');
    expect(
      phaseWhy(mkPhase({ role: 'reserve_halten', kind: 'idle', driver: 'lastspitze' }), 'eigenverbrauch'),
    ).toContain('Reserve für die Lastspitzenkappung');
    expect(phaseWhy(mkPhase({ role: 'warten', kind: 'idle', driver: null }), 'eigenverbrauch')).toContain(
      'kein Einsatz',
    );
    expect(phaseWhy(mkPhase({ role: 'abregeln', kind: 'curtail' }), 'eigenverbrauch')).toContain(
      'der Plan sieht vor, die PV zu drosseln',
    );
    expect(phaseWhy(mkPhase({ role: 'abregeln', kind: 'curtail' }), 'eigenverbrauch')).not.toContain(
      'wird gedrosselt',
    );
  });

  it('roleLabel carries the §6 customer vocabulary', () => {
    expect(roleLabel('abregeln', 'eigenverbrauch')).toBe(
      'Einspeisung pausieren (Negativpreis) — geplant',
    );
    // Wo der Satz schon „Geplant ist gerade" sagt, entfällt der Zusatz.
    expect(roleLabel('abregeln', 'eigenverbrauch', null, true)).toBe(
      'Einspeisung pausieren (Negativpreis)',
    );
    // Der Zusatz ist NUR die Abregelung - ausgeführte Rollen sind unberührt.
    expect(roleLabel('eigenverbrauch', 'eigenverbrauch')).not.toContain('geplant');
    expect(roleLabel('verkaufen', 'direktvermarktung')).toBe('Zum Spitzenpreis verkaufen');
    expect(roleLabel('verkaufen', 'eigenverbrauch')).toBe('Einspeisen');
    expect(roleLabel('reserve_halten', 'eigenverbrauch', ['reserve_backup'])).toBe(
      'Reserve halten (Notstrom)',
    );
    expect(roleLabel('reserve_halten', 'eigenverbrauch', ['reserve_peak'])).toBe(
      'Reserve halten (Lastspitze)',
    );
  });

  it('schaltet mit BELEG auf Gegenwart um - und nur die Abregelung (PR 3)', () => {
    // Der Beleg kommt IMMER durch `curtailTruthForSlot`, also nur für den
    // laufenden Abregel-Slot; hier steht er direkt, um den Wortlaut zu pinnen.
    const done = curtailTruth(
      {
        deviceId: 'd1',
        units: 2,
        certifiedUnits: 2,
        controlEnabled: true,
        active: true,
        appliedCapKw: 12.5,
        allMatch: true,
        possibleOverride: false,
        checkedAt: new Date(Date.now() - 5000).toISOString(),
      },
      new Date(),
    );
    expect(roleLabel('abregeln', 'eigenverbrauch', null, false, done)).toBe(
      'Einspeisung pausiert (Negativpreis)',
    );
    expect(phaseWhy(mkPhase({ role: 'abregeln', kind: 'curtail' }), 'eigenverbrauch', done)).toContain(
      'die PV wird deshalb gedrosselt',
    );
    const curtailSlot: WhySlot = {
      start: new Date(2026, 6, 23, 12, 0).toISOString(),
      batteryKw: 0,
      priceEurMwh: -21,
      costEur: null,
      baselineCostEur: null,
      slotFlags: null,
      slotRole: 'abregeln',
    };
    expect(slotWhy(curtailSlot, 'eigenverbrauch', done)).toBe(
      'Einspeisen würde beim negativen Börsenpreis (-2,1 ct/kWh) Geld kosten – die PV wird deshalb gedrosselt.',
    );
    expect(bindingChips(['curtailing'], done)).toEqual(['Drosselung aktiv']);
    // Ohne Beleg ist ALLES zeichengleich zu Fix 1 - der Regressionsschutz.
    expect(bindingChips(['curtailing'])).toEqual(['Drosselung geplant']);
    expect(roleLabel('abregeln', 'eigenverbrauch')).toContain('— geplant');
  });

  it('the honesty copy never names solver internals', () => {
    for (const text of [FORECAST_FOOTNOTE, FALLBACK_14A_NOTE]) {
      expect(text).not.toMatch(/MILP|Dual|Schattenpreis|Optimizer/);
    }
    expect(FORECAST_FOOTNOTE).toContain('aktualisiert alle 15 Minuten');
    expect(FALLBACK_14A_NOTE).toContain('Ihr Gerät begrenzt zusätzlich');
  });
});
