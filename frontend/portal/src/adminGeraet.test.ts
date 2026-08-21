import { describe, expect, it } from 'vitest';
import {
  findeGeraet,
  geraetView,
  kundenGeraetZiel,
  lebendigkeit,
  REGISTRY_AUFKLEBER,
  REGISTRY_SELBST,
  verlauf,
  VERLAUF_MAX,
  type GeraetInput,
  geraetLinkAusgang,
  NOCH_KEIN_GERAET,
  NICHT_GEFUNDEN,
  OHNE_ANLAGE,
} from './adminGeraet';
import type { AdminDeviceRow, ControlCandidate } from './admin/adminApi';
import type { AdminFleetSite } from './admin/fleetApi';
import type { EdgeUpdatesRelease, JournalEntry } from './adminEdgeUpdates';

const NOW = new Date('2026-08-18T10:00:00Z');

/** Eine echte Bestandsbox: `edge-`Referenz, verbunden, aktuell. */
const BOX: AdminDeviceRow = {
  deviceId: 'd1',
  externalRef: 'edge-k2m4pqj',
  label: 'Wechselrichter Scheune',
  siteId: 's1',
  siteName: 'Auernheim',
  tenantId: 't1',
  tenantName: 'Maximilian Wüstholz',
  kind: 'inverter',
  ist: 'edge-2026.08.1-9b37439a02c1',
  soll: 'edge-2026.08.1',
  sollSeq: 14,
  channel: 'stable',
  pinned: false,
  state: 'bestaetigt',
  reason: null,
  blocker: null,
  lastSeenAt: '2026-08-18T09:58:00Z',
  reportedAt: '2026-08-18T09:55:00Z',
  provisioned: false,
  note: null,
  provisionedAt: null,
  trust: {
    rootKeyIds: ['root-2026-a'],
    trustSetKeyIds: ['rel-2026-a'],
    trustSetGeneratedAt: '2026-08-04T10:00:00Z',
    trustSetError: null,
  },
  apply: null,
};

/** Eine gedruckte Aufkleber-ID, die noch niemand verbunden hat. */
const GEDRUCKT: AdminDeviceRow = {
  ...BOX,
  deviceId: null,
  externalRef: 'VP-DEMO-0002',
  label: null,
  siteId: null,
  siteName: null,
  tenantId: null,
  tenantName: null,
  ist: null,
  soll: null,
  sollSeq: null,
  channel: null,
  pinned: false,
  state: null,
  lastSeenAt: null,
  reportedAt: null,
  provisioned: true,
  provisionedAt: '2026-07-01T00:00:00Z',
  trust: null,
};

const SITE: AdminFleetSite = {
  siteId: 's1',
  siteName: 'Auernheim',
  tenantId: 't1',
  tenantName: 'Maximilian Wüstholz',
  plantKind: 'eigenverbrauch',
  netzladenErlaubt: false,
  tarifArt: 'dynamisch',
  deviceCount: 1,
  onlineCount: 1,
  waitingCount: 0,
  worstStatus: 'online',
  lastSeenAt: '2026-08-18T09:58:00Z',
  lastPlanGeneratedAt: '2026-08-18T09:45:00Z',
  hasStorage: true,
  batteryWithoutDevice: false,
  sources: { total: 3, ok: 2, stale: 1, never: 0 },
  edge: null,
  update: null,
  control: {
    deviceId: 'd1',
    commandedKw: -6.1,
    confirmedKw: -6.1,
    allMatch: true,
    controlEnabled: true,
    certified: true,
    mismatchRoles: null,
    slotStart: null,
    checkedAt: '2026-08-18T09:59:00Z',
    certSource: 'platform',
  },
  curtailment: {
    deviceId: 'd1',
    units: 2,
    certifiedUnits: 0,
    controlEnabled: true,
    active: false,
    appliedCapKw: null,
    allMatch: null,
    possibleOverride: false,
    checkedAt: '2026-08-18T09:59:00Z',
    exportGuard: {
      limitKw: 70,
      state: 'ueberwacht',
      reason: 'Die Einspeisung liegt unter der Grenze.',
      capKw: null,
      limiting: false,
      blind: false,
      effective: true,
      reach: null,
    },
    deviceExportLimit: {
      limitKw: 33,
      register: '0x00E7',
      readAt: '2026-08-18T04:00:00Z',
    },
  },
  kwp: { configuredKwp: 30, observedPeakKw: 28, buckets: 200, verdict: 'ok', reason: '' },
  forecast: [],
  pflege: [],
};

