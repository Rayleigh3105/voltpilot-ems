import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type Site, type SiteAsset, type SiteEntities } from '../api';
import {
  bekannterSpeicher,
  erzeugerPlaene,
  gefundeneZeilen,
  kwhText,
  kwpText,
  pruefeKwp,
  pruefeSpeicher,
  pvLage,
  type GefundeneZeile,
} from '../anlageBestaetigen';
import { entitiesApi } from '../entitiesApi';
import { ADOPT_FAILED_MSG, ADOPT_FORBIDDEN_MSG, UNGUIDED_HINT } from '../setupPath';
import { alsOrtFehler } from '../standorte';
import type { TeileEntwurf } from '../anlageEntwurf';
import { Recht } from './Recht';
import { RegisterHolen } from './RegisterHolen';
import './AnlageBestaetigen.css';

/** Wie oft der Schritt fragt, was die Box inzwischen gefunden hat. */
export const FUND_TAKT_MS = 5000;

type Feld = 'kwp' | 'kwh' | 'kw';
const FELD_ID: Record<Feld, string> = { kwp: 'flow-kwp', kwh: 'flow-speicher-kwh', kw: 'flow-speicher-kw' };

/** `feld` einer Ablehnung (`{code, feld, message}`, AnlageFeldFehler) → das Feld dieses Schritts. */
function feldDesServers(feld: string | undefined): Feld | null {
  if (feld === 'capacityKwp') return 'kwp';
  if (feld === 'capacityKwh') return 'kwh';
  if (feld === 'maxChargeKw' || feld === 'maxDischargeKw') return 'kw';
  return null;
}

/**
 * Schritt 3 · Anlage - „Was gehört zu Ihrer Anlage?“ (Anlage-Flow a1, Paket 2).
 *
 * Mit Box: die Liste dessen, was die Box meldet, wächst im Hintergrund (kein Warte-Bildschirm, D7) und
 * wird mit „Stimmt so“ übernommen; die Leistung der Solarmodule ist vorbelegt, wenn die Anlagen-Daten sie
 * kennen (F17), und wird dann nie ein zweites Mal gebucht. Ohne Box: zwei Kacheln, Solar und Speicher, je
 * mit ihren Zahlen. Die MaStR-Nummer ist ein Link „Aus dem Register holen“ (R4).
 *
 * „Später ergänzen“ lässt alles offen und erfindet nichts. Die reinen Regeln: `../anlageBestaetigen.ts`.
 */
