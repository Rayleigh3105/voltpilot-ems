import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import {
  api,
  ApiError,
  type Device,
  type MastrPreview,
  type PlantKind,
  type Site,
  type SiteAsset,
  type SiteEntity,
  type SiteUsageProfile,
  type TarifArt,
} from '../api';
import { isPlatformAdmin } from '../auth';
import { entitiesApi, type AutoStartOutcome, type EntityTypeDef } from '../entitiesApi';
import {
  PROFILE_OPTIONS,
  autoStartSummary,
  creatableConsumerTypes,
  entitiesRecognisedSummary,
  entityGroupLabel,
  initialProfileChoice,
  overrideForChoice,
  profileChoiceChanged,
  profileLabel,
  type ProfileChoice,
} from '../adaptiveOnboarding';
import {
  SPEICHERSCHONUNG_OPTIONS,
  presetOf,
  type SpeicherschonungPreset,
} from '../speicherschonung';
import {
  buildMastrApply,
  DEVICE_ID_FIELD,
  DEVICE_ID_UNKNOWN_MSG,
  FLOW_STEPS,
  initialFlowStep,
  mastrLocationLabel,
  mastrPvSummary,
  mastrStorageSummary,
  normalizeDeviceIdInput,
  normalizeSeeNummer,
  parseBatteryForm,
  pickStorageNumber,
  validateSeeNummer,
  zoneForCountry,
} from '../anlageFlow';
import { parseFeedInCapInput, parsePremiumInput } from '../fleet';
import { SETUP_NEXT_HINT } from '../setupPath';
import { fmtNum } from '../format';
import { LocationMap } from './LocationMap';
import { TariffFields } from './TariffFields';

