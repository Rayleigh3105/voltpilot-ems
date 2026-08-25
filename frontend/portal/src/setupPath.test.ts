import { describe, expect, it } from 'vitest';
import {
  ADOPT_FORBIDDEN_MSG,
  adoptedBridge,
  adoptionPlan,
  guidedAdoptions,
  reportedNames,
  setupPath,
  setupPathActive,
  typeLabel,
} from './setupPath';
import type { AdoptableSource } from './rollen';
import { adoptableSources } from './rollen';

/**
 * M5 (#533) — der Leer-Zustand als Einrichtungspfad.
 *
 * Zwei Dinge werden hier festgenagelt:
 *  1. **Die Weiche ist eng** — eine laufende v1-Anlage ohne v2-Entitäten behält
 *     ihr Cockpit (report §6.2); nur die ehrlich leere Anlage bekommt den Pfad.
 *  2. **Die geführte Adoption ist katalog-geführt** (F6): der Typ wird
 *     vorgeschlagen, gefragt wird nur, was NUR der Kunde weiß.
 */

function source(over: Partial<AdoptableSource> = {}): AdoptableSource {
  return {
    id: 'src-1',
    role: 'consumer',
    brand: 'go-e',
    label: 'go-e Charger',
    roleLabel: 'Verbraucher',
    summary: 'go-e · go-e Charger',
    suggestedType: 'wallbox',
    ...over,
  };
}

describe('setupPathActive - die Weiche', () => {
  const leer = {
    hasEntities: false,
    modeCount: 0,
    statusLoaded: true,
    lastSeenAt: null,
    hasLiveSample: false,
  };

  it('ist offen für die ehrlich leere Anlage', () => {
    expect(setupPathActive(leer)).toBe(true);
  });

  it('bleibt zu, solange das Read-Model nicht geladen ist', () => {
    expect(setupPathActive({ ...leer, hasEntities: undefined })).toBe(false);
    expect(setupPathActive({ ...leer, hasEntities: null })).toBe(false);
    expect(setupPathActive(null)).toBe(false);
  });

  it('bleibt zu, sobald Entitäten existieren', () => {
    expect(setupPathActive({ ...leer, hasEntities: true })).toBe(false);
  });

  it('bleibt zu, sobald ein Modus läuft', () => {
    expect(setupPathActive({ ...leer, modeCount: 1 })).toBe(false);
  });

  it('bleibt zu, solange der Status noch lädt (kein Aufblitzen)', () => {
    expect(setupPathActive({ ...leer, statusLoaded: false })).toBe(false);
  });

  it('bleibt zu für eine LAUFENDE v1-Anlage ohne Entitäten (das v1-Invariant)', () => {
    // Genau der heutige Bestandskunde: keine v2-Entitäten, aber echte Messdaten.
    expect(setupPathActive({ ...leer, lastSeenAt: '2026-07-21T10:00:00Z' })).toBe(false);
    expect(setupPathActive({ ...leer, hasLiveSample: true })).toBe(false);
  });
});

describe('setupPath - die drei Schritte', () => {
  it('führt eine Anlage ohne Gerät bei Schritt 1', () => {
    const view = setupPath({ deviceCount: 0, reported: [], adoptedCount: 0 });
    expect(view.currentId).toBe('geraet');
    expect(view.steps.map((s) => s.state)).toEqual(['current', 'todo', 'todo']);
    expect(view.steps[0].action).toEqual({ kind: 'claim', label: 'Gerät verbinden' });
    // Kein Schritt verspricht etwas, das noch nicht geht.
    expect(view.steps[1].action).toBeNull();
    expect(view.steps[2].action).toBeNull();
  });

  it('hakt Schritt 1 ab und bietet die gemeldeten Geräte an', () => {
    const view = setupPath({
      deviceCount: 1,
      reported: [source(), source({ id: 'src-2', summary: 'Deye · Wechselrichter' })],
      adoptedCount: 0,
    });
    expect(view.steps[0].state).toBe('done');
    expect(view.steps[0].title).toBe('Gerät verbunden');
    expect(view.currentId).toBe('uebernehmen');
    expect(view.steps[1].line).toContain('go-e · go-e Charger und Deye · Wechselrichter');
    expect(view.steps[1].action).toEqual({ kind: 'adopt', label: '2 Geräte übernehmen' });
  });

  it('sagt ehrlich, wenn das Gerät noch nichts meldet - und bietet keinen Knopf', () => {
    const view = setupPath({ deviceCount: 1, reported: [], adoptedCount: 0 });
    expect(view.steps[1].state).toBe('current');
    expect(view.steps[1].action).toBeNull();
    expect(view.steps[1].line).toContain('meldet noch keine Geräte');
  });

  it('öffnet Schritt 3 erst mit dem ersten übernommenen Gerät', () => {
    const before = setupPath({ deviceCount: 1, reported: [source()], adoptedCount: 0 });
    expect(before.steps[2].state).toBe('todo');
    expect(before.steps[2].action).toBeNull();

    const after = setupPath({ deviceCount: 1, reported: [], adoptedCount: 1 });
    expect(after.steps.map((s) => s.state)).toEqual(['done', 'done', 'current']);
    expect(after.currentId).toBe('steuerung');
    expect(after.steps[2].action).toEqual({ kind: 'toolbox', label: 'Betriebsmodell wählen' });
  });

  it('nennt genau drei Schritte in fester Reihenfolge', () => {
    const view = setupPath({});
    expect(view.steps.map((s) => s.id)).toEqual(['geraet', 'uebernehmen', 'steuerung']);
    expect(view.steps.map((s) => s.num)).toEqual([1, 2, 3]);
  });
});