export function AnlageBestaetigen({
  site,
  mitBox,
  plz,
  ort,
  onFertig,
  entwurf = null,
  onEntwurf,
}: {
  site: Site;
  /** Eine Box ist verbunden (eben oder schon vorher). */
  mitBox: boolean;
  /** Postleitzahl und Ort der Anlage (Schritt 1) für den Abgleich mit dem Register. */
  plz: string | null;
  ort: string | null;
  onFertig: () => void;
  /** F9: Solar und Speicher aus dem Entwurf. */
  entwurf?: TeileEntwurf | null;
  onEntwurf?: (e: TeileEntwurf) => void;
}) {
  const [entities, setEntities] = useState<SiteEntities | null>(null);
  const [assets, setAssets] = useState<SiteAsset[] | null>(null);
  const [solarAn, setSolarAn] = useState(entwurf?.solarAn ?? true);
  const [speicherAn, setSpeicherAn] = useState(entwurf?.speicherAn ?? false);
  const [kwp, setKwp] = useState(entwurf?.kwp ?? '');
  const [kwh, setKwh] = useState(entwurf?.kwh ?? '');
  const [kw, setKw] = useState(entwurf?.kw ?? '');
  const onEntwurfRef = useRef(onEntwurf);
  onEntwurfRef.current = onEntwurf;
  useEffect(() => {
    onEntwurfRef.current?.({ solarAn, speicherAn, kwp, kwh, kw });
  }, [solarAn, speicherAn, kwp, kwh, kw]);
  const [register, setRegister] = useState(false);
  const [fehler, setFehler] = useState<Partial<Record<Feld, string>>>({});
  const [zeilenFehler, setZeilenFehler] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    let aktiv = true;
    api.siteAssets(site.id).then(
      (a) => aktiv && setAssets(a),
      () => aktiv && setAssets([]),
    );
    return () => {
      aktiv = false;
    };
  }, [site.id]);

  // Was die Box findet, kommt im Hintergrund dazu - der Kunde wartet nicht davor (D7).
  useEffect(() => {
    if (!mitBox) return;
    let aktiv = true;
    const lesen = () => {
      if (busyRef.current) return;
      api.siteEntities(site.id).then(
        (d) => aktiv && setEntities(d),
        () => {
          // Ein Aussetzer lässt die Liste stehen, wie sie ist.
        },
      );
    };
    lesen();
    const takt = setInterval(lesen, FUND_TAKT_MS);
    return () => {
      aktiv = false;
      clearInterval(takt);
    };
  }, [mitBox, site.id]);

  const zeilen = gefundeneZeilen(entities?.localSetup ?? []);
  const plaene = zeilen.flatMap((z) => (z.plan ? [z.plan] : []));
  const erzeuger = erzeugerPlaene(zeilen);
  const pv = pvLage(assets, erzeuger);
  const speicher = bekannterSpeicher(assets);
  const gefunden = zeilen.length > 0;

  function setzeFehler(f: Partial<Record<Feld, string>>) {
    setFehler(f);
    const erstes = (Object.keys(FELD_ID) as Feld[]).find((k) => f[k]);
    if (erstes) requestAnimationFrame(() => document.getElementById(FELD_ID[erstes])?.focus());
  }

  async function stimmtSo() {
    if (busy) return;
    setErr(null);
    const f: Partial<Record<Feld, string>> = {};
    let kwpWert: number | null = null;
    if (solarAn && pv.art === 'frage') {
      const p = pruefeKwp(kwp);
      if (p.ok) kwpWert = p.wert;
      else f.kwp = p.satz;
    }
    let speicherWerte: { kwh: number; kw: number } | null = null;
    if (speicherAn && !speicher) {
      const s = pruefeSpeicher(kwh, kw);
      if (s.werte) speicherWerte = s.werte;
      else Object.assign(f, s);
    }
    if (Object.keys(f).length > 0) {
      setzeFehler(f);
      return;
    }
    setBusy(true);
    setFehler({});
    try {
      if (speicherWerte) {
        await api.saveBattery(site.id, {
          capacityKwh: speicherWerte.kwh,
          maxChargeKw: speicherWerte.kw,
          maxDischargeKw: speicherWerte.kw,
        });
      }
      if (kwpWert != null && pv.art === 'frage' && pv.ziel === 'anlage') {
        await api.savePv(site.id, kwpWert);
      }
      const offen: Record<string, string> = {};
      for (const plan of plaene) {
        const ersterErzeuger = plan.entityType === 'producer' && plan.sourceId === erzeuger[0]?.sourceId;
        try {
          await entitiesApi.adopt(site.id, {
            sourceId: plan.sourceId,
            entityType: plan.entityType,
            // Die kWp nur einmal: bekannt ist sie schon in der Summe, getippt geht sie an den ersten Erzeuger.
            capacityKwp: ersterErzeuger && pv.art === 'frage' && pv.ziel === 'erzeuger' ? kwpWert ?? undefined : undefined,
            registryUnitId:
              plan.entityType === 'producer' && pv.art === 'bekannt' && pv.ausRegister ? pv.mastrNummer ?? undefined : undefined,
          });
        } catch (e) {
          const abgelehnt = e instanceof ApiError ? alsOrtFehler(e.body) : null;
          const feld = abgelehnt ? feldDesServers(abgelehnt.feld) : null;
          if (abgelehnt && feld) {
            setzeFehler({ [feld]: abgelehnt.message });
            return;
          }
          const status = e instanceof ApiError ? e.status : 0;
          offen[plan.sourceId] = status === 401 || status === 403 || status === 404 ? ADOPT_FORBIDDEN_MSG : ADOPT_FAILED_MSG;
        }
      }
      setZeilenFehler(offen);
      if (Object.keys(offen).length > 0) {
        // Übernommenes bleibt übernommen; die Liste zeigt es beim nächsten Lesen.
        void api.siteEntities(site.id).then(setEntities, () => {});
        return;
      }
      onFertig();
    } catch (e) {
      const abgelehnt = e instanceof ApiError ? alsOrtFehler(e.body) : null;
      const feld = abgelehnt ? feldDesServers(abgelehnt.feld) : null;
      if (abgelehnt && feld) {
        setzeFehler({ [feld]: abgelehnt.message });
        return;
      }
      setErr('Das Speichern hat gerade nicht geklappt. Bitte versuchen Sie es noch einmal - nichts wird doppelt angelegt.');
    } finally {
      setBusy(false);
    }
  }

  if (register) {
    return (
      <div className="vp-onboarding-step vp-anlage-bestaetigen">
        <RegisterHolen
          site={site}
          plz={plz}
          ort={ort}
          onUebernommen={(a) => {
            setAssets(a);
            setRegister(false);
            setFehler({});
          }}
          onZurueck={() => setRegister(false)}
        />
      </div>
    );
  }

  const titel = mitBox ? (gefunden ? 'Das hat Ihre Box gefunden' : 'Ihre Box meldet gerade ihre Geräte\u00a0…') : 'Was haben Sie?';
  const unterzeile = mitBox
    ? gefunden
      ? 'Stimmt das? Dann übernehmen wir es so.'
      : 'Sie können schon weitermachen, bevor sie fertig ist.'
    : 'Zwei Zahlen genügen für die Sonnenprognose. Alles ist freiwillig.';

  return (
    <div className="vp-onboarding-step vp-anlage-bestaetigen">
      <h3>{titel}</h3>
      <p className="vp-muted">{unterzeile}</p>

      {mitBox && (
        <ul className="vp-fund" aria-live="polite" aria-busy={!gefunden}>
          {gefunden ? (
            zeilen.map((z) => <FundZeile key={z.id} zeile={z} fehler={zeilenFehler[z.id] ?? null} />)
          ) : (
            <li className="vp-fund-zeile is-sucht">
              <span className="vp-fund-symbol vp-ustate-busy" aria-hidden="true">
                <span className="vp-ustate-dot" />
              </span>
              <span className="vp-fund-text">
                <strong>Wechselrichter, Speicher und Zähler</strong>
                <span className="vp-muted">werden gesucht</span>
              </span>
            </li>
          )}
        </ul>
      )}

      <div className="vp-anlage-teile" role="group" aria-label="Ihre Anlage">
        {pv.art === 'bekannt' ? (
          <TatsachenZeile symbol="sun" art="pv" titel="Solarmodule" wert={kwpText(pv.kwp)} quelle={pv.ausRegister ? 'aus dem Register' : 'aus Ihren Angaben'} />
        ) : (
          <TeilKachel symbol="sun" art="pv" titel="Solar" an={solarAn} onAn={setSolarAn}>
            <Input
              id={FELD_ID.kwp}
              label="Leistung der Solarmodule (kWp)"
              placeholder="z. B. 9,8"
              inputMode="decimal"
              value={kwp}
              hint="Steht auf der Rechnung Ihrer Anlage."
              error={fehler.kwp}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setKwp(e.target.value);
                setFehler((x) => ({ ...x, kwp: undefined }));
              }}
            />
          </TeilKachel>
        )}
        {speicher ? (
          <TatsachenZeile symbol="battery" art="batt" titel="Speicher" wert={kwhText(speicher.kwh)} quelle="aus Ihren Anlagen-Daten" />
        ) : (
          <TeilKachel symbol="battery" art="batt" titel="Speicher" an={speicherAn} onAn={setSpeicherAn}>
            <div className="vp-anlage-teil-felder">
              <Input
                id={FELD_ID.kwh}
                label="Kapazität (kWh)"
                placeholder="z. B. 10"
                inputMode="decimal"
                value={kwh}
                error={fehler.kwh}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setKwh(e.target.value);
                  setFehler((x) => ({ ...x, kwh: undefined }));
                }}
              />
              <Input
                id={FELD_ID.kw}
                label="Lade- und Entladeleistung (kW)"
                placeholder="z. B. 5"
                inputMode="decimal"
                value={kw}
                error={fehler.kw}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setKw(e.target.value);
                  setFehler((x) => ({ ...x, kw: undefined }));
                }}
              />
            </div>
          </TeilKachel>
        )}
      </div>

      {(pv.art === 'frage' || !speicher) && (
        <p className="vp-note vp-register-link">
          MaStR-Nummer zur Hand?{' '}
          <button type="button" className="vp-linklike" onClick={() => setRegister(true)}>
            <Icon name="search" size={13} aria-hidden="true" />
            Aus dem Register holen
          </button>
        </p>
      )}

      {err && (
        <div className="vp-alert vp-alert-err" role="alert">
          {err}
        </div>
      )}
      <Recht aktion="geraet.einrichten">
        <Button variant="primary" size="lg" fullWidth onClick={stimmtSo} disabled={busy} style={{ marginTop: 20 }}>
          {busy ? 'Wird gespeichert…' : mitBox ? 'Stimmt so' : 'Weiter'}
        </Button>
      </Recht>
      <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
        <button type="button" className="vp-linklike" onClick={onFertig} disabled={busy}>
          Später ergänzen
        </button>
      </p>
    </div>
  );
}

