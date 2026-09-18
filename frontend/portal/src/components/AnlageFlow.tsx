import { Recht } from './Recht';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  type SupplyPriceUpdate,
  type TarifArt,
  type Funktionen,
} from '../api';
import { VERAEUSSERUNGSFORM_FRAGE, VERAEUSSERUNGSFORM_LABEL } from '../glossar';
import { standortWaehlenSatz, standortWahl, standortWahlHinweis, type StandortWahl } from '../anlageStandort';
import { alsOrtFehler } from '../standorte';
import { showTechnicalLayer } from '../rollen';
import { entitiesApi, type EntityTypeDef } from '../entitiesApi';
import {
  creatableConsumerTypes,
  entitiesRecognisedSummary,
  entityGroupLabel,
} from '../adaptiveOnboarding';
import {
  PRESETS,
  REGAL,
  anwendung,
  betriebsmodellVorschlag,
  exklusivGeschwister,
  istAbschaltbar,
  presetSchaltplan,
  type Profil,
  type Zurueckgestellt,
} from '../anwendungen';
import { anwendungenSatz } from '../anwendungen';
import type { SiteProfile } from '../profiles';
import './Profile.css';
import './AnwendungenStep.css';
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
import { VpPicker } from './VpPicker';
import { TariffFields } from './TariffFields';
import { StandortZuerst } from './StandortZuerst';
import { HelpLink } from '../help/HelpProvider';
import { helpForSetupStep } from '../help/context';
import type { Route } from '../nav';
import {
  anlegeArt,
  anlegeSchritte,
  anlegeStandort,
  ERSTE_DATEN_NUR_MESSEN,
  messstellenZiel,
  nurMessenWeiterSatz,
  ZU_DEN_MESSSTELLEN,
  type AnlegeArt,
} from '../anlegeNurMessen';
import {
  buildSupplyPricePatch,
  showSupplyPriceFields,
  supplyPriceFormValues,
  type SupplyPriceFormValues,
} from '../supplyPrice';
import type { PriceMode } from '../tariffInput';

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