describe('reportedNames', () => {
  it('zählt deutsch auf und erfindet nichts', () => {
    expect(reportedNames([])).toBe('');
    expect(reportedNames(null)).toBe('');
    expect(reportedNames([source({ summary: 'A' })])).toBe('A');
    expect(
      reportedNames([
        source({ summary: 'A' }),
        source({ id: 'b', summary: 'B' }),
        source({ id: 'c', summary: 'C' }),
      ]),
    ).toBe('A, B und C');
  });
});

describe('adoptionPlan - katalog-geführt (F6)', () => {
  it('schlägt die Wallbox vor und fragt nur die Anschlussleistung', () => {
    const plan = adoptionPlan(source());
    expect(plan.guided).toBe(true);
    expect(plan.entityType).toBe('wallbox');
    expect(plan.actionLabel).toBe('Als Wallbox übernehmen');
    expect(plan.fields.map((f) => f.id)).toEqual(['leistung']);
  });

  it('fragt beim Erzeuger nach kWp und MaStR - dem, was nur der Kunde weiß', () => {
    const plan = adoptionPlan(
      source({ role: 'pv-generation', brand: 'Fronius', suggestedType: 'producer' }),
    );
    expect(plan.entityType).toBe('producer');
    expect(plan.fields.map((f) => f.id)).toEqual(['kwp', 'mastr']);
    // Nichts davon ist Pflicht - eine Übernahme darf daran nie scheitern.
    expect(plan.fields.every((f) => !f.required)).toBe(true);
  });

  it('fragt beim Netz-Zähler gar nichts', () => {
    const plan = adoptionPlan(source({ role: 'grid-meter', suggestedType: 'grid-meter' }));
    expect(plan.typeLabel).toBe('Netz-Zähler');
    expect(plan.fields).toEqual([]);
  });

  it('übernimmt NICHT ohne sicheren Vorschlag (keine freie Typwahl im Kundenpfad)', () => {
    expect(adoptionPlan(source({ suggestedType: null })).guided).toBe(false);
    expect(adoptionPlan(source({ suggestedType: 'battery-hybrid' })).guided).toBe(false);
    // ... und die geführte Liste lässt genau die weg.
    const plans = guidedAdoptions([source(), source({ id: 'x', suggestedType: null })]);
    expect(plans.map((p) => p.sourceId)).toEqual(['src-1']);
  });

  it('nimmt das Katalog-Label, wenn eines da ist, und bleibt sonst bedienbar', () => {
    expect(typeLabel('wallbox', 'Ladepunkt')).toBe('Ladepunkt');
    expect(typeLabel('wallbox')).toBe('Wallbox');
    expect(typeLabel('unbekannt')).toBe('unbekannt');
  });

  it('liest die gemeldeten Quellen direkt aus der U2-Brücke', () => {
    const plans = guidedAdoptions(
      adoptableSources([
        {
          id: 's1',
          kind: 'source',
          role: 'consumer',
          brand: 'go-e',
          label: 'Charger',
          reportedAt: '',
          adoptedEntityId: null,
        },
        {
          id: 's2',
          kind: 'source',
          role: 'consumer',
          brand: 'go-e',
          label: 'Schon da',
          reportedAt: '',
          adoptedEntityId: 'e-1',
        },
      ]),
    );
    expect(plans.map((p) => p.sourceId)).toEqual(['s1']);
  });
});

describe('adoptedBridge - „übernommen → Regel anlegen?"', () => {
  it('bietet für ein steuerbares Gerät sofort die Regel an', () => {
    const bridge = adoptedBridge({ entityType: 'wallbox', label: 'Wallbox Carport' });
    expect(bridge.text).toBe('„Wallbox Carport" übernommen.');
    expect(bridge.cta).toBe('Regel dafür anlegen?');
    expect(bridge.ctaHint).toContain('Sonne');
  });

  it('bietet für einen Zähler KEINE Regel an', () => {
    const bridge = adoptedBridge({ entityType: 'grid-meter' });
    expect(bridge.text).toBe('„Netz-Zähler" übernommen.');
    expect(bridge.cta).toBeNull();
  });

  it('fällt ohne Bezeichnung auf das Typwort zurück', () => {
    expect(adoptedBridge({ entityType: 'producer', label: '  ' }).text).toBe(
      '„PV-Erzeuger" übernommen.',
    );
  });
});

describe('Ehrlichkeit', () => {
  it('nennt VoltPilot, wenn das Backend die Übernahme nicht erlaubt', () => {
    expect(ADOPT_FORBIDDEN_MSG).toContain('VoltPilot');
    expect(ADOPT_FORBIDDEN_MSG).not.toMatch(/403|Fehler|admin/i);
  });
});