function FundZeile({ zeile, fehler }: { zeile: GefundeneZeile; fehler: string | null }) {
  // Farbe und Symbol nach der Rolle (die Rollenfarben des Cockpits), nicht nach dem Zustand der Zeile.
  const rolle = zeile.titel.includes('PV') || zeile.titel === 'Wechselrichter' ? 'pv' : zeile.titel.includes('Zähler') ? 'netz' : 'last';
  const symbol: IconName = rolle === 'pv' ? 'sun' : rolle === 'netz' ? 'activity' : 'zap';
  return (
    <li className={`vp-fund-zeile is-${zeile.art} rolle-${rolle}`}>
      <span className="vp-fund-symbol" aria-hidden="true">
        <Icon name={symbol} size={16} />
      </span>
      <span className="vp-fund-text">
        <strong>{zeile.titel}</strong>
        <span className="vp-muted">{zeile.zeile}</span>
        {zeile.art === 'einordnung' && <span className="vp-note">{UNGUIDED_HINT}</span>}
        {fehler && (
          <span className="vp-fund-fehler" role="alert">
            {fehler}
          </span>
        )}
      </span>
      {zeile.art === 'uebernommen' && (
        <span className="vp-fund-marke">
          <Icon name="check" size={12} strokeWidth={3} aria-hidden="true" /> übernommen
        </span>
      )}
    </li>
  );
}

