import { Recht } from './Recht';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, neueAnfrageKennung, type Device, type Site, type Funktionen } from '../api';
import { anlegeWeg, type AnlegeWeg } from '../anlageOrt';
import { kennungSendbar, pruefeKennung } from '../edgeRef';
import { KennungFeld } from './KennungFeld';
import { DEVICE_ID_FIELD, DEVICE_ID_TAKEN_MSG, DEVICE_ID_UNKNOWN_MSG } from '../anlageFlow';
import { VpPicker } from './VpPicker';
import { StandortZuerst } from './StandortZuerst';
import { AnlageStep, type OrtDerAnlage } from './AnlageSchritt';
import { AnlageBestaetigen } from './AnlageBestaetigen';
import { HelpLink } from '../help/HelpProvider';
import { helpForSetupStep } from '../help/context';
import { anlageRoute, type Route } from '../nav';
import { merkeErsteWerte } from '../ersteWerte';
import { isPlatformAdmin } from '../auth';
import {
  leseEntwurf,
  loescheEntwurf,
  meinEntwurfSchluessel,
  schreibeEntwurf,
  type AdressEntwurf,
  type EntwurfWirt,
  type TeileEntwurf,
} from '../anlageEntwurf';
import {
  anlegeArt,
  anlegeSchritte,
  anlegeStandort,
  messstellenZiel,
  type AnlegeArt,
} from '../anlegeNurMessen';

/**
 * DER Anlege-Fluss (Anlage-Flow a1, Konzept §5.3): drei feste Schritte, die Leiste ändert sich nie -
 * 1 · Adresse (wo die Anlage steht, `AnlageSchritt.tsx`) → 2 · Box (Kennung verbinden oder „noch nicht
 * da“) → 3 · Anlage (bestätigen, was die Box gefunden hat, oder Solar und Speicher eintragen,
 * `AnlageBestaetigen.tsx`). Danach geht es ins Cockpit, wie es heute ist (D7): kein Warte-Bildschirm,
 * keine Zusammenfassung; die einmalige Karte „Ihre Anlage ist live“ erscheint über dem Cockpit, sobald
 * die ersten Werte da sind (`ersteWerte.ts`). Der Schritt „Betrieb“ ist entfallen (D6, R14): die
 * Steuerung schlägt ihn später vor, die Einrichtungs-Karte führt dorthin. Das Register ist ein Link in
 * Schritt 3 (R4), kein eigener Schritt.
 *
 * Beide Einstiege rendern DIESE Komponente: der Einrichtungs-Assistent (erste Anlage, ganze Seite) und
 * „Anlage anlegen“ (Dialog). Der Modus „nur messen“ (`anlegeNurMessen.ts`) endet bei den Messstellen.
 */

