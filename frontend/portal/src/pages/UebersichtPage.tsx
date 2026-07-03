import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Stat } from '../../designsystem/components/core/Stat';
import { KpiCard } from '../../designsystem/components/shell/KpiCard';
import {
  api,
  deviceLiveStatus,
  type Device,
  type PriceSeries,
  type SchedulePlan,
  type Site,
  type TelemetryPoint,
  type WeatherForecast,
} from '../api';
import { currentUser } from '../auth';
import { ctPerKwh, eurAmount, fmtNum, zoneLabel } from '../format';
import type { PageId } from '../nav';
import { SitePicker } from '../components/SitePicker';
import { CreateSiteDrawer } from '../components/CreateSiteDrawer';
import { AddDeviceDrawer } from '../components/DeviceDrawers';
import { InfoTip } from '../components/InfoTip';
import { ChartCardSkeleton, ErrorState, Skeleton, TextSkeleton } from '../components/States';
import { TelemetryChart } from '../TelemetryChart';
import { PriceChart } from '../PriceChart';

/**
 * A widget whose data failed to load: a distinct error card with a retry, NOT
 * the benign "waiting for data / no prices" empty copy (M2). Keeps the outage
 * honest instead of reassuring.
 */
function WidgetError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <ErrorState message={message} onRetry={onRetry} />;
}

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
  isAdmin = false,
}: {
  sites: Site[];
  devices: Device[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
  onNavigate: (page: PageId) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
}) {
  const user = currentUser();
  const site = sites.find((s) => s.id === selectedSite) ?? null;

  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [prices, setPrices] = useState<PriceSeries | null>(null);
  const [weather, setWeather] = useState<WeatherForecast | null>(null);
  const [schedule, setSchedule] = useState<SchedulePlan | null>(null);
  // Per-widget load failure flags: an outage must render a distinct
  // "konnte nicht geladen werden" card, NOT the benign "waiting for data /
  // no prices" empty state (M2). Each is set when its endpoint rejects.
  const [failed, setFailed] = useState({
    telemetry: false,
    prices: false,
    weather: false,
    schedule: false,
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [siteDrawer, setSiteDrawer] = useState(false);
  const [deviceDrawer, setDeviceDrawer] = useState(false);

  useEffect(() => {
    if (!site) {
      setTelemetry([]);
      setPrices(null);
      setWeather(null);
      setSchedule(null);
      setFailed({ telemetry: false, prices: false, weather: false, schedule: false });
      return;
    }
    let active = true;
    setLoading(true);
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
      setFailed({
        telemetry: t.status === 'rejected',
        prices: p.status === 'rejected',
        weather: w.status === 'rejected',
        schedule: s.status === 'rejected',
      });
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [site?.id, reloadKey]);

  const retry = () => setReloadKey((k) => k + 1);

  // --- KPI derivations (money first) ---------------------------------------
  const today = new Date();
  const todaySlots = (schedule?.slots ?? []).filter(
    (s) => new Date(s.start).toDateString() === today.toDateString(),
  );
  // Distinguish "no plan exists yet" from a genuine 0,00 € (D1): a brand-new
  // customer must not read the headline as "you saved nothing today".
  const hasTodayPlan = todaySlots.length > 0;
  const savingsToday = todaySlots.reduce(
    (sum, s) => sum + ((s.baselineCostEur ?? 0) - (s.costEur ?? 0)),
    0,
  );

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
  const allFailed =
    site != null && failed.telemetry && failed.prices && failed.weather && failed.schedule;

  const firstName = (user.name || '').split(/\s+/)[0] || user.name;

  if (sites.length === 0) {
    // Empty-state: for a customer this is the onboarding entry (never a
    // dead-end); for an admin viewing an empty tenant it is a neutral notice,
    // not customer-directed "Willkommen"-onboarding copy (m3).
    return (
      <>
        <div className="vp-page-head">
          <div className="titles">
            <h1>{isAdmin ? 'Übersicht' : 'Willkommen bei VoltPilot'}</h1>
            <p>
              {isAdmin
                ? 'Dieser Mandant hat noch keine Standorte.'
                : 'Legen Sie Ihren ersten Standort an, um Geräte zu verbinden und Live-Daten, Preise und Fahrplan zu sehen.'}
            </p>
          </div>
        </div>
        <Card padding="lg" radius="lg">
          <div className="vp-empty">
            <IconTile category="home" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
              <Icon name="map-pin" size={24} />
            </IconTile>
            <h3>{isAdmin ? 'Dieser Mandant hat noch keine Standorte' : 'Noch kein Standort'}</h3>
            <p>
              {isAdmin
                ? 'Sobald für diesen Mandanten ein Standort angelegt ist, erscheinen hier seine Geräte, Marktpreise, Wetter und der Batterie-Fahrplan. Sie können im Namen des Mandanten einen Standort anlegen.'
                : 'Ein Standort bündelt Ihre Geräte, Marktpreise, Wetter und den Batterie-Fahrplan. Danach verbinden Sie Ihre Geräte in wenigen Schritten.'}
            </p>
            <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setSiteDrawer(true)}>
              {isAdmin ? 'Standort anlegen' : 'Ersten Standort anlegen'}
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
          <Button variant="outline" iconLeft={<Icon name="plus" size={18} />} onClick={() => setSiteDrawer(true)}>
            Standort
          </Button>
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setDeviceDrawer(true)}>
            Gerät hinzufügen
          </Button>
        </div>
      </div>

      {allFailed && (
        <div
          className="vp-alert vp-alert-err"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--vp-space-3)', flexWrap: 'wrap' }}
        >
          <span style={{ flex: '1 1 320px' }}>
            Die Daten dieses Standorts konnten gerade nicht geladen werden. Bitte prüfen Sie
            Ihre Verbindung und versuchen Sie es erneut.
          </span>
          <Button variant="outline" size="sm" iconLeft={<Icon name="refresh-cw" size={16} />} onClick={retry}>
            Erneut versuchen
          </Button>
        </div>
      )}

      {/* Money-first hero: ONE calm money number leads, the day's price second.
          Counts are demoted to the compact strip below (report P3). */}
      <section className="vp-kpis vp-kpis-hero" aria-label="Kennzahlen">
        <KpiCard
          icon={<Icon name="euro" size={20} />}
          category="battery"
          value={failed.schedule || !hasTodayPlan ? '—' : eurAmount(savingsToday)}
          label={
            failed.schedule
              ? 'Ersparnis gerade nicht verfügbar'
              : hasTodayPlan
                ? 'Heute geplant gespart'
                : 'Noch kein Fahrplan'
          }
          title={
            failed.schedule
              ? 'Der Fahrplan konnte nicht geladen werden - die Ersparnis ist gerade nicht verfügbar.'
              : hasTodayPlan
                ? 'Projizierte Ersparnis des Batterie-Fahrplans heute gegenüber einem Betrieb ohne Speicher'
                : 'Für heute liegt noch kein Batterie-Fahrplan vor - sobald einer erstellt wird, erscheint hier Ihre geplante Ersparnis.'
          }
        />
        <KpiCard
          icon={<Icon name="trending-up" size={20} />}
          category="dynamic"
          value={failed.prices || avgPriceToday == null ? '—' : ctPerKwh(avgPriceToday)}
          label="Ø Strompreis heute"
          title="Durchschnittlicher Börsen-Strompreis heute in Cent pro Kilowattstunde"
        />
      </section>

      {/* Bestand: counts demoted to a calm secondary strip. */}
      <div className="vp-count-strip" role="group" aria-label="Bestand">
        <span className="vp-count-item">
          <Icon name="map-pin" size={16} />
          <strong>{sites.length}</strong> Standorte
        </span>
        <span className="vp-count-item">
          <Icon name="zap" size={16} />
          <strong>{devices.length}</strong> Geräte
        </span>
        <span className="vp-count-item">
          <Badge variant={online > 0 ? 'ok' : 'off'} dot>
            {online}/{devices.length} online
          </Badge>
        </span>
      </div>

      {/* Hero split: live telemetry primary, prices + weather secondary. */}
      <section className="vp-section">
        <div className="vp-hero-split">
          <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
            <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
              <IconTile category="dynamic" size={40}>
                <Icon name="activity" size={20} />
              </IconTile>
              <h2>Live-Daten</h2>
              {site && <Badge variant="tint">{site.name}</Badge>}
              <span className="actions">
                <SitePicker sites={sites} value={selectedSite} onChange={onSelectSite} />
              </span>
            </div>
            {loading && telemetry.length === 0 && !failed.telemetry ? (
              <ChartCardSkeleton />
            ) : failed.telemetry ? (
              <WidgetError
                message="Die Live-Daten konnten nicht geladen werden."
                onRetry={retry}
              />
            ) : telemetry.length === 0 ? (
              <p className="vp-muted">
                Noch keine Messwerte in den letzten 24 Stunden. Sobald Ihr Gerät sendet,
                erscheinen die Live-Daten hier.
              </p>
            ) : (
              <>
                <div className="vp-grid vp-grid-stats" style={{ marginBottom: 'var(--vp-space-5)' }}>
                  <Stat value={fmtNum(latest?.pvPowerKw, 'kW')} label="PV-Erzeugung" />
                  <Stat value={fmtNum(latest?.loadKw, 'kW')} label="Verbrauch" />
                  <Stat
                    value={fmtNum(latest?.powerKw, 'kW')}
                    label={
                      <>
                        Netzleistung{' '}
                        <InfoTip label="Was bedeutet Netzleistung?">
                          Leistung an Ihrem Netzanschluss: positiv = Sie beziehen Strom aus dem
                          Netz, negativ = Sie speisen ein.
                        </InfoTip>
                      </>
                    }
                  />
                  <Stat
                    value={fmtNum(latest?.socPct, '%')}
                    label={
                      <>
                        Batterie-Ladestand{' '}
                        <InfoTip label="Was bedeutet Batterie-Ladestand?">
                          Ladezustand der Batterie (SoC) in Prozent - 100 % bedeutet voll
                          geladen, 0 % leer.
                        </InfoTip>
                      </>
                    }
                  />
                </div>
                <TelemetryChart points={telemetry} />
                <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                  Messwerte Ihrer Geräte aus den letzten 24 Stunden.
                </p>
              </>
            )}
          </Card>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--vp-gap)', minWidth: 0 }}>
            <Card style={{ minWidth: 0 }}>
              <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
                <IconTile category="dynamic" size={40}>
                  <Icon name="euro" size={20} />
                </IconTile>
                <h2 style={{ fontSize: '1.1rem' }}>Börsen-Strompreise</h2>
                <span className="actions">
                  {prices && <Badge variant="tint">{zoneLabel(prices.biddingZone)}</Badge>}
                </span>
              </div>
              {loading && !prices && !failed.prices ? (
                <Skeleton height={140} radius="var(--vp-radius-md)" />
              ) : failed.prices ? (
                <WidgetError
                  message="Die Börsenpreise konnten nicht geladen werden."
                  onRetry={retry}
                />
              ) : prices && prices.points.length > 0 ? (
                <>
                  <PriceChart series={prices} />
                  <p className="vp-note" style={{ marginTop: 'var(--vp-space-2)' }}>
                    <a href="#/marktpreise" onClick={(e) => { e.preventDefault(); onNavigate('marktpreise'); }}>
                      Alle Marktpreise →
                    </a>
                  </p>
                </>
              ) : (
                <p className="vp-muted">
                  Noch keine Börsenpreise. Sie werden automatisch geladen, sobald die
                  Strombörse sie veröffentlicht.
                </p>
              )}
            </Card>

            <Card style={{ minWidth: 0 }}>
              <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
                <IconTile category="solar" size={40}>
                  <Icon name="sun" size={20} />
                </IconTile>
                <h2 style={{ fontSize: '1.1rem' }}>Wetter</h2>
                <span className="actions">
                  <span className="vp-note">nächste Stunde</span>
                </span>
              </div>
              {loading && !weather && !failed.weather ? (
                <TextSkeleton lines={2} />
              ) : failed.weather ? (
                <WidgetError
                  message="Die Wettervorhersage konnte nicht geladen werden."
                  onRetry={retry}
                />
              ) : now ? (
                <div style={{ display: 'flex', gap: 'var(--vp-space-5)', flexWrap: 'wrap' }}>
                  <Stat value={fmtNum(now.temperatureC, '°C')} label="Temperatur" />
                  <Stat value={fmtNum(now.cloudCoverPct, '%', 0)} label="Bewölkung" />
                  <Stat value={fmtNum(now.ghiWM2, 'W/m²', 0)} label="Einstrahlung" />
                </div>
              ) : (
                <p className="vp-muted">Noch keine Vorhersage für diesen Standort.</p>
              )}
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-2)' }}>
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
          <IconTile category="home" size={40}>
            <Icon name="map-pin" size={20} />
          </IconTile>
          <h2>Ihre Standorte</h2>
          <Badge variant="tint">{sites.length}</Badge>
          <span className="actions">
            <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => setSiteDrawer(true)}>
              Standort anlegen
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
                <h4 style={{ marginBottom: 'var(--vp-space-2)' }}>{s.name}</h4>
                <div style={{ display: 'flex', gap: 'var(--vp-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge variant="tint">{zoneLabel(s.biddingZone)}</Badge>
                  {siteDevices.length > 0 ? (
                    <Badge variant={siteOnline > 0 ? 'ok' : 'off'} dot>
                      {siteOnline}/{siteDevices.length} online
                    </Badge>
                  ) : (
                    <span className="vp-note">keine Geräte</span>
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
