import { describe, expect, it } from 'vitest';
import { buildPolicyDocument, type BuildOptions } from '../consumers/policy';
import type { ConsumerDraft } from '../consumers/questions';
import { isValid, validatePolicy } from '../consumers/validate';
import { buildGuidedFlow, parseGuidedFlow } from '../flows/guidedBuilder';
import type { EditorEntity } from '../flows/model';
import { validateFlow } from '../flows/validate';
import {
  VORBELEGUNG_FRAGE,
  istVerbraucherRezept,
  REZEPTE,
  REZEPT_PREFILL,
  rezept,
  rezeptPrefill,
  schaltbareKomponenten,
  speicherEntity,
  speicherSchutzRegel,
  vorbelegungen,
} from './rezepte';

const WALLBOX: EditorEntity = {
  id: 'e-wb', entityType: 'wallbox', label: 'Wallbox Garage', measure: ['power_kw'], actuate: ['on_off'],
};
const SPEICHER: EditorEntity = {
  id: 'e-batt', entityType: 'battery-hybrid', label: 'Speicher', measure: ['soc_pct'], actuate: ['setpoint_kw'],
};
const ZAEHLER: EditorEntity = {
  id: 'e-grid', entityType: 'grid-meter', label: 'Netzanschluss', measure: ['power_kw'], actuate: [],
};

const BUILD_OPTS: BuildOptions = {
  entityId: '6f1d2c3b-4a59-4687-9abc-def012345678',
  requirementId: 'r-1',
  ctx: { controlKind: 'on_off', hasStorage: true, hasMeasurementChannel: true },
  controlProfile: { control_kind: 'on_off', rated_power_kw: 11 },
};

/** Der Ausgangs-Entwurf des Regelbaukastens (Spiegel von `initialDraft`). */
function baseDraft(): ConsumerDraft {
  return {
    intent: null,
    conditions: [{ signal: 'consumer.available', operator: 'eq', value: true }],
    combinator: 'and',
    recurrence: { days: 'daily', from: '13:00', to: '14:00' },
    demandMode: 'runtime',
    runtimeMinutes: 60,
    energyKwh: null,
    contiguous: true,
    target: { kind: 'on_off', value: true },
    enforcement: 'must_run',
    gridEnergyPolicy: 'allow',
    storageRelation: 'consumer_first',
    allowStorageDischarge: false,
  };
}

describe('Die Rezepte (5b.4) - seit Stufe 2 die Vorbelegungen', () => {
  it('führt die vier Verbraucher-Absichten plus Speicher-Schutz und Benachrichtigung', () => {
    expect(REZEPTE.map((r) => r.id)).toEqual([
      'pv-surplus-consumer',
      'schedule-consumer',
      'price-consumer',
      'deadline-consumer',
      'storage-protect',
      'notify',
    ]);
  });

  it('jede Vorbefüllung wird über die BESTEHENDE Pipeline ein GÜLTIGES Dokument', () => {
    for (const [id, prefill] of Object.entries(REZEPT_PREFILL)) {
      const draft = { ...baseDraft(), ...prefill };
      expect(draft.intent, id).not.toBeNull();
      const doc = buildPolicyDocument(draft, BUILD_OPTS);
      const findings = validatePolicy(doc);
      expect(isValid(findings), `${id}: ${JSON.stringify(findings)}`).toBe(true);
    }
  });

  it('genau die Verbraucher-Rezepte tragen eine Vorbefüllung', () => {
    const mitPrefill = Object.keys(REZEPT_PREFILL).sort();
    const verbraucher = REZEPTE.filter((r) => r.maschine === 'verbraucher').map((r) => r.id).sort();
    expect(mitPrefill).toEqual(verbraucher);
    for (const id of verbraucher) expect(istVerbraucherRezept(id)).toBe(true);
    expect(istVerbraucherRezept('storage-protect')).toBe(false);
    expect(istVerbraucherRezept('gibt-es-nicht')).toBe(false);
  });

  it('„PV-Überschuss" ist eine reaktive LOKAL-Signal-Regel mit Hysterese', () => {
    const p = rezeptPrefill('pv-surplus-consumer');
    expect(p?.intent).toBe('react');
    expect(p?.conditions?.[0].signal).toBe('site.pv_surplus_kw');
    expect(p?.conditions?.[0].resetValue).toBeLessThan(p?.conditions?.[0].value as number);
    // „Nur bei Überschuss" ist eine Gelegenheit, nie ein Pflichtlauf.
    expect(p?.enforcement).toBe('opportunistic');
  });

  it('„Günstige Stunden" hängt am PREIS-Signal, nicht am Gerät (Cloud-Fenster)', () => {
    const p = rezeptPrefill('price-consumer');
    expect(p?.intent).toBe('cheap');
    expect(p?.conditions?.[0].signal.startsWith('market.')).toBe(true);
  });

  it('„Bis zu einer Frist" ist eine flexible Aufgabe mit Fenster und Bedarf', () => {
    const p = rezeptPrefill('deadline-consumer');
    expect(p?.intent).toBe('deadline');
    expect(p?.recurrence).toEqual({ days: 'daily', from: '22:00', to: '06:00' });
    expect(p?.runtimeMinutes).toBeGreaterThan(0);
  });

  it('kennt kein Rezept zu einer unbekannten Id (nie geraten)', () => {
    expect(rezept('gibt-es-nicht')).toBeNull();
    expect(rezeptPrefill('gibt-es-nicht')).toBeNull();
  });
});

