import { useEffect, useMemo, useState } from 'react';
import { Button } from '../designsystem/components/core/Button';
import { Card } from '../designsystem/components/core/Card';
import { Badge } from '../designsystem/components/core/Badge';
import { Stat } from '../designsystem/components/core/Stat';
import { IconTile } from '../designsystem/components/core/IconTile';
import { Input } from '../designsystem/components/forms/Input';
import logoUrl from '../designsystem/assets/voltpilot-logo.png';
import { currentUser, isPlatformAdmin, login, logout } from './auth';
import {
  api,
  ApiError,
  type Device,
  type PriceSeries,
  type Site,
  type TelemetryPoint,
  type WeatherForecast,
} from './api';
import { TelemetryChart } from './TelemetryChart';
import { PriceChart } from './PriceChart';
import { WeatherChart } from './WeatherChart';
import AdminApp from './admin/AdminApp';

export default function App({
  initialAuth,
  authError = false,
}: {
  initialAuth: boolean;
  authError?: boolean;
}) {
  if (!initialAuth) return <LoginScreen authError={authError} />;
  // Role-aware entry: Portal-Admins (platform operators) get the admin console;
  // Portal-Users (customers) get the tenant-scoped customer portal. The backend
  // enforces this split too - the UI just picks the right surface.
  if (isPlatformAdmin()) return <AdminApp />;
  return <Portal />;
}

function LoginScreen({ authError }: { authError: boolean }) {
  return (
    <div className="vp-login">
      <Card padding="lg" radius="lg" className="vp-login-card">
        <img src={logoUrl} alt="VoltPilot" />
        <h1>VoltPilot EMS</h1>
        <p>Energiemanagement-Portal - melden Sie sich an, um Ihre Standorte und Telemetrie zu sehen.</p>
        <Button variant="primary" size="lg" fullWidth onClick={login}>
          Anmelden mit Keycloak
        </Button>
        {authError && (
          <div className="vp-alert vp-alert-err">
            Keycloak ist nicht erreichbar. Läuft der lokale Stack (docker compose up)?
          </div>
        )}
      </Card>
    </div>
  );
}