/** Eine Kachel „Solar“ / „Speicher“: an = die Zahlen dazu stehen darunter. */
function TeilKachel({
  symbol,
  art,
  titel,
  an,
  onAn,
  children,
}: {
  symbol: IconName;
  art: 'pv' | 'batt';
  titel: string;
  an: boolean;
  onAn: (an: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`vp-anlage-teil is-${art}${an ? ' is-an' : ''}`}>
      <button type="button" className="vp-anlage-teil-kopf" aria-pressed={an} onClick={() => onAn(!an)}>
        <span className="vp-anlage-teil-symbol" aria-hidden="true">
          <Icon name={symbol} size={18} />
        </span>
        <span className="vp-anlage-teil-titel">{titel}</span>
        <span className="vp-anlage-teil-haken" aria-hidden="true">
          {an && <Icon name="check" size={14} strokeWidth={3} />}
        </span>
      </button>
      {an && <div className="vp-anlage-teil-inhalt">{children}</div>}
    </div>
  );
}

/** Was die Anlagen-Daten schon wissen: eine Zeile, keine Frage (F17). */
function TatsachenZeile({
  symbol,
  art,
  titel,
  wert,
  quelle,
}: {
  symbol: IconName;
  art: 'pv' | 'batt';
  titel: string;
  wert: string;
  quelle: string;
}) {
  return (
    <div className={`vp-anlage-teil is-${art} is-an is-bekannt`}>
      <div className="vp-anlage-teil-kopf">
        <span className="vp-anlage-teil-symbol" aria-hidden="true">
          <Icon name={symbol} size={18} />
        </span>
        <span className="vp-anlage-teil-titel">
          {titel} <strong>{wert}</strong>
        </span>
        <span className="vp-anlage-teil-quelle">{quelle}</span>
      </div>
    </div>
  );
}
