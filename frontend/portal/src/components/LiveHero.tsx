import type { ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { fmtNum } from '../format';
import {
  batteryState,
  buildSnapshot,
  composeStatusSentence,
  gridState,
  loadState,
  pvState,
  type LiveSnapshot,
} from '../live';
import type { TelemetryPoint } from '../api';
import { EnergyFlow } from './EnergyFlow';

/**
 * The Live-Daten status hero (report direction B): one German status sentence,
 * four verdict tiles (Solar / Batterie / Haus / Netz) and the animated
 * energy-flow diagram - the status-first layer that mirrors the edge device's
 * :8484 dashboard. Signs never reach the customer: the grid/battery tiles flip
 * their labels and the sentence speaks direction words. When the newest sample
 * is past the liveness window everything keeps its last-good value but dims
 * (`fresh=false`), and the sentence goes honest-grey.
 *
 * All derivation lives in the pure, unit-tested `live.ts`; this component only
 * renders it.
 */
export function LiveHero({ points, fresh }: { points: TelemetryPoint[]; fresh: boolean }) {
  const snap = buildSnapshot(points);
  const sentence = composeStatusSentence(snap, fresh);
  const dim = !fresh;

  return (
    <div className="vp-live-hero">
      <p className={`vp-status-line${sentence.live ? '' : ' stale'}`} aria-live="polite">
        <span className="vp-status-dot" aria-hidden="true" />
        <span>{sentence.text}</span>
      </p>

      <div className={`vp-verdict-grid${dim ? ' vp-stale' : ''}`}>
        <SolarTile snap={snap} />
        <BatteryTile snap={snap} />
        <HausTile snap={snap} />
        <NetzTile snap={snap} />
      </div>

      <EnergyFlow snapshot={snap} stale={dim} />
    </div>
  );
}

function Tile({
  cls,
  icon,
  title,
  value,
  children,
}: {
  cls: string;
  icon: ReactNode;
  title: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <div className={`vp-verdict ${cls}`}>
      <span className="vp-verdict-head">
        <span className="vp-verdict-ico">{icon}</span>
        {title}
      </span>
      <span className="vp-verdict-val">{value}</span>
      {children}
    </div>
  );
}

function State({ tone, arrow, children }: { tone: 'accent' | 'muted'; arrow?: 'up' | 'down'; children: ReactNode }) {
  return (
    <span className={`vp-verdict-state${tone === 'muted' ? ' muted' : ''}`}>
      {arrow && <Icon name={arrow === 'up' ? 'arrow-up' : 'arrow-down'} size={14} />}
      {children}
    </span>
  );
}

function SolarTile({ snap }: { snap: LiveSnapshot }) {
  const s = pvState(snap.pvKw);
  return (
    <Tile cls="pv" icon={<Icon name="sun" size={16} />} title="Solar" value={fmtNum(snap.pvKw, 'kW')}>
      {s === 'erzeugt' ? (
        <State tone="accent">Anlage erzeugt</State>
      ) : s === 'keine' ? (
        <State tone="muted">keine Erzeugung</State>
      ) : (
        <State tone="muted">wartet auf Daten</State>
      )}
    </Tile>
  );
}

function BatteryTile({ snap }: { snap: LiveSnapshot }) {
  const s = batteryState(snap.socPct, snap.battKw);
  const pct = snap.socPct == null ? 0 : Math.max(0, Math.min(100, snap.socPct));
  return (
    <Tile
      cls="batt"
      icon={<Icon name="battery" size={16} />}
      title="Batterie"
      value={snap.socPct == null ? '–' : fmtNum(snap.socPct, '%', 0)}
    >
      {s === 'laedt' ? (
        <>
          <State tone="accent" arrow="up">
            Lädt
          </State>
          {snap.battKw != null && (
            <span className="vp-verdict-sub">Ladeleistung {fmtNum(snap.battKw, 'kW')}</span>
          )}
        </>
      ) : s === 'entlaedt' ? (
        <>
          <State tone="accent" arrow="down">
            Entlädt
          </State>
          {snap.battKw != null && (
            <span className="vp-verdict-sub">Abgabe {fmtNum(Math.abs(snap.battKw), 'kW')}</span>
          )}
        </>
      ) : s === 'voll' ? (
        <State tone="muted">Voll geladen</State>
      ) : s === 'bereit' ? (
        <State tone="muted">Bereit</State>
      ) : (
        <State tone="muted">keine Batterie</State>
      )}
      {snap.socPct != null && (
        <span className="vp-verdict-soc" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
    </Tile>
  );
}

function HausTile({ snap }: { snap: LiveSnapshot }) {
  const s = loadState(snap.loadKw);
  return (
    <Tile cls="load" icon={<Icon name="building" size={16} />} title="Haus" value={fmtNum(snap.loadKw, 'kW')}>
      {s === 'bedarf' ? (
        <State tone="accent">aktueller Bedarf</State>
      ) : s === 'keiner' ? (
        <State tone="muted">kein Verbrauch</State>
      ) : (
        <State tone="muted">wartet auf Daten</State>
      )}
    </Tile>
  );
}

function NetzTile({ snap }: { snap: LiveSnapshot }) {
  const s = gridState(snap.gridKw);
  const abs = snap.gridKw == null ? null : Math.abs(snap.gridKw);
  return (
    <Tile cls="grid" icon={<Icon name="zap" size={16} />} title="Netz" value={fmtNum(abs, 'kW')}>
      {s === 'bezug' ? (
        <>
          <State tone="accent" arrow="up">
            Netzbezug
          </State>
          <span className="vp-verdict-sub">aus dem Netz</span>
        </>
      ) : s === 'einspeisung' ? (
        <>
          <State tone="accent" arrow="down">
            Einspeisung
          </State>
          <span className="vp-verdict-sub">ins Netz</span>
        </>
      ) : s === 'ausgeglichen' ? (
        <State tone="muted">ausgeglichen</State>
      ) : (
        <State tone="muted">wartet auf Daten</State>
      )}
    </Tile>
  );
}
