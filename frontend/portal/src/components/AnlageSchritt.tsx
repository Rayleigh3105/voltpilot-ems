import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import {
  api,
  ApiError,
  neueAnfrageKennung,
  type PlantKind,
  type Site,
  type StandortAmStichtag,
  type SupplyPriceUpdate,
  type TarifArt,
  type Unternehmen,
} from '../api';
import {
  adresseAusTreffer,
  adresseText,
  NAME_VORGABE,
  offeneStandorte,
  ortModus,
  ortVorwahl,
  ortWahlFolge,
  ortZeile,
  SATZ_ADRESSE_FEHLT,
  SATZ_NICHT_GEFUNDEN,
  satzErsterVorschlag,
  standortAnfrage,
  standortNamen,
  standortOhneLage,
  type AnlegeWeg,
  type OrtWahl,
} from '../anlageOrt';
import { zoneForCountry } from '../anlageFlow';
import { parseFeedInCapInput, parsePremiumInput } from '../fleet';
import { ctFehler, einspeisegrenzeFehler } from '../zahlFehler';
import { VERAEUSSERUNGSFORM_FRAGE, VERAEUSSERUNGSFORM_LABEL } from '../glossar';
import { alsOrtFehler } from '../standorte';
import {
  buildSupplyPricePatch,
  showSupplyPriceFields,
  supplyPriceFormValues,
  type SupplyPriceFormValues,
} from '../supplyPrice';
import type { PriceMode } from '../tariffInput';
import { AdressSuche, type AdressWahl } from './AdressSuche';
import { LocationMap } from './LocationMap';
import { Recht } from './Recht';
import type { AdressEntwurf } from '../anlageEntwurf';
import { StandortDialog } from './StandortDialog';
import { TariffFields } from './TariffFields';
import { VpPicker } from './VpPicker';
import './AnlageSchritt.css';

/** Postleitzahl und Ort der neuen Anlage - Schritt 3 gleicht damit den Ort aus dem Register ab (R4). */
export interface OrtDerAnlage {
  plz: string | null;
  ort: string | null;
}

/** Die Felder des Schritts, an denen ein Satz stehen kann (eigene Prüfung oder Ablehnung des Servers, F4). */
type Feld = 'name' | 'ort' | 'adresse' | 'praemie' | 'tarifParam' | 'maxFeedIn';

/** `feld` einer Ablehnung von `POST /sites` oder `/standorte` → das Feld dieses Schritts. */
function feldDesServers(feld: string | undefined): Feld | null {
  if (!feld) return null;
  if (feld === 'name') return 'name';
  if (feld === 'maxFeedInKw') return 'maxFeedIn';
  if (feld === 'anzulegenderWertCtKwh') return 'praemie';
  if (feld === 'tarifParamCtKwh') return 'tarifParam';
  if (feld === 'standortId') return 'ort';
  if (feld.startsWith('adresse') || feld === 'lage') return 'adresse';
  return null;
}

const FELD_ID: Record<Feld, string> = {
  name: 'flow-name',
  ort: 'flow-ort',
  adresse: 'flow-adresse',
  praemie: 'flow-praemie',
  tarifParam: 'flow-site-param',
  maxFeedIn: 'flow-einspeisegrenze',
};

/**
 * Schritt 1 · Anlage - wo sie steht und wie sie heißt (Anlage-Flow a1, Paket 1). Die Adresse wird
 * EINMAL erfasst: ein Feld mit Vorschlägen (`AdressSuche`), die Karte springt aufs Haus, der Pin lässt
 * sich aufs Dach ziehen. Bei „Weiter“ entstehen Standort und Anlage in einem Zug, beide mit einer
 * Anfrage-Kennung - eine verlorene Antwort legt nichts doppelt an (B3).
 *
 * - Erste Anlage (kein Standort, keine Anlage): „Wo steht Ihre Anlage?“, der Name ist „Zuhause“.
 * - Weitere Anlage: „Wo steht die neue Anlage?“ - am selben Ort wie ein Standort (vorgewählt bei genau
 *   einem) oder an einer anderen Adresse, die den Standort mit anlegt (D8). Unternehmen legen einen
 *   neuen Standort über den Standort-Dialog an. Die Wahl nennt ihre Folge (F16).
 * - Bestand ohne Standort-Objekt: die Adresse setzt nur den Kartenpunkt der Anlage (wie bisher).
 *
 * Der Geld-Teil (Veräußerungsform, Feineinstellungen) steht nur, wenn der Fluss wie heute spricht;
 * was nicht zu sehen war, wird nicht gesendet. Jede Ablehnung landet am Feld, das sie meint (F4).
 * Die reinen Regeln stehen in `../anlageOrt.ts`.
 */