const CANDIDATE: ControlCandidate = {
  deviceId: 'd1',
  tenantId: 't1',
  siteId: 's1',
  siteName: 'Auernheim',
  tenantName: 'Maximilian Wüstholz',
  externalRef: 'edge-k2m4pqj',
  activated: true,
  platformCertVerdict: 'granted',
  platformCertModel: 'sun-30k-sg01hp3',
  certSource: 'platform',
  activatedAt: '2026-08-10T08:00:00Z',
  activatedBy: 'admin',
};

const RELEASES: EdgeUpdatesRelease[] = [
  {
    releaseSeq: 14,
    version: 'edge-2026.08.1',
    targetCommit: null,
    notes: null,
    signed: true,
    signingKeyId: 'rel-2026-a',
    createdAt: '2026-08-04T10:00:00Z',
    runningOnDevices: 1,
  },
  {
    releaseSeq: 13,
    version: 'edge-2026.08.0',
    targetCommit: null,
    notes: null,
    signed: false,
    signingKeyId: null,
    createdAt: '2026-08-01T10:00:00Z',
    runningOnDevices: 0,
  },
];

const JOURNAL: JournalEntry[] = [
  { id: 1, at: '2026-08-18T09:00:00Z', actor: 'admin', event: 'target_set', rolloutId: null, deviceId: 'd1', detail: null },
  { id: 2, at: '2026-08-18T08:00:00Z', actor: 'system', event: 'target_set', rolloutId: null, deviceId: 'd-fremd', detail: null },
];

function input(over: Partial<GeraetInput> = {}): GeraetInput {
  return {
    ref: 'edge-k2m4pqj',
    devices: [BOX, GEDRUCKT],
    sites: [SITE],
    candidates: [CANDIDATE],
    releases: RELEASES,
    journal: JOURNAL,
    ...over,
  };
}

describe('findeGeraet - die REFERENZ ist der Schlüssel', () => {
  it('findet unabhängig von der Groß-/Kleinschreibung', () => {
    expect(findeGeraet([BOX, GEDRUCKT], 'EDGE-K2M4PQJ')?.deviceId).toBe('d1');
    expect(findeGeraet([BOX, GEDRUCKT], 'vp-demo-0002')?.externalRef).toBe('VP-DEMO-0002');
    expect(findeGeraet([BOX, GEDRUCKT], '  edge-k2m4pqj ')?.deviceId).toBe('d1');
  });

  it('gibt null zurück, wo es nichts zu finden gibt', () => {
    expect(findeGeraet([BOX], 'VP-GIBT-ES-NICHT')).toBeNull();
    expect(findeGeraet(null, 'edge-k2m4pqj')).toBeNull();
    expect(findeGeraet([BOX], '')).toBeNull();
  });
});

