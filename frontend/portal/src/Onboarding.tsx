import { useEffect, useState } from 'react';
import { Button } from '../designsystem/components/core/Button';
import { Card } from '../designsystem/components/core/Card';
import { Icon } from '../designsystem/components/core/Icon';
import { Input } from '../designsystem/components/forms/Input';
import { api, ApiError, type Site } from './api';

/**
 * Guided first-run onboarding: Standort -> Geraet -> erste Daten.
 * Shown to any customer without a device, so the path from "frisches Konto"
 * to "Anlage sendet Daten" is one sequenced flow instead of two disconnected
 * forms. The address search keeps WGS84/Gebotszone jargon out of the UI: the
 * customer types their town, we derive coordinates and bidding zone.
 */

export interface GeoPlace {
  name: string;
  latitude: number;
  longitude: number;
  countryCode: string;
  label: string;
}

/** Bidding zone from the place's country; everything else defaults to DE-LU. */
export function zoneForCountry(countryCode: string | null | undefined): string {
  switch ((countryCode ?? '').toUpperCase()) {
    case 'AT':
      return 'AT';
    case 'CH':
      return 'CH';
    default:
      return 'DE-LU';
  }
}

/** Keyless Open-Meteo geocoding (same provider family as the weather feed). */
async function searchPlaces(query: string): Promise<GeoPlace[]> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    query,
  )}&count=5&language=de&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ortssuche fehlgeschlagen (${res.status})`);
  const data = (await res.json()) as {
    results?: {
      name: string;
      latitude: number;
      longitude: number;
      country_code?: string;
      country?: string;
      admin1?: string;
    }[];
  };
  return (data.results ?? []).map((r) => ({
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    countryCode: r.country_code ?? '',
    label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
  }));
}

export function LocationSearch({
  selected,
  onSelect,
}: {
  selected: GeoPlace | null;
  onSelect: (place: GeoPlace | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoPlace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function search() {
    if (query.trim().length < 2 || busy) return;
    setBusy(true);
    setErr(null);
    setResults(null);
    try {
      setResults(await searchPlaces(query.trim()));
    } catch {
      setErr('Die Ortssuche ist gerade nicht erreichbar. Bitte versuchen Sie es gleich noch einmal.');
    } finally {
      setBusy(false);
    }
  }

  if (selected) {
    return (
      <div className="vp-geo-selected">
        <Icon name="map-pin" size={16} />
        <span>{selected.label}</span>
        <button type="button" className="vp-linklike" onClick={() => onSelect(null)}>
          Ändern
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="vp-field-row">
        <div style={{ flex: '1 1 220px' }}>
          <Input
            label="Ort"
            placeholder="z. B. Berlin oder 10115"
            value={query}
            onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter') void search();
            }}
          />
        </div>
        <Button variant="outline" onClick={search} disabled={busy || query.trim().length < 2}>
          {busy ? 'Suche…' : 'Suchen'}
        </Button>
      </div>
      {results && results.length === 0 && (
        <p className="vp-note" style={{ marginTop: 8 }}>
          Kein Ort gefunden. Versuchen Sie es mit dem Namen der nächstgrößeren Stadt.
        </p>
      )}
      {results && results.length > 0 && (
        <div className="vp-geo-results" role="listbox" aria-label="Gefundene Orte">
          {results.map((r) => (
            <button
              key={`${r.label}-${r.latitude}-${r.longitude}`}
              type="button"
              className="vp-geo-result"
              onClick={() => onSelect(r)}
            >
              <Icon name="map-pin" size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              {r.label}
            </button>
          ))}
        </div>
      )}
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
    </div>
  );
}

function Steps({ current }: { current: 1 | 2 | 3 }) {
  const steps = ['Standort', 'Gerät', 'Startklar'];
  return (
    <ol className="vp-steps">
      {steps.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const state = n < current ? 'done' : n === current ? 'active' : 'todo';
        return (
          <li key={label} className={`vp-step vp-step-${state}`}>
            <span className="vp-step-num" aria-hidden="true">
              {state === 'done' ? <Icon name="check" size={13} strokeWidth={3} /> : n}
            </span>
            <span className="vp-step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function OnboardingWizard({
  sites,
  onDone,
  onSkip,
}: {
  sites: Site[];
  onDone: () => void;
  onSkip: () => void;
}) {
  // A customer who already created a site (but has no device yet) starts at step 2.
  const [site, setSite] = useState<Site | null>(sites[0] ?? null);
  const [step, setStep] = useState<1 | 2 | 3>(sites[0] ? 2 : 1);

  return (
    <div className="vp-onboarding">
      <Card padding="lg" radius="lg">
        <h2 style={{ marginBottom: 4 }}>Willkommen bei VoltPilot</h2>
        <p className="vp-muted" style={{ margin: '0 0 8px' }}>
          In drei Schritten ist Ihre Anlage startklar.
        </p>
        <Steps current={step} />
        {step === 1 && (
          <SiteStep
            onCreated={(s) => {
              setSite(s);
              setStep(2);
            }}
          />
        )}
        {step === 2 && site && (
          <DeviceStep siteName={site.name} siteId={site.id} onClaimed={() => setStep(3)} />
        )}
        {step === 3 && site && <FirstDataStep siteId={site.id} onDone={onDone} />}
        {step < 3 && (
          <p className="vp-note" style={{ marginTop: 20, textAlign: 'center' }}>
            <button type="button" className="vp-linklike" onClick={onSkip}>
              Später einrichten - direkt zum Portal
            </button>
          </p>
        )}
      </Card>
    </div>
  );
}

function SiteStep({ onCreated }: { onCreated: (site: Site) => void }) {
  const [name, setName] = useState('');
  const [place, setPlace] = useState<GeoPlace | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valid = name.trim().length > 0;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const site = await api.createSite({
        name: name.trim(),
        biddingZone: zoneForCountry(place?.countryCode),
        latitude: place?.latitude ?? null,
        longitude: place?.longitude ?? null,
      });
      onCreated(site);
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 400
          ? 'Bitte prüfen Sie den Namen des Standorts.'
          : 'Das Anlegen hat gerade nicht geklappt. Bitte versuchen Sie es gleich noch einmal.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-onboarding-step">
      <h3>Wo steht Ihre Anlage?</h3>
      <p className="vp-muted">
        Geben Sie Ihrem Standort einen Namen und sagen Sie uns den Ort - so erhalten Sie
        eine Wetter- und Ertragsprognose für Ihre Anlage.
      </p>
      <div style={{ display: 'grid', gap: 16 }}>
        <Input
          label="Name des Standorts"
          placeholder="z. B. Zuhause"
          value={name}
          onChange={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <LocationSearch selected={place} onSelect={setPlace} />
      </div>
      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={submit}
        disabled={busy || !valid}
        style={{ marginTop: 20 }}
      >
        {busy ? 'Lege Standort an…' : 'Weiter'}
      </Button>
      {!place && (
        <p className="vp-note" style={{ marginTop: 8 }}>
          Ohne Ortsangabe geht es auch - dann allerdings ohne Wetterprognose.
        </p>
      )}
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
    </div>
  );
}

/**
 * Geräte-IDs come in two shapes and typing case must not matter, so the field
 * mirrors the canonical form as you type (the api canonicalizes the same way on
 * claim): sticker IDs are printed uppercase (VP-1234-ABCD), self-generated edge
 * references lowercase (edge-k7m2xqp). Other refs are left alone.
 */
export function normalizeDeviceIdInput(value: string): string {
  if (/^\s*vp-/i.test(value)) return value.toUpperCase();
  if (/^\s*edge-/i.test(value)) return value.toLowerCase();
  return value;
}

/**
 * Shared claim-field copy so the onboarding wizard and the Geräte drawer speak
 * with ONE voice about where the Geräte-ID comes from - the device shows it in
 * its own app, and some devices also carry a sticker. This replaces the former
 * mismatch (wizard said "Aufkleber", drawer said "Typenschild") that fed the
 * one-character-typo dead-end.
 */
export const DEVICE_ID_FIELD = {
  label: 'Geräte-ID',
  placeholder: 'z. B. edge-k7m2xqp',
  help: 'Die Geräte-ID zeigt Ihnen Ihr VoltPilot-Gerät direkt an - in der Geräte-App unter „Gerät verbinden". Manche Geräte tragen sie zusätzlich auf einem Aufkleber.',
} as const;

/** One 422 message for both gates (unknown sticker OR mistyped edge reference). */
export const DEVICE_ID_UNKNOWN_MSG =
  'Diese Geräte-ID kennen wir nicht. Bitte vergleichen Sie Ihre Eingabe Zeichen für Zeichen mit der ID, die Ihr Gerät anzeigt - schon ein Tippfehler verhindert die Verbindung.';

function DeviceStep({
  siteName,
  siteId,
  onClaimed,
}: {
  siteName: string;
  siteId: string;
  onClaimed: () => void;
}) {
  const [deviceId, setDeviceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valid = deviceId.trim().length > 0;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.claimDevice(siteId, deviceId.trim());
      onClaimed();
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 422
          ? DEVICE_ID_UNKNOWN_MSG
          : e instanceof ApiError && e.status === 409
            ? 'Dieses Gerät ist bereits mit einem anderen Konto verbunden. Bitte prüfen Sie die Geräte-ID - oder kontaktieren Sie unseren Support.'
            : 'Das Verbinden hat gerade nicht geklappt. Bitte prüfen Sie die Geräte-ID und versuchen Sie es noch einmal.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-onboarding-step">
      <h3>Verbinden Sie Ihr VoltPilot-Gerät</h3>
      <p className="vp-muted">
        {DEVICE_ID_FIELD.help} Das Gerät wird mit dem Standort „{siteName}“ verbunden.
      </p>
      <Input
        label={DEVICE_ID_FIELD.label}
        placeholder={DEVICE_ID_FIELD.placeholder}
        value={deviceId}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        onChange={(e) => setDeviceId(normalizeDeviceIdInput((e.target as HTMLInputElement).value))}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter') void submit();
        }}
      />
      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={submit}
        disabled={busy || !valid}
        style={{ marginTop: 20 }}
      >
        {busy ? 'Verbinde…' : 'Gerät verbinden'}
      </Button>
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
    </div>
  );
}

function FirstDataStep({ siteId, onDone }: { siteId: string; onDone: () => void }) {
  const [connected, setConnected] = useState(false);
  const [waitedLong, setWaitedLong] = useState(false);

  useEffect(() => {
    if (connected) return;
    let active = true;
    const check = async () => {
      try {
        const points = await api.telemetry(siteId);
        if (active && points.length > 0) setConnected(true);
      } catch {
        // keep waiting - transient errors must not break the wait screen
      }
    };
    void check();
    const poll = setInterval(check, 5000);
    const slow = setTimeout(() => active && setWaitedLong(true), 90_000);
    return () => {
      active = false;
      clearInterval(poll);
      clearTimeout(slow);
    };
  }, [siteId, connected]);

  if (connected) {
    return (
      <div className="vp-onboarding-step" style={{ textAlign: 'center' }}>
        <div className="vp-success-mark" aria-hidden="true">
          <Icon name="check" size={26} strokeWidth={2.5} />
        </div>
        <h3>Ihre Anlage ist verbunden</h3>
        <p className="vp-muted">
          Ihr Gerät sendet Daten. Im Portal sehen Sie ab jetzt Live-Werte, Prognosen und
          den optimierten Speicher-Fahrplan Ihrer Anlage.
        </p>
        <Button variant="primary" size="lg" fullWidth onClick={onDone} style={{ marginTop: 12 }}>
          Zum Portal
        </Button>
      </div>
    );
  }

  return (
    <div className="vp-onboarding-step" style={{ textAlign: 'center' }}>
      <div className="vp-spinner" aria-hidden="true" />
      <h3>Ihr Gerät meldet sich…</h3>
      <p className="vp-muted">
        Wir warten auf die ersten Daten Ihrer Anlage. Das dauert in der Regel weniger als
        eine Minute.
      </p>
      {waitedLong && (
        <div className="vp-alert vp-alert-err" style={{ textAlign: 'left' }}>
          Das dauert länger als gewöhnlich. Bitte prüfen Sie, ob Ihr VoltPilot-Gerät mit
          Strom und Internet verbunden ist. Sie können das Portal trotzdem schon nutzen -
          wir verbinden im Hintergrund weiter.
        </div>
      )}
      <p className="vp-note" style={{ marginTop: 16 }}>
        <button type="button" className="vp-linklike" onClick={onDone}>
          Später ansehen - zum Portal
        </button>
      </p>
    </div>
  );
}
