import { useEffect, useState } from 'react';
import { api } from '../api';
import { VpPicker } from './VpPicker';
import { finiteInput, initialOcppControl, observedOcpp, ocppReadiness, withOcppLimit,
  type OcppControlPolicy, type OcppControlView } from '../ocppControl';
import './OcppControlPanel.css';

export function OcppControlPanel({ siteId, stationId, deviceId, canEdit }: {
  siteId: string; stationId: string; deviceId?: string; canEdit: boolean;
}) {
  const [view, setView] = useState<OcppControlView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connector, setConnector] = useState('1');
  const [kw, setKw] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [voltage, setVoltage] = useState('');
  const [current, setCurrent] = useState('');
  const [phases, setPhases] = useState<number[]>([]);
  const [circuits, setCircuits] = useState(['', '', '']);
  const [supervised, setSupervised] = useState(false);
  const [testKw, setTestKw] = useState('6');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    const load = async () => {
      try { const v = await api.ocppControl(siteId); if (active) { setView((old) => old && (old.desired?.revision ?? 0) > (v.desired?.revision ?? 0) ? old : v); setNow(Date.now()); } }
      catch { if (active) setError('OCPP-Einrichtung konnte nicht geladen werden.'); }
    };
    void load(); const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [siteId]);

  async function save(change: (p: OcppControlPolicy) => OcppControlPolicy) {
    if (!view || busy) return;
    setBusy(true); setError('');
    try { setView(await api.saveOcppControl(siteId, change(view.desired ?? initialOcppControl()))); setNow(Date.now()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Einstellungen konnten nicht gespeichert werden.'); }
    finally { setBusy(false); }
  }
  const desired = view?.desired ?? initialOcppControl();
  const observed = view ? observedOcpp(view, stationId, deviceId) : undefined;
  const station = observed?.state.stations.find((s) => s.id === stationId);
  const connectorId = Number(connector);
  const options = [...new Set([1, ...(station?.connectors.map((c) => c.id) ?? []),
    ...desired.electrical.filter((e) => e.charge_point_id === stationId).map((e) => e.connector_id)])].sort((a, b) => a - b);
  const limit = desired.limits.find((l) => l.charge_point_id === stationId && l.connector_id === connectorId);
  const wiring = desired.electrical.find((e) => e.charge_point_id === stationId && e.connector_id === connectorId);
  const tags = [...new Set([...(observed?.state.seen_tags ?? []), ...desired.authorization.allowed_tags])];
  const test = observed?.state.test?.charge_point_id === stationId && observed.state.test.connector_id === connectorId ? observed.state.test : undefined;
  const requestedTest = desired.test?.charge_point_id === stationId && desired.test.connector_id === connectorId ? desired.test : undefined;
  const pendingTest = requestedTest && (!test || Date.parse(test.requested_at) !== Date.parse(requestedTest.requested_at));
  return <div className="vp-ocpp-control">
    <h3>OCPP einrichten und prüfen</h3>
    <p>Die Box verteilt das Ladebudget. Manuelle Grenzen gelten zusätzlich zu Anschlussgrenze, Phasengrenzen und Sicherheitsprofil.</p>
    {error && <p role="alert">{error}</p>}
    {!view ? <p role="status">Einrichtung wird geladen …</p> : <>
      <VpPicker label="Stecker für Grenze und Prüfung" value={connector} options={options.map((id) => ({ value: String(id), label: `Stecker ${id}` }))} onChange={setConnector} />
      <dl className="vp-ocpp-control-facts">{ocppReadiness(view, stationId, connectorId, now, deviceId).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {canEdit && <fieldset disabled={busy}>
        <legend>Freigabe für die OCPP-Säulen dieser Anlage</legend>
        <p>Der Not-Aus der Box bleibt wirksam. Diese Freigabe schaltet ausschließlich die OCPP-Regelung frei.</p>
        <div className="vp-ocpp-control-buttons">
          <button type="button" onClick={() => void save((p) => ({ ...p, enabled: true }))}>OCPP-Regelung freigeben</button>
          <button type="button" onClick={() => void save((p) => ({ ...p, enabled: false }))}>Regelung abschalten</button>
        </div>
        <p>Gespeichert: {desired.enabled == null ? 'bisherige Box-Einstellung' : desired.enabled ? 'freigegeben' : 'abgeschaltet'}. Maßgeblich ist die Bestätigung der Box oben.</p>
      </fieldset>}
      {canEdit && <fieldset disabled={busy}>
        <legend>Zeitlich begrenzte Ladegrenze</legend>
        <div className="vp-ocpp-control-inputs">
          <label>Ladegrenze in kW<input inputMode="decimal" value={kw} onChange={(e) => setKw(e.target.value)} placeholder="z. B. 11" /></label>
          <label>Dauer in Minuten<input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} /></label>
        </div>
        <p>0 kW pausiert den gewählten Stecker. Höchstens 24 Stunden; die Grenze erhöht kein verfügbares Ladebudget. Fällt die Box aus, läuft die aktuelle Vorgabe spätestens nach zwei Minuten aus; dann gilt das Sicherheitsprofil der Säule.</p>
        <div className="vp-ocpp-control-buttons">
          <button type="button" onClick={() => void save((p) => withOcppLimit(p, stationId, connectorId, kw, minutes, Date.now()))}>Ladegrenze speichern</button>
          {limit && <button type="button" onClick={() => void save((p) => ({ ...p, limits: p.limits.filter((l) => l !== limit) }))}>Ladegrenze aufheben</button>}
        </div>
        {limit && <p>{Date.parse(limit.expires_at) > now ? 'Angefordert' : 'Abgelaufen'}: {limit.limit_kw} kW bis {new Date(limit.expires_at).toLocaleString('de-DE')}.</p>}
      </fieldset>}
      {canEdit && <details>
        <summary>AC-Anschluss und Phasengrenzen</summary>
        <p>Von der Elektrofachkraft bestätigte Verdrahtung eintragen. Die Spannung ist die obere Betriebsspannung zwischen Phase und Neutralleiter. Alle Säulen mit gemeinsamen Phasengrenzen müssen an derselben Box hängen. Die Strombudgets müssen für den Ladepark verfügbar sein und Reserven für andere Verbraucher bereits enthalten.</p>
        <p>Phasengrenzen lassen sich nur übernehmen, wenn alle Säulen verbunden und alle Stecker frei sind. Nach einer Ablehnung erneut speichern, sobald diese Bedingungen erfüllt sind.</p>
        {wiring && <p>Hinterlegt für Stecker {connector}: {wiring.voltage_v} V, Phase {wiring.phases.join(', ')}, höchstens {wiring.max_current_a} A.</p>}
        <fieldset disabled={busy}>
          <legend>Verdrahtung dieses Steckers</legend>
          <div className="vp-ocpp-control-inputs">
            <label>Obere Betriebsspannung in V<input inputMode="decimal" value={voltage} onChange={(e) => setVoltage(e.target.value)} /></label>
            <label>Stromgrenze des Steckers in A<input inputMode="decimal" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
          </div>
          <div className="vp-ocpp-control-buttons">{[1, 2, 3].map((phase) => <label key={phase}><input type="checkbox" checked={phases.includes(phase)} onChange={(e) => setPhases(e.target.checked ? [...phases, phase].sort() : phases.filter((p) => p !== phase))} />Phase L{phase}</label>)}</div>
          <div className="vp-ocpp-control-inputs">{circuits.map((value, index) => <label key={index}>Ladepark-Budget L{index + 1} in A<input inputMode="decimal" value={value} onChange={(e) => setCircuits(circuits.map((v, i) => i === index ? e.target.value : v))} /></label>)}</div>
          <button type="button" onClick={() => void save((p) => {
            if (!phases.length) throw new Error('Bitte die tatsächlich angeschlossenen Phasen wählen.');
            return { ...p, phase_limits_a: circuits.map((v) => finiteInput(v, 0, 2000, 'Phasenbudget')),
              electrical: [...p.electrical.filter((e) => e.charge_point_id !== stationId || e.connector_id !== connectorId), {
                charge_point_id: stationId, connector_id: connectorId, voltage_v: finiteInput(voltage, 100, 300, 'Spannung'),
                max_current_a: finiteInput(current, 1, 2000, 'Stromgrenze'), phases,
              }] };
          })}>Bestätigte Anschlussdaten speichern</button>
          <p>Alle Stecker benötigen eine Zuordnung. Die Box reserviert je Phase feste Anteile auch für getrennte Säulen. Eine Phasenumschaltung wird dadurch nicht ausgelöst.</p>
        </fieldset>
      </details>}
      {canEdit && <details>
        <summary>Ladekarten und Zugang</summary>
        <p>Gilt für neue Ladevorgänge an den OCPP-Säulen dieser Anlage. Eine Rücknahme beendet keinen bereits laufenden Ladevorgang. Fahrzeugprofile für Stromquelle und Priorität bleiben davon unabhängig.</p>
        <fieldset disabled={busy}>
          <legend>Zugangsmodus</legend>
          <VpPicker label="Ladeberechtigung" value={desired.authorization.mode} options={[{ value: 'free', label: 'Freies Laden' }, { value: 'allowlist', label: 'Nur freigegebene Karten' }]}
            onChange={(mode) => void save((p) => ({ ...p, authorization: { ...p.authorization, mode: mode as 'free' | 'allowlist' } }))} />
          <p>Karte an der Säule vorhalten, dann die gesichtete Referenz freigeben. Bei Cloud-Ausfall entscheidet die Box weiter lokal. Ohne Verbindung zur Box startet die Säule im Kartenmodus keinen neuen, ungeprüften Ladevorgang.</p>
          {tags.length ? tags.map((tag) => <label className="vp-ocpp-card-choice" key={tag}><input type="checkbox" checked={desired.authorization.allowed_tags.includes(tag)}
            onChange={(e) => void save((p) => ({ ...p, authorization: { ...p.authorization, allowed_tags: e.target.checked
              ? [...p.authorization.allowed_tags, tag] : p.authorization.allowed_tags.filter((t) => t !== tag) } }))} />Karte …{tag.slice(-8)}</label>) : <p>Noch keine Karte von dieser Box gesichtet.</p>}
        </fieldset>
      </details>}
      <fieldset disabled={busy}>
        <legend>Beaufsichtigte Regelprüfung</legend>
        <p>Mit einem ladenden Fahrzeug: 60 Sekunden begrenzen, 60 Sekunden pausieren, 60 Sekunden wieder laden. Die Ausgangsleistung muss über der Prüfgrenze liegen. Die Prüfgrenze muss über der Mindestladeleistung des Fahrzeugs liegen. Eine Bestätigung erfordert Rücklesung und passende frische Leistungsmessungen in allen drei Schritten.</p>
        {canEdit && <>
          <label>Prüfgrenze in kW<input inputMode="decimal" value={testKw} onChange={(e) => setTestKw(e.target.value)} /></label>
          <label className="vp-ocpp-card-choice"><input type="checkbox" checked={supervised} onChange={(e) => setSupervised(e.target.checked)} />Ich beaufsichtige den Ladevorgang während der Prüfung.</label>
          <div className="vp-ocpp-control-buttons">
            <button type="button" disabled={!supervised} onClick={() => void save((p) => ({ ...p, test: { charge_point_id: stationId, connector_id: connectorId,
              limit_kw: finiteInput(testKw, 0.1, 1000, 'Prüfgrenze'), requested_at: new Date().toISOString() } }))}>Dreiminütige Prüfung anfordern</button>
            {requestedTest && (pendingTest || test?.state === 'running') && <button type="button" onClick={() => void save((p) => ({ ...p, test: null }))}>Prüfung abbrechen</button>}
          </div>
        </>}
        {pendingTest && <p role="status">Prüfung angefordert. Die Übernahme durch die Box ist noch nicht bestätigt.</p>}
        {test && <ul className="vp-ocpp-test-steps" aria-label="Gemessene Prüfschritte">
          <li>Begrenzung: {test.limited ? 'gemessen' : 'noch kein Nachweis'}</li>
          <li>Pause: {test.paused ? 'gemessen' : 'noch kein Nachweis'}</li>
          <li>Wiederaufnahme: {test.resumed ? 'gemessen' : 'noch kein Nachweis'}</li>
        </ul>}
        {test ? <p role="status">{({ running: 'Prüfung läuft', confirmed: 'Regelwirkung in allen drei Schritten gemessen', not_confirmed: 'Regelwirkung nicht vollständig nachgewiesen', cancelled: 'Prüfung abgebrochen' })[test.state] ?? 'Prüfzustand unbekannt'} · {test.model || 'Modell nicht gemeldet'} · Firmware {test.firmware || 'nicht gemeldet'} · {new Date(test.requested_at).toLocaleString('de-DE')}</p> : <p>Noch kein Prüfergebnis von der Box gemeldet.</p>}
      </fieldset>
    </>}
  </div>;
}
