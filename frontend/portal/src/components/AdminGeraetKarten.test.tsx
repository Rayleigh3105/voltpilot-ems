import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdminGeraetKarten } from './AdminGeraetKarten';
import { geraetView, type GeraetInput } from '../adminGeraet';
import type { AdminDeviceRow, ControlCandidate } from '../admin/adminApi';
import type { AdminFleetSite } from '../admin/fleetApi';
import type { EdgeUpdatesRelease } from '../adminEdgeUpdates';

const NOW = new Date('2026-08-18T10:00:00Z');

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
    deviceExportLimit: { limitKw: 33, register: '0x00E7', readAt: '2026-08-18T04:00:00Z' },
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
];

function view(over: Partial<GeraetInput> = {}) {
  return geraetView(
    {
      ref: 'edge-k2m4pqj',
      devices: [BOX],
      sites: [SITE],
      candidates: [CANDIDATE],
      releases: RELEASES,
      journal: [],
      ...over,
    },
    NOW,
  );
}

const base = {
  busy: false,
  onNavigateSteuerung: vi.fn(),
};

/**
 * Anlagen-Zentrale Stufe 3 (PR 3b): die Plattform-Sicht hat seit PR 1f ZWEI
 * Wirte gehabt (die Admin-Vollansicht und die Kunden-Geräteseite); mit dem
 * Rückbau ist nur noch die Geräteseite übrig. Diese Suite ist die UMGEZOGENE
 * Abdeckung der entfallenen `GeraetSeite.test.tsx` - sie prüft jetzt den
 * BLOCK selbst, also unabhängig davon, wer ihn hostet.
 */
describe('AdminGeraetKarten - die Plattform-Sicht EINES Geräts', () => {
  it('rendert alle sechs Sektionen an EINEM Ort', () => {
    render(<AdminGeraetKarten {...base} view={view()!} />);
    for (const titel of [
      'Software',
      'Vertrauen',
      'Steuerung',
      'Grenzen & Wächter',
      'Verbindung & Onboarding',
      'Verlauf',
    ]) {
      expect(screen.getByRole('heading', { name: new RegExp(titel) })).toBeInTheDocument();
    }
  });

  it('reicht die Sätze der Box DURCH, statt sie neu zu formulieren', () => {
    render(<AdminGeraetKarten {...base} view={view()!} />);
    expect(screen.getByTestId('geraet-guard')).toHaveTextContent(
      'Die Einspeisung liegt unter der Grenze.',
    );
    // Die Diskrepanz zwischen Gerät und hinterlegter Grenze - der Asbeck-Fall.
    expect(screen.getByTestId('geraet-device-limit')).toHaveTextContent('33,0');
    // Und der Freigabestand der Abregel-Einheiten, der Pilsting-Fall.
    expect(screen.getByTestId('geraet-abregelung')).toHaveTextContent(
      '0 von 2 Wechselrichtern freigegeben',
    );
  });

  it('weist ein Release zu und nimmt die Zuweisung zurück', () => {
    const onAssign = vi.fn().mockResolvedValue(undefined);
    const onRevert = vi.fn().mockResolvedValue(undefined);
    render(<AdminGeraetKarten {...base} view={view()!} onAssign={onAssign} onRevert={onRevert} />);
    fireEvent.click(screen.getByRole('button', { name: 'Release zuweisen' }));
    expect(onAssign).toHaveBeenCalledWith(14, 'stable', false);
    fireEvent.click(screen.getByRole('button', { name: 'Zuweisung zurücknehmen' }));
    expect(onRevert).toHaveBeenCalled();
  });

  it('nennt VOR dem Anwenden, was es verhindern wird', () => {
    const blockiert: AdminDeviceRow = {
      ...BOX,
      state: 'blockiert',
      blocker: 'neutralzeit',
      reason: 'Autonomie blockiert: die Neutral-Zeit ist nicht belegt.',
    };
    render(
      <AdminGeraetKarten {...base} view={view({ devices: [blockiert] })!} onApply={vi.fn()} />,
    );
    // Der Satz steht GENAU EINMAL - dort, wo gleich geklickt wird.
    expect(screen.getByTestId('geraet-apply')).toHaveTextContent('Achtung:');
    expect(screen.queryByTestId('geraet-hebel')).toBeNull();
  });

  it('behält den Hebel, wo es gar keinen Anwenden-Knopf gibt', () => {
    const blockiert: AdminDeviceRow = {
      ...BOX,
      state: 'blockiert',
      blocker: 'neutralzeit',
      reason: 'Autonomie blockiert: die Neutral-Zeit ist nicht belegt.',
    };
    render(<AdminGeraetKarten {...base} view={view({ devices: [blockiert] })!} />);
    expect(screen.getByTestId('geraet-hebel')).toHaveTextContent('Hebel:');
  });

  it('bietet den Anwenden-Knopf nicht an, wenn der Wirt ihn nicht ausführen kann', () => {
    render(<AdminGeraetKarten {...base} view={view()!} />);
    expect(screen.queryByTestId('geraet-apply')).toBeNull();
  });

  it('bietet einer gedruckten ID keine Zuweisung an - und sagt an JEDER Sektion warum', () => {
    const gedruckt: AdminDeviceRow = {
      ...BOX,
      deviceId: null,
      externalRef: 'VP-DEMO-0002',
      label: null,
      siteId: null,
      siteName: null,
      tenantId: null,
      tenantName: null,
      lastSeenAt: null,
      soll: null,
      state: null,
      provisioned: true,
      trust: null,
    };
    render(
      <AdminGeraetKarten
        {...base}
        view={view({ ref: 'VP-DEMO-0002', devices: [gedruckt] })!}
        onAssign={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Release zuweisen' })).toBeNull();
    // Nie ein stilles Nichts.
    expect(screen.getAllByText(/mit keinem Kundenkonto verbunden/).length).toBeGreaterThan(1);
  });

  it('nennt den Grund, wo eine Sektion nichts zu zeigen hat', () => {
    render(<AdminGeraetKarten {...base} view={view({ sites: null, candidates: null })!} />);
    expect(screen.getByText(/noch nicht gemeldet/)).toBeInTheDocument();
    expect(screen.getByText(/weder einen Einspeisewächter/)).toBeInTheDocument();
  });
});