describe('Die VORBELEGUNGEN sind Einladungen — nie ein toter Knopf (Stufe 2)', () => {
  it('bietet auf einer vollständigen Anlage jeden nutzbaren Startpunkt an', () => {
    const v = vorbelegungen({ entities: [WALLBOX, SPEICHER, ZAEHLER] });
    expect(v.liste.map((r) => r.id)).toEqual([
      'pv-surplus-consumer', 'schedule-consumer', 'price-consumer',
      'deadline-consumer', 'storage-protect',
    ]);
    expect(v.brauchtKomponente).toBe(false);
    // „Sag mir Bescheid" fehlt, wird aber GEZÄHLT — verschwiegen wird nichts.
    expect(v.hinweis).toBe('1 weiterer Startpunkt passt nicht zu Ihrer Anlage.');
  });

  it('lässt einen Startpunkt weg, den diese Anlage nicht bauen kann', () => {
    const v = vorbelegungen({ entities: [WALLBOX] });
    expect(v.liste.map((r) => r.id)).not.toContain('storage-protect');
    expect(v.hinweis).toBe('2 weitere Startpunkte passen nicht zu Ihrer Anlage.');
  });

  it('nennt den GRUND, wenn alle Übersprungenen denselben haben', () => {
    // Ohne schaltbares Gerät scheitert JEDES nutzbare Rezept am selben Fehlen.
    const v = vorbelegungen({ entities: [SPEICHER, ZAEHLER] });
    expect(v.liste).toHaveLength(0);
    expect(v.brauchtKomponente).toBe(true);
    expect(v.hinweis).toContain('6 weitere Startpunkte');
  });

  it('behauptet KEINEN gemeinsamen Grund, wenn die Übersprungenen verschiedene haben', () => {
    // „Sag mir Bescheid" fehlt der Zustellweg, dem Speicher-Rezept der
    // Speicher — eine Klammer mit EINEM Grund wäre für einen der beiden falsch.
    const v = vorbelegungen({ entities: [WALLBOX] });
    expect(v.hinweis).not.toContain('(');
  });

  it('bietet „Speicher schützen" NUR an, wenn die Maschine es auch bauen kann', () => {
    // ⚠ Im Browser aufgefallen: der Rollen-Vorfilter kennt eine Batterie am
    // TYP, `speicherSchutzRegel` braucht aber einen gemessenen Ladestand — der
    // Startpunkt wurde angeboten und tat beim Klick nichts.
    const ohneSoc: EditorEntity = { ...SPEICHER, measure: [] };
    const v = vorbelegungen({ entities: [WALLBOX, ohneSoc] });
    expect(v.liste.map((r) => r.id)).not.toContain('storage-protect');
    expect(speicherSchutzRegel([WALLBOX, ohneSoc])).toBeNull();
    // Verschwiegen wird es trotzdem nicht.
    expect(v.hinweis).toContain('2 weitere Startpunkte');
  });

  it('fragt nach dem ERGEBNIS, nicht nach der Technik', () => {
    expect(VORBELEGUNG_FRAGE).toBe('Womit anfangen?');
  });
});

describe('„Speicher schützen" befüllt den Wenn/Dann-Baukasten vor', () => {
  it('baut eine gültige, wieder-lesbare Regel mit Hysterese', () => {
    const rule = speicherSchutzRegel([WALLBOX, SPEICHER]);
    expect(rule).not.toBeNull();
    expect(rule!.conditions[0]).toMatchObject({
      kind: 'entity', entityId: 'e-batt', channel: 'soc_pct', direction: 'above',
    });
    expect((rule!.conditions[0] as { hysteresis?: number }).hysteresis).toBeGreaterThan(0);

    // Sie geht durch den GETEILTEN Emitter und ist danach wieder lesbar
    // (Roundtrip-Gesetz) und clientseitig gültig.
    const doc = buildGuidedFlow(rule!, 'Speicher schützen', 's-1');
    expect(parseGuidedFlow(doc)).toEqual(rule);
    expect(validateFlow(doc, [WALLBOX, SPEICHER]).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('erfindet nichts, wenn die Zutaten fehlen', () => {
    expect(speicherSchutzRegel([WALLBOX])).toBeNull();
    expect(speicherSchutzRegel([SPEICHER])).toBeNull();
    expect(speicherSchutzRegel([])).toBeNull();
  });

  it('findet Speicher und schaltbare Komponenten über die FÄHIGKEITEN', () => {
    expect(speicherEntity([WALLBOX, SPEICHER])?.id).toBe('e-batt');
    expect(speicherEntity([WALLBOX])).toBeNull();
    expect(schaltbareKomponenten([WALLBOX, SPEICHER, ZAEHLER]).map((e) => e.id)).toEqual(['e-wb']);
  });
});
