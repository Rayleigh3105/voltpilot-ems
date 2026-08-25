import { useEffect, useRef, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type OcppAction,
  type OcppActionAudit,
  type OcppDataGap,
  type OcppActionIntent,
  type OcppActionPermissions,
  type OcppConfiguration,
  type OcppMeterSample,
  type OcppProtocolEvent,
  type OcppStation,
  type OcppTransaction,
} from '../api';
import { fokussierbare } from '../components/VpPanel';
import {
  ACTION_GROUP_LABEL,
  OCPP_ACTIONS,
  ROLE_LABEL,
  actionNeedsIntent,
  actionNeedsPolling,
  actionFingerprint,
  actionHandoffCode,
  actionRequest,
  actionState,
  maskReference,
  parseActionHandoff,
  redactSensitiveText,
  safeActionError,
  safeJson,
  stationConnection,
  stationTitle,
  wallboxHero,
  type OcppActionHandoff,
  type OcppActionDefinition,
  type OcppActionGroup,
} from '../ocppWallbox';
import './OcppWallboxPage.css';

const NAV = [
  ['jetzt', 'Jetzt'], ['stecker', 'Stecker'], ['messwerte', 'Messwerte'],
  ['aktionen', 'Aktionen'], ['konfiguration', 'Konfiguration'], ['ereignisse', 'Ereignisse'],
  ['ladevorgaenge', 'Ladevorgänge'], ['software', 'Software & Diagnose'],
] as const;

interface OcppData {
  stations: OcppStation[];
  events: OcppProtocolEvent[];
  gaps: OcppDataGap[];
  transactions: OcppTransaction[];
  meter: OcppMeterSample[];
  configuration: OcppConfiguration[];
  permissions: OcppActionPermissions;
  actions: OcppAction[];
}

const EMPTY_PERMISSIONS: OcppActionPermissions = { actions: {} };
const EMPTY: OcppData = { stations: [], events: [], gaps: [], transactions: [], meter: [], configuration: [], permissions: EMPTY_PERMISSIONS, actions: [] };