describe('geraetView - die sieben Sektionen aus vier Reads', () => {
  it('komponiert Kopf, Software, Vertrauen, Steuerung, Grenzen und Verlauf', () => {
    const v = geraetView(input(), NOW)!;
    expect(v).not.toBeNull();

    // Kopf: das GERÄT führt, die Anlage steht als Kontext daneben.
    expect(v.kopf.name).toBe('Wechselrichter Scheune');
    expect(v.kopf.ref).toBe('edge-k2m4pqj');
    expect(v.kopf.kontext).toBe('Auernheim · Maximilian Wüstholz');
    expect(v.kopf.lebendigkeit.tone).toBe('ok');
    expect(v.kopf.sprungAnlage).toEqual({ tenantId: 't1', siteId: 's1' });

    // Software: Tag + Build getrennt, Soll benannt, Zustand aus stateLabel.
    const werte = Object.fromEntries(v.software.zeilen.map((z) => [z.label, z.wert]));
    expect(werte.Ist).toBe('edge-2026.08.1 (Build 9b37439a)');
    expect(werte.Soll).toBe('edge-2026.08.1');
    expect(werte.Zustand).toBe('bestätigt ✓');
    // „Ist gemeldet" rechnet gegen DIESELBE Bezugszeit wie der Kopf - sonst
    // behaupteten zwei Zeilen derselben Seite verschiedene Alter.
    expect(werte['Ist gemeldet']).toBe('vor 5\u00a0Min.');
    // Nur SIGNIERTE Releases sind verteilbar.
    expect(v.software.signierteReleases.map((r) => r.releaseSeq)).toEqual([14]);

    expect(v.vertrauen.state).toBe('gekreuzt');
    expect(v.vertrauen.trustSet).toEqual(['rel-2026-a']);

    expect(v.steuerung.freigabe?.state).toBe('aktiv');
    expect(v.steuerung.beleg?.tone).toBe('ok');

    // Grenzen: der Satz der Box, durchgereicht - plus die Diskrepanz-Zeile.
    expect(v.grenzen.guard?.line).toContain('Die Einspeisung liegt unter der Grenze.');
    expect(v.grenzen.guard?.deviceLimitLine).toContain('33,0');
    // Der Pilsting-Fall steht prominent.
    expect(v.grenzen.freigabeText).toBe('0 von 2 Wechselrichtern freigegeben');

    // Der Verlauf ist der DIESES Geräts, nicht das Flotten-Journal.
    expect(v.verlauf.map((e) => e.id)).toEqual([1]);
  });

  it('gibt null zurück, wenn die Referenz in keinem Inventar vorkommt', () => {
    expect(geraetView(input({ ref: 'VP-GIBT-ES-NICHT' }), NOW)).toBeNull();
    expect(geraetView(input({ devices: null }), NOW)).toBeNull();
  });

  it('behauptet über eine gedruckte, unverbundene ID NICHTS', () => {
    const v = geraetView(input({ ref: 'VP-DEMO-0002' }), NOW)!;
    // Kein Sprung, der nirgends hinführt.
    expect(v.kopf.sprungAnlage).toBeNull();
    expect(v.kopf.sprungBefehle).toBeNull();
    expect(v.kopf.lebendigkeit.label).toBe('wartet auf erste Daten');
    // Keine Software-Zeilen - über eine ID, die sich nie gemeldet hat, ist
    // nichts abzuleiten.
    expect(v.software.zeilen).toEqual([]);
    expect(v.software.verbunden).toBe(false);
    // Steuerung und Grenzen sagen den GRUND, nie ein stilles Nichts.
    expect(v.steuerung.leerGrund).toContain('mit keinem Kundenkonto verbunden');
    expect(v.grenzen.leerGrund).toContain('mit keinem Kundenkonto verbunden');
    expect(v.verlauf).toEqual([]);
    // Und ihre Herkunft ist die Registry.
    const herkunft = v.verbindung.zeilen.find((z) => z.label === 'Herkunft');
    expect(herkunft?.wert).toBe(REGISTRY_AUFKLEBER);
  });

  it('nennt eine `edge-`Referenz als das, was sie ist - kein Mangel', () => {
    const v = geraetView(input(), NOW)!;
    expect(v.verbindung.zeilen.find((z) => z.label === 'Herkunft')?.wert).toBe(REGISTRY_SELBST);
  });

  it('sagt einen Grund NICHT zweimal, wenn er den Zustand nur wiederholt', () => {
    // Die Puls-Zelle trägt den Freigabestand als Text UND - weil er zugleich
    // die Ursache ist - noch einmal als Begründung. Auf EINER Karte stand
    // derselbe Satz damit doppelt.
    const v = geraetView(input(), NOW)!;
    expect(v.grenzen.abregelung?.text).toBe('0 von 2 Wechselrichtern freigegeben');
    expect(v.grenzen.abregelung?.detail).toBeNull();
  });

  it('behält einen Grund, der etwas ANDERES sagt als der Zustand', () => {
    const abweichend: AdminFleetSite = {
      ...SITE,
      control: { ...SITE.control!, allMatch: false, mismatchRoles: 'battery_power' },
    };
    const v = geraetView(input({ sites: [abweichend] }), NOW)!;
    expect(v.steuerung.beleg?.text).toBe('Rücklesen weicht ab');
    expect(v.steuerung.beleg?.detail).toContain('battery_power');
  });

  it('schreibt einen fremden Beleg NICHT diesem Gerät zu', () => {
    // Der Flotten-Read trägt Steuerungs- und Abregel-Block je ANLAGE; auf einer
    // Anlage mit mehreren Geräten stammt er von genau einem. Gehört er einem
    // anderen, wird hier nichts behauptet.
    const fremd: AdminFleetSite = {
      ...SITE,
      control: { ...SITE.control!, deviceId: 'd-anderes' },
      curtailment: { ...SITE.curtailment!, deviceId: 'd-anderes' },
    };
    const v = geraetView(input({ sites: [fremd] }), NOW)!;
    expect(v.steuerung.beleg?.text).toBe('kein Beleg');
    expect(v.grenzen.guard).toBeNull();
    expect(v.grenzen.leerGrund).toContain('weder einen Einspeisewächter');
  });

  it('degradiert ehrlich, wenn ein Neben-Read ausgefallen ist', () => {
    const v = geraetView(input({ sites: null, candidates: null }), NOW)!;
    // Der Kopf und die Software leben aus dem Geräte-Read und bleiben voll.
    expect(v.kopf.name).toBe('Wechselrichter Scheune');
    expect(v.software.zeilen.length).toBeGreaterThan(0);
    // Die Sektionen, denen ihre Quelle fehlt, sagen das.
    expect(v.steuerung.beleg).toBeNull();
    expect(v.steuerung.leerGrund).toContain('noch nicht gemeldet');
    expect(v.grenzen.leerGrund).toBeTruthy();
    // Ohne Anlage keine Quellen-Zahlen - und KEINE erfundene 0.
    const quellen = v.verbindung.zeilen.find((z) => z.label === 'Quellen');
    expect(quellen?.wert).toBe('—');
    expect(v.verbindung.zeilen.some((z) => z.label === 'Letzter Fahrplan')).toBe(false);
  });

  it('nennt den Hebel einer stehenden Sperre und den Satz der Box', () => {
    const blockiert: AdminDeviceRow = {
      ...BOX,
      state: 'blockiert',
      blocker: 'neutralzeit',
      reason: 'Autonomie blockiert: die Neutral-Zeit ist für diese Familie nicht belegt.',
    };
    const v = geraetView(input({ devices: [blockiert] }), NOW)!;
    expect(v.software.hebel).toBeTruthy();
    // Die Warnung VOR dem Knopf sagt denselben Satz - das darf nicht zweimal
    // auf einer Karte stehen.
    expect(v.software.hebelDoppelt).toBe(true);
    // Der Satz der Box wird DURCHGEREICHT, nie umformuliert.
    expect(v.software.grund).toBe(blockiert.reason);
  });

  it('behauptet ohne gemeldeten Vertrauensanker weder „gekreuzt" noch „offen"', () => {
    const v = geraetView(input({ devices: [{ ...BOX, trust: null }] }), NOW)!;
    expect(v.vertrauen.state).toBe('unbekannt');
    expect(v.vertrauen.trustSet).toEqual([]);
    expect(v.vertrauen.detail).toBeTruthy();
  });

  it('sagt bei fehlender Freigabe-Herkunft „nicht gemeldet", nie „nicht freigegeben"', () => {
    const ohne: AdminFleetSite = { ...SITE, control: { ...SITE.control!, certSource: null } };
    const v = geraetView(
      input({ sites: [ohne], candidates: [{ ...CANDIDATE, certSource: null }] }),
      NOW,
    )!;
    const zeile = v.steuerung.zeilen.find((z) => z.label === 'Herkunft der Freigabe')!;
    expect(zeile.wert).toBe('—');
    expect(zeile.detail).toContain('nicht gemeldet');
  });
});

