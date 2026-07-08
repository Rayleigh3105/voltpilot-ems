import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type Device, type PlantKind, type Site, type TarifArt } from '../api';
import {
  DEVICE_ID_FIELD,
  DEVICE_ID_UNKNOWN_MSG,
  FLOW_STEPS,
  initialFlowStep,
  normalizeDeviceIdInput,
  parseBatteryForm,
  zoneForCountry,
} from '../anlageFlow';
import { parsePremiumInput } from '../fleet';
import { LocationMap } from './LocationMap';
import { TariffFields } from './TariffFields';

/**
 * THE "Anlage anlegen" flow (captain decision 5, 2026-07-07): ONE sequenced
 * flow instead of site-then-device - 1 · Anlage (Name + Adresse + Anlagentyp,
 * Feineinstellungen eingeklappt), 2 · Gerät (Geräte-ID verbinden),
 * 3 · Speicher (optional; the claimed inverter auto-links as the controlling
 * device). Both entry points render THIS component: the first-run onboarding
 * wizard (full-page card, waits for first data at the end) and the
 * "Anlage anlegen" drawer for existing customers (summary finish). Every
 * step past the first is skippable and dead-end-free - whatever exists so
 * far is kept and reachable again (resume banner, Technik section).
 */

export interface GeoPlace {
  name: string;
  latitude: number;
  longitude: number;
  countryCode: string;
  label: string;
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

function StepsRail({ current }: { current: number }) {
  return (
    <ol className="vp-steps">
      {FLOW_STEPS.map((label, i) => {
        const n = i + 1;
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

export function AnlageFlow({
  sites,
  waitForFirstData,
  onSiteCreated,
  onDone,
  onSkipAll,
}: {
  /** The customer's existing Anlagen (wizard resume + target picker). */
  sites: Site[];
  /**
   * true = first-run wizard: after a claimed device the flow ends on the
   * "Ihr Gerät meldet sich…" wait screen (polls for first data).
   * false = drawer: the flow ends on a summary card.
   */
  waitForFirstData: boolean;
  /** Fired the moment the Anlage row exists (host refreshes on close). */
  onSiteCreated?: (site: Site) => void;
  /** The flow is finished or deliberately left - host closes/returns. */
  onDone: () => void;
  /** Wizard only: "Später einrichten" leaves the whole flow. */
  onSkipAll?: () => void;
}) {
  // Resume: a customer who already has an Anlage but no device continues at
  // the Gerät step (wizard restart after "Später einrichten").
  const [site, setSite] = useState<Site | null>(sites[0] ?? null);
  const [createdHere, setCreatedHere] = useState(false);
  const [claimed, setClaimed] = useState<Device | null>(null);
  const [batterySaved, setBatterySaved] = useState(false);
  const [step, setStep] = useState<number>(initialFlowStep(sites.length > 0));

  const finished = step > FLOW_STEPS.length;

  return (
    <div className="vp-anlage-flow">
      <StepsRail current={step} />
      {step === 1 && (
        <AnlageStep
          onCreated={(s) => {
            setSite(s);
            setCreatedHere(true);
            onSiteCreated?.(s);
            setStep(2);
          }}
        />
      )}
      {step === 2 && site && (
        <GeraetStep
          sites={createdHere ? [site] : sites}
          site={site}
          onSiteChange={setSite}
          onClaimed={(d) => {
            setClaimed(d);
            setStep(3);
          }}
          onSkip={() => setStep(3)}
        />
      )}
      {step === 3 && site && (
        <SpeicherStep
          site={site}
          onSaved={() => {
            setBatterySaved(true);
            setStep(4);
          }}
          onSkip={() => setStep(4)}
        />
      )}
      {finished &&
        site &&
        (waitForFirstData && claimed ? (
          <FirstDataStep siteId={site.id} onDone={onDone} />
        ) : (
          <SummaryStep
            site={site}
            claimed={claimed}
            batterySaved={batterySaved}
            onDone={onDone}
          />
        ))}
      {!finished && onSkipAll && (
        <p className="vp-note" style={{ marginTop: 20, textAlign: 'center' }}>
          <button type="button" className="vp-linklike" onClick={onSkipAll}>
            Später einrichten - direkt zum Portal
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Step 1 · Anlage: Name + Adresse (Suche + Karte) + Anlagentyp. The
 * Feineinstellungen (anzulegender Wert, Strompreis, Netzladen) stay collapsed
 * so the first screen stays simple - everything is editable later under
 * Technik & Einstellungen. The Gebotszone is derived from the address'
 * country (no jargon in the UI).
 */
function AnlageStep({ onCreated }: { onCreated: (site: Site) => void }) {
  const [name, setName] = useState('');
  const [place, setPlace] = useState<GeoPlace | null>(null);
  // Actual coordinates: seeded from the chosen Ort, then fine-tunable by
  // dragging the pin (which can diverge from the searched town).
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [plantKind, setPlantKind] = useState<PlantKind>('eigenverbrauch');
  const [advanced, setAdvanced] = useState(false);
  const [netzladen, setNetzladen] = useState(false);
  const [praemie, setPraemie] = useState('');
  const [tarifArt, setTarifArt] = useState<TarifArt>('ohne');
  const [tarifParam, setTarifParam] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const valid = name.trim().length > 0;

  function selectPlace(p: GeoPlace | null) {
    setPlace(p);
    if (p) {
      setLat(p.latitude);
      setLon(p.longitude);
    }
  }

  async function submit() {
    if (busy) return;
    if (!valid) {
      // Never a silently-disabled button - point at the missing field instead.
      setTouched(true);
      nameRef.current?.focus();
      return;
    }
    const praemieValue = plantKind === 'direktvermarktung' ? parsePremiumInput(praemie) : null;
    if (praemieValue === undefined) {
      setErr('Bitte geben Sie den anzulegenden Wert als Zahl in ct/kWh an, z. B. 8,11.');
      return;
    }
    const tarifParamValue = tarifArt === 'ohne' ? null : parsePremiumInput(tarifParam);
    if (tarifParamValue === undefined) {
      setErr(
        tarifArt === 'dynamisch'
          ? 'Bitte geben Sie den Aufschlag als Zahl in ct/kWh an, z. B. 18.'
          : 'Bitte geben Sie Ihren Strompreis als Zahl in ct/kWh an, z. B. 32,5.',
      );
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const site = await api.createSite({
        name: name.trim(),
        biddingZone: zoneForCountry(place?.countryCode),
        latitude: lat,
        longitude: lon,
        plantKind,
        anzulegenderWertCtKwh: praemieValue,
        tarifArt,
        tarifParamCtKwh: tarifParamValue,
        netzladenErlaubt: netzladen,
      });
      onCreated(site);
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 400
          ? 'Bitte prüfen Sie den Namen Ihrer Anlage.'
          : 'Das Anlegen hat gerade nicht geklappt. Bitte versuchen Sie es gleich noch einmal.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-onboarding-step">
      <h3>Ihre Anlage</h3>
      <p className="vp-muted">
        Geben Sie Ihrer Anlage einen Namen und sagen Sie uns, wo sie steht - so
        erhalten Sie eine Wetter- und Ertragsprognose.
      </p>
      <div style={{ display: 'grid', gap: 16 }}>
        <Input
          ref={nameRef}
          label="Name der Anlage"
          placeholder="z. B. Zuhause"
          value={name}
          onChange={(e) => {
            setName((e.target as HTMLInputElement).value);
            if (touched) setTouched(false);
          }}
          onBlur={() => setTouched(true)}
          error={touched && !valid ? 'Bitte geben Sie einen Namen für Ihre Anlage ein.' : null}
        />
        <LocationSearch selected={place} onSelect={selectPlace} />
        <LocationMap
          lat={lat}
          lon={lon}
          onChange={(la, lo) => {
            setLat(la);
            setLon(lo);
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="flow-plant-kind" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Anlagentyp
          </label>
          <select
            id="flow-plant-kind"
            className="vp-select"
            value={plantKind}
            onChange={(e) => setPlantKind(e.target.value as PlantKind)}
          >
            <option value="eigenverbrauch">Eigenverbrauch (Haushalt/Gewerbe)</option>
            <option value="direktvermarktung">Direktvermarktung (Einspeisung am Markt)</option>
          </select>
          <p className="vp-note" style={{ margin: 0 }}>
            Bestimmt, wie Ihr Vorteil erzählt wird: „gespart" beim Eigenverbrauch,
            „mehr verdient" bei der Direktvermarktung.
          </p>
        </div>
        <div>
          <button
            type="button"
            className="vp-linklike"
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
          >
            <Icon
              name="chevron-down"
              size={14}
              style={{
                verticalAlign: '-2px',
                marginRight: 4,
                transform: advanced ? 'rotate(180deg)' : undefined,
              }}
            />
            Feineinstellungen {advanced ? 'ausblenden' : '(optional)'}
          </button>
          {!advanced && (
            <p className="vp-note" style={{ margin: '4px 0 0' }}>
              Stromtarif, Vergütung und Netzladen - jetzt oder später unter
              „Technik &amp; Einstellungen".
            </p>
          )}
        </div>
        {advanced && (
          <>
            {plantKind === 'direktvermarktung' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <Input
                  label="Anzulegender Wert (ct/kWh)"
                  placeholder="z. B. 8,11"
                  inputMode="decimal"
                  value={praemie}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPraemie(e.target.value)}
                />
                <p className="vp-note" style={{ margin: 0 }}>
                  Steht in Ihrem EEG-Zuschlag bzw. Direktvermarktungsvertrag. Optional -
                  wenn angegeben, rechnen wir Ihre Marktprämie (anzulegender Wert minus
                  Monatsmarktwert Solar) in Ihren Mehrerlös ein; bei negativen
                  Börsenpreisen entfällt sie.
                </p>
              </div>
            )}
            <TariffFields
              tarifArt={tarifArt}
              onTarifArt={setTarifArt}
              param={tarifParam}
              onParam={setTarifParam}
              idPrefix="flow-site"
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label htmlFor="flow-netzladen" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                Netzladen des Speichers
              </label>
              <select
                id="flow-netzladen"
                className="vp-select"
                value={netzladen ? 'erlaubt' : 'verboten'}
                onChange={(e) => setNetzladen(e.target.value === 'erlaubt')}
              >
                <option value="verboten">Verboten - EEG-Anlage (nur Solarladen)</option>
                <option value="erlaubt">Erlaubt - Speicher darf aus dem Netz laden</option>
              </select>
              <p className="vp-note" style={{ margin: 0 }}>
                EEG-geförderte Anlagen dürfen ihren Speicher nicht aus dem Netz laden
                (Ausschließlichkeitsprinzip). Nur aktivieren, wenn Ihre Anlage keine
                EEG-Vergütung bezieht.
              </p>
            </div>
          </>
        )}
      </div>
      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={submit}
        disabled={busy}
        style={{ marginTop: 20 }}
      >
        {busy ? 'Lege Anlage an…' : 'Weiter'}
      </Button>
      {lat == null && (
        <p className="vp-note" style={{ marginTop: 8 }}>
          Ohne Adresse geht es auch - dann allerdings ohne Wetterprognose.
        </p>
      )}
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
    </div>
  );
}

/**
 * Step 2 · Gerät: connect the VoltPilot device by its Geräte-ID. Skippable -
 * the Anlage exists either way and the resume banner keeps the way back in.
 */
function GeraetStep({
  sites,
  site,
  onSiteChange,
  onClaimed,
  onSkip,
}: {
  sites: Site[];
  site: Site;
  onSiteChange: (site: Site) => void;
  onClaimed: (device: Device) => void;
  onSkip: () => void;
}) {
  const [deviceId, setDeviceId] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A returning multi-Anlagen customer must be able to pick the target
  // Anlage instead of being pinned to sites[0].
  const multiSite = sites.length > 1;
  const valid = deviceId.trim().length > 0;

  async function submit() {
    if (busy) return;
    if (!valid) {
      // Keep the button live, point at the empty field.
      setTouched(true);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const device = await api.claimDevice(site.id, deviceId.trim());
      onClaimed(device);
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
        {DEVICE_ID_FIELD.help}
        {!multiSite && ` Das Gerät wird mit der Anlage „${site.name}“ verbunden.`}
      </p>
      <div style={{ display: 'grid', gap: 16 }}>
        {multiSite && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <label htmlFor="flow-site" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
              Anlage
            </label>
            <select
              id="flow-site"
              className="vp-select"
              value={site.id}
              onChange={(e) => {
                const next = sites.find((s) => s.id === e.target.value);
                if (next) onSiteChange(next);
              }}
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <Input
          ref={inputRef}
          label={DEVICE_ID_FIELD.label}
          placeholder={DEVICE_ID_FIELD.placeholder}
          value={deviceId}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => {
            setDeviceId(normalizeDeviceIdInput((e.target as HTMLInputElement).value));
            if (touched) setTouched(false);
          }}
          onBlur={() => setTouched(true)}
          error={touched && !valid ? 'Bitte geben Sie die Geräte-ID ein.' : null}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === 'Enter') void submit();
          }}
        />
      </div>
      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={submit}
        disabled={busy}
        style={{ marginTop: 20 }}
      >
        {busy ? 'Verbinde…' : 'Gerät verbinden'}
      </Button>
      <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
        <button type="button" className="vp-linklike" onClick={onSkip}>
          Gerät später verbinden
        </button>
      </p>
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
    </div>
  );
}

/**
 * Step 3 · Speicher (optional): the battery master data the Fahrplan plans
 * with. No controlling-device picker here - the claimed inverter auto-links
 * as the Anlage's single device (backend auto-link); everything further
 * (Wirkungsgrad, Gerätewahl) lives under Technik & Einstellungen.
 */
function SpeicherStep({
  site,
  onSaved,
  onSkip,
}: {
  site: Site;
  onSaved: () => void;
  onSkip: () => void;
}) {
  const [capacity, setCapacity] = useState('');
  const [maxCharge, setMaxCharge] = useState('');
  const [maxDischarge, setMaxDischarge] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    const parsed = parseBatteryForm({ capacity, maxCharge, maxDischarge });
    if (!parsed.ok) {
      setErr(parsed.error);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // No deviceId: the backend links the Anlage's single device (the
      // claimed inverter) as the controlling device automatically.
      await api.saveBattery(site.id, parsed.value);
      onSaved();
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Eingabe. Bitte prüfen Sie die Werte.'
          : 'Die Speicherdaten konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-onboarding-step">
      <h3>Ihr Batteriespeicher</h3>
      <p className="vp-muted">
        Optional: Mit den Speicherdaten plant VoltPilot den Lade-Fahrplan Ihres
        Speichers. Die Werte stehen im Datenblatt - Sie können sie jederzeit
        unter „Technik &amp; Einstellungen" nachtragen oder ändern.
      </p>
      <div style={{ display: 'grid', gap: 16 }}>
        <Input
          label="Kapazität (kWh)"
          placeholder="z. B. 10"
          inputMode="decimal"
          value={capacity}
          onChange={(e) => setCapacity((e.target as HTMLInputElement).value)}
        />
        <Input
          label="Max. Ladeleistung (kW)"
          placeholder="z. B. 5"
          inputMode="decimal"
          value={maxCharge}
          onChange={(e) => setMaxCharge((e.target as HTMLInputElement).value)}
        />
        <Input
          label="Max. Entladeleistung (kW)"
          placeholder="z. B. 5"
          inputMode="decimal"
          value={maxDischarge}
          onChange={(e) => setMaxDischarge((e.target as HTMLInputElement).value)}
        />
      </div>
      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={submit}
        disabled={busy}
        style={{ marginTop: 20 }}
      >
        {busy ? 'Speichere…' : 'Speicher speichern'}
      </Button>
      <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
        <button type="button" className="vp-linklike" onClick={onSkip}>
          Kein Speicher oder später eintragen
        </button>
      </p>
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
    </div>
  );
}

/**
 * Wizard finish after a claimed device: wait for the first data so the
 * customer sees their Anlage come alive before entering the portal.
 */
export function FirstDataStep({ siteId, onDone }: { siteId: string; onDone: () => void }) {
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

/**
 * Drawer finish (and wizard finish without a claimed device): an honest
 * summary of what exists now and what happens next - never pretending a
 * skipped step happened.
 */
function SummaryStep({
  site,
  claimed,
  batterySaved,
  onDone,
}: {
  site: Site;
  claimed: Device | null;
  batterySaved: boolean;
  onDone: () => void;
}) {
  return (
    <div className="vp-onboarding-step" style={{ textAlign: 'center' }}>
      <div className="vp-success-mark" aria-hidden="true">
        <Icon name="check" size={26} strokeWidth={2.5} />
      </div>
      <h3>Anlage „{site.name}“ ist angelegt</h3>
      {claimed ? (
        <p className="vp-muted">
          Ihr Gerät <span className="vp-mono">{claimed.externalRef}</span> ist verbunden.
          Sobald es eingeschaltet ist, konfiguriert es sich selbst und beginnt zu senden -
          der Status wechselt dann automatisch auf „online“.
        </p>
      ) : (
        <p className="vp-muted">
          Noch ist kein Gerät verbunden. Sie können es jederzeit nachholen - auf der
          Anlagen-Seite unter „Technik &amp; Einstellungen“.
        </p>
      )}
      {batterySaved && (
        <p className="vp-muted">
          Die Speicherdaten sind hinterlegt - der Fahrplan plant damit.
        </p>
      )}
      <Button variant="primary" size="lg" fullWidth onClick={onDone} style={{ marginTop: 12 }}>
        Fertig
      </Button>
    </div>
  );
}