export function OcppWallboxPage({
  siteId, chargePointId, fallbackTitle, backHref,
}: { siteId: string; chargePointId: string; fallbackTitle: string; backHref: string }) {
  const [data, setData] = useState<OcppData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [actionOpen, setActionOpen] = useState<OcppActionDefinition | null>(null);
  const [meterSearch, setMeterSearch] = useState('');
  const [configSearch, setConfigSearch] = useState('');
  const [eventFilter, setEventFilter] = useState('alle');
  const [pollError, setPollError] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setError(null);
    Promise.allSettled([
      api.ocppStations(siteId, controller.signal), api.ocppEvents(siteId, 200, controller.signal),
      api.ocppGaps(siteId, 200, controller.signal), api.ocppTransactions(siteId, 200, controller.signal),
      api.ocppMeterValues(siteId, 1000, controller.signal), api.ocppConfiguration(siteId, chargePointId, controller.signal),
      api.ocppActionPermissions(siteId, controller.signal), api.ocppActions(siteId, chargePointId, 100, controller.signal),
    ]).then((result) => {
      if (!active) return;
      const value = <T,>(index: number, fallback: T): T => result[index].status === 'fulfilled'
        ? (result[index] as PromiseFulfilledResult<T>).value : fallback;
      setData({
        stations: value(0, []), events: value(1, []), gaps: value(2, []), transactions: value(3, []),
        meter: value(4, []), configuration: value(5, []), permissions: value(6, EMPTY_PERMISSIONS),
        actions: value(7, []),
      });
      const failed = result.filter((item) => item.status === 'rejected').length;
      if (failed === result.length) setError('Die OCPP-Gerätedaten konnten nicht geladen werden.');
      else if (failed) setError(`${failed} Teilbereiche sind gerade nicht erreichbar. Die übrigen Daten bleiben sichtbar.`);
    });
    return () => { active = false; controller.abort(); };
  }, [siteId, chargePointId, reload]);

  const shouldPoll = data?.actions.some((action) => actionNeedsPolling(action)) ?? false;

  // Response and observed effect are separate. A bounded timeout-afterrun keeps
  // late evidence visible; cleanup aborts the active request before a target switch.
  useEffect(() => {
    if (!shouldPoll) return;
    let active = true;
    let controller: AbortController | null = null;
    let timer = 0;
    const poll = async () => {
      controller = new AbortController();
      try {
        const actions = await api.ocppActions(siteId, chargePointId, 100, controller.signal);
        if (!active) return;
        setPollError(false);
        setData((old) => old ? { ...old, actions } : old);
      } catch (cause) {
        if (active && !(cause instanceof DOMException && cause.name === 'AbortError')) setPollError(true);
      } finally {
        if (active) timer = window.setTimeout(() => { void poll(); }, 3_000);
      }
    };
    timer = window.setTimeout(() => { void poll(); }, 3_000);
    return () => { active = false; window.clearTimeout(timer); controller?.abort(); };
  }, [shouldPoll, siteId, chargePointId]);

  if (!data) {
    return <Card padding="lg" radius="lg"><p role="status">OCPP-Gerätedaten werden geladen …</p></Card>;
  }
  const station = data.stations.find((item) => item.chargePointId === chargePointId) ?? null;
  const events = data.events.filter((item) => item.chargePointId === chargePointId);
  const gaps = data.gaps.filter((item) => item.deviceId === station?.deviceId);
  const transactions = data.transactions.filter((item) => item.chargePointId === chargePointId);
  const meter = data.meter.filter((item) => item.chargePointId === chargePointId);
  const configuration = data.configuration.find((item) => item.chargePointId === chargePointId) ?? null;
  const hero = wallboxHero(transactions, meter, data.actions, now);
  const connection = stationConnection(station, now);
  const title = stationTitle(station, fallbackTitle);

  const searchedMeter = meter.filter((row) => contains(row, meterSearch));
  const searchedConfig = (configuration?.keys ?? []).filter((row) => contains(row, configSearch));
  const shownEvents = events.filter((row) => eventFilter === 'alle'
    || (eventFilter === 'fehler' ? row.messageType === 'CallError' || Boolean(row.errorCode) : row.action === eventFilter));

  return (
    <div className="vp-ocpp" data-testid="ocpp-wallbox-page">
      <a className="vp-ocpp-back" href={backHref}><Icon name="chevron-left" size={16} /> Zurück zu den Komponenten</a>

      <header className="vp-ocpp-head">
        <div>
          <p className="vp-ocpp-eyebrow">OCPP 1.6J · {chargePointId}</p>
          <h1>{title}</h1>
          <p className="vp-ocpp-sub">
            {[station?.chargePointSerialNumber, station?.firmwareVersion && `Firmware ${station.firmwareVersion}`].filter(Boolean).join(' · ') || 'Stationsdaten noch nicht gemeldet'}
          </p>
        </div>
        <div className="vp-ocpp-connection"><StatusPill ok={connection.sendable}>{connection.label}</StatusPill><small>{connection.detail}</small></div>
      </header>

      {error && (
        <div className={`vp-alert ${data === EMPTY ? 'vp-alert-err' : 'vp-alert-warn'}`} role="status">
          {error} <button type="button" className="vp-linkbtn" onClick={() => setReload((value) => value + 1)}>Erneut laden</button>
        </div>
      )}
      {pollError && <div className="vp-alert vp-alert-warn" role="status">Der Aktionsstatus konnte gerade nicht aktualisiert werden. Der letzte belegte Stand bleibt sichtbar; VoltPilot versucht es erneut.</div>}

      <nav className="vp-ocpp-nav" aria-label="Bereiche der Ladesäule">
        {NAV.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
      </nav>

      <section id="jetzt" className="vp-ocpp-section vp-ocpp-now" aria-labelledby="ocpp-jetzt-title">
        <div className="vp-ocpp-section-title">
          <div><span>Jetzt</span><h2 id="ocpp-jetzt-title">{hero.transaction ? 'Auto lädt' : connection.sendable ? 'Bereit für den nächsten Ladevorgang' : connection.label}</h2></div>
          {hero.transaction && <StatusPill ok>Aktive Transaktion</StatusPill>}
        </div>
        {hero.transaction ? (
          <div className="vp-ocpp-hero-grid">
            <div className="vp-ocpp-power"><span>Leistung</span><strong>{hero.power ?? '—'}</strong><small>{hero.power ? 'aktueller Wert der laufenden Transaktion' : station?.connected && !connection.sendable ? 'kein aktueller Messwert verfügbar' : 'wird von dieser Station nicht geliefert'}</small></div>
            <div className="vp-ocpp-stats">
              <Metric label="Energie" value={hero.energy} absent={station?.connected && !connection.sendable ? 'kein aktueller Wert' : 'nicht geliefert'} />
              <Metric label="Dauer" value={hero.duration} absent="Startzeit fehlt" />
              {hero.soc && <Metric label="SoC" value={hero.soc} />}
              <Metric label="Transaktion" value={`#${hero.transaction.transactionId}`} />
            </div>
            <div className="vp-ocpp-limits">
              <div><span>Freigabe</span><strong>{hero.release}</strong></div>
              <div><span>Angewendetes Limit</span><strong>{hero.applied}</strong></div>
            </div>
            <div className="vp-ocpp-primary-actions">
              <button type="button" className="vp-btn vp-btn--primary vp-btn--md" onClick={() => setActionOpen(findAction('RemoteStopTransaction'))}>Laden stoppen</button>
              <button type="button" className="vp-btn vp-btn--outline vp-btn--md" onClick={() => setActionOpen(findAction('UnlockConnector'))}>Stecker entriegeln</button>
            </div>
          </div>
        ) : (
          <div className="vp-ocpp-empty">
            <p>{connection.sendable ? 'Derzeit läuft keine OCPP-Transaktion.' : `Befehle sind nicht sendbar. ${connection.detail}`}</p>
            <button type="button" className="vp-btn vp-btn--primary vp-btn--md" onClick={() => setActionOpen(findAction('RemoteStartTransaction'))} disabled={!connection.sendable}>Laden starten</button>
          </div>
        )}
      </section>

      <OcppSection id="stecker" label="Stecker" title="Jeder Anschluss für sich">
        {(station?.connectors ?? []).length ? (
          <div className="vp-ocpp-connectors">
            {station!.connectors.map((connector) => (
              <article key={connector.connectorId} className="vp-ocpp-connector">
                <div><span>Stecker {connector.connectorId}</span><strong>{connectorStatus(connector.status)}</strong></div>
                <StatusPill ok={connector.status === 'Available' || connector.status === 'Charging'}>{connector.status}</StatusPill>
                <dl>
                  <div><dt>Fehlercode</dt><dd>{connector.errorCode || 'Kein Fehler gemeldet'}</dd></div>
                  <div><dt>Letzte Nachricht</dt><dd>{time(connector.reportedAt)}</dd></div>
                  <div><dt>Steuerung</dt><dd>{data.permissions.actions.RemoteStartTransaction ? 'steuerbar' : 'nur gelesen'}</dd></div>
                </dl>
                {(connector.info || connector.vendorId || connector.vendorErrorCode) && (
                  <details><summary>Herstellerangaben</summary><p>{connector.vendorId || 'Vendor unbekannt'} · {connector.vendorErrorCode || 'kein Vendor-Fehler'} · {connector.info || 'keine Zusatzinfo'}</p></details>
                )}
              </article>
            ))}
          </div>
        ) : <Empty text="Die Station hat noch keine Connector-Zustände gemeldet." />}
      </OcppSection>

      <OcppSection id="messwerte" label="Messwerte" title="Vollständige MeterValues">
        <Search value={meterSearch} onChange={setMeterSearch} label="Messwerte durchsuchen" placeholder="Measurand, Phase, Einheit oder Rohwert" />
        {searchedMeter.length ? <MeterTable rows={searchedMeter} /> : <Empty text={meter.length ? 'Kein Messwert passt zur Suche.' : 'Diese Station hat noch keine MeterValues geliefert.'} />}
      </OcppSection>

      <OcppSection id="aktionen" label="Aktionen" title="Alltag zuerst, Protokoll bei Bedarf">
        <p className="vp-ocpp-intro">Alle OCPP-1.6-Aktionen bleiben sichtbar. Ein Schloss erklärt fehlende Rollen; die API prüft dieselbe Berechtigung erneut.</p>
        <div className="vp-ocpp-action-groups">
          {(['alltag', 'betrieb', 'protokoll'] as OcppActionGroup[]).map((group) => (
            <details key={group} className="vp-ocpp-action-group" open={group === 'alltag'}>
              <summary><span>{ACTION_GROUP_LABEL[group]}</span><small>{OCPP_ACTIONS.filter((item) => item.group === group).length} Aktionen</small></summary>
              <div className="vp-ocpp-action-list">
                {OCPP_ACTIONS.filter((item) => item.group === group).map((definition) => {
                  const allowed = data.permissions.actions[definition.action] === true;
                  const capabilityUnknown = definition.capability && !station?.supportedFeatureProfiles?.includes(definition.capability);
                  return (
                    <button key={definition.action} type="button" className={`vp-ocpp-action${allowed ? '' : ' is-locked'}`}
                      onClick={() => allowed && setActionOpen(definition)} disabled={!allowed}
                      aria-describedby={`action-help-${definition.action}`}>
                      <span className="vp-ocpp-action-name">{!allowed && <Icon name="lock" size={14} />} {definition.label}</span>
                      <span id={`action-help-${definition.action}`} className="vp-ocpp-action-help">
                        {allowed ? definition.impact : `Gesperrt: erfordert ${ROLE_LABEL[definition.role]}.`}
                      </span>
                      {capabilityUnknown && <span className="vp-ocpp-capability">Fähigkeit nicht gemeldet · NotSupported möglich</span>}
                    </button>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
        <ActionJournal siteId={siteId} actions={data.actions} onChanged={(changed) => {
          setData((old) => old ? { ...old, actions: old.actions.map((row) => row.id === changed.id ? changed : row) } : old);
        }} />
      </OcppSection>

      <OcppSection id="konfiguration" label="Konfiguration" title="Gemeldet, änderbar und unbekannt">
        <Search value={configSearch} onChange={setConfigSearch} label="Konfiguration durchsuchen" placeholder="Schlüssel oder Wert" />
        {searchedConfig.length ? (
          <div className="vp-ocpp-config-list">
            {searchedConfig.map((key) => (
              <article key={key.key} className="vp-ocpp-config-row">
                <div><strong>{key.key}</strong><span>{key.standardKey ? 'OCPP-Standard' : 'Herstellerfeld'} · {key.meaningKnown ? 'Bedeutung bekannt' : 'Bedeutung unbekannt'}</span></div>
                <code>{key.secret || key.redacted ? '••••••••' : key.value === '' ? '(leer)' : key.value ?? '—'}</code>
                <span>{key.readonly ? 'nur gelesen' : 'änderbar'} · bestätigt {time(key.reportedAt)}</span>
              </article>
            ))}
          </div>
        ) : <Empty text={configuration ? 'Kein Schlüssel passt zur Suche.' : 'Die Konfiguration wurde noch nicht gelesen.'} />}
        {(configuration?.unknownKeys ?? []).length > 0 && (
          <details className="vp-ocpp-unknown"><summary>unknownKey ({configuration!.unknownKeys.length})</summary>
            <ul>{configuration!.unknownKeys.map((key) => <li key={key}><code>{key}</code> · von der Station ausdrücklich als unbekannt gemeldet</li>)}</ul>
          </details>
        )}
      </OcppSection>

      <OcppSection id="ereignisse" label="Ereignisse" title="OCPP-Journal mit Rohbeleg">
        <GapEvidence gaps={gaps} />
        <div className="vp-ocpp-filters" role="group" aria-label="Ereignisse filtern">
          {['alle', 'fehler', 'StatusNotification', 'BootNotification', 'FirmwareStatusNotification', 'DiagnosticsStatusNotification'].map((filter) => (
            <button key={filter} type="button" aria-pressed={eventFilter === filter} onClick={() => setEventFilter(filter)}>{filter === 'alle' ? 'Alle' : filter === 'fehler' ? 'Fehler' : filter}</button>
          ))}
        </div>
        {shownEvents.length ? <EventList rows={shownEvents} /> : <Empty text={events.length ? 'Kein Ereignis passt zum Filter.' : 'Noch keine OCPP-Ereignisse aufgezeichnet.'} />}
      </OcppSection>

      <OcppSection id="ladevorgaenge" label="Ladevorgänge" title="Transaktionen ohne Identitätsleck">
        {transactions.length ? <TransactionList rows={transactions} /> : <Empty text="Noch keine Ladevorgänge aufgezeichnet." />}
      </OcppSection>

      <OcppSection id="software" label="Software & Diagnose" title="Was die Station über sich meldet">
        <dl className="vp-ocpp-facts">
          <Fact label="Hersteller" value={station?.chargePointVendor} /> <Fact label="Modell" value={station?.chargePointModel} />
          <Fact label="Stations-Serial" value={station?.chargePointSerialNumber} mono /> <Fact label="Box-Serial" value={station?.chargeBoxSerialNumber} mono />
          <Fact label="Firmware" value={station?.firmwareVersion} /> <Fact label="Letzter Boot" value={station?.bootedAt ? time(station.bootedAt) : null} />
          <Fact label="Diagnose" value={station?.diagnosticsStatus} detail={station?.diagnosticsStatusAt ? time(station.diagnosticsStatusAt) : null} />
          <Fact label="Firmware-Choreografie" value={station?.firmwareStatus} detail={station?.firmwareStatusAt ? time(station.firmwareStatusAt) : null} />
          <Fact label="Zähler" value={[station?.meterType, station?.meterSerialNumber].filter(Boolean).join(' · ') || null} />
          <Fact label="Mobilfunk" value={[maskReference(station?.iccid ?? null), maskReference(station?.imsi ?? null)].filter((v) => v !== '—').join(' · ') || null} mono />
        </dl>
        <details className="vp-ocpp-unknown" open><summary>Gemeldete Fähigkeiten</summary>
          {(station?.supportedFeatureProfiles ?? []).length ? <ul>{station!.supportedFeatureProfiles.map((profile) => <li key={profile}>{profile}</li>)}</ul> : <p>Die Station hat keine Feature Profiles gemeldet. Das ist nicht gleichbedeutend mit „nicht unterstützt“.</p>}
        </details>
      </OcppSection>

      {actionOpen && (
        <ActionDialog definition={actionOpen} siteId={siteId} chargePointId={chargePointId}
          connected={connection.sendable} connectionDetail={connection.detail} transaction={hero.transaction}
          onClose={() => setActionOpen(null)} onCreated={(action) => {
            setData((old) => old ? { ...old, actions: [action, ...old.actions.filter((row) => row.id !== action.id)] } : old);
          }} />
      )}
    </div>
  );
}

function OcppSection({ id, label, title, children }: { id: string; label: string; title: string; children: React.ReactNode }) {
  return <section id={id} className="vp-ocpp-section"><div className="vp-ocpp-section-title"><div><span>{label}</span><h2>{title}</h2></div></div>{children}</section>;
}
function Metric({ label, value, absent = 'nicht geliefert' }: { label: string; value: string | null; absent?: string }) {
  return <div><span>{label}</span><strong>{value ?? '—'}</strong>{!value && <small>{absent}</small>}</div>;
}
function Fact({ label, value, detail, mono }: { label: string; value?: string | null; detail?: string | null; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? 'vp-mono' : undefined}>{value || 'nicht gemeldet'}{detail && <small>{detail}</small>}</dd></div>;
}
function Empty({ text }: { text: string }) { return <div className="vp-ocpp-empty"><Icon name="activity" size={18} /><p>{text}</p></div>; }
function Search({ value, onChange, label, placeholder }: { value: string; onChange: (value: string) => void; label: string; placeholder: string }) {
  return <label className="vp-ocpp-search"><span className="vp-sr-only">{label}</span><Icon name="search" size={16} /><input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}
function StatusPill({ ok, children }: { ok: boolean; children: React.ReactNode }) { return <span className={`vp-ocpp-pill ${ok ? 'is-ok' : 'is-off'}`}><i />{children}</span>; }
function findAction(action: string): OcppActionDefinition { return OCPP_ACTIONS.find((item) => item.action === action)!; }
function time(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' }); }
function contains(value: unknown, query: string): boolean { return !query.trim() || JSON.stringify(value).toLowerCase().includes(query.trim().toLowerCase()); }
function connectorStatus(status: string): string { return ({ Available: 'Frei', Preparing: 'Fahrzeug erkannt', Charging: 'Lädt', SuspendedEV: 'Auto pausiert', SuspendedEVSE: 'Station pausiert', Finishing: 'Wird beendet', Reserved: 'Reserviert', Unavailable: 'Außer Betrieb', Faulted: 'Störung' } as Record<string, string>)[status] ?? `Unbekannter Zustand · ${status}`; }

function MeterTable({ rows }: { rows: OcppMeterSample[] }) {
  return <div className="vp-ocpp-table-wrap"><table className="vp-ocpp-table"><thead><tr><th>Zeit / Stecker</th><th>Measurand</th><th>Wert</th><th>Einordnung</th><th>Quelle / Rohbeleg</th></tr></thead><tbody>
    {rows.map((row) => <tr key={`${row.eventId}-${row.meterValueIndex}-${row.sampledValueIndex}`}>
      <td data-label="Zeit / Stecker">{time(row.sampledAt)}<small>Stecker {row.connectorId}{row.transactionId != null ? ` · Tx #${row.transactionId}` : ''}</small></td>
      <td data-label="Measurand"><strong>{row.measurand || 'Unbekanntes Measurand'}</strong><small>{row.pointKey}</small></td>
      <td data-label="Wert"><strong>{row.numericValue ?? row.value} {row.unit || ''}</strong><small>roh: {row.value} · Format {row.format || 'unbekannt'}</small></td>
      <td data-label="Einordnung">{[row.context, row.phase, row.location].filter(Boolean).join(' · ') || 'keine Semantik gemeldet'}</td>
      <td data-label="Quelle / Rohbeleg">{row.source}<small>Event {row.eventId}</small></td>
    </tr>)}
  </tbody></table></div>;
}

function EventList({ rows }: { rows: OcppProtocolEvent[] }) {
  return <ol className="vp-ocpp-events">{rows.map((row) => <li key={row.eventId} className={row.messageType === 'CallError' || row.errorCode ? 'is-error' : ''}>
    <time>{time(row.occurredAt)}</time><div><strong>{row.action || row.messageType}</strong><span>{row.direction} · {row.messageType}{row.correlationId ? ` · ${row.correlationId}` : ''}</span>
      {(row.errorCode || row.errorDescription) && <p>{redactSensitiveText(row.errorCode || 'OCPP-Fehler')} · {row.errorDescription ? redactSensitiveText(row.errorDescription) : 'keine Beschreibung geliefert'}</p>}
      <details><summary>Technische Details und Rohbeleg</summary><pre>{safeJson({ errorDetails: row.errorDetails, payload: row.payload, eventId: row.eventId })}</pre></details>
    </div></li>)}</ol>;
}

function GapEvidence({ gaps }: { gaps: OcppDataGap[] }) {
  if (!gaps.length) return <p className="vp-ocpp-gap-ok">Keine unvollständige Journalspanne gemeldet.</p>;
  return <div className="vp-ocpp-gaps" role="status"><strong>{gaps.length} belegte Datenlücke{gaps.length === 1 ? '' : 'n'}</strong>
    <p>In diesen Zeiträumen ist das Protokoll nachweislich unvollständig; fehlende Ereignisse werden nicht als „nicht passiert“ gewertet.</p>
    <details><summary>Lückennachweise anzeigen</summary><ul>{gaps.map((gap) => <li key={gap.eventId}>
      <span>{time(gap.reportedAt)} · {gap.droppedCount.toLocaleString('de-DE')} verworfene Ereignisse</span>
      <small>{gap.firstOccurredAt ? time(gap.firstOccurredAt) : 'Beginn unbekannt'} bis {gap.lastOccurredAt ? time(gap.lastOccurredAt) : 'Ende unbekannt'} · Gründe {safeJson(gap.reasons)}</small>
    </li>)}</ul></details>
  </div>;
}

function TransactionList({ rows }: { rows: OcppTransaction[] }) {
  return <div className="vp-ocpp-transactions">{rows.map((row) => <article key={`${row.chargePointId}-${row.transactionId}`}>
    <div className="vp-ocpp-transaction-head"><div><span>Transaktion #{row.transactionId} · Stecker {row.connectorId}</span><strong>{row.stoppedAt ? 'Abgeschlossen' : 'Läuft'}</strong></div><StatusPill ok={!row.stoppedAt}>{row.stoppedAt ? row.stopReason || 'beendet' : 'aktiv'}</StatusPill></div>
    <dl><Fact label="Beginn" value={time(row.startedAt)} /><Fact label="Ende" value={row.stoppedAt ? time(row.stoppedAt) : null} />
      <Fact label="Zähler" value={`${row.meterStart}${row.meterStop != null ? ` → ${row.meterStop}` : ' → läuft'}`} />
      <Fact label="Energie" value={row.meterStop != null ? `${((row.meterStop - row.meterStart) / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kWh` : null} />
      <Fact label="Autorisierung" value={`${maskReference(row.startIdTagRef)}${row.stopIdTagRef ? ` → ${maskReference(row.stopIdTagRef)}` : ''}`} mono />
      <Fact label="Reservierung / Profil" value={[row.reservationId != null && `#${row.reservationId}`, row.chargingProfileId != null && `Profil #${row.chargingProfileId}`, row.chargingProfilePurpose].filter(Boolean).join(' · ') || null} />
    </dl>
    {Boolean(row.transactionData) && <details><summary>TransactionData (maskiert)</summary><pre>{safeJson(row.transactionData)}</pre></details>}
  </article>)}</div>;
}

function ActionJournal({ siteId, actions, onChanged }: { siteId: string; actions: OcppAction[]; onChanged: (action: OcppAction) => void }) {
  if (!actions.length) return <div className="vp-ocpp-journal"><h3>Letzte Aktionen</h3><Empty text="Noch keine OCPP-Aktion ausgeführt." /></div>;
  return <div className="vp-ocpp-journal"><h3>Letzte Aktionen</h3><ol>{actions.slice(0, 12).map((action) =>
    <ActionJournalItem key={action.id} siteId={siteId} action={action} onChanged={onChanged} />)}</ol></div>;
}

function ActionJournalItem({ siteId, action, onChanged }: { siteId: string; action: OcppAction; onChanged: (action: OcppAction) => void }) {
  const [audit, setAudit] = useState<OcppActionAudit[] | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const state = actionState(action.state);
  const deadline = Date.parse(action.deadlineAt);
  const lateResponse = Boolean(action.responseAt && Number.isFinite(deadline) && Date.parse(action.responseAt) > deadline);
  const lateEffect = Boolean(action.effectAt && Number.isFinite(deadline) && Date.parse(action.effectAt) > deadline);

  async function loadAudit() {
    if (auditBusy) return;
    setAuditBusy(true); setRowError(null);
    try { setAudit(await api.ocppActionAudit(siteId, action.id)); }
    catch (cause) { setRowError(safeActionError(cause)); }
    finally { setAuditBusy(false); }
  }

  async function cancel() {
    if (cancelBusy) return;
    setCancelBusy(true); setRowError(null);
    try {
      await api.cancelOcppAction(siteId, action.id);
      onChanged(await api.ocppAction(siteId, action.id));
      setAudit(null);
    } catch (cause) { setRowError(safeActionError(cause)); }
    finally { setCancelBusy(false); }
  }

  return <li className={`is-${state.tone}`}><div className="vp-ocpp-action-result-head"><strong>{OCPP_ACTIONS.find((item) => item.action === action.action)?.label ?? action.action}</strong><time>{time(action.updatedAt)}</time></div>
    <div className="vp-ocpp-two-results"><span><small>OCPP-Antwort</small>{lateResponse ? 'Antwort verspätet eingetroffen' : state.response}{action.responseStatus ? ` · ${action.responseStatus}` : ''}</span><span><small>Wirkungsstatus</small>{lateEffect ? 'Wirkung verspätet beobachtet' : state.effect}</span></div>
    {action.reason && <p>{redactSensitiveText(action.reason)}</p>}
    {rowError && <div className="vp-alert vp-alert-err" role="alert">{rowError}</div>}
    <div className="vp-ocpp-journal-actions">
      {action.state === 'prepared' && <button type="button" className="vp-btn vp-btn--outline vp-btn--md" disabled={cancelBusy} onClick={() => { void cancel(); }}>{cancelBusy ? 'Wird abgebrochen …' : 'Vor Versand abbrechen'}</button>}
      <button type="button" className="vp-linkbtn" disabled={auditBusy} onClick={() => { void loadAudit(); }}>{auditBusy ? 'Auditspur wird geladen …' : audit ? 'Auditspur aktualisieren' : 'Unveränderliche Auditspur laden'}</button>
    </div>
    {audit && <ol className="vp-ocpp-audit" aria-label="Unveränderliche Auditspur">{audit.map((entry) => <li key={entry.id}>
      <time>{time(entry.occurredAt)}</time><strong>{actionState(entry.state).response}</strong><span>{redactSensitiveText(entry.actor)}{entry.reason ? ` · ${redactSensitiveText(entry.reason)}` : ''}</span>
    </li>)}</ol>}
    <details><summary>Anforderung und technische Belege</summary><pre>{safeJson({ correlationId: action.correlationId, request: action.request, response: action.response, effect: action.effect })}</pre></details>
  </li>;
}

function ActionDialog({ definition, siteId, chargePointId, connected, connectionDetail, transaction, onClose, onCreated }: {
  definition: OcppActionDefinition; siteId: string; chargePointId: string; connected: boolean;
  connectionDetail: string; transaction: OcppTransaction | null; onClose: () => void; onCreated: (action: OcppAction) => void;
}) {
  const initial = Object.fromEntries(definition.fields.map((field) => [field.key, field.defaultValue ?? ''])) as Record<string, string>;
  if (transaction) { initial.transactionId ||= String(transaction.transactionId); initial.connectorId ||= String(transaction.connectorId); }
  const [values, setValues] = useState(initial);
  const [intent, setIntent] = useState<OcppActionIntent | null>(null);
  const [phrase, setPhrase] = useState('');
  const [handoffInput, setHandoffInput] = useState('');
  const [handoff, setHandoff] = useState<OcppActionHandoff | null>(null);
  const [handoffCode, setHandoffCode] = useState('');
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<OcppAction | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const requestSeedRef = useRef(crypto.randomUUID());
  closeRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  const missing = handoff ? undefined : definition.fields.find((field) => field.required && !values[field.key]?.trim());
  const hard = Boolean(handoff) || actionNeedsIntent(definition.action, values);
  const waitingForSecondOperator = Boolean(intent?.fourEyes && !handoff);

  function requestClose() { if (!busy) closeRef.current(); }

  function onDialogKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      if (!busy) { event.preventDefault(); event.stopPropagation(); requestClose(); }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = fokussierbare(dialogRef.current);
    if (!focusable.length) return;
    const current = document.activeElement as HTMLElement | null;
    const index = current ? focusable.indexOf(current) : -1;
    const target = event.shiftKey
      ? focusable[(index <= 0 ? focusable.length : index) - 1]
      : focusable[(index + 1) % focusable.length];
    event.preventDefault();
    target?.focus();
  }

  function updateValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    requestSeedRef.current = crypto.randomUUID();
    setIntent(null); setPhrase(''); setHandoff(null); setHandoffCode(''); setCopied(false);
  }

  function importHandoff() {
    try {
      const parsed = parseActionHandoff(handoffInput, { siteId, chargePointId, action: definition.action });
      setHandoff(parsed); setIntent(parsed.intent); setPhrase(''); setHandoffError(null); setError(null);
    } catch (cause) {
      const kind = cause instanceof Error ? cause.message : 'format';
      setHandoffError(kind === 'expired' ? 'Diese Übergabe ist abgelaufen. Der erste Operator muss eine neue erzeugen.'
        : kind === 'binding' ? 'Die Übergabe gehört nicht zu dieser Station oder Aktion.'
          : 'Der Übergabecode ist unvollständig oder beschädigt.');
    }
  }

  async function submit() {
    if (missing || !connected || busy || waitingForSecondOperator) return;
    setBusy(true); setError(null);
    try {
      const request = handoff?.request ?? actionRequest(definition.action, values, requestSeedRef.current);
      const connectorId = handoff?.connectorId ?? (values.connectorId ? Number(values.connectorId) : undefined);
      const transactionId = handoff?.transactionId ?? (values.transactionId ? Number(values.transactionId) : undefined);
      if (hard && !intent) {
        const next = await api.createOcppActionIntent(siteId, chargePointId, { action: definition.action, connectorId, transactionId, request });
        setIntent(next);
        if (next.fourEyes) setHandoffCode(actionHandoffCode({
          version: 1, siteId, chargePointId, action: definition.action,
          connectorId, transactionId, request, intent: next,
        }));
        return;
      }
      const fingerprint = actionFingerprint(definition.action, connectorId, transactionId, request);
      if (attemptRef.current?.fingerprint !== fingerprint) {
        attemptRef.current = { fingerprint, key: crypto.randomUUID() };
      }
      const action = await api.createOcppAction(siteId, chargePointId, {
        action: definition.action, connectorId, transactionId, request,
        ...(intent ? { intentId: intent.id, confirmationPhrase: phrase } : {}),
      }, attemptRef.current.key);
      setCreated(action); onCreated(action);
    } catch (cause) {
      setError(safeActionError(cause));
    } finally { setBusy(false); }
  }

  return <div className="vp-ocpp-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <section ref={dialogRef} tabIndex={-1} className={`vp-ocpp-dialog${hard ? ' is-hard' : ''}`} role="dialog" aria-modal="true"
      aria-labelledby="ocpp-action-title" aria-describedby="ocpp-action-description" onKeyDown={onDialogKeyDown}>
      <header><div><p>OCPP 1.6 · {ACTION_GROUP_LABEL[definition.group]}</p><h2 id="ocpp-action-title">{definition.label}</h2></div><button type="button" onClick={requestClose} disabled={busy} aria-label="Dialog schließen">×</button></header>
      {created ? <div className="vp-ocpp-created"><StatusPill ok={actionState(created.state).tone === 'ok'}>{actionState(created.state).response}</StatusPill>
        <h3>Befehl ist erfasst</h3><p>{actionState(created.state).effect}. Diese zweite Aussage aktualisiert sich im Aktionsjournal.</p>
        <button type="button" className="vp-btn vp-btn--primary vp-btn--md" onClick={requestClose}>Zum Journal</button></div> : <>
        <div id="ocpp-action-description" className="vp-ocpp-impact"><strong>Auswirkung</strong><p>{definition.impact}</p><strong>Bestätigung</strong><p>{definition.confirmation}</p></div>
        {!connected && <div className="vp-alert vp-alert-warn" role="alert">Nicht sendbar: {connectionDetail} Eingaben bleiben sichtbar, Senden ist gesperrt.</div>}
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {definition.action === 'UpdateFirmware' && !intent && <details className="vp-ocpp-handoff-import"><summary>Vier-Augen-Übergabe eines anderen Operators übernehmen</summary>
            <label><span>Übergabecode</span><textarea value={handoffInput} onChange={(event) => setHandoffInput(event.target.value)} /></label>
            {handoffError && <p className="vp-ocpp-validation" role="alert">{handoffError}</p>}
            <button type="button" className="vp-btn vp-btn--outline vp-btn--md" onClick={importHandoff} disabled={!handoffInput.trim()}>Übergabe prüfen</button>
          </details>}
          {handoff ? <div className="vp-ocpp-handoff-bound"><strong>Gebundene Übergabe übernommen</strong><p>Station, Aktion, Nutzlast und Ablauf sind serverseitig gebunden. Änderungen sind nicht möglich.</p><pre>{safeJson({ action: handoff.action, connectorId: handoff.connectorId, transactionId: handoff.transactionId, request: handoff.request, expiresAt: handoff.intent.expiresAt })}</pre></div>
            : <div className="vp-ocpp-form-grid">{definition.fields.map((field) => <label key={field.key}><span>{field.label}{field.required ? ' *' : ''}</span>
              {field.kind === 'select' ? <select value={values[field.key] ?? ''} onChange={(event) => updateValue(field.key, event.target.value)}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                : field.kind === 'textarea' ? <textarea value={values[field.key] ?? ''} placeholder={field.placeholder} onChange={(event) => updateValue(field.key, event.target.value)} />
                  : <input type={field.kind} value={values[field.key] ?? ''} placeholder={field.placeholder} onChange={(event) => updateValue(field.key, event.target.value)} />}
              {field.help && <small>{field.help}</small>}</label>)}</div>}
          {intent?.fourEyes && !handoff && <div className="vp-ocpp-strong-confirm"><strong>Übergabe an zweiten Plattformoperator</strong><p>Dieser Intent darf nicht vom vorbereitenden Konto ausgeführt werden. Übergeben Sie den Code vor {time(intent.expiresAt)} an einen anderen Plattformoperator. Er öffnet dieselbe Aktion und übernimmt den Code.</p>
            <label><span>Gebundener Übergabecode</span><textarea readOnly value={handoffCode} /></label>
            <button type="button" className="vp-btn vp-btn--outline vp-btn--md" onClick={() => { void navigator.clipboard?.writeText(handoffCode).then(() => setCopied(true)); }}>{copied ? 'Übergabecode kopiert' : 'Übergabecode kopieren'}</button>
          </div>}
          {intent && (!intent.fourEyes || handoff) && <div className="vp-ocpp-strong-confirm"><strong>Starke Bestätigung</strong><p>Geben Sie die einmalige Phrase exakt ein. Sie läuft {time(intent.expiresAt)} ab.{handoff ? ' Sie bestätigen als zweiter Plattformoperator die unverändert gebundene Übergabe.' : ''}</p><code>{intent.phrase}</code><label><span>Bestätigungsphrase</span><input value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" /></label></div>}
          {error && <div className="vp-alert vp-alert-err" role="alert">{error}</div>}
          {missing && <p className="vp-ocpp-validation" role="status">Pflichtfeld fehlt: {missing.label}</p>}
          <footer><button type="button" className="vp-btn vp-btn--outline vp-btn--md" onClick={requestClose} disabled={busy}>Abbrechen</button><button type="submit" className={`vp-btn vp-btn--md ${hard ? 'vp-ocpp-danger' : 'vp-btn--primary'}`} disabled={Boolean(missing) || !connected || busy || waitingForSecondOperator || Boolean(intent && (!intent.fourEyes || handoff) && phrase !== intent.phrase)}>{busy ? 'Wird geprüft …' : waitingForSecondOperator ? 'Übergabe durch zweiten Operator erforderlich' : hard && !intent ? 'Starke Bestätigung vorbereiten' : 'Prüfen und senden'}</button></footer>
        </form>
      </>}
    </section>
  </div>;
}