export function AnlageStep({
  locationSites,
  mitGeld,
  weg,
  vorwahl,
  onStandort,
  onCreated,
  entwurf = null,
  onEntwurf,
}: {
  locationSites: Site[];
  /**
   * Steuern-Regel im Anlege-Fluss: Veräußerungsform und Feineinstellungen stehen nur, wenn der Fluss
   * wie heute spricht — nicht im Modus „nur messen“ und nicht, solange das noch nicht feststeht.
   */
  mitGeld: boolean;
  /** Privatkunde oder Unternehmen (D2); `null` ohne Antwort (Bestand). */
  weg: AnlegeWeg | null;
  /** Vom Wirt vorbelegter Standort; gilt nur, wenn er zur Wahl steht. */
  vorwahl: string | null;
  /** Der gewählte Standort — an ihm entscheidet der Fluss (`anlegeArt`). */
  onStandort: (standortId: string | null) => void;
  onCreated: (site: Site, ort: OrtDerAnlage | null) => void;
  /** F9: der Entwurf dieses Schritts nach Neuladen oder Anmeldung - die Felder stehen wieder da. */
  entwurf?: AdressEntwurf | null;
  /** Jede Änderung der Felder geht in den Entwurf des Flusses. */
  onEntwurf?: (e: AdressEntwurf) => void;
}) {
  const [standorte, setStandorte] = useState<StandortAmStichtag[] | null | undefined>(undefined);
  const [stichtag, setStichtag] = useState<string>('');
  const [unternehmen, setUnternehmen] = useState<Unternehmen | null>(null);
  const [standorteRunde, setStandorteRunde] = useState(0);
  const [wahl, setWahl] = useState<OrtWahl | null>(entwurf?.wahl ?? null);
  const wahlRef = useRef(wahl);
  wahlRef.current = wahl;
  const [dialog, setDialog] = useState<{ standort: StandortAmStichtag | null } | null>(null);

  // Unlesbare Standorte: wie ohne Standort-Objekt - nie ein Standort, der vielleicht schon existiert.
  const modus = standorte === undefined ? null : standorte === null ? 'nur_lage' : ortModus(standorte, locationSites.length > 0);
  const erste = modus === 'erste';
  const [name, setName] = useState(entwurf?.name ?? '');
  const [nameOffen, setNameOffen] = useState(entwurf?.nameOffen ?? false);
  const [suche, setSuche] = useState(entwurf?.suche ?? '');
  const [adresse, setAdresse] = useState<AdressWahl | null>(entwurf?.adresse ?? null);
  const [lat, setLat] = useState<number | null>(entwurf?.lat ?? null);
  const [lon, setLon] = useState<number | null>(entwurf?.lon ?? null);
  // Bestand ohne Standort-Objekt: „Gleicher Standort wie …“ übernimmt Kartenpunkt und Gebotszone einer Anlage.
  const [zoneDerAnlage, setZoneDerAnlage] = useState<string | null>(null);
  // Jede gewählte Adresse holt die Karte aufs Haus (LocationMap `fokus`) - auch die aus dem Entwurf.
  const [kartenFokus, setKartenFokus] = useState(entwurf?.adresse ? 1 : 0);
  const [plantKind, setPlantKind] = useState<PlantKind>(entwurf?.plantKind ?? 'eigenverbrauch');
  const [advanced, setAdvanced] = useState(false);
  const [netzladen, setNetzladen] = useState(entwurf?.netzladen ?? false);
  const [praemie, setPraemie] = useState(entwurf?.praemie ?? '');
  const [tarifArt, setTarifArt] = useState<TarifArt>(entwurf?.tarifArt ?? 'ohne');
  const [tarifParam, setTarifParam] = useState(entwurf?.tarifParam ?? '');
  const [maxFeedIn, setMaxFeedIn] = useState(entwurf?.maxFeedIn ?? '');
  // Strukturierte Bezugspreis-Komponenten: nur gespeichert, wenn der Betreiber „Genau“ WÄHLT.
  const [supply, setSupply] = useState<SupplyPriceFormValues>(() => supplyPriceFormValues(null));
  const [priceMode, setPriceMode] = useState<PriceMode>('schnell');
  const [fehler, setFehler] = useState<Partial<Record<Feld, string>>>({});
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // B3: EINE Kennung je Formular - jeder Versuch dieses Formulars trägt sie, der Server legt nie doppelt an.
  const kennung = useRef(neueAnfrageKennung());

  // F9: jede Änderung geht in den Entwurf des Flusses (Neuladen, Anmeldung - die Felder bleiben).
  const onEntwurfRef = useRef(onEntwurf);
  onEntwurfRef.current = onEntwurf;
  useEffect(() => {
    onEntwurfRef.current?.({
      name, nameOffen, suche, adresse, lat, lon, wahl, plantKind, tarifArt, tarifParam, praemie, maxFeedIn, netzladen,
    });
  }, [name, nameOffen, suche, adresse, lat, lon, wahl, plantKind, tarifArt, tarifParam, praemie, maxFeedIn, netzladen]);

  useEffect(() => {
    let aktiv = true;
    Promise.all([api.standorte(), api.unternehmen().catch(() => null)]).then(
      ([antwort, u]) => {
        if (!aktiv) return;
        const offen = offeneStandorte(antwort);
        setStandorte(offen);
        setStichtag(antwort.stichtag);
        setUnternehmen(u);
        // Eine schon getroffene Wahl bleibt, solange es ihren Standort gibt.
        const bisher = wahlRef.current;
        const bleibt = bisher?.art === 'neu' || (bisher != null && offen.some((o) => o.id === bisher.id));
        if (!bleibt) {
          const v = ortVorwahl(offen, vorwahl);
          setWahl(v);
          onStandort(v?.art === 'standort' ? v.id : null);
        }
      },
      () => {
        // Unlesbar: wie ohne Standort-Objekt - die Adresse setzt den Kartenpunkt der Anlage.
        if (aktiv) setStandorte(null);
      },
    );
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standorteRunde]);

  // Die erste Anlage heißt wie ihr Ort, bis der Kunde etwas anderes wählt.
  useEffect(() => {
    if (erste && !name) setName(NAME_VORGABE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erste]);

  const offen = standorte ?? [];
  const gewaehlt = wahl?.art === 'standort' ? offen.find((s) => s.id === wahl.id) ?? null : null;
  // Wo die Adresse gefragt wird: erste Anlage, eine andere Adresse, oder der Bestand ohne Standort-Objekt.
  const mitAdresse = erste || modus === 'nur_lage' || wahl?.art === 'neu';
  // Unternehmen legen einen neuen Standort über den Standort-Dialog an (D2: sie behalten ihn).
  const neuUeberDialog = weg === 'unternehmen';

  function setzeFehler(f: Partial<Record<Feld, string>>) {
    setFehler(f);
    const erstes = (Object.keys(FELD_ID) as Feld[]).find((k) => f[k]);
    if (erstes && (erstes === 'praemie' || erstes === 'tarifParam' || erstes === 'maxFeedIn')) setAdvanced(true);
    if (erstes) requestAnimationFrame(() => document.getElementById(FELD_ID[erstes])?.focus());
  }

  function waehleAdresse(w: AdressWahl | null) {
    setAdresse(w);
    setHinweis(null);
    setFehler((f) => ({ ...f, adresse: undefined }));
    if (w?.punkt) {
      setLat(w.punkt.breitengrad);
      setLon(w.punkt.laengengrad);
      setKartenFokus((n) => n + 1);
    }
  }

  /** F5: getippt, aber nicht gewählt - der erste Vorschlag gilt, der Pin zeigt ihn zur Kontrolle. */
  async function ersterVorschlag(): Promise<boolean> {
    try {
      const a = await api.orteSuche(suche.trim());
      const t = a.treffer.find((x) => adresseAusTreffer(x));
      if (!t) {
        setzeFehler({ adresse: SATZ_NICHT_GEFUNDEN });
        return false;
      }
      const ad = adresseAusTreffer(t)!;
      setSuche(adresseText(ad));
      waehleAdresse({ adresse: ad, punkt: { breitengrad: t.breitengrad, laengengrad: t.laengengrad } });
      setHinweis(satzErsterVorschlag(adresseText(ad)));
    } catch {
      setzeFehler({ adresse: 'Die Adresssuche ist gerade nicht erreichbar - geben Sie die Adresse bitte von Hand ein.' });
    }
    return false;
  }

  async function submit() {
    if (busy || modus === null) return;
    setErr(null);
    const f: Partial<Record<Feld, string>> = {};
    if (!name.trim()) f.name = 'Bitte geben Sie einen Namen für Ihre Anlage ein.';
    if (modus === 'wahl' && !wahl) f.ort = 'Bitte wählen Sie, wo die neue Anlage steht.';
    if (mitAdresse && !adresse) {
      if (suche.trim().length >= 3) {
        setBusy(true);
        await ersterVorschlag();
        setBusy(false);
        return;
      }
      if (modus !== 'nur_lage') f.adresse = SATZ_ADRESSE_FEHLT;
    }
    // Was nicht zu sehen war, wird nicht gesendet: ohne Geld-Teil gilt ein unberührter Block.
    const geld = mitGeld && !erste;
    const kind: PlantKind = geld ? plantKind : 'eigenverbrauch';
    const tarif: TarifArt = geld ? tarifArt : 'ohne';
    if (geld && kind === 'direktvermarktung') {
      const satz = ctFehler(praemie, '8,11');
      if (satz) f.praemie = satz;
    }
    if (geld && tarif !== 'ohne') {
      const satz = ctFehler(tarifParam, tarif === 'dynamisch' ? '18' : '32,5');
      if (satz) f.tarifParam = satz;
    }
    if (geld) {
      const satz = einspeisegrenzeFehler(maxFeedIn);
      if (satz) f.maxFeedIn = satz;
    }
    if (Object.keys(f).length > 0) {
      setzeFehler(f);
      return;
    }
    let supplyPatch: SupplyPriceUpdate | null = null;
    if (geld && priceMode === 'genau' && showSupplyPriceFields(tarif)) {
      const built = buildSupplyPricePatch(supply);
      if ('error' in built) {
        setErr(built.error);
        return;
      }
      supplyPatch = built.patch;
    }
    setBusy(true);
    setFehler({});
    try {
      const lage = lat != null && lon != null ? { breitengrad: lat, laengengrad: lon } : null;
      let standortId: string | null = gewaehlt?.id ?? null;
      if (mitAdresse && modus !== 'nur_lage' && adresse) {
        standortId = (await standortAnlegen(adresse.adresse, lage)).id;
        onStandort(standortId);
      }
      const site = await api.createSite(
        {
          name: name.trim(),
          // Am Standort übernimmt die Anlage seine Lage und Gebotszone (die API); ohne Standort ihre eigene.
          ...(standortId
            ? { standortId }
            : {
                latitude: lat,
                longitude: lon,
                biddingZone: adresse ? zoneForCountry(adresse.adresse.land) : zoneDerAnlage ?? zoneForCountry(null),
              }),
          plantKind: kind,
          anzulegenderWertCtKwh: kind === 'direktvermarktung' ? parsePremiumInput(praemie) ?? null : null,
          tarifArt: tarif,
          tarifParamCtKwh: tarif === 'ohne' ? null : parsePremiumInput(tarifParam) ?? null,
          netzladenErlaubt: geld && netzladen,
          maxFeedInKw: geld ? parseFeedInCapInput(maxFeedIn) ?? null : null,
        },
        `${kennung.current}:anlage`,
      );
      if (supplyPatch) {
        // F12: ein gescheitertes Preisblatt verschwindet nicht still - die Anlage gibt es trotzdem.
        try {
          await api.updateSupplyPrice(site.id, supplyPatch);
        } catch {
          setErr('Die Anlage ist angelegt, das Preisblatt aber nicht gespeichert. Sie tragen es unter „Einstellungen“ nach.');
        }
      }
      const ad = adresse?.adresse ?? gewaehlt?.adresse ?? null;
      onCreated(site, ad ? { plz: ad.plz ?? null, ort: ad.ort ?? null } : null);
    } catch (e) {
      const abgelehnt = e instanceof ApiError ? alsOrtFehler(e.body) : null;
      // Der Server kennt mehrere Standorte, die Wahl hier (noch) nicht: sein Satz an die Wahl, neu lesen.
      const code: string | undefined = abgelehnt?.code;
      if (abgelehnt && code === 'standort_waehlen') {
        setzeFehler({ ort: abgelehnt.message });
        setStandorteRunde((r) => r + 1);
        return;
      }
      const feld = abgelehnt ? feldDesServers(abgelehnt.feld) : null;
      if (abgelehnt && feld) {
        setzeFehler({ [feld]: abgelehnt.message });
        return;
      }
      setErr(
        e instanceof ApiError && e.status < 500 && abgelehnt
          ? abgelehnt.message
          : 'Das Anlegen hat gerade nicht geklappt. Bitte versuchen Sie es gleich noch einmal - nichts wird doppelt angelegt.',
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Der Standort zur Adresse: die erste Anlage heißt wie er; an einer anderen Adresse heißt er wie die
   * Straße - ist der Name vergeben, Straße und Ort. Jeder Versuch trägt die Kennung des Formulars.
   */
  async function standortAnlegen(a: AdressWahl['adresse'], lage: { breitengrad: number; laengengrad: number } | null) {
    const namen = erste ? [name.trim()] : standortNamen(a);
    for (let i = 0; i < namen.length; i++) {
      try {
        return await api.standortAnlegen(standortAnfrage(namen[i], a, lage), `${kennung.current}:standort${i}`);
      } catch (e) {
        const abgelehnt = e instanceof ApiError ? alsOrtFehler(e.body) : null;
        if (abgelehnt?.code !== 'name_belegt' || i === namen.length - 1) throw e;
      }
    }
    throw new Error('unerreichbar');
  }

  if (modus === null) {
    return (
      <div className="vp-onboarding-step">
        <p className="vp-note" aria-busy="true">Der nächste Schritt wird vorbereitet …</p>
      </div>
    );
  }

  return (
    <div className="vp-onboarding-step vp-anlage-ort">
      <h3>{erste ? 'Wo steht Ihre Anlage?' : 'Wo steht die neue Anlage?'}</h3>
      <p className="vp-muted">
        {erste
          ? 'Daraus kommen Wetter und Sonnenprognose.'
          : 'Ein Name, unter dem Sie sie wiederfinden - und wo sie steht.'}
      </p>
      <div className="vp-anlage-ort-felder">
        {modus === 'wahl' && (
          <fieldset className="vp-ort-wahl" aria-describedby={fehler.ort ? 'flow-ort-fehler' : undefined}>
            <legend className="vp-ort-wahl-titel">Ort</legend>
            {offen.map((s) => {
              const z = ortZeile(s);
              const an = wahl?.art === 'standort' && wahl.id === s.id;
              return (
                <label key={s.id} className={`vp-ort-karte${an ? ' is-an' : ''}`}>
                  <input
                    id={an || (!wahl && s === offen[0]) ? FELD_ID.ort : undefined}
                    type="radio"
                    name="flow-ort"
                    checked={an}
                    onChange={() => {
                      setWahl({ art: 'standort', id: s.id });
                      setFehler((f) => ({ ...f, ort: undefined }));
                      onStandort(s.id);
                    }}
                  />
                  <span className="vp-ort-karte-text">
                    <strong>{z.titel}</strong>
                    <span className={z.ohneAdresse ? 'vp-ort-karte-fehlt' : 'vp-muted'}>{z.zeile}</span>
                  </span>
                </label>
              );
            })}
            <label className={`vp-ort-karte${wahl?.art === 'neu' ? ' is-an' : ''}`}>
              <input
                type="radio"
                name="flow-ort"
                checked={wahl?.art === 'neu'}
                onChange={() => {
                  if (neuUeberDialog) {
                    setDialog({ standort: null });
                    return;
                  }
                  setWahl({ art: 'neu' });
                  setFehler((f) => ({ ...f, ort: undefined }));
                  onStandort(null);
                }}
              />
              <span className="vp-ort-karte-text">
                <strong>{neuUeberDialog ? 'Neuen Standort anlegen' : 'An einer anderen Adresse'}</strong>
                <span className="vp-muted">
                  {neuUeberDialog ? 'Name und Adresse des Standorts' : 'Neuer Ort mit eigener Karte'}
                </span>
              </span>
            </label>
            {fehler.ort && (
              <p id="flow-ort-fehler" className="vp-ort-wahl-fehler" role="alert">
                {fehler.ort}
              </p>
            )}
            {!fehler.ort && ortWahlFolge(wahl, offen) && <p className="vp-note vp-ort-folge">{ortWahlFolge(wahl, offen)}</p>}
            {gewaehlt && standortOhneLage(gewaehlt) && (
              <p className="vp-note vp-ort-folge">
                {standortOhneLage(gewaehlt)!.satz}{' '}
                <button type="button" className="vp-linklike" onClick={() => setDialog({ standort: gewaehlt })}>
                  {standortOhneLage(gewaehlt)!.knopf}
                </button>
              </p>
            )}
          </fieldset>
        )}

        {erste && !nameOffen ? (
          <p className="vp-anlage-name-zeile">
            <span className="vp-muted">Name</span> <strong>{name || NAME_VORGABE}</strong>{' '}
            <button type="button" className="vp-linklike" onClick={() => setNameOffen(true)}>
              ändern
            </button>
          </p>
        ) : (
          <Input
            id={FELD_ID.name}
            label={erste ? 'Name' : 'Name der neuen Anlage'}
            placeholder={erste ? NAME_VORGABE : 'z. B. Garage'}
            value={name}
            autoFocus={nameOffen}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setName(e.target.value);
              setFehler((f) => ({ ...f, name: undefined }));
            }}
            error={fehler.name}
          />
        )}
        {erste && !nameOffen && fehler.name && <p className="vp-ort-wahl-fehler" role="alert">{fehler.name}</p>}

        {modus === 'nur_lage' && locationSites.some((x) => x.latitude != null && x.longitude != null) && (
          <div className="vp-reuse-loc">
            <span className="vp-reuse-loc-lbl">Gleicher Standort wie</span>
            <div className="vp-reuse-loc-chips">
              {locationSites
                .filter((x) => x.latitude != null && x.longitude != null)
                .map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    className="vp-chip-action"
                    onClick={() => {
                      setAdresse(null);
                      setSuche('');
                      setLat(x.latitude);
                      setLon(x.longitude);
                      setZoneDerAnlage(x.biddingZone);
                    }}
                  >
                    <Icon name="map-pin" size={13} />
                    {x.name}
                  </button>
                ))}
            </div>
          </div>
        )}
        {mitAdresse && (
          <>
            <AdressSuche
              id={FELD_ID.adresse}
              suche={suche}
              onSuche={(t) => {
                setSuche(t);
                setHinweis(null);
                setFehler((f) => ({ ...f, adresse: undefined }));
              }}
              gewaehlt={adresse}
              onWahl={waehleAdresse}
              fehler={fehler.adresse}
              hinweis={modus === 'nur_lage' ? 'Straße und Hausnummer genügen - optional, dann ohne Wetter.' : undefined}
            />
            {hinweis && (
              <p className="vp-alert vp-alert-info" role="status" style={{ margin: 0 }}>
                {hinweis}
              </p>
            )}
            <LocationMap
              lat={lat}
              lon={lon}
              fokus={kartenFokus}
              onChange={(la, lo) => {
                setLat(la);
                setLon(lo);
              }}
            />
          </>
        )}

        {mitGeld && !erste && (
          <GeldTeil
            plantKind={plantKind}
            onPlantKind={setPlantKind}
            advanced={advanced}
            onAdvanced={setAdvanced}
            praemie={praemie}
            onPraemie={(v) => {
              setPraemie(v);
              setFehler((f) => ({ ...f, praemie: undefined }));
            }}
            tarifArt={tarifArt}
            onTarifArt={setTarifArt}
            tarifParam={tarifParam}
            onTarifParam={(v) => {
              setTarifParam(v);
              setFehler((f) => ({ ...f, tarifParam: undefined }));
            }}
            supply={supply}
            onSupply={setSupply}
            priceMode={priceMode}
            onPriceMode={setPriceMode}
            netzladen={netzladen}
            onNetzladen={setNetzladen}
            maxFeedIn={maxFeedIn}
            onMaxFeedIn={(v) => {
              setMaxFeedIn(v);
              setFehler((f) => ({ ...f, maxFeedIn: undefined }));
            }}
            fehler={fehler}
          />
        )}
      </div>
      <Recht aktion="anlage.verwalten">
        <Button variant="primary" size="lg" fullWidth onClick={submit} disabled={busy} style={{ marginTop: 20 }}>
          {busy ? 'Lege Anlage an…' : 'Weiter'}
        </Button>
      </Recht>
      {modus === 'nur_lage' && lat == null && (
        <p className="vp-note" style={{ marginTop: 8 }}>
          Ohne Standort geht es auch - dann allerdings ohne Wetterprognose.
        </p>
      )}
      {err && <div className="vp-alert vp-alert-err">{err}</div>}

      {dialog && (
        <StandortDialog
          open
          standort={dialog.standort}
          unternehmen={unternehmen}
          standorte={offen}
          heute={stichtag}
          onClose={() => setDialog(null)}
          onGespeichert={(neu) => {
            setDialog(null);
            setWahl({ art: 'standort', id: neu.id });
            onStandort(neu.id);
            setFehler((f) => ({ ...f, ort: undefined }));
            setStandorteRunde((r) => r + 1);
          }}
        />
      )}
    </div>
  );
}