describe('lebendigkeit - gegen die ANTWORTZEIT, nie gegen eine laufende Uhr', () => {
  it('ist frisch innerhalb des 5-Minuten-Fensters', () => {
    expect(lebendigkeit('2026-08-18T09:58:00Z', NOW).tone).toBe('ok');
  });

  it('meldet sich nicht, sobald das Fenster überschritten ist', () => {
    const v = lebendigkeit('2026-08-18T09:00:00Z', NOW);
    expect(v.tone).toBe('warn');
    // `relAge` bringt seinen Punkt selbst mit - ein zweiter ergäbe „Min..".
    expect(v.detail).toBe('Zuletzt gemeldet vor 1 Std.');
  });

  it('unterscheidet „noch nie" von „meldet sich nicht"', () => {
    expect(lebendigkeit(null, NOW).label).toBe('wartet auf erste Daten');
    expect(lebendigkeit(undefined, NOW).tone).toBe('off');
  });

  it('erfindet aus einem unbrauchbaren Zeitstempel kein Alter', () => {
    expect(lebendigkeit('kaputt', NOW).label).toBe('unbekannt');
  });
});

describe('verlauf', () => {
  it('deckelt die Liste, damit die Sektion nicht zur Journal-Wand wird', () => {
    const viele: JournalEntry[] = Array.from({ length: VERLAUF_MAX + 5 }, (_, i) => ({
      ...JOURNAL[0],
      id: i + 100,
    }));
    expect(verlauf(BOX, viele)).toHaveLength(VERLAUF_MAX);
  });

  it('gibt einer unverbundenen ID NICHT das Flotten-Journal', () => {
    expect(verlauf(GEDRUCKT, JOURNAL)).toEqual([]);
  });
});

