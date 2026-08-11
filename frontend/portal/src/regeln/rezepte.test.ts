import { describe, expect, it } from 'vitest';
import { buildPolicyDocument, type BuildOptions } from '../consumers/policy';
import type { ConsumerDraft } from '../consumers/questions';
import { isValid, validatePolicy } from '../consumers/validate';
import { buildGuidedFlow, parseGuidedFlow } from '../flows/guidedBuilder';
import type { EditorEntity } from '../flows/model';
import { validateFlow } from '../flows/validate';
import {
  GALERIE_FRAGE,
  istVerbraucherRezept,
  REZEPTE,
  REZEPT_PREFILL,
  rezept,
  rezeptGalerie,
  rezeptGrund,
  rezeptPrefill,
  schaltbareKomponenten,
  speicherEntity,
  speicherSchutzRegel,
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

describe('Die Rezept-Galerie (5b.4)', () => {
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

describe('Die Galerie blendet aus statt auszugrauen', () => {
  it('zeigt auf einer vollständigen Anlage alle nutzbaren Rezepte', () => {
    const g = rezeptGalerie({ entities: [WALLBOX, SPEICHER, ZAEHLER] });
    expect(g.passend.map((r) => r.id)).toEqual([
      'pv-surplus-consumer', 'schedule-consumer', 'price-consumer',
      'deadline-consumer', 'storage-protect',
    ]);
    expect(g.ausgeblendet).toHaveLength(0);
    expect(g.aufklappZeile).toBeNull();
    expect(g.brauchtKomponente).toBe(false);
  });

  it('blendet das Speicher-Rezept ohne Speicher aus UND nennt den Grund', () => {
    const g = rezeptGalerie({ entities: [WALLBOX] });
    expect(g.passend.map((r) => r.id)).not.toContain('storage-protect');
    expect(g.ausgeblendet.map((r) => r.id)).toEqual(['storage-protect']);
    expect(g.ausgeblendet[0].grund).toContain('Speicher');
    expect(g.aufklappZeile).toBe('1 weiteres Rezept passt nicht zu Ihrer Anlage');
  });

  it('ohne schaltbares Gerät bietet sie den Weg an, statt eine Sackgasse zu zeigen', () => {
    const g = rezeptGalerie({ entities: [SPEICHER, ZAEHLER] });
    expect(g.passend).toHaveLength(0);
    expect(g.brauchtKomponente).toBe(true);
    expect(g.aufklappZeile).toContain('5');
    for (const k of g.ausgeblendet) expect(k.grund).toContain('steuerbares Gerät');
  });

  it('„Sag mir Bescheid" wird GEZEIGT — ehrlich vertagt, mit dem echten Grund', () => {
    const g = rezeptGalerie({ entities: [WALLBOX, SPEICHER] });
    expect(g.bald.map((r) => r.id)).toEqual(['notify']);
    const karte = g.bald[0];
    expect(karte.bald).toBe(true);
    expect(karte.waehlbar).toBe(false);
    expect(karte.grund).toContain('Zustellweg');
    // Es steht weder unter den passenden noch unter den ausgeblendeten.
    expect([...g.passend, ...g.ausgeblendet].map((r) => r.id)).not.toContain('notify');
  });

  it('nennt den Grund auch je einzelnem Rezept', () => {
    const notify = rezept('notify')!;
    expect(rezeptGrund(notify, { entities: [WALLBOX] })).toContain('Zustellweg');
    const speicher = rezept('storage-protect')!;
    expect(rezeptGrund(speicher, { entities: [WALLBOX] })).toContain('Speicher');
    expect(rezeptGrund(speicher, { entities: [WALLBOX, SPEICHER] })).toBeNull();
  });

  it('die Einleitung fragt nach dem ERGEBNIS, nicht nach der Technik', () => {
    expect(GALERIE_FRAGE).toBe('Was soll Ihre Anlage für Sie erledigen?');
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