/**
 * Der Geld-Teil des Schritts (Veräußerungsform und Feineinstellungen) - nur, wenn der Fluss wie heute
 * spricht. Jedes Feld zeigt seinen eigenen Satz (F4), keiner steht mehr unter dem Knopf.
 */
function GeldTeil(p: {
  plantKind: PlantKind;
  onPlantKind: (k: PlantKind) => void;
  advanced: boolean;
  onAdvanced: (an: boolean) => void;
  praemie: string;
  onPraemie: (v: string) => void;
  tarifArt: TarifArt;
  onTarifArt: (t: TarifArt) => void;
  tarifParam: string;
  onTarifParam: (v: string) => void;
  supply: SupplyPriceFormValues;
  onSupply: (fn: (s: SupplyPriceFormValues) => SupplyPriceFormValues) => void;
  priceMode: PriceMode;
  onPriceMode: (m: PriceMode) => void;
  netzladen: boolean;
  onNetzladen: (an: boolean) => void;
  maxFeedIn: string;
  onMaxFeedIn: (v: string) => void;
  fehler: Partial<Record<Feld, string>>;
}) {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <VpPicker
          id="flow-plant-kind"
          label={VERAEUSSERUNGSFORM_LABEL}
          options={[
            { value: 'eigenverbrauch', label: 'Eigenverbrauch (Haushalt/Gewerbe)' },
            { value: 'direktvermarktung', label: 'Direktvermarktung (Einspeisung am Markt)' },
          ]}
          value={p.plantKind}
          onChange={(v) => p.onPlantKind(v as PlantKind)}
        />
        <p className="vp-note" style={{ margin: 0 }}>
          {VERAEUSSERUNGSFORM_FRAGE} Sie bestimmt auch, wie Ihr Vorteil erzählt wird: „gespart" beim
          Eigenverbrauch, „mehr verdient" bei der Direktvermarktung.
        </p>
      </div>
      <div>
        <button type="button" className="vp-linklike" aria-expanded={p.advanced} onClick={() => p.onAdvanced(!p.advanced)}>
          <Icon
            name="chevron-down"
            size={14}
            style={{ verticalAlign: '-2px', marginRight: 4, transform: p.advanced ? 'rotate(180deg)' : undefined }}
          />
          Feineinstellungen {p.advanced ? 'ausblenden' : '(optional)'}
        </button>
        {!p.advanced && (
          <p className="vp-note" style={{ margin: '4px 0 0' }}>
            Stromtarif, Vergütung, Netzladen und Einspeisegrenze - jetzt oder später unter „Einstellungen".
          </p>
        )}
      </div>
      {p.advanced && (
        <>
          {p.plantKind === 'direktvermarktung' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <Input
                id={FELD_ID.praemie}
                label="Anzulegender Wert (ct/kWh)"
                placeholder="z. B. 8,11"
                inputMode="decimal"
                value={p.praemie}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => p.onPraemie(e.target.value)}
                error={p.fehler.praemie}
              />
              <p className="vp-note" style={{ margin: 0 }}>
                Steht in Ihrem EEG-Zuschlag bzw. Direktvermarktungsvertrag. Optional - wenn angegeben, rechnen
                wir Ihre Marktprämie (anzulegender Wert minus Monatsmarktwert Solar) in Ihren Mehrerlös ein; bei
                negativen Börsenpreisen entfällt sie.
              </p>
            </div>
          )}
          <TariffFields
            tarifArt={p.tarifArt}
            onTarifArt={p.onTarifArt}
            param={p.tarifParam}
            onParam={p.onTarifParam}
            idPrefix="flow-site"
            supplyValues={p.supply}
            onSupplyChange={(field, value) => p.onSupply((s) => ({ ...s, [field]: value }))}
            priceMode={p.priceMode}
            onPriceMode={p.onPriceMode}
            paramError={p.fehler.tarifParam}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <VpPicker
              id="flow-netzladen"
              label="Netzladen des Speichers"
              options={[
                { value: 'verboten', label: 'Verboten - EEG-Anlage (nur Solarladen)' },
                { value: 'erlaubt', label: 'Erlaubt - Speicher darf aus dem Netz laden' },
              ]}
              value={p.netzladen ? 'erlaubt' : 'verboten'}
              onChange={(v) => p.onNetzladen(v === 'erlaubt')}
            />
            <p className="vp-note" style={{ margin: 0 }}>
              EEG-geförderte Anlagen dürfen ihren Speicher nicht aus dem Netz laden (Ausschließlichkeitsprinzip).
              Nur aktivieren, wenn Ihre Anlage keine EEG-Vergütung bezieht.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <Input
              id={FELD_ID.maxFeedIn}
              label="Maximale Einspeiseleistung am Netzanschlusspunkt (kW)"
              placeholder="z. B. 75"
              inputMode="decimal"
              value={p.maxFeedIn}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => p.onMaxFeedIn(e.target.value)}
              error={p.fehler.maxFeedIn}
            />
            <p className="vp-note" style={{ margin: 0 }}>
              Steht in Ihrer Netzanschluss-Zusage bzw. im Einspeisevertrag. Optional - wenn angegeben, plant
              VoltPilot die Einspeisung nie über diese Grenze hinaus. Ihr Bezug aus dem Netz ist davon nicht
              betroffen.
            </p>
          </div>
        </>
      )}
    </>
  );
}