function Portal() {
  const user = useMemo(() => currentUser(), []);
  const [sites, setSites] = useState<Site[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedSite, setSelectedSite] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const [s, d] = await Promise.all([api.listSites(), api.listDevices()]);
      setSites(s);
      setDevices(d);
      setSelectedSite((cur) => cur ?? s[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const deviceCount = (siteId: string) => devices.filter((d) => d.siteId === siteId).length;

  return (
    <div className="vp-shell">
      <nav className="vp-nav">
        <div className="vp-container vp-nav-inner">
          <div className="vp-brand">
            <img src={logoUrl} alt="VoltPilot" />
            <span className="vp-brand-name">VoltPilot EMS</span>
          </div>
          <div className="vp-nav-user">
            <div className="vp-nav-user-meta">
              <div className="vp-nav-user-name">{user.name}</div>
              {user.email && <div className="vp-nav-user-email">{user.email}</div>}
            </div>
            <Button variant="outline" size="sm" onClick={logout}>
              Abmelden
            </Button>
          </div>
        </div>
      </nav>

      <main className="vp-main">
        <div className="vp-container">
          <div className="vp-page-head">
            <h2>Übersicht</h2>
            <p>
              Standorte, Geräte und Telemetrie Ihres Mandanten.{' '}
              {user.tenantId && (
                <Badge variant="tint" title="Aus dem OIDC-Token (tenant_id)">
                  Mandant {user.tenantId.slice(0, 8)}
                </Badge>
              )}
            </p>
          </div>

          {error && <div className="vp-alert vp-alert-err">{error}</div>}

          <SitesSection
            sites={sites}
            selectedSite={selectedSite}
            onSelect={setSelectedSite}
            deviceCount={deviceCount}
          />

          {selectedSite && (
            <TelemetrySection
              site={sites.find((s) => s.id === selectedSite) ?? null}
            />
          )}

          {selectedSite && (
            <MarketSection site={sites.find((s) => s.id === selectedSite) ?? null} />
          )}

          {selectedSite && (
            <WeatherSection site={sites.find((s) => s.id === selectedSite) ?? null} />
          )}

          <DevicesSection devices={devices} sites={sites} onClaimed={reload} />
        </div>
      </main>
    </div>
  );
}

function SitesSection({
  sites,
  selectedSite,
  onSelect,
  deviceCount,
}: {
  sites: Site[];
  selectedSite: string | null;
  onSelect: (id: string) => void;
  deviceCount: (id: string) => number;
}) {
  return (
    <section className="vp-section">
      <div className="vp-section-title">
        <IconTile category="home" size={40}>
          ⌂
        </IconTile>
        <h3>Standorte</h3>
      </div>
      {sites.length === 0 ? (
        <p className="vp-muted">Keine Standorte für diesen Mandanten.</p>
      ) : (
        <div className="vp-grid vp-grid-sites">
          {sites.map((s) => (
            <Card
              key={s.id}
              interactive
              accent="primary"
              className={`vp-selectable ${selectedSite === s.id ? 'vp-selected' : ''}`}
              onClick={() => onSelect(s.id)}
            >
              <h4 style={{ marginBottom: 8 }}>{s.name}</h4>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Badge variant="tint">{s.biddingZone}</Badge>
                <span className="vp-note">
                  {deviceCount(s.id)} Gerät{deviceCount(s.id) === 1 ? '' : 'e'}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function TelemetrySection({ site }: { site: Site | null }) {
  const [points, setPoints] = useState<TelemetryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!site) return;
    let active = true;
    setLoading(true);
    setErr(null);
    api
      .telemetry(site.id)
      .then((p) => active && setPoints(p))
      .catch((e) => active && setErr(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [site?.id]);

  const latest = points.length ? points[points.length - 1] : null;
  const fmt = (v: number | null | undefined, unit: string) =>
    v == null ? '-' : `${Number(v).toFixed(1)} ${unit}`;

  if (!site) return null;

  return (
    <section className="vp-section">
      <div className="vp-section-title">
        <IconTile category="dynamic" size={40}>
          ∿
        </IconTile>
        <h3>Telemetrie - {site.name}</h3>
      </div>
      <Card padding="lg" radius="lg">
        {loading && <p className="vp-muted">Lade Telemetrie…</p>}
        {err && <div className="vp-alert vp-alert-err">Telemetrie-Fehler: {err}</div>}
        {!loading && !err && points.length === 0 && (
          <p className="vp-muted">Keine Telemetriedaten für die letzten 24 Stunden.</p>
        )}
        {!loading && !err && points.length > 0 && (
          <>
            <div className="vp-grid vp-grid-stats" style={{ marginBottom: 24 }}>
              <Stat value={fmt(latest?.pvPowerKw, 'kW')} label="PV aktuell" />
              <Stat value={fmt(latest?.loadKw, 'kW')} label="Last aktuell" />
              <Stat value={fmt(latest?.powerKw, 'kW')} label="Netto-Leistung" />
              <Stat value={fmt(latest?.socPct, '%')} label="Batterie-SoC" />
            </div>
            <TelemetryChart points={points} />
            <p className="vp-note" style={{ marginTop: 12 }}>
              Demo-Daten (dev-seed) - der reale Ingest-Pfad folgt in einem späteren Increment.
            </p>
          </>
        )}
      </Card>
    </section>
  );
}

function MarketSection({ site }: { site: Site | null }) {
  const [series, setSeries] = useState<PriceSeries | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!site) return;
    let active = true;
    setLoading(true);
    setErr(null);
    api
      .prices(site.id)
      .then((s) => active && setSeries(s))
      .catch((e) => active && setErr(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [site?.id]);

  if (!site) return null;

  const points = series?.points ?? [];
  const nums = points.map((p) => p.priceEurMwh).filter((v): v is number => v != null);
  const min = nums.length ? Math.min(...nums) : null;
  const max = nums.length ? Math.max(...nums) : null;
  const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  const fmt = (v: number | null) => (v == null ? '-' : `${v.toFixed(1)} EUR/MWh`);

  return (
    <section className="vp-section">
      <div className="vp-section-title">
        <IconTile category="solar" size={40}>
          €
        </IconTile>
        <h3>Day-Ahead Börsenpreise - {site.biddingZone}</h3>
      </div>
      <Card padding="lg" radius="lg">
        {loading && <p className="vp-muted">Lade Börsenpreise…</p>}
        {err && <div className="vp-alert vp-alert-err">Preis-Fehler: {err}</div>}
        {!loading && !err && points.length === 0 && (
          <p className="vp-muted">
            Noch keine Day-Ahead-Preise. Der Collector (energy-charts.info) füllt sie
            beim nächsten Lauf.
          </p>
        )}
        {!loading && !err && points.length > 0 && (
          <>
            <div className="vp-grid vp-grid-stats" style={{ marginBottom: 24 }}>
              <Stat value={fmt(min)} label="Minimum" />
              <Stat value={fmt(avg)} label="Ø heute/morgen" />
              <Stat value={fmt(max)} label="Maximum" />
              <Stat value={`${points.length}`} label={`Slots @ ${series?.resolution ?? '-'}`} />
            </div>
            <PriceChart series={series!} />
            <p className="vp-note" style={{ marginTop: 12 }}>
              Quelle: energy-charts.info (Fraunhofer ISE) - 15-Minuten-Slots, keyless.
            </p>
          </>
        )}
      </Card>
    </section>
  );
}

function WeatherSection({ site }: { site: Site | null }) {
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!site) return;
    let active = true;
    setLoading(true);
    setErr(null);
    api
      .weather(site.id)
      .then((w) => active && setForecast(w))
      .catch((e) => active && setErr(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [site?.id]);

  if (!site) return null;

  const points = forecast?.points ?? [];
  const now = points[0] ?? null;
  const peakGhi = points.reduce<number | null>(
    (m, p) => (p.ghiWM2 != null && (m == null || p.ghiWM2 > m) ? p.ghiWM2 : m),
    null,
  );
  const fmt = (v: number | null | undefined, unit: string) =>
    v == null ? '-' : `${Number(v).toFixed(unit === '°C' ? 1 : 0)} ${unit}`;

  return (
    <section className="vp-section">
      <div className="vp-section-title">
        <IconTile category="dynamic" size={40}>
          ☀
        </IconTile>
        <h3>Wettervorhersage - {site.name}</h3>
      </div>
      <Card padding="lg" radius="lg">
        {loading && <p className="vp-muted">Lade Wettervorhersage…</p>}
        {err && <div className="vp-alert vp-alert-err">Wetter-Fehler: {err}</div>}
        {!loading && !err && points.length === 0 && (
          <p className="vp-muted">
            Noch keine Vorhersage. Der Collector (Open-Meteo) füllt sie beim nächsten
            Lauf.
          </p>
        )}
        {!loading && !err && points.length > 0 && (
          <>
            <div className="vp-grid vp-grid-stats" style={{ marginBottom: 24 }}>
              <Stat value={fmt(now?.temperatureC, '°C')} label="Temperatur (nächste Stunde)" />
              <Stat value={fmt(now?.cloudCoverPct, '%')} label="Bewölkung" />
              <Stat value={fmt(peakGhi, 'W/m²')} label="Max. Einstrahlung" />
              <Stat value={`${points.length} h`} label="Horizont" />
            </div>
            <WeatherChart points={points} />
            <p className="vp-note" style={{ marginTop: 12 }}>
              Quelle: Open-Meteo (EU-gehostet) - stündlich, keyless. Einstrahlung (GHI)
              speist die PV-Prognose.
            </p>
          </>
        )}
      </Card>
    </section>
  );
}

function DevicesSection({
  devices,
  sites,
  onClaimed,
}: {
  devices: Device[];
  sites: Site[];
  onClaimed: () => void;
}) {
  const [externalRef, setExternalRef] = useState('');
  const [siteId, setSiteId] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!siteId && sites[0]) setSiteId(sites[0].id);
  }, [sites, siteId]);

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  async function claim() {
    if (!externalRef.trim() || !siteId) return;
    setBusy(true);
    setMsg(null);
    try {
      const d = await api.claimDevice(siteId, externalRef.trim());
      setMsg({ ok: true, text: `Gerät "${d.externalRef}" beansprucht (${d.status}).` });
      setExternalRef('');
      onClaimed();
    } catch (e) {
      const text =
        e instanceof ApiError && e.status === 409
          ? 'Dieses Gerät ist bereits beansprucht (evtl. durch einen anderen Mandanten).'
          : e instanceof ApiError && e.status === 404
            ? 'Standort nicht gefunden.'
            : 'Beanspruchen fehlgeschlagen.';
      setMsg({ ok: false, text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="vp-section">
      <div className="vp-section-title">
        <IconTile category="battery" size={40}>
          ⚡
        </IconTile>
        <h3>Geräte</h3>
      </div>
      <Card padding="lg" radius="lg">
        {devices.length === 0 ? (
          <p className="vp-muted">Noch keine Geräte. Beanspruchen Sie unten ein Edge-Gerät.</p>
        ) : (
          <table className="vp-table">
            <thead>
              <tr>
                <th>Referenz</th>
                <th>Typ</th>
                <th>Standort</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td className="vp-mono">{d.externalRef}</td>
                  <td>{d.kind}</td>
                  <td>{siteName(d.siteId)}</td>
                  <td>
                    <Badge variant={d.status === 'claimed' ? 'gradient' : 'tint'}>{d.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 24 }}>
          <h4 style={{ marginBottom: 12 }}>Gerät beanspruchen</h4>
          <div className="vp-field-row">
            <div style={{ flex: '1 1 220px' }}>
              <Input
                label="Edge-Referenz"
                placeholder="z. B. edge-inverter-42"
                value={externalRef}
                onChange={(e) => setExternalRef((e.target as HTMLInputElement).value)}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label htmlFor="claim-site" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                Standort
              </label>
              <select
                id="claim-site"
                className="vp-select"
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <Button variant="primary" onClick={claim} disabled={busy || !externalRef.trim()}>
              {busy ? 'Beanspruche…' : 'Beanspruchen'}
            </Button>
          </div>
          {msg && (
            <div className={`vp-alert ${msg.ok ? 'vp-alert-ok' : 'vp-alert-err'}`}>{msg.text}</div>
          )}
        </div>
      </Card>
    </section>
  );
}