function StepsRail({ current, schritte }: { current: number; schritte: readonly string[] }) {
  return (
    <ol className="vp-steps">
      {schritte.map((label, i) => {
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
  kopf,
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
  /**
   * The flow is finished or deliberately left - host closes/returns. Im Modus
   * „nur messen“ nennt der Knopf „Zu den Messstellen“ sein Ziel; ohne Ziel wie heute.
   */
  onDone: (ziel?: Route) => void;
  /** Wizard only: "Später einrichten" leaves the whole flow. */
  onSkipAll?: () => void;
  /**
   * Was der Wirt über dem Fluss zeigt, abhängig von den Schritten, die er wirklich hat
   * (Einrichtungs-Assistent: „In vier Schritten …“). `null`, solange die Art offen ist.
   */
  kopf?: (schritte: readonly string[] | null) => ReactNode;
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
  // Welche Anwendungen der Assistent eingeschaltet hat (für die Zusammenfassung).
  const [eingeschaltet, setEingeschaltet] = useState<string[]>([]);
  const [step, setStep] = useState<number>(initialFlowStep(sites.length > 0));
  // Steuern-Regel im Anlege-Fluss (`anlegeNurMessen.ts`): die Funktionen IN der
  // Entscheidung laden — `undefined`, solange sie unterwegs sind (dann fehlen
  // Geld-Block und „Betrieb“, statt aufzublitzen); bei einem Fehler bleibt die
  // Entscheidung ebenso offen.
  // Der Standort kommt aus Schritt 1, nach dem Anlegen steht die Art fest.
  const [funktionen, setFunktionen] = useState<Funktionen | null | undefined>(undefined);
  const [funktionenRunde, setFunktionenRunde] = useState(0);
  const [standortId, setStandortId] = useState<string | null>(null);
  const [artBeimAnlegen, setArtBeimAnlegen] = useState<AnlegeArt | null>(null);
  useEffect(() => {
    let aktiv = true;
    api.funktionen().then(
      (f) => {
        if (aktiv) setFunktionen(f);
      },
      () => {
        if (aktiv) setFunktionen(null);
      },
    );
    return () => {
      aktiv = false;
    };
  }, [funktionenRunde]);
  // Die neue Anlage steht noch nicht in den Funktionen — nach dem Anlegen zählt ihr Standort.
  const ort = createdHere
    ? { standortId, hatAnlage: true }
    : { standortId, anlageId: site?.id ?? null, hatAnlage: sites.length > 0 || (existingSites?.length ?? 0) > 0 };
  const art: AnlegeArt | null = artBeimAnlegen ?? (funktionen === undefined ? null : anlegeArt(funktionen, ort));
  const nurMessen = art === 'nur_messen';
  const schritte = anlegeSchritte(art);
  const messStandort = nurMessen ? anlegeStandort(funktionen ?? null, ort) : null;
  const messenEnde: NurMessenEnde | null = nurMessen
    ? { satz: nurMessenWeiterSatz(messStandort), ziel: messstellenZiel(messStandort) }
    : null;

  const locationSites = existingSites ?? sites;
  // Im Modus „nur messen“ endet der Fluss nach dem Gerät — „Betrieb“ gehört zum Steuern.
  const finished = step > (nurMessen ? schritte.length : FLOW_STEPS.length);

  return (
    <>
      {kopf?.(art === null ? null : schritte)}
      <div className="vp-anlage-flow">
        <StepsRail current={step} schritte={schritte} />
        <div className="vp-context-help"><HelpLink article={helpForSetupStep(finished ? FLOW_STEPS.length + 1 : step)}>Hilfe zu diesem Schritt</HelpLink></div>
        {step === 1 && art === 'standort_zuerst' && (
          <StandortZuerst
            onGespeichert={(id) => {
              setStandortId(id);
              setFunktionen(undefined);
              setFunktionenRunde((runde) => runde + 1);
            }}
          />
        )}
        {step === 1 && art !== null && art !== 'standort_zuerst' && (
          <AnlageStep
            locationSites={locationSites}
            mitGeld={art === 'wie_heute'}
            onStandort={setStandortId}
            onCreated={(s) => {
              setSite(s);
              setCreatedHere(true);
              if (art) setArtBeimAnlegen(art);
              onSiteCreated?.(s);
              setStep(2);
            }}
          />
        )}
        {step === 1 && art === null && (
          <p className="vp-note" aria-busy={funktionen === undefined}>
            {funktionen === undefined
              ? 'Der nächste Schritt wird vorbereitet …'
              : 'Der nächste Schritt konnte nicht geladen werden.'}
          </p>
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
        {step === 4 && site && !nurMessen && (
          <AnwendungenStep
            site={site}
            onNext={(ids) => {
              setEingeschaltet(ids);
              setStep(5);
            }}
          />
        )}
        {finished &&
          site &&
          (waitForFirstData && claimed ? (
            <FirstDataStep siteId={site.id} onDone={onDone} messen={messenEnde} />
          ) : (
            <SummaryStep
              site={site}
              claimed={claimed}
              pvApplied={pvApplied}
              storageApplied={storageApplied}
              manualBatterySaved={manualBatterySaved}
              eingeschaltet={eingeschaltet}
              onDone={onDone}
              messen={messenEnde}
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
    </>
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
  mitGeld,
  onStandort,
  onCreated,
}: {
  locationSites: Site[];
  /**
   * Steuern-Regel im Anlege-Fluss: Veräußerungsform und Feineinstellungen stehen nur,
   * wenn der Fluss wie heute spricht — nicht im Modus „nur messen“ und nicht, solange
   * das noch nicht feststeht. Was nicht zu sehen war, wird nicht gesendet.
   */
  mitGeld: boolean;
  /** Der gewählte oder vorbelegte Standort — an ihm entscheidet der Fluss. */
  onStandort: (standortId: string | null) => void;
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
  // Structured Bezugspreis-Komponenten (Stufe 2): prefilled with the researched
  // suggestions but only PERSISTED when the operator actually edits them, so a
  // create that leaves Feineinstellungen untouched never activates the sheet.
  const [supply, setSupply] = useState<SupplyPriceFormValues>(() =>
    supplyPriceFormValues(null),
  );
  // E2/D3: die ausdrückliche Wahl statt eines stillen „berührt"-Flags. Ein
  // Anlege-Vorgang startet auf „Schnell" - die Vorschlagswerte bleiben ein
  // Prefill und werden erst zum gepflegten Preisblatt, wenn der Betreiber
  // „Genau" WÄHLT.
  const [priceMode, setPriceMode] = useState<PriceMode>('schnell');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // UEMS AP-02 IP-8: der Standort der neuen Anlage — vorbelegt bei genau einem,
  // zur Wahl bei mehreren. Ohne Standort-Objekt (oder unlesbar) kein Picker und
  // kein `standortId`: der Schritt bleibt, wie er war (AnlageFlow.standort.test.tsx).
  const [standortAuswahl, setStandortAuswahl] = useState<StandortWahl | null>(null);
  const [standortId, setStandortId] = useState<string | null>(null);
  const [standortFehler, setStandortFehler] = useState<string | null>(null);
  const [standorteRunde, setStandorteRunde] = useState(0);

  useEffect(() => {
    let aktiv = true;
    api
      .standorte()
      .then((antwort) => {
        if (!aktiv) return;
        const wahl = standortWahl(antwort);
        setStandortAuswahl(wahl);
        setStandortId(wahl?.vorbelegt ?? null);
        onStandort(wahl?.vorbelegt ?? null);
      })
      .catch(() => {
        // Unlesbar: kein Picker. Bei genau einem Standort ordnet der Server selbst zu,
        // bei mehreren antwortet er 422 mit seinem Satz (siehe `submit`).
      });
    return () => {
      aktiv = false;
    };
  }, [standorteRunde]);

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
    if (standortAuswahl && !standortId) {
      setStandortFehler(standortWaehlenSatz(standortAuswahl.optionen.length));
      document.getElementById('flow-standort')?.focus();
      return;
    }
    // Steuern-Regel im Anlege-Fluss: ohne Geld-Block gilt, was ein unberührter Block
    // sendet — nie ein Wert, den der Kunde nicht sehen konnte (etwa nach dem Wechsel
    // zu einem Standort, der nur misst).
    const kind: PlantKind = mitGeld ? plantKind : 'eigenverbrauch';
    const tarif: TarifArt = mitGeld ? tarifArt : 'ohne';
    const praemieValue = kind === 'direktvermarktung' ? parsePremiumInput(praemie) : null;
    if (praemieValue === undefined) {
      setErr('Bitte geben Sie den anzulegenden Wert als Zahl in ct/kWh an, z. B. 8,11.');
      return;
    }
    const tarifParamValue = tarif === 'ohne' ? null : parsePremiumInput(tarifParam);
    if (tarifParamValue === undefined) {
      setErr(
        tarif === 'dynamisch'
          ? 'Bitte geben Sie den Aufschlag als Zahl in ct/kWh an, z. B. 18.'
          : 'Bitte geben Sie Ihren Arbeitspreis als Zahl in ct/kWh an, z. B. 32,5.',
      );
      return;
    }
    const maxFeedInValue = mitGeld ? parseFeedInCapInput(maxFeedIn) : null;
    if (maxFeedInValue === undefined) {
      setErr('Bitte geben Sie die maximale Einspeiseleistung als Zahl in kW an, z. B. 75.');
      return;
    }
    // Only persist the supply-price sheet when the operator CHOSE „Genau" and
    // the Tarif-Art uses it (dynamisch/ohne) - the prefilled suggestions stay a
    // prefill, never an auto-activated sheet.
    let supplyPatch: SupplyPriceUpdate | null = null;
    if (mitGeld && priceMode === 'genau' && showSupplyPriceFields(tarif)) {
      const built = buildSupplyPricePatch(supply);
      if ('error' in built) {
        setErr(built.error);
        return;
      }
      supplyPatch = built.patch;
    }
    setBusy(true);
    setErr(null);
    try {
      const site = await api.createSite({
        name: name.trim(),
        biddingZone: zone,
        latitude: lat,
        longitude: lon,
        plantKind: kind,
        anzulegenderWertCtKwh: praemieValue,
        tarifArt: tarif,
        tarifParamCtKwh: tarifParamValue,
        netzladenErlaubt: mitGeld && netzladen,
        maxFeedInKw: maxFeedInValue,
        ...(standortId ? { standortId } : {}),
      });
      if (supplyPatch) {
        // Best-effort: the site exists; a sheet write failure must not block
        // onboarding (the operator can maintain it later under Marktoptimierung).
        try {
          await api.updateSupplyPrice(site.id, supplyPatch);
        } catch {
          /* non-fatal */
        }
      }
      onCreated(site);
    } catch (e) {
      const abgelehnt = e instanceof ApiError ? alsOrtFehler(e.body) : null;
      const code: string | undefined = abgelehnt?.code;
      if (abgelehnt && code === 'standort_waehlen') {
        // Der Server kennt mehrere Standorte, die Auswahl hier (noch) nicht: sein Satz an den Picker, Auswahl neu lesen.
        setStandortFehler(abgelehnt.message);
        setStandorteRunde((r) => r + 1);
        return;
      }
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
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
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
        {standortAuswahl && (
          <VpPicker
            id="flow-standort"
            label="Standort *"
            placeholder="Standort wählen"
            options={standortAuswahl.optionen}
            value={standortId}
            onChange={(v) => {
              setStandortId(v);
              setStandortFehler(null);
              onStandort(v);
            }}
            hint={standortWahlHinweis(standortAuswahl, standortId) ?? undefined}
            error={standortFehler}
          />
        )}
        {reusable.length > 0 && (
          <div className="vp-reuse-loc">
            <span className="vp-reuse-loc-lbl">Gleicher Standort wie</span>
            <div className="vp-reuse-loc-chips">
              {reusable.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="vp-chip-action"
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
        {/* Steuern-Regel im Anlege-Fluss: im Modus „nur messen“ gibt es diesen Teil nicht. */}
        {mitGeld && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <VpPicker
                id="flow-plant-kind"
                label={VERAEUSSERUNGSFORM_LABEL}
                options={[
                  { value: 'eigenverbrauch', label: 'Eigenverbrauch (Haushalt/Gewerbe)' },
                  {
                    value: 'direktvermarktung',
                    label: 'Direktvermarktung (Einspeisung am Markt)',
                  },
                ]}
                value={plantKind}
                onChange={(v) => setPlantKind(v as PlantKind)}
              />
              <p className="vp-note" style={{ margin: 0 }}>
                {VERAEUSSERUNGSFORM_FRAGE} Sie bestimmt auch, wie Ihr Vorteil erzählt wird:
                „gespart" beim Eigenverbrauch, „mehr verdient" bei der Direktvermarktung.
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
                  später unter „Einstellungen".
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
                  supplyValues={supply}
                  onSupplyChange={(field, value) => setSupply((s) => ({ ...s, [field]: value }))}
                  priceMode={priceMode}
                  onPriceMode={setPriceMode}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <VpPicker
                    id="flow-netzladen"
                    label="Netzladen des Speichers"
                    options={[
                      { value: 'verboten', label: 'Verboten - EEG-Anlage (nur Solarladen)' },
                      { value: 'erlaubt', label: 'Erlaubt - Speicher darf aus dem Netz laden' },
                    ]}
                    value={netzladen ? 'erlaubt' : 'verboten'}
                    onChange={(v) => setNetzladen(v === 'erlaubt')}
                  />
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
          </>
        )}
      </div>
      <Recht aktion="anlage.verwalten"><Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={submit}
        disabled={busy}
        style={{ marginTop: 20 }}
      >
        {busy ? 'Lege Anlage an…' : 'Weiter'}
      </Button></Recht>
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
        <Recht aktion="anlage.verwalten"><Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={apply}
          disabled={busy}
          style={{ marginTop: 8 }}
        >
          {busy ? 'Wird übernommen…' : 'Übernehmen & weiter'}
        </Button></Recht>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
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
      <Recht aktion="geraet.einrichten"><Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={submit}
        disabled={busy}
        style={{ marginTop: 20 }}
      >
        {busy ? 'Speichere…' : 'Speicher speichern'}
      </Button></Recht>
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
 * Der Satz, der den Schritt schliesst (Konzept §3.9): der Assistent legt keine
 * Regeln an, und er verschweigt das nicht — er sagt, wo sie entstehen.
 */
export const REGELN_SPAETER =
  'Regeln legen Sie später in der Steuerung an - VoltPilot macht Ihnen Vorschläge.';

/**
 * Der ehrliche Satz eines Profils OHNE Betriebsmodell (Privat, und jede Anlage,
 * deren Voraussetzungen fehlen). Der Eigenverbrauchs-Fahrplan ist seit dem
 * 29.07.2026 GRUNDVERHALTEN, kein Modus — er wird deshalb benannt, nicht als
 * Schalter angeboten.
 */
export const KEIN_BETRIEBSMODELL =
  'Ohne Betriebsmodell fährt Ihr Speicher den Eigenverbrauchs-Fahrplan: '
  + 'möglichst viel eigener Strom im Haus.';

/**
 * Schritt 4 · **Betrieb** (Anwendungs-Programm Stufe 2, verengt durch Steuerung
 * Stufe 0 „Entwirrung", Konzept `vp-steuerung-konzept-b3` §3.9). Vier Blöcke,
 * alle überspringbar:
 *
 *  - **Ihre Geräte** — was der SERVER aus den Stammdaten komponiert hat, sobald
 *    Schritt „Gerät" das Gerät beansprucht hat. Read-only für den Kunden.
 *  - **Wofür ist diese Anlage?** — die zwei PRESET-Karten (Privat · Gewerbe)
 *    plus „Später entscheiden". Die Wahl schreibt `site.profil` und ist damit
 *    Vorauswahl + Tonalität + Reset-Basis; sie ist NIE ein Signal der
 *    Ableitung (Captain-Entscheid E3).
 *  - **Ihr Betriebsmodell** — GENAU EINES, aus dem Preset abgeleitet, oder
 *    keins („Privat: Ihr Speicher fährt den Eigenverbrauchs-Fahrplan"). Sein
 *    Schalter ist ein `PUT /profiles`, also öffnet der SERVER das Tor und sät
 *    den Starter — **für jeden Kunden**, nicht mehr nur für einen Admin (das
 *    war die stille Lücke: `entitiesApi.autoStart` lief hinter einem
 *    `if (admin)`, ein Kunde bekam also nie einen Start-Flow).
 *  - **Umgang mit dem Speicher** — die Speicherschonung, unverändert.
 *
 * ⚠ **Das neunzeilige Regal ist aus dem Assistenten VERSCHWUNDEN** (Stufe 0):
 * es zeigte Basis-Schalter, die der Server mit 400 ablehnt, und
 * Regel-Schalter, die nichts auslösen — und wiederholte damit genau die
 * Verwirrung, die die Steuerungs-Seite hatte. Regeln entstehen später in der
 * Steuerung, mit Vorschlägen; der Assistent sagt das in einem Satz
 * ({@link REGELN_SPAETER}).
 *
 * ⚠ Der frühere AE7-Vorwahl-Block („Womit sollen wir starten?") ist ERSATZLOS
 * entfallen: er schrieb `usage_profile_override`, eine Spalte, die seit F5
 * keine Kundenfläche mehr liest — für einen Kunden war die Wahl damit fast
 * wirkungslos. Die Spalte bleibt lesbar, das Portal schreibt sie nicht mehr
 * (`migration.test.ts` wacht darüber).
 *
 * Alle Regeln liegen rein in `../anwendungen`; diese Komponente verdrahtet und
 * rendert nur.
 */
function AnwendungenStep({
  site,
  onNext,
}: {
  site: Site;
  onNext: (eingeschaltet: string[]) => void;
}) {
  const [battery, setBattery] = useState<SiteAsset | null>(null);
  const [schonung, setSchonung] = useState<SpeicherschonungPreset>('ausgewogen');
  const [entities, setEntities] = useState<SiteEntity[]>([]);
  const [catalog, setCatalog] = useState<EntityTypeDef[]>([]);
  /** Das Regal, wie der Server es sieht; null = noch nicht geladen. */
  const [karten, setKarten] = useState<SiteProfile[] | null>(null);
  const [profil, setProfil] = useState<Profil | null>(site.profil ?? null);
  const [getickt, setGetickt] = useState<ReadonlySet<string>>(new Set());
  // Was der Kunde AUSDRÜCKLICH will (Preset-Vorauswahl + jeder von Hand
  // eingeschaltete Schalter). Nur das wird geschrieben - wer den Schritt bloß
  // durchklickt, pinnt keine Absicht, die er nie geäußert hat.
  const [gewollt, setGewollt] = useState<ReadonlySet<string>>(new Set());
  /**
   * ⚠ Was der Schritt ANBIETET — es wächst, es schrumpft nie. Ohne dieses Set
   * verschwände die Radiogruppe in dem Moment, in dem der Kunde „Kein
   * Betriebsmodell" wählt (die Zeile stand nur, weil sie vorgeschlagen war),
   * und mit ihr der Weg zurück: eine Abwahl wäre endgültig.
   */
  const [angeboten, setAngeboten] = useState<ReadonlySet<string>>(new Set());
  const [zurueckgestellt, setZurueckgestellt] = useState<Zurueckgestellt | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Hat der Kunde ein Preset angefasst? Nur dann wird `site.profil` geschrieben
  // - „Später entscheiden" ist eine Wahl, ein unberührter Schritt nicht.
  const profilBeruehrt = useRef(false);

  const admin = showTechnicalLayer();

  // Die Batterie, die Register-/Handeingabe gerade angelegt hat (oder keine).
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

  const loadEntities = () =>
    api.siteEntities(site.id).then(
      (d) => setEntities(d.entities),
      () => setEntities([]),
    );

  useEffect(() => {
    let active = true;
    async function run() {
      const [d, regal] = await Promise.all([
        api.siteEntities(site.id).then((x) => x.entities).catch(() => [] as SiteEntity[]),
        api.siteProfiles(site.id).then((r) => r.profiles).catch(() => null),
      ]);
      if (!active) return;
      setEntities(d);
      setKarten(regal);
      // Der Ausgangszustand ist die SERVER-Wahrheit, nie eine Vorbelegung:
      // was schon läuft, bleibt an, alles andere aus.
      if (regal) {
        setGetickt(new Set(aktiveIds(regal)));
        setAngeboten(new Set(aktiveIds(regal)));
      }
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

  /** Die schon laufenden, SCHALTBAREN Anwendungen - sie bleiben immer getickt. */
  function aktiveIds(regal: SiteProfile[]): string[] {
    return regal.filter((k) => k.active && istAbschaltbar(k.id)).map((k) => k.id);
  }

  function waehleProfil(p: Profil | null) {
    profilBeruehrt.current = true;
    setProfil(p);
    if (!p || !karten) {
      setZurueckgestellt(null);
      return;
    }
    const vorschlag = betriebsmodellVorschlag(p, karten);
    // Die Vorauswahl WÄHLT AUS, sie schaltet nichts ab: was schon läuft, bleibt.
    const eins = vorschlag.ticken ? [vorschlag.ticken] : [];
    setGetickt(new Set([...aktiveIds(karten), ...eins]));
    setGewollt(new Set(eins));
    setAngeboten((v) => new Set([...v, ...aktiveIds(karten), ...eins]));
    setZurueckgestellt(vorschlag.zurueckgestellt);
  }

  /**
   * ⚠ **Betriebsmodelle sind EXKLUSIV** (Steuerung Stufe 5): das Einschalten
   * eines Modells nimmt jedes andere DERSELBEN Gruppe aus der Auswahl — hier
   * wie später im Regal. Der Server tut dasselbe beim Schreiben; wäre es hier
   * anders, zeigte der Assistent zwei Häkchen und der nächste Aufruf machte
   * daraus stillschweigend eines.
   *
   * `presetSchaltplan` erzeugt aus einem entfernten Häkchen genau dann ein
   * `aus`, wenn das Modell wirklich aktiv WAR — ein bloß vorgeschlagenes
   * verschwindet ohne einen Aufruf.
   */
  function toggle(id: string) {
    const an = !getickt.has(id);
    const geschwister = an ? exklusivGeschwister(id) : [];
    const anwenden = (vorher: ReadonlySet<string>): ReadonlySet<string> => {
      const next = new Set(vorher);
      if (an) {
        next.add(id);
        for (const other of geschwister) next.delete(other);
      } else {
        next.delete(id);
      }
      return next;
    };
    setGetickt(anwenden);
    setGewollt(anwenden);
  }

  /**
   * Ein Radio WÄHLT AUS — es hakt sich nicht bloß an. Der Unterschied zählt im
   * Altbestands-Fall: laufen ZWEI Modelle derselben Gruppe, sind beide angehakt,
   * und ein „nur einschalten, wenn aus"-Klick wäre auf beiden ein No-op — der
   * Kunde könnte die Anlage im Assistenten gar nicht mehr entwirren.
   */
  function waehleModell(id: string) {
    const geschwister = exklusivGeschwister(id);
    const anwenden = (vorher: ReadonlySet<string>): ReadonlySet<string> => {
      const next = new Set(vorher);
      next.add(id);
      for (const other of geschwister) next.delete(other);
      return next;
    };
    setGetickt(anwenden);
    setGewollt(anwenden);
  }

  async function next() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      // Speicherschonung: ein unberührtes „Ausgewogen" entspricht dem
      // gespeicherten Effektivwert - nur eine echte Änderung schreibt.
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
      // Das PRESET ist Vorauswahl + Tonalität; es schaltet selbst NICHTS.
      if (profilBeruehrt.current && profil !== (site.profil ?? null)) {
        await api.setAnwendungsPreset(site.id, profil);
      }
      // ... die Schalter tun das - über GENAU den Weg, den auch das Regal unter
      // „Steuerung" geht, mit denselben Server-Wirkungen (Tor öffnen, Starter
      // säen). Nacheinander, weil jeder Aufruf das Regal serverseitig neu
      // rechnet.
      const plan = karten ? presetSchaltplan([...gewollt], [...getickt], karten) : [];
      for (const schritt of plan) {
        await api.setSiteProfile(site.id, schritt.id, schritt.state);
      }
      onNext(plan.filter((p) => p.state === 'an').map((p) => p.id));
    } catch {
      setErr('Die Auswahl konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(false);
    }
  }

  const summary = entitiesRecognisedSummary(entities);
  const kartenById = new Map((karten ?? []).map((k) => [k.id, k] as const));
  // Seit Steuerung Stufe 0 zeigt der Schritt NUR Betriebsmodelle: das
  // vorgeschlagene plus jedes, das auf dieser Anlage schon läuft (es zu
  // verschweigen hiesse, ihren Funktionsumfang vor ihr zu verbergen).
  const zeilenIds = REGAL.filter(
    (a) => angeboten.has(a.id) || getickt.has(a.id) || kartenById.get(a.id)?.active,
  ).map((a) => a.id);
  // Gezeigte Modelle DER Exklusivitäts-Gruppe — nur mit ihnen gibt es eine
  // Radiogruppe und damit eine Zeile „Kein Betriebsmodell".
  const exklusiveIds = zeilenIds.filter((id) => anwendung(id)?.exklusiv_gruppe != null);
  const hatExklusive = exklusiveIds.length > 0;
  const exklusiveGetickt = exklusiveIds.filter((id) => getickt.has(id));
  const keinsGewaehlt = exklusiveGetickt.length === 0;

  const zeile = (id: string) => {
    const def = anwendung(id);
    const karte = kartenById.get(id);
    // Ein Katalog-Eintrag, den DIESER Server nicht kennt, wird nicht gezeigt -
    // ein Schalter ohne Gegenstück wäre eine Zusage, die niemand einlöst.
    if (!def || !karte) return null;
    const an = getickt.has(id);
    const exklusiv = def.exklusiv_gruppe != null;
    return (
      <li key={id} className="vp-anw-row">
        <span className="vp-anw-main">
          <span className="vp-anw-label">{def.label}</span>
          <span className="vp-anw-benefit">{def.nutzen}</span>
        </span>
        {/* ⚠ Ein EXKLUSIVES Modell ist ein Radio, ein gruppenloses ein Schalter -
            dieselbe Grammatik wie im Regal unter „Steuerung". */}
        {exklusiv ? (
          <button
            type="button"
            role="radio"
            aria-checked={an}
            aria-label={def.label}
            className={`vp-anw-radio${an ? ' on' : ''}`}
            onClick={() => waehleModell(id)}
          />
        ) : (
          <Recht aktion="betriebsweise.aendern"><button
            type="button"
            role="switch"
            aria-checked={an}
            aria-label={`${def.label} ${an ? 'ausschalten' : 'einschalten'}`}
            className={`vp-switch${an ? ' on' : ''}`}
            onClick={() => toggle(id)}
          >
            <span className="vp-switch-knob" aria-hidden="true" />
          </button></Recht>
        )}
      </li>
    );
  };

  return (
    <div className="vp-onboarding-step">
      <h3>Wofür ist diese Anlage?</h3>
      <p className="vp-muted">
        Daraus schlagen wir vor, wie Ihr Speicher arbeitet. Sie können alles später jederzeit
        auf der Anlagen-Seite ändern.
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
        <h4 className="vp-onb-block-title">Profil</h4>
        <fieldset className="vp-schonung">
          <legend className="vp-visually-hidden">Profil dieser Anlage</legend>
          {PRESETS.map((o) => (
            <label
              key={o.id}
              className={'vp-schonung-opt' + (profil === o.id ? ' selected' : '')}
            >
              <input
                type="radio"
                name="anwendungen-profil"
                value={o.id}
                checked={profil === o.id}
                onChange={() => waehleProfil(o.id)}
              />
              <span className="vp-schonung-main">
                <span className="vp-schonung-label">{o.label}</span>
                <span className="vp-schonung-sentence">{o.satz}</span>
              </span>
            </label>
          ))}
          <label className={'vp-schonung-opt' + (profil === null ? ' selected' : '')}>
            <input
              type="radio"
              name="anwendungen-profil"
              value=""
              checked={profil === null}
              onChange={() => waehleProfil(null)}
            />
            <span className="vp-schonung-main">
              <span className="vp-schonung-label">Später entscheiden</span>
              <span className="vp-schonung-sentence">
                Wir schlagen dann nichts vor - Sie wählen später selbst.
              </span>
            </span>
          </label>
        </fieldset>
      </section>

      {karten && karten.length > 0 && (
        <section className="vp-onb-block">
          <h4 className="vp-onb-block-title">Ihr Betriebsmodell</h4>
          {zeilenIds.length > 0 ? (
            <ul
              className="vp-anw-list"
              {...(hatExklusive
                ? { role: 'radiogroup' as const, 'aria-label': 'Ihr Betriebsmodell' }
                : {})}
            >
              {zeilenIds.map(zeile)}
              {/* Der Grundmodus IST der Weg zurück: ein Radio kann sich nicht
                  selbst abwählen, also braucht die Gruppe diese Zeile. */}
              {hatExklusive && (
                <li key="__keins" className="vp-anw-row">
                  <span className="vp-anw-main">
                    <span className="vp-anw-label">Kein Betriebsmodell</span>
                    <span className="vp-anw-benefit">{KEIN_BETRIEBSMODELL}</span>
                  </span>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!keinsGewaehlt ? false : true}
                    aria-label="Kein Betriebsmodell"
                    className={`vp-anw-radio${keinsGewaehlt ? ' on' : ''}`}
                    onClick={() => exklusiveGetickt.forEach((id) => toggle(id))}
                  />
                </li>
              )}
            </ul>
          ) : (
            <p className="vp-note" style={{ marginTop: 0 }}>
              {KEIN_BETRIEBSMODELL}
            </p>
          )}
          {zurueckgestellt && (
            <p className="vp-note vp-anw-zurueck">
              {`${zurueckgestellt.label} schlagen wir noch nicht vor: `
                + `${zurueckgestellt.fehlend.join(' und ')} fehlt.`}
            </p>
          )}
          <p className="vp-note" style={{ marginTop: 8 }}>{REGELN_SPAETER}</p>
        </section>
      )}

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

      <Recht aktion="betriebsweise.aendern"><Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={next}
        disabled={busy}
        style={{ marginTop: 20 }}
      >
        {busy ? 'Speichere…' : 'Weiter'}
      </Button></Recht>
      <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
        <button type="button" className="vp-linklike" onClick={() => onNext([])}>
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
      <VpPicker
        id="onb-consumer-type"
        label="Verbraucher-Typ"
        options={types.map((t) => ({ value: t.type, label: t.label }))}
        value={entityType}
        onChange={setEntityType}
      />
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
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
        {multiSite && (
          <VpPicker
            id="flow-site"
            label="Anlage"
            options={sites.map((s) => ({ value: s.id, label: s.name }))}
            value={site.id}
            onChange={(v) => {
              const next = sites.find((s) => s.id === v);
              if (next) onSiteChange(next);
            }}
            searchPlaceholder="Anlage suchen …"
          />
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
      <Recht aktion="geraet.einrichten"><Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={submit}
        disabled={busy}
        style={{ marginTop: 20 }}
      >
        {busy ? 'Verbinde…' : 'Anlage anlegen'}
      </Button></Recht>
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
export function FirstDataStep({
  siteId,
  onDone,
  messen = null,
}: {
  siteId: string;
  onDone: (ziel?: Route) => void;
  /** Modus „nur messen“: Satz und Ziel des Endes (`anlegeNurMessen.ts`). */
  messen?: NurMessenEnde | null;
}) {
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
        {messen ? (
          <p className="vp-muted">{ERSTE_DATEN_NUR_MESSEN}</p>
        ) : (
          <p className="vp-muted">
            Ihr Gerät sendet Daten. Im Portal sehen Sie ab jetzt Live-Werte, Prognosen und
            den optimierten Speicher-Fahrplan Ihrer Anlage.
          </p>
        )}
        {/* M5 (#533): die Übergabe in den Einrichtungspfad - der Assistent legt
            die Anlage an, die Anlagen-Seite führt die Kette zu Ende. */}
        <p className="vp-note" style={{ marginTop: 8 }}>{messen ? messen.satz : SETUP_NEXT_HINT}</p>
        {messen ? (
          <NurMessenKnoepfe messen={messen} onDone={onDone} marginTop={12} />
        ) : (
          <Button variant="primary" size="lg" fullWidth onClick={() => onDone()} style={{ marginTop: 12 }}>
            Zur Anlage
          </Button>
        )}
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
        <button type="button" className="vp-linklike" onClick={() => onDone()}>
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
  eingeschaltet,
  onDone,
  messen,
}: {
  site: Site;
  claimed: Device | null;
  pvApplied: MastrPreview | null;
  storageApplied: MastrPreview | null;
  manualBatterySaved: boolean;
  eingeschaltet: string[];
  onDone: (ziel?: Route) => void;
  /** Modus „nur messen“: Satz und Ziel des Endes; `null` = wie heute. */
  messen: NurMessenEnde | null;
}) {
  const fromRegistry = pvApplied != null || storageApplied != null;
  const anwendungenLine = anwendungenSatz(eingeschaltet);
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
      {anwendungenLine && (
        <p className="vp-note" style={{ marginTop: 12 }}>
          {anwendungenLine}
        </p>
      )}
      {!claimed && (
        <p className="vp-note" style={{ marginTop: 12 }}>
          Sie können das Gerät jederzeit nachholen - auf der Anlagen-Seite unter „Technik &amp;
          Einstellungen".
        </p>
      )}
      {/* M5 (#533): die Übergabe in den Einrichtungspfad. */}
      <p className="vp-note" style={{ marginTop: 12 }}>{messen ? messen.satz : SETUP_NEXT_HINT}</p>
      {messen ? (
        <NurMessenKnoepfe messen={messen} onDone={onDone} marginTop={16} />
      ) : (
        <Button variant="primary" size="lg" fullWidth onClick={() => onDone()} style={{ marginTop: 16 }}>
          Zur Anlage
        </Button>
      )}
    </div>
  );
}

/** Das Ende des Modus „nur messen“: der Übergabe-Satz und das Ziel „Zu den Messstellen“. */
interface NurMessenEnde {
  satz: string;
  ziel: Route;
}

/**
 * Die Knöpfe am Ende des Modus „nur messen“: ohne Umweg zu den Messstellen — und
 * die Anlage bleibt einen Tipp entfernt. Dort liegt auch ihr Bereich „Steuerung“,
 * still und nicht angepriesen: verboten ist das Aufdrängen, nicht die Erreichbarkeit.
 */
function NurMessenKnoepfe({
  messen,
  onDone,
  marginTop,
}: {
  messen: NurMessenEnde;
  onDone: (ziel?: Route) => void;
  marginTop: number;
}) {
  return (
    <>
      <Button variant="primary" size="lg" fullWidth onClick={() => onDone(messen.ziel)} style={{ marginTop }}>
        {ZU_DEN_MESSSTELLEN}
      </Button>
      <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
        <button type="button" className="vp-linklike" onClick={() => onDone()}>
          Zur Anlage
        </button>
      </p>
    </>
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