function StepsRail({ current, schritte }: { current: number; schritte: readonly string[] }) {
  return (
    <ol className="vp-steps">
      {schritte.map((label, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'active' : 'todo';
        return (
          <li key={label} className={`vp-step vp-step-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
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

export type FlowStep = 1 | 2 | 3;

export function AnlageFlow({
  wirt,
  sites,
  existingSites,
  onSiteCreated,
  onDone,
  onSkipAll,
  kopf,
  standortId: vorwahl = null,
  zurueck = false,
  vorschlagKennung = null,
}: {
  /** Wer den Fluss zeigt - der Entwurf (F9) gilt nur für denselben Wirt. */
  wirt: EntwurfWirt;
  /** Die Anlagen des Kunden: mit einer Anlage setzt der Assistent bei der Box fort. */
  sites: Site[];
  /**
   * All of the customer's Anlagen for the "gleicher Standort wie …" reuse
   * affordance in the Anlage step. Defaults to `sites`; the drawer passes the
   * real list even though it starts a fresh flow with `sites={[]}`.
   */
  existingSites?: Site[];
  /** Fired the moment the Anlage row exists (host refreshes on close). */
  onSiteCreated?: (site: Site) => void;
  /**
   * Der Fluss ist fertig oder wird verlassen - der Wirt schließt. Das Ziel ist die neue Anlage (ihr
   * Cockpit), im Modus „nur messen“ ihre Messstellen; ohne Ziel bleibt der Wirt, wo er ist.
   */
  onDone: (ziel?: Route) => void;
  /** Wizard only: "Später einrichten" leaves the whole flow. */
  onSkipAll?: () => void;
  /**
   * Was der Wirt über dem Fluss zeigt, abhängig von den Schritten, die er wirklich hat
   * (Einrichtungs-Assistent: „In drei Schritten …“). `null`, solange die Art offen ist.
   */
  kopf?: (schritte: readonly string[] | null) => ReactNode;
  /**
   * Der Standort, an dem die Anlage entstehen soll — vorbelegt vom Assistenten
   * „Messen & Auswerten“ (Knopf „Messanlage anlegen“) oder von „Hinzufügen › Anlage“
   * im Aufbau eines Standorts (UEMS AP-02 IP-9). Kein Schalter: der Modus folgt
   * weiter dem Fakt dieses Standorts (`anlegeArt`), und der Kunde kann ihn in Schritt 1
   * ändern. Ohne Angabe wie heute.
   */
  standortId?: string | null;
  /**
   * Kommt der Fluss aus einem Assistenten, der danach weitergeht („Messen & Auswerten“, Knopf
   * „Messanlage anlegen“): das Ende kehrt ohne Ziel dorthin zurück, der Wirt nimmt den Kunden wieder auf.
   */
  zurueck?: boolean;
  /**
   * Die Referenz aus dem Direktlink vom Gehäuse (`koppelLink.ts`): steht im Schritt „Box“ im Feld,
   * solange kein Entwurf eine andere getippte Kennung mitbringt. Verbunden wird erst auf Knopfdruck.
   */
  vorschlagKennung?: string | null;
}) {
  // F9 (Paket 3): der Entwurf dieses Tabs - nach Neuladen oder Anmeldung geht es am selben Schritt weiter,
  // mit denselben Eingaben. Ein Entwurf, dessen Anlage es nicht mehr gibt, gilt nicht.
  const [schluessel] = useState(() => meinEntwurfSchluessel());
  const [start] = useState(() => {
    const e = leseEntwurf(schluessel);
    if (!e || e.wirt !== wirt) return null;
    const anlage = e.siteId ? [...sites, ...(existingSites ?? [])].find((x) => x.id === e.siteId) ?? null : null;
    if (e.siteId && !anlage) return null;
    return { e, anlage };
  });
  const [wiederhergestellt, setWiederhergestellt] = useState(start != null);
  const [adressEntwurf, setAdressEntwurf] = useState<AdressEntwurf | null>(start?.e.adresse ?? null);
  const [kennungEntwurf, setKennungEntwurf] = useState(start?.e.kennung || vorschlagKennung || '');
  const [teileEntwurf, setTeileEntwurf] = useState<TeileEntwurf | null>(start?.e.teile ?? null);

  // Wiedereinstieg: eine Anlage ohne Box setzt bei der Box fort, eine mit Box bei Schritt 3.
  const [site, setSite] = useState<Site | null>(start?.anlage ?? sites[0] ?? null);
  const [createdHere, setCreatedHere] = useState(start?.anlage != null);
  const [mitBox, setMitBox] = useState(start?.e.mitBox ?? false);
  const [ortDerAnlage, setOrtDerAnlage] = useState<OrtDerAnlage | null>(start?.e.ort ?? null);
  const [step, setStep] = useState<FlowStep>(start?.e.schritt ?? (sites.length > 0 ? 2 : 1));
  const [wiedereinstiegBereit, setWiedereinstiegBereit] = useState(sites.length === 0 || start != null);
  useEffect(() => {
    if (sites.length === 0 || start != null) return;
    let aktiv = true;
    api.listDevices().then(
      (liste) => {
        if (!aktiv) return;
        if (liste.eintraege.some((d) => d.siteId === sites[0].id)) {
          setMitBox(true);
          setStep(3);
        }
        setWiedereinstiegBereit(true);
      },
      () => {
        if (aktiv) setWiedereinstiegBereit(true);
      },
    );
    return () => {
      aktiv = false;
    };
    // Nur beim Öffnen: der Wiedereinstieg entscheidet einmal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Steuern-Regel im Anlege-Fluss (`anlegeNurMessen.ts`): die Funktionen IN der
  // Entscheidung laden — `undefined`, solange sie unterwegs sind; bei einem Fehler
  // bleibt die Entscheidung ebenso offen.
  const [funktionen, setFunktionen] = useState<Funktionen | null | undefined>(undefined);
  const [funktionenRunde, setFunktionenRunde] = useState(0);
  const [standortId, setStandortId] = useState<string | null>(start?.e.standortId ?? vorwahl);
  const [artBeimAnlegen, setArtBeimAnlegen] = useState<AnlegeArt | null>(start?.e.art ?? null);
  // D2 (Anlage-Flow a1): Privatkunde oder Unternehmen aus der Antwort der Registrierung - `undefined`,
  // solange unterwegs; ohne Antwort (`null`, Bestand) entscheidet die Steuern-Regel wie bisher.
  const [weg, setWeg] = useState<AnlegeWeg | null | undefined>(undefined);
  useEffect(() => {
    let aktiv = true;
    api.tenantContext().then(
      (k) => aktiv && setWeg(anlegeWeg(k)),
      () => aktiv && setWeg(null),
    );
    return () => {
      aktiv = false;
    };
  }, []);
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
  // Ein Privatkunde spricht wie heute (F2: jeder Neukunde lief sonst „nur messen“) und legt seinen
  // Standort mit der Adresse in Schritt 1 an - kein Standort-Dialog vorab.
  const art: AnlegeArt | null =
    artBeimAnlegen ??
    (funktionen === undefined || weg === undefined ? null : weg === 'privat' ? 'wie_heute' : anlegeArt(funktionen, ort));
  const nurMessen = art === 'nur_messen';
  // F7: begann der Fluss mit dem Standort, bleibt er in der Leiste - abgehakt, nicht verschwunden.
  const [mitStandortSchritt, setMitStandortSchritt] = useState(false);
  useEffect(() => {
    if (art === 'standort_zuerst') setMitStandortSchritt(true);
  }, [art]);
  const schritte = anlegeSchritte(mitStandortSchritt ? 'standort_zuerst' : art);
  const leisteSchritt = art === 'standort_zuerst' ? 1 : mitStandortSchritt ? step + 1 : step;
  const locationSites = existingSites ?? sites;

  // F9: was der Kunde getippt hat, geht in den Entwurf - bei jedem Schritt und jeder Eingabe.
  useEffect(() => {
    schreibeEntwurf(schluessel, {
      v: 1,
      wirt,
      schritt: step,
      siteId: step > 1 ? site?.id ?? null : null,
      standortId,
      art: artBeimAnlegen,
      mitBox,
      ort: ortDerAnlage,
      adresse: step === 1 ? adressEntwurf : null,
      kennung: step === 2 ? kennungEntwurf : '',
      teile: step === 3 ? teileEntwurf : null,
    });
  }, [schluessel, wirt, step, site, standortId, artBeimAnlegen, mitBox, ortDerAnlage, adressEntwurf, kennungEntwurf, teileEntwurf]);

  /** Ins Cockpit der neuen Anlage (D7) - im Modus „nur messen“ zu ihren Messstellen. */
  function fertig() {
    // Nichts bleibt als Geisterzustand: der Entwurf geht mit dem Ende des Flusses.
    loescheEntwurf(schluessel);
    if (!site) return onDone();
    if (nurMessen) {
      onDone(zurueck ? undefined : messstellenZiel(anlegeStandort(funktionen ?? null, ort)));
      return;
    }
    // Die Karte „Ihre Anlage ist live“ erscheint einmal über dem Cockpit, sobald die ersten Werte da sind.
    merkeErsteWerte(site.id);
    onDone(anlageRoute(site.id));
  }

  return (
    <>
      {kopf?.(art === null ? null : schritte)}
      <div className="vp-anlage-flow">
        <StepsRail current={leisteSchritt} schritte={schritte} />
        {wiederhergestellt && (
          <p className="vp-alert vp-alert-info vp-entwurf-zurueck" role="status">
            <span>Ihre Eingaben sind wiederhergestellt.</span>
            <button type="button" className="vp-linklike" onClick={() => setWiederhergestellt(false)}>
              Ausblenden
            </button>
          </p>
        )}
        <div className="vp-context-help"><HelpLink article={helpForSetupStep(step)}>Hilfe zu diesem Schritt</HelpLink></div>
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
            weg={weg ?? null}
            vorwahl={standortId}
            onStandort={setStandortId}
            entwurf={adressEntwurf}
            onEntwurf={setAdressEntwurf}
            onCreated={(s, o) => {
              setSite(s);
              setCreatedHere(true);
              setOrtDerAnlage(o);
              if (art) setArtBeimAnlegen(art);
              onSiteCreated?.(s);
              setStep(2);
            }}
          />
        )}
        {step === 1 && art === null && (
          <p className="vp-note" aria-busy={funktionen === undefined || weg === undefined}>
            {funktionen === undefined || weg === undefined
              ? 'Der nächste Schritt wird vorbereitet …'
              : 'Der nächste Schritt konnte nicht geladen werden.'}
          </p>
        )}
        {!wiedereinstiegBereit && (
          <p className="vp-note" aria-busy="true">Der nächste Schritt wird vorbereitet …</p>
        )}
        {wiedereinstiegBereit && step === 2 && site && (
          <GeraetStep
            sites={createdHere ? [site] : locationSites}
            site={site}
            onSiteChange={setSite}
            onClaimed={() => {
              setMitBox(true);
              setStep(3);
            }}
            onSkip={() => {
              setMitBox(false);
              setStep(3);
            }}
            kennungEntwurf={kennungEntwurf}
            onKennung={setKennungEntwurf}
          />
        )}
        {wiedereinstiegBereit && step === 3 && site && (
          <AnlageBestaetigen
            site={site}
            mitBox={mitBox}
            plz={ortDerAnlage?.plz ?? null}
            ort={ortDerAnlage?.ort ?? null}
            onFertig={fertig}
            entwurf={teileEntwurf}
            onEntwurf={setTeileEntwurf}
          />
        )}
        {/* In Schritt 3 ist „Später ergänzen“ derselbe Weg - kein zweiter Link daneben. */}
        {onSkipAll && step < 3 && (
          <p className="vp-note" style={{ marginTop: 20, textAlign: 'center' }}>
            <button
              type="button"
              className="vp-linklike"
              onClick={() => {
                loescheEntwurf(schluessel);
                onSkipAll();
              }}
            >
              Später einrichten - direkt zum Portal
            </button>
          </p>
        )}
      </div>
    </>
  );
}

/**
 * Schritt 2 · Box: die VoltPilot-Box über ihre Kennung verbinden (`KennungFeld`). „Box ist noch nicht da“
 * ist ein gültiges Ende - die Anlage gibt es so oder so, die Box holt die Einrichtungs-Karte im Cockpit
 * nach. Kein Warte-Bildschirm (D7): nach dem Verbinden geht es sofort weiter, die Box meldet sich im
 * Hintergrund. Das Verbinden trägt eine Anfrage-Kennung - eine verlorene Antwort wird wiederholt, nie
 * doppelt verbunden.
 */
function GeraetStep({
  sites,
  site,
  onSiteChange,
  onClaimed,
  onSkip,
  kennungEntwurf,
  onKennung,
}: {
  sites: Site[];
  site: Site;
  onSiteChange: (site: Site) => void;
  onClaimed: (device: Device) => void;
  onSkip: () => void;
  /** F9: die getippte Kennung aus dem Entwurf. */
  kennungEntwurf: string;
  onKennung: (kennung: string) => void;
}) {
  const [deviceId, setDeviceId] = useState(kennungEntwurf);
  const [abgeschickt, setAbgeschickt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const kennung = useRef(neueAnfrageKennung());
  // Die Plattform verbindet auch freie Kennungen (der Server erlaubt sie nur ihr).
  const frei = isPlatformAdmin();

  // A returning multi-Anlagen customer must be able to pick the target
  // Anlage instead of being pinned to sites[0].
  const multiSite = sites.length > 1;

  async function submit() {
    if (busy) return;
    const pruefung = pruefeKennung(deviceId);
    const gesendet = frei ? deviceId.trim() : pruefung.kennung;
    if (frei ? !gesendet : !kennungSendbar(pruefung)) {
      // Keep the button live, point at the field (B4: a typo never becomes a device).
      setAbgeschickt(true);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const device = await api.claimDevice(site.id, gesendet, `${kennung.current}:box:${gesendet}`);
      onClaimed(device);
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 422
          ? DEVICE_ID_UNKNOWN_MSG
          : e instanceof ApiError && e.status === 409
            ? DEVICE_ID_TAKEN_MSG
            : 'Das Verbinden hat gerade nicht geklappt. Bitte versuchen Sie es noch einmal.',
      );
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-onboarding-step">
      <h3>Ihre VoltPilot-Box</h3>
      <p className="vp-muted">
        Tragen Sie die Kennung Ihrer Box ein.
        {!multiSite && ` Die Box gehört dann zur Anlage „${site.name}“.`}
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
        <KennungFeld
          ref={inputRef}
          id="flow-kennung"
          wert={deviceId}
          onWert={(w) => {
            setDeviceId(w);
            onKennung(w);
            setErr(null);
          }}
          abgeschickt={abgeschickt}
          serverFehler={err}
          frei={frei}
          onEnter={() => void submit()}
        />
        <p className="vp-note" style={{ margin: 0 }}>{DEVICE_ID_FIELD.help}</p>
      </div>
      <Recht aktion="geraet.einrichten"><Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={submit}
        disabled={busy}
        style={{ marginTop: 20 }}
      >
        {busy ? 'Verbinde…' : 'Box verbinden'}
      </Button></Recht>
      <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
        <button type="button" className="vp-linklike" onClick={onSkip}>
          Box ist noch nicht da - später verbinden
        </button>
      </p>
    </div>
  );
}