/**
 * THE register-first "Anlage anlegen" flow (captain 2026-07-09): instead of
 * typing PV and battery specs by hand, the customer enters their MaStR
 * number(s) and VoltPilot pulls the data from the Marktstammdatenregister.
 * 1 · Anlage (Name + Standort) -> 2 · Register (PV + Speicher aus dem
 * Register, Vorschau, Übernehmen - manual entry stays one tap away) ->
 * 3 · Nutzung ("Wie soll Ihr Speicher arbeiten?" - captain design update
 * 2026-07-16, changeable later on the Optimierung subpage) ->
 * 4 · Gerät (Geräte-ID verbinden) -> Fertig. Both entry points render THIS
 * component: the first-run onboarding wizard (full-page card, waits for first
 * data at the end) and the "Anlage anlegen" drawer for existing customers
 * (summary finish). Every step past the first is skippable and dead-end-free -
 * whatever exists so far is kept and reachable again (resume banner, Technik
 * section). Pure step/validation/MaStR-mapping logic lives in ../anlageFlow.
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
            label="Standort"
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
  existingSites,
  waitForFirstData,
  onSiteCreated,
  onDone,
  onSkipAll,
}: {
  /** The customer's existing Anlagen (wizard resume + Gerät target picker). */
  sites: Site[];
  /**
   * All of the customer's Anlagen for the "gleicher Standort wie …" reuse
   * affordance in the Anlage step. Defaults to `sites`; the drawer passes the
   * real list even though it starts a fresh flow with `sites={[]}`.
   */
  existingSites?: Site[];
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
  // the Register step (skippable) on the way to the Gerät step.
  const [site, setSite] = useState<Site | null>(sites[0] ?? null);
  const [createdHere, setCreatedHere] = useState(false);
  const [claimed, setClaimed] = useState<Device | null>(null);
  // What the register applied (drives the Fertig summary + "Quelle: Register").
  const [pvApplied, setPvApplied] = useState<MastrPreview | null>(null);
  const [storageApplied, setStorageApplied] = useState<MastrPreview | null>(null);
  const [manualBatterySaved, setManualBatterySaved] = useState(false);
  // What the AE7 auto-start seeded (shown on the summary; null = none/skipped).
  const [autoStart, setAutoStart] = useState<AutoStartOutcome | null>(null);
  const [step, setStep] = useState<number>(initialFlowStep(sites.length > 0));

  const locationSites = existingSites ?? sites;
  const finished = step > FLOW_STEPS.length;

  return (
    <div className="vp-anlage-flow">
      <StepsRail current={step} />
      {step === 1 && (
        <AnlageStep
          locationSites={locationSites}
          onCreated={(s) => {
            setSite(s);
            setCreatedHere(true);
            onSiteCreated?.(s);
            setStep(2);
          }}
        />
      )}
      {step === 2 && site && (
        <RegisterStep
          site={site}
          onApplied={(pv, storage) => {
            setPvApplied(pv);
            setStorageApplied(storage);
            setStep(3);
          }}
          onManualSaved={() => {
            setManualBatterySaved(true);
            setStep(3);
          }}
          onSkip={() => setStep(3)}
        />
      )}
      {step === 3 && site && (
        <GeraetStep
          sites={createdHere ? [site] : locationSites}
          site={site}
          onSiteChange={setSite}
          onClaimed={(d) => {
            setClaimed(d);
            setStep(4);
          }}
          onSkip={() => setStep(4)}
        />
      )}
      {step === 4 && site && (
        <NutzungStep
          site={site}
          onNext={(outcome) => {
            setAutoStart(outcome);
            setStep(5);
          }}
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
            pvApplied={pvApplied}
            storageApplied={storageApplied}
            manualBatterySaved={manualBatterySaved}
            autoStart={autoStart}
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
 * Step 1 · Anlage: Name + Standort (Suche + Karte). The exact PV/Speicher
 * specs come from the register in step 2, so this screen stays intentionally
 * short. The Feineinstellungen (anzulegender Wert, Stromtarif, Netzladen) stay
 * collapsed - everything is editable later under Technik & Einstellungen. The
 * Gebotszone is derived from the address' country (no jargon in the UI).
 */
function AnlageStep({
  locationSites,
  onCreated,
}: {
  locationSites: Site[];
  onCreated: (site: Site) => void;
}) {
  const [name, setName] = useState('');
  const [place, setPlace] = useState<GeoPlace | null>(null);
  // Actual coordinates: seeded from the chosen Ort or a reused Anlage, then
  // fine-tunable by dragging the pin.
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [zone, setZone] = useState<string>('DE-LU');
  const [plantKind, setPlantKind] = useState<PlantKind>('eigenverbrauch');
  const [advanced, setAdvanced] = useState(false);
  const [netzladen, setNetzladen] = useState(false);
  const [praemie, setPraemie] = useState('');
  const [tarifArt, setTarifArt] = useState<TarifArt>('ohne');
  const [tarifParam, setTarifParam] = useState('');
  const [maxFeedIn, setMaxFeedIn] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const valid = name.trim().length > 0;
  // "Gleicher Standort wie …": Anlagen the customer already placed on the map.
  const reusable = locationSites.filter((s) => s.latitude != null && s.longitude != null);

  function selectPlace(p: GeoPlace | null) {
    setPlace(p);
    if (p) {
      setLat(p.latitude);
      setLon(p.longitude);
      setZone(zoneForCountry(p.countryCode));
    }
  }

  function reuseLocation(s: Site) {
    setPlace(null);
    setLat(s.latitude);
    setLon(s.longitude);
    setZone(s.biddingZone);
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
    const maxFeedInValue = parseFeedInCapInput(maxFeedIn);
    if (maxFeedInValue === undefined) {
      setErr('Bitte geben Sie die maximale Einspeiseleistung als Zahl in kW an, z. B. 75.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const site = await api.createSite({
        name: name.trim(),
        biddingZone: zone,
        latitude: lat,
        longitude: lon,
        plantKind,
        anzulegenderWertCtKwh: praemieValue,
        tarifArt,
        tarifParamCtKwh: tarifParamValue,
        netzladenErlaubt: netzladen,
        maxFeedInKw: maxFeedInValue,
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
      <h3>Wie heißt Ihre Anlage?</h3>
      <p className="vp-muted">
        Ein Name, unter dem Sie sie wiederfinden - und wo sie steht. Leistung,
        Speicher &amp; Co. holen wir gleich aus dem Register.
      </p>
      <div style={{ display: 'grid', gap: 16 }}>
        <Input
          ref={nameRef}
          label="Name der Anlage"
          placeholder="z. B. Anlage Auernheim"
          value={name}
          onChange={(e) => {
            setName((e.target as HTMLInputElement).value);
            if (touched) setTouched(false);
          }}
          onBlur={() => setTouched(true)}
          error={touched && !valid ? 'Bitte geben Sie einen Namen für Ihre Anlage ein.' : null}
        />
        {reusable.length > 0 && (
          <div className="vp-reuse-loc">
            <span className="vp-reuse-loc-lbl">Gleicher Standort wie</span>
            <div className="vp-reuse-loc-chips">
              {reusable.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="vp-chip"
                  onClick={() => reuseLocation(s)}
                >
                  <Icon name="map-pin" size={13} />
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}
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
              Stromtarif, Vergütung, Netzladen und Einspeisegrenze - jetzt oder
              später unter „Technik &amp; Einstellungen".
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <Input
                label="Maximale Einspeiseleistung am Netzanschlusspunkt (kW)"
                placeholder="z. B. 75"
                inputMode="decimal"
                value={maxFeedIn}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setMaxFeedIn(e.target.value)
                }
              />
              <p className="vp-note" style={{ margin: 0 }}>
                Steht in Ihrer Netzanschluss-Zusage bzw. im Einspeisevertrag. Optional -
                wenn angegeben, plant VoltPilot die Einspeisung nie über diese Grenze
                hinaus. Ihr Bezug aus dem Netz ist davon nicht betroffen.
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
          Ohne Standort geht es auch - dann allerdings ohne Wetterprognose.
        </p>
      )}
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
    </div>
  );
}

/**
 * Step 2 · Register: the heart of the register-first flow. The customer enters
 * the MaStR number of the PV plant (and optionally the storage; it is
 * auto-filled from the register's `linkedUnitNumber` when the two are linked),
 * we look both up and show ONE preview to confirm, and "Übernehmen" applies
 * PV + Speicher together (`mastr-apply`, atomic, auto-links the battery to the
 * device). Manual entry is always one tap away for Balkonkraftwerke,
 * unregistered plants or an unknown number.
 */
function RegisterStep({
  site,
  onApplied,
  onManualSaved,
  onSkip,
}: {
  site: Site;
  onApplied: (pv: MastrPreview | null, storage: MastrPreview | null) => void;
  onManualSaved: () => void;
  onSkip: () => void;
}) {
  const [mode, setMode] = useState<'enter' | 'preview' | 'manual'>('enter');
  const [pvNummer, setPvNummer] = useState('');
  const [storageNummer, setStorageNummer] = useState('');
  const [storageAutoFilled, setStorageAutoFilled] = useState(false);
  const [previews, setPreviews] = useState<MastrPreview[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pvHint = validateSeeNummer(pvNummer);
  const storageHint = validateSeeNummer(storageNummer);
  const canLookup =
    !busy && !pvHint && !storageHint && (pvNummer.trim() !== '' || storageNummer.trim() !== '');

  const pvPreview = previews?.find((p) => p.kind === 'pv') ?? null;
  const storagePreview = previews?.find((p) => p.kind === 'storage') ?? null;

  async function lookup() {
    if (!canLookup) return;
    setBusy(true);
    setError(null);
    try {
      const found: MastrPreview[] = [];
      let pv: MastrPreview | null = null;
      const pvNorm = normalizeSeeNummer(pvNummer);
      if (pvNorm) {
        pv = await api.mastrLookup(site.id, pvNorm);
        found.push(pv);
      }
      // Auto-adopt the linked storage number when the field is empty.
      const storage = pickStorageNumber(pv, storageNummer);
      if (storage) {
        const storagePrev = await api.mastrLookup(site.id, storage.number);
        found.push(storagePrev);
        if (storage.autoFilled) {
          setStorageNummer(storage.number);
          setStorageAutoFilled(true);
        }
      }
      const kinds = found.map((p) => p.kind);
      if (new Set(kinds).size !== kinds.length) {
        setError(
          'Beide Nummern gehören zur gleichen Einheitenart. Bitte geben Sie die SEE-Nummer der PV-Anlage und - falls vorhanden - die des Speichers an.',
        );
        return;
      }
      setPreviews(found);
      setMode('preview');
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Die Registerabfrage ist gerade nicht erreichbar. Bitte versuchen Sie es gleich noch einmal.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!previews) return;
    setBusy(true);
    setError(null);
    try {
      await api.mastrApply(site.id, buildMastrApply(previews));
      onApplied(pvPreview, storagePreview);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Die Daten konnten nicht übernommen werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'manual') {
    return (
      <ManualBatteryStep
        site={site}
        onSaved={onManualSaved}
        onSkip={onSkip}
        onBack={() => setMode('enter')}
      />
    );
  }

  if (mode === 'preview' && previews) {
    return (
      <div className="vp-onboarding-step">
        <h3>Im Register gefunden</h3>
        <p className="vp-muted">Bitte kurz prüfen und bestätigen - erst dann speichern wir die Werte.</p>
        {pvPreview && <MastrPreviewCard preview={pvPreview} />}
        {storagePreview && (
          <MastrPreviewCard preview={storagePreview} linked={storageAutoFilled} />
        )}
        <p className="vp-note">
          Datenquelle: Marktstammdatenregister der Bundesnetzagentur (dl-de/by-2-0). Straße und
          Koordinaten sind für private Betreiber nicht öffentlich - Ihren Standort setzen Sie selbst.
        </p>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={apply}
          disabled={busy}
          style={{ marginTop: 8 }}
        >
          {busy ? 'Wird übernommen…' : 'Übernehmen & weiter'}
        </Button>
        <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
          <button
            type="button"
            className="vp-linklike"
            onClick={() => {
              setMode('enter');
              setError(null);
            }}
          >
            Zurück zu den Nummern
          </button>
        </p>
        {error && <div className="vp-alert vp-alert-err">{error}</div>}
      </div>
    );
  }

  return (
    <div className="vp-onboarding-step">
      <h3>PV &amp; Speicher aus dem Register</h3>
      <p className="vp-muted">
        Geben Sie die MaStR-Nummer Ihrer PV-Anlage ein - wir holen Leistung, Modulzahl und
        Ausrichtung automatisch. Den verknüpften Speicher erkennen wir mit.
      </p>
      <div style={{ display: 'grid', gap: 16 }}>
        <Input
          label="MaStR-Nummer der PV-Anlage"
          placeholder="z. B. SEE966831669444"
          value={pvNummer}
          error={pvHint}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setPvNummer(e.target.value);
            if (error) setError(null);
          }}
        />
        <div>
          <Input
            label="MaStR-Nummer des Speichers (optional)"
            placeholder="z. B. SEE972142227037"
            value={storageNummer}
            error={storageHint}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setStorageNummer(e.target.value);
              setStorageAutoFilled(false);
              if (error) setError(null);
            }}
          />
          <p className="vp-note vp-hint-row" style={{ margin: '6px 0 0' }}>
            <Icon name="link" size={14} />
            <span>
              {storageAutoFilled
                ? 'Verknüpft - automatisch aus der PV-Anlage übernommen.'
                : 'Ist Ihr Speicher im Register verknüpft, füllen wir die Nummer nach der Suche automatisch. Kein Speicher? Feld leer lassen.'}
            </span>
          </p>
        </div>
      </div>
      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={lookup}
        disabled={!canLookup}
        style={{ marginTop: 20 }}
      >
        <Icon name="search" size={17} style={{ marginRight: 8, verticalAlign: '-3px' }} />
        {busy ? 'Suche im Register…' : 'Im Register suchen'}
      </Button>
      <p className="vp-note" style={{ marginTop: 10, textAlign: 'center' }}>
        <button type="button" className="vp-linklike" onClick={() => setMode('manual')}>
          Keine Nummer? Daten manuell eingeben
        </button>
      </p>
      <p className="vp-note" style={{ marginTop: 4, textAlign: 'center' }}>
        <button type="button" className="vp-linklike vp-linklike-quiet" onClick={onSkip}>
          Überspringen - später nachtragen
        </button>
      </p>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </div>
  );
}

/** The confirmation card for one mapped MaStR record (PV or storage). */
function MastrPreviewCard({ preview, linked }: { preview: MastrPreview; linked?: boolean }) {
  const isPv = preview.kind === 'pv';
  const location = mastrLocationLabel(preview);
  return (
    <div className={`vp-mastr-card ${isPv ? 'vp-mastr-pv' : 'vp-mastr-storage'}`}>
      <div className="vp-mastr-card-head">
        <span className="vp-mastr-card-title">
          <Icon name={isPv ? 'sun' : 'battery'} size={16} />
          {isPv ? 'PV-Anlage' : 'Batteriespeicher'}
        </span>
        {linked && (
          <Badge variant="tint" dot>
            verknüpft
          </Badge>
        )}
        <span className="vp-mono vp-note vp-mastr-nr">{preview.mastrNummer}</span>
      </div>
      <dl className="vp-kv-list">
        {isPv ? (
          <>
            <KvRow k="Leistung" v={preview.powerKw != null ? fmtNum(preview.powerKw, 'kWp', 2) : null} />
            <KvRow k="Module" v={preview.moduleCount != null ? String(preview.moduleCount) : null} />
            <KvRow
              k="Ausrichtung"
              v={[preview.azimuthLabel, preview.tiltLabel].filter(Boolean).join(' · ') || null}
            />
            <KvRow k="In Betrieb seit" v={preview.commissionedOn} />
          </>
        ) : (
          <>
            <KvRow
              k="Kapazität"
              v={preview.storageCapacityKwh != null ? fmtNum(preview.storageCapacityKwh, 'kWh', 1) : null}
            />
            <KvRow k="Entladeleistung" v={preview.powerKw != null ? fmtNum(preview.powerKw, 'kW', 2) : null} />
            <KvRow k="Ladeleistung" v={preview.chargePowerKw != null ? fmtNum(preview.chargePowerKw, 'kW', 2) : null} />
            <KvRow k="Technologie" v={preview.batteryTechnology} />
          </>
        )}
      </dl>
      {location && (
        <p className="vp-mastr-plaus">
          <Icon name="map-pin" size={14} />
          <span>{location} - stimmt das?</span>
        </p>
      )}
      {preview.warnings.map((w) => (
        <div key={w} className="vp-alert vp-alert-info" style={{ marginBottom: 0, marginTop: 10 }}>
          {w}
        </div>
      ))}
    </div>
  );
}

function KvRow({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="vp-kv-row">
      <dt>{k}</dt>
      <dd>{v ?? <span className="vp-muted">nicht im Register</span>}</dd>
    </div>
  );
}

/**
 * The manual fallback (today's hand-entry path): the battery master data the
 * Fahrplan plans with. No controlling-device picker - the claimed inverter
 * auto-links as the Anlage's single device (backend auto-link). Kept fully
 * functional for Balkonkraftwerke / unregistered plants / an unknown number.
 */
function ManualBatteryStep({
  site,
  onSaved,
  onSkip,
  onBack,
}: {
  site: Site;
  onSaved: () => void;
  onSkip: () => void;
  onBack: () => void;
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
      <h3>Daten manuell eingeben</h3>
      <p className="vp-muted">
        Kein Eintrag im Register (z. B. Balkonkraftwerk) oder Nummer nicht zur Hand? Tragen Sie
        die Speicherdaten aus dem Datenblatt ein - Sie können sie jederzeit unter „Technik &amp;
        Einstellungen" ändern.
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
      <p className="vp-note" style={{ marginTop: 4, textAlign: 'center' }}>
        <button type="button" className="vp-linklike vp-linklike-quiet" onClick={onBack}>
          Zurück zur Registersuche
        </button>
      </p>
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
    </div>
  );
}

/**
 * Step 4 · Nutzung: the ADAPTIVE step (AE5, spec §2/§3/§10). Three parts, all
 * optional and skippable:
 *
 *  - Ihre Geräte: the entities of the Anlage. When VoltPilot onboards
 *    (platform-admin via the tenant switcher) the pilot entities are composed
 *    from the Register/Gerät master data via the v2 bootstrap and additional
 *    controllable Verbraucher (Wallbox/Heizstab/…) can be added; a customer
 *    sees the recognised devices read-only (the permanent editing home is the
 *    "Geräte & Entitäten" surface).
 *  - Nutzungsprofil: the DERIVED usage profile (AE7 `GET /sites/{id}/profile`)
 *    with an explicit override. This is the second adaptation axis - it steers
 *    which view emphasis the customer then gets (Geld-/Peak-/Flow-zentriert).
 *  - Umgang mit dem Speicher: Speicherschonung preset (battery master data).
 *
 * On finish the profile override is written (only on a change), the
 * Speicherschonung saved, and - for an admin onboarding - the profile's
 * auto-start starter flow is seeded (`POST .../flows/auto-start`), so the
 * customer never faces an empty flow. All decision logic lives in
 * ../adaptiveOnboarding; this component only wires + renders it.
 */
function NutzungStep({ site, onNext }: { site: Site; onNext: (outcome: AutoStartOutcome | null) => void }) {
  const [battery, setBattery] = useState<SiteAsset | null>(null);
  const [schonung, setSchonung] = useState<SpeicherschonungPreset>('ausgewogen');
  const [entities, setEntities] = useState<SiteEntity[]>([]);
  const [profile, setProfile] = useState<SiteUsageProfile | null>(null);
  const [choice, setChoice] = useState<ProfileChoice>('auto');
  const [catalog, setCatalog] = useState<EntityTypeDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Once the customer picks a profile, a late-arriving profile load must not
  // clobber their selection back to the derived default.
  const choiceTouched = useRef(false);

  const admin = isPlatformAdmin();

  // The battery the Register/manual step just created (or none). Fail-soft.
  useEffect(() => {
    let active = true;
    api.siteAssets(site.id).then(
      (assets) => {
        if (!active) return;
        const b = assets.find((a) => a.type === 'battery') ?? null;
        setBattery(b);
        setSchonung(presetOf(b?.speicherschonung) ?? 'ausgewogen');
      },
      () => {
        if (active) setBattery(null);
      },
    );
    return () => {
      active = false;
    };
  }, [site.id]);

  // Compose the pilot entities (admin bootstrap - idempotent, fail-soft), then
  // load the entity list + derived usage profile (+ the type catalog for the
  // admin add). A customer just reads what exists; nothing here blocks the step.
  const loadEntities = () =>
    api.siteEntities(site.id).then(
      (d) => setEntities(d.entities),
      () => setEntities([]),
    );

  useEffect(() => {
    let active = true;
    async function run() {
      if (admin) {
        try {
          await entitiesApi.bootstrap(site.id);
        } catch {
          // Best-effort: an un-migratable or gateway-less site just shows fewer
          // entities - the wizard never dead-ends on it.
        }
      }
      const [d, prof] = await Promise.all([
        api.siteEntities(site.id).then((x) => x.entities).catch(() => [] as SiteEntity[]),
        api.usageProfile(site.id).then((p) => p).catch(() => null),
      ]);
      if (!active) return;
      setEntities(d);
      setProfile(prof);
      if (!choiceTouched.current) setChoice(initialProfileChoice(prof));
      if (admin) {
        entitiesApi.typeCatalog().then(
          (c) => active && setCatalog(c.types),
          () => {},
        );
      }
    }
    void run();
    return () => {
      active = false;
    };
  }, [site.id, admin]);

  const batteryEditable =
    battery != null &&
    battery.capacityKwh != null &&
    battery.maxChargeKw != null &&
    battery.maxDischargeKw != null;
  const derivedLabel = profileLabel(profile?.derivedProfile);

  async function next() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      // Speicherschonung: an untouched Ausgewogen equals the stored effective
      // preset - only a real change writes (never pins the default).
      if (batteryEditable && battery && schonung !== presetOf(battery.speicherschonung)) {
        await api.saveBattery(site.id, {
          capacityKwh: battery.capacityKwh as number,
          maxChargeKw: battery.maxChargeKw as number,
          maxDischargeKw: battery.maxDischargeKw as number,
          roundtripEfficiencyPct: battery.roundtripEfficiencyPct,
          deviceId: battery.deviceId,
          speicherschonung: schonung,
        });
      }
      // Usage-profile override: only on a real change (null re-enables auto).
      if (profileChoiceChanged(choice, profile)) {
        await api.setUsageProfileOverride(site.id, overrideForChoice(choice));
      }
      // Auto-start the profile's starter flow (admin onboarding; fail-soft,
      // idempotent - a site with a flow / no battery is skipped, not an error).
      let outcome: AutoStartOutcome | null = null;
      if (admin) {
        outcome = await entitiesApi.autoStart(site.id).catch(() => null);
      }
      onNext(outcome);
    } catch {
      setErr('Die Auswahl konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(false);
    }
  }

  const summary = entitiesRecognisedSummary(entities);

  return (
    <div className="vp-onboarding-step">
      <h3>Wie nutzen Sie Ihre Anlage?</h3>
      <p className="vp-muted">
        Daraus richten wir Ihre Ansicht ein. Sie können alles später jederzeit auf der
        Anlagen-Seite ändern.
      </p>

      <section className="vp-onb-block">
        <h4 className="vp-onb-block-title">Ihre Geräte</h4>
        {summary ? (
          <>
            <p className="vp-note" style={{ marginTop: 0 }}>
              {summary}
            </p>
            <ul className="vp-onb-entities">
              {entities.map((e) => (
                <li key={e.id} className="vp-onb-entity">
                  <span className="vp-onb-entity-role">{entityGroupLabel(e)}</span>
                  <span className="vp-onb-entity-name">{e.label ?? e.typeLabel}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="vp-note" style={{ marginTop: 0 }}>
            {admin
              ? 'Noch keine Geräte erkannt - legen Sie zuerst PV/Speicher und das Gerät an.'
              : 'Ihre Geräte richten wir aus Ihren Angaben ein. Weitere - etwa eine Wallbox oder einen Heizstab - ergänzt VoltPilot für Sie.'}
          </p>
        )}
        {admin && <ConsumerAddRow siteId={site.id} catalog={catalog} onAdded={loadEntities} />}
      </section>

      <section className="vp-onb-block">
        <h4 className="vp-onb-block-title">Womit sollen wir starten?</h4>
        <p className="vp-note" style={{ marginTop: 0 }}>
          Bestimmt, welche Steuerung wir für Sie einrichten. Sie können jederzeit
          weitere Modi hinzufügen oder wieder abschalten.
          {choice === 'auto' && ` Vorschlag für Ihre Anlage: ${derivedLabel}.`}
        </p>
        <fieldset className="vp-schonung">
          <legend className="vp-visually-hidden">Start-Steuerung</legend>
          {PROFILE_OPTIONS.map((o) => (
            <label
              key={o.value}
              className={'vp-schonung-opt' + (choice === o.value ? ' selected' : '')}
            >
              <input
                type="radio"
                name="nutzung-profil"
                value={o.value}
                checked={choice === o.value}
                onChange={() => {
                  choiceTouched.current = true;
                  setChoice(o.value);
                }}
              />
              <span className="vp-schonung-main">
                <span className="vp-schonung-label">
                  {o.label}
                  {o.value === 'auto' ? ` (${derivedLabel})` : ''}
                </span>
                <span className="vp-schonung-sentence">{o.sentence}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>

      {batteryEditable && (
        <section className="vp-onb-block">
          <h4 className="vp-onb-block-title">Umgang mit dem Speicher</h4>
          <fieldset className="vp-schonung">
            <legend className="vp-visually-hidden">Umgang mit dem Speicher</legend>
            {SPEICHERSCHONUNG_OPTIONS.map((o) => (
              <label
                key={o.value}
                className={'vp-schonung-opt' + (schonung === o.value ? ' selected' : '')}
              >
                <input
                  type="radio"
                  name="nutzung-speicherschonung"
                  value={o.value}
                  checked={schonung === o.value}
                  onChange={() => setSchonung(o.value)}
                />
                <span className="vp-schonung-main">
                  <span className="vp-schonung-label">
                    {o.label}
                    {o.recommended ? ' (empfohlen)' : ''}
                  </span>
                  <span className="vp-schonung-sentence">{o.sentence}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </section>
      )}

      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={next}
        disabled={busy}
        style={{ marginTop: 20 }}
      >
        {busy ? 'Speichere…' : 'Weiter'}
      </Button>
      <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
        <button type="button" className="vp-linklike" onClick={() => onNext(null)}>
          Überspringen - später festlegen
        </button>
      </p>
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
    </div>
  );
}

/**
 * Admin-only inline row to add a controllable Verbraucher (Wallbox/Heizstab/
 * generischer Verbraucher) during onboarding - reuses the E1b entity CRUD
 * (`entitiesApi.create`). PV/Speicher/Netz come from the Register/Gerät steps
 * + the bootstrap, so only consumer types are offered here.
 */
function ConsumerAddRow({
  siteId,
  catalog,
  onAdded,
}: {
  siteId: string;
  catalog: EntityTypeDef[];
  onAdded: () => void | Promise<void>;
}) {
  const types = creatableConsumerTypes(catalog);
  const [open, setOpen] = useState(false);
  const [entityType, setEntityType] = useState('');
  const [label, setLabel] = useState('');
  const [maxPowerKw, setMaxPowerKw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!entityType && types.length > 0) setEntityType(types[0].type);
  }, [types, entityType]);

  if (types.length === 0) return null;

  async function add() {
    if (busy || !entityType) return;
    const power = maxPowerKw.trim() === '' ? undefined : Number(maxPowerKw.replace(',', '.'));
    if (power !== undefined && (Number.isNaN(power) || power < 0)) {
      setErr('Bitte geben Sie eine gültige Leistung in kW an.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await entitiesApi.create(siteId, {
        entityType,
        label: label.trim() || undefined,
        maxPowerKw: power,
      });
      setLabel('');
      setMaxPowerKw('');
      setOpen(false);
      await onAdded();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Der Verbraucher konnte nicht angelegt werden.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="vp-linklike" onClick={() => setOpen(true)}>
        <Icon name="plus" size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
        Verbraucher hinzufügen
      </button>
    );
  }

  return (
    <div className="vp-onb-add">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <label htmlFor="onb-consumer-type" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
          Verbraucher-Typ
        </label>
        <select
          id="onb-consumer-type"
          className="vp-select"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
        >
          {types.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <Input
        label="Bezeichnung (optional)"
        placeholder="z. B. Wallbox Carport"
        value={label}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
      />
      <Input
        label="Leistung (kW, optional)"
        placeholder="z. B. 11"
        inputMode="decimal"
        value={maxPowerKw}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaxPowerKw(e.target.value)}
      />
      <div className="vp-field-row">
        <Button variant="outline" onClick={add} disabled={busy}>
          {busy ? 'Füge hinzu…' : 'Hinzufügen'}
        </Button>
        <button type="button" className="vp-linklike vp-linklike-quiet" onClick={() => setOpen(false)}>
          Abbrechen
        </button>
      </div>
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
    </div>
  );
}

/**
 * Step 4 · Gerät: connect the VoltPilot device by its Geräte-ID. Skippable -
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
      <p className="vp-note">
        Wechselrichter, Erzeuger und Verbraucher richten Sie direkt am Gerät ein – auf der
        Geräteseite „Meine Anlage". Hier im Portal verbinden Sie das Gerät nur mit Ihrem Konto.
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
        {busy ? 'Verbinde…' : 'Anlage anlegen'}
      </Button>
      <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
        <button type="button" className="vp-linklike" onClick={onSkip}>
          Gerät habe ich noch nicht - später
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
        {/* M5 (#533): die Übergabe in den Einrichtungspfad - der Assistent legt
            die Anlage an, die Anlagen-Seite führt die Kette zu Ende. */}
        <p className="vp-note" style={{ marginTop: 8 }}>{SETUP_NEXT_HINT}</p>
        <Button variant="primary" size="lg" fullWidth onClick={onDone} style={{ marginTop: 12 }}>
          Zur Anlage
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
 * summary of what was created - PV, Speicher, Gerät and the source - never
 * pretending a skipped step happened.
 */
function SummaryStep({
  site,
  claimed,
  pvApplied,
  storageApplied,
  manualBatterySaved,
  autoStart,
  onDone,
}: {
  site: Site;
  claimed: Device | null;
  pvApplied: MastrPreview | null;
  storageApplied: MastrPreview | null;
  manualBatterySaved: boolean;
  autoStart: AutoStartOutcome | null;
  onDone: () => void;
}) {
  const fromRegistry = pvApplied != null || storageApplied != null;
  const autoStartLine = autoStartSummary(autoStart);
  return (
    <div className="vp-onboarding-step" style={{ textAlign: 'center' }}>
      <div className="vp-success-mark" aria-hidden="true">
        <Icon name="check" size={26} strokeWidth={2.5} />
      </div>
      <h3>Anlage „{site.name}“ ist da</h3>
      <dl className="vp-summary-list">
        {pvApplied && <SummaryRow k="PV" v={mastrPvSummary(pvApplied)} />}
        {storageApplied ? (
          <SummaryRow k="Speicher" v={mastrStorageSummary(storageApplied)} />
        ) : (
          manualBatterySaved && <SummaryRow k="Speicher" v="manuell hinterlegt" />
        )}
        <SummaryRow k="Gerät" v={claimed ? claimed.externalRef : 'später verbinden'} />
        {fromRegistry && <SummaryRow k="Quelle" v="Marktstammdaten" />}
      </dl>
      {autoStartLine && (
        <p className="vp-note" style={{ marginTop: 12 }}>
          {autoStartLine}
        </p>
      )}
      {!claimed && (
        <p className="vp-note" style={{ marginTop: 12 }}>
          Sie können das Gerät jederzeit nachholen - auf der Anlagen-Seite unter „Technik &amp;
          Einstellungen".
        </p>
      )}
      {/* M5 (#533): die Übergabe in den Einrichtungspfad. */}
      <p className="vp-note" style={{ marginTop: 12 }}>{SETUP_NEXT_HINT}</p>
      <Button variant="primary" size="lg" fullWidth onClick={onDone} style={{ marginTop: 16 }}>
        Zur Anlage
      </Button>
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="vp-summary-row">
      <dt>{k}</dt>
      <dd className="vp-mono">{v}</dd>
    </div>
  );
}