describe('kundenGeraetZiel', () => {
  it('führt ein verbundenes Gerät auf die Geräteseite SEINER Anlage - über den Mandanten', () => {
    expect(kundenGeraetZiel(BOX)).toEqual({
      tenantId: 't1',
      siteId: 's1',
      ref: 'edge-k2m4pqj',
    });
  });

  it('führt eine gedruckte, noch nicht verbundene ID NIRGENDWOHIN - sie bleibt Zeile', () => {
    expect(kundenGeraetZiel(GEDRUCKT)).toBeNull();
  });

  it('springt nie ohne Mandant oder Anlage - die Adresse wäre nicht auflösbar', () => {
    expect(kundenGeraetZiel({ ...BOX, tenantId: null })).toBeNull();
    expect(kundenGeraetZiel({ ...BOX, siteId: null })).toBeNull();
    expect(kundenGeraetZiel(null)).toBeNull();
  });
});

/*
  Anlagen-Zentrale Stufe 3 (PR 3b): eine `?geraet=`-Adresse hat GENAU ZWEI
  Ausgänge - weiterleiten oder einen ehrlichen Satz. Die dritte Möglichkeit
  (eine zweite Vollansicht desselben Geräts) ist entfallen.
*/
describe('geraetLinkAusgang - der Deep-Link-Vertrag der abgelösten Vollansicht', () => {
  it('leitet ein verbundenes Gerät auf seine Geräteseite weiter', () => {
    expect(geraetLinkAusgang([BOX], 'edge-k2m4pqj')).toEqual({
      kind: 'weiterleiten',
      tenantId: 't1',
      siteId: 's1',
      ref: 'edge-k2m4pqj',
    });
  });

  it('nennt bei einer gedruckten ID, dass es noch KEIN Gerät gibt', () => {
    const a = geraetLinkAusgang([GEDRUCKT], GEDRUCKT.externalRef);
    expect(a.kind).toBe('hinweis');
    expect(a.kind === 'hinweis' && a.text).toBe(NOCH_KEIN_GERAET);
  });

  it('nennt bei einer unbekannten Referenz, dass es sie nicht gibt', () => {
    const a = geraetLinkAusgang([BOX], 'VP-GIBT-ES-NICHT');
    expect(a.kind === 'hinweis' && a.text).toBe(NICHT_GEFUNDEN);
  });

  it('schweigt nicht, wenn ein verbundenes Gerät keine Anlage nennt', () => {
    // Der Fall ist selten, aber eine tote Adresse wäre schlimmer als ein Satz.
    const a = geraetLinkAusgang([{ ...BOX, siteId: null }], 'edge-k2m4pqj');
    expect(a.kind === 'hinweis' && a.text).toBe(OHNE_ANLAGE);
  });

  it('urteilt ohne Inventar gar nicht über die Referenz - aber nie „weiterleiten"', () => {
    // Der Wirt rendert den Hinweis erst, wenn das Inventar da ist; hier zählt
    // nur, dass niemals eine Weiterleitung erfunden wird.
    expect(geraetLinkAusgang(null, 'edge-k2m4pqj').kind).toBe('hinweis');
  });
});
