import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Stat } from '../../designsystem/components/core/Stat';
import { KpiCard } from '../../designsystem/components/shell/KpiCard';
import {
  api,
  ApiError,
  deviceLiveStatus,
  type Device,
  type PriceSeries,
  type SchedulePlan,
  type Site,
  type TelemetryPoint,
  type WeatherForecast,
} from '../api';
import { currentUser } from '../auth';
import { eur, fmtNum } from '../format';
import type { PageId } from '../nav';
import { SitePicker } from '../components/SitePicker';
import { CreateSiteDrawer } from '../components/CreateSiteDrawer';
import { AddDeviceDrawer } from '../components/DeviceDrawers';
import { TelemetryChart } from '../TelemetryChart';
import { PriceChart } from '../PriceChart';

/**
 * The Übersicht landing: money-first KPI hero row (savings + price lead),
 * live telemetry as the primary widget, prices + weather secondary, and the
 * quick site list. Per the redesign report section 4 + captain decisions.
 */
export function UebersichtPage({
  sites,
  devices,
  selectedSite,
  onSelectSite,
  onNavigate,
  onReload,
}: {
  sites: Site[];
  devices: Device[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
  onNavigate: (page: PageId) => void;
  onReload: (selectSiteId?: string) => void;
}) {
  const user = currentUser();
  const site = sites.find((s) => s.id === selectedSite) ?? null;

  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [prices, setPrices] = useState<PriceSeries | null>(null);
  const [weather, setWeather] = useState<WeatherForecast | null>(null);
  const [schedule, setSchedule] = useState<SchedulePlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [siteDrawer, setSiteDrawer] = useState(false);
  const [deviceDrawer, setDeviceDrawer] = useState(false);

  useEffect(() => {
    if (!site) {
      setTelemetry([]);
      setPrices(null);
      setWeather(null);
      setSchedule(null);
      return;
    }
    let active = true;
    setErr(null);
    Promise.allSettled([
      api.telemetry(site.id),
      api.prices(site.id),
      api.weather(site.id),
      api.schedule(site.id),
    ]).then(([t, p, w, s]) => {
      if (!active) return;
      if (t.status === 'fulfilled') setTelemetry(t.value);
      if (p.status === 'fulfilled') setPrices(p.value);
      if (w.status === 'fulfilled') setWeather(w.value);
      if (s.status === 'fulfilled') setSchedule(s.value);
      const failed = [t, p, w, s].filter((r) => r.status === 'rejected');
      if (failed.length === 4) {
        const reason = (failed[0] as PromiseRejectedResult).reason;
        setErr(reason instanceof ApiError ? `API-Fehler: ${reason.message}` : 'Daten konnten nicht geladen werden.');
      }
    });
    return () => {
      active = false;
    };
  }, [site?.id]);

  // --- KPI derivations (money first) ---------------------------------------
  const today = new Date();
  const savingsToday = (schedule?.slots ?? [])
    .filter((s) => new Date(s.start).getDate() === today.getDate())
    .reduce((sum, s) => sum + ((s.baselineCostEur ?? 0) - (s.costEur ?? 0)), 0);

  const todayPrices = (prices?.points ?? [])
    .filter((p) => new Date(p.ts).toDateString() === today.toDateString())
    .map((p) => p.priceEurMwh)
    .filter((v): v is number => v != null);
  const avgPriceToday = todayPrices.length
    ? todayPrices.reduce((a, b) => a + b, 0) / todayPrices.length
    : null;

  const online = devices.filter((d) => deviceLiveStatus(d) === 'online').length;
  const latest = telemetry.length ? telemetry[telemetry.length - 1] : null;
  const now = weather?.points?.[0] ?? null;

  const firstName = (user.name || '').split(/\s+/)[0] || user.name;

  if (sites.length === 0) {
    // Onboarding empty state: never a dead-end.
    return (
      <>
        <div className="vp-page-head">
          <div className="titles">
            <h1>Willkommen bei VoltPilot</h1>
            <p>Legen Sie Ihren ersten Standort an, um Geräte zu verbinden und Telemetrie, Preise und Fahrplan zu sehen.</p>
          </div>
        </div>
        <Card padding="lg" radius="lg">
          <div className="vp-empty">
            <IconTile category="home" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>⌂</IconTile>
            <h3>Noch kein Standort</h3>
            <p>
              Ein Standort bündelt Ihre Geräte, Marktpreise, Wetter und den
              Batterie-Fahrplan. Danach fügen Sie Geräte einfach per Edge-Referenz hinzu.
            </p>
            <Button variant="primary" onClick={() => setSiteDrawer(true)}>
              ＋ Ersten Standort anlegen
            </Button>
          </div>
        </Card>
        <CreateSiteDrawer
          open={siteDrawer}
          onClose={() => setSiteDrawer(false)}
          onCreate={(input) => api.createSite(input)}
          onCreated={(s) => onReload(s.id)}
        />
      </>
    );
  }

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Guten Tag, {firstName}</h1>
          <p>Alles Wichtige zu Ihren Standorten und Geräten auf einen Blick.</p>
        </div>
        <div className="actions">
          <Button variant="outline" onClick={() => setSiteDrawer(true)}>
            ＋ Standort
          </Button>
          <Button variant="primary" onClick={() => setDeviceDrawer(true)}>
            ＋ Gerät hinzufügen
          </Button>
        </div>
      </div>

      {err && <div className="vp-alert vp-alert-err">{err}</div>}

      {/* KPI hero row - money lens leads. */}
      <section className="vp-kpis" aria-label="Kennzahlen">
        <KpiCard
          icon="€"
          category="battery"
          value={`${eur(savingsToday)} €`}
          label="Heute geplant gespart"
          title="Projizierte Ersparnis des Batterie-Fahrplans heute ggü. ohne Speicher"
        />
        <KpiCard
          icon="€"
          category="dynamic"
          value={avgPriceToday == null ? '-' : avgPriceToday.toFixed(1)}
          label="Ø Preis heute (EUR/MWh)"
        />
        <KpiCard icon="⌂" category="home" value={sites.length} label="Standorte" />
        <KpiCard icon="⚡" category="battery" value={devices.length} label="Geräte" />
        <KpiCard
          icon="●"
          category="ev"
          value={
            <>
              {online}
              <span style={{ fontSize: '1rem', color: 'var(--vp-text-gray)', fontWeight: 600 }}>
                {' '}/ {devices.length}
              </span>
            </>
          }
          label="Online"
        />
      </section>

      {/* Hero split: live telemetry primary, prices + weather secondary. */}
      <section className="vp-section">
        <div className="vp-hero-split">
          <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
            <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
              <IconTile category="dynamic" size={40}>∿</IconTile>
              <h2>Live-Telemetrie</h2>
              {site && <Badge variant="tint">{site.name}</Badge>}
              <span className="actions">
                <SitePicker sites={sites} value={selectedSite} onChange={onSelectSite} />
              </span>
            </div>
            {telemetry.length === 0 ? (
              <p className="vp-muted">Keine Telemetriedaten für die letzten 24 Stunden.</p>
            ) : (
              <>
                <div className="vp-grid vp-grid-stats" style={{ marginBottom: 'var(--vp-space-5)' }}>
                  <Stat value={fmtNum(latest?.pvPowerKw, 'kW')} label="PV aktuell" />
                  <Stat value={fmtNum(latest?.loadKw, 'kW')} label="Last aktuell" />
                  <Stat value={fmtNum(latest?.powerKw, 'kW')} label="Netto-Leistung" />
                  <Stat value={fmtNum(latest?.socPct, '%')} label="Batterie-SoC" />
                </div>
                <TelemetryChart points={telemetry} />
                <p className="vp-note" style={{ marginTop: 12 }}>
                  Telemetrie über den Live-Ingest-Pfad: MQTT → Ingest → Redpanda → TimescaleDB.
                </p>
              </>
            )}
          </Card>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--vp-gap)', minWidth: 0 }}>
            <Card style={{ minWidth: 0 }}>
              <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
                <IconTile category="dynamic" size={40}>€</IconTile>
                <h2 style={{ fontSize: '1.1rem' }}>Day-Ahead Preise</h2>
                <span className="actions">
                  {prices && <Badge variant="tint">{prices.biddingZone}</Badge>}
                </span>
              </div>
              {prices && prices.points.length > 0 ? (
                <>
                  <PriceChart series={prices} />
                  <p className="vp-note" style={{ marginTop: 8 }}>
                    <a href="#/marktpreise" onClick={(e) => { e.preventDefault(); onNavigate('marktpreise'); }}>
                      Alle Marktpreise →
                    </a>
                  </p>
                </>
              ) : (
                <p className="vp-muted">Noch keine Day-Ahead-Preise.</p>
              )}
            </Card>

            <Card style={{ minWidth: 0 }}>
              <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
                <IconTile category="solar" size={40}>☀</IconTile>
                <h2 style={{ fontSize: '1.1rem' }}>Wetter</h2>
                <span className="actions">
                  <span className="vp-note">nächste Stunde</span>
                </span>
              </div>
              {now ? (
                <div style={{ display: 'flex', gap: 'var(--vp-space-5)', flexWrap: 'wrap' }}>
                  <Stat value={fmtNum(now.temperatureC, '°C')} label="Temperatur" />
                  <Stat value={fmtNum(now.cloudCoverPct, '%', 0)} label="Bewölkung" />
                  <Stat value={fmtNum(now.ghiWM2, 'W/m²', 0)} label="Einstrahlung" />
                </div>
              ) : (
                <p className="vp-muted">Noch keine Vorhersage.</p>
              )}
              <p className="vp-note" style={{ marginTop: 8 }}>
                <a href="#/wetter" onClick={(e) => { e.preventDefault(); onNavigate('wetter'); }}>
                  Zur Wettervorhersage →
                </a>
              </p>
            </Card>
          </div>
        </div>
      </section>

      {/* Quick site list (first rung of the entity pattern). */}
      <section className="vp-section">
        <div className="vp-section-head">
          <IconTile category="home" size={40}>⌂</IconTile>
          <h2>Ihre Standorte</h2>
          <Badge variant="tint">{sites.length}</Badge>
          <span className="actions">
            <Button variant="outline" size="sm" onClick={() => setSiteDrawer(true)}>
              ＋ Standort anlegen
            </Button>
          </span>
        </div>
        <div className="vp-grid vp-grid-cards">
          {sites.map((s) => {
            const siteDevices = devices.filter((d) => d.siteId === s.id);
            const siteOnline = siteDevices.filter((d) => deviceLiveStatus(d) === 'online').length;
            return (
              <Card
                key={s.id}
                interactive
                accent="primary"
                className={`vp-selectable ${selectedSite === s.id ? 'vp-selected' : ''}`}
                style={{ minWidth: 0 }}
                onClick={() => onSelectSite(s.id)}
              >
                <h4 style={{ marginBottom: 8 }}>{s.name}</h4>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge variant="tint">{s.biddingZone}</Badge>
                  {siteDevices.length > 0 ? (
                    <Badge variant={siteOnline > 0 ? 'ok' : 'off'} dot>
                      {siteOnline}/{siteDevices.length} online
                    </Badge>
                  ) : (
                    <span className="vp-note">keine Geräte</span>
                  )}
                  {s.latitude != null && s.longitude != null && (
                    <span className="vp-note">
                      {s.latitude}, {s.longitude}
                    </span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <CreateSiteDrawer
        open={siteDrawer}
        onClose={() => setSiteDrawer(false)}
        onCreate={(input) => api.createSite(input)}
        onCreated={(s) => onReload(s.id)}
      />
      <AddDeviceDrawer
        open={deviceDrawer}
        onClose={() => setDeviceDrawer(false)}
        sites={sites}
        onClaimed={() => onReload()}
      />
    </>
  );
}
