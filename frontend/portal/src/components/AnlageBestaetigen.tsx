import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type Site, type SiteAsset } from '../api';
import { bekannterSpeicher, kwhText, kwpText, pruefeKwp, pruefeSpeicher, pvLage } from '../anlageBestaetigen';
import { SETUP_TITLE } from '../setupPath';
import { alsOrtFehler } from '../standorte';
import type { TeileEntwurf } from '../anlageEntwurf';
import { Recht } from './Recht';
import { RegisterHolen } from './RegisterHolen';
import './AnlageBestaetigen.css';

/** Wie lang die kurze Bestätigung von „Später eintragen“ steht, bevor es ins Cockpit geht. */
export const SPAETER_BESTAETIGT_MS = 1400;

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
 * Schritt 3 · Anlage - „Was gehört zu Ihrer Anlage?“ (Anlage-Flow a1, Paket 2;
 * mit Box seit vp-box-verbinden-konzept Runde 1/E5: kein Warten auf eine
 * Gerätesuche mehr - eine neue Box sucht nicht von selbst, und das Suchen und
 * Übernehmen lebt seit Runde 1 im Cockpit, nicht mehr im Assistenten, N1/N2).
 *
 * Mit Box zeigt der Schritt zuerst einen Überblick, was jetzt kommt, dann
 * zwei Kacheln (Solar, Speicher) mit ihren Zahlen, beides freiwillig; die
 * Leistung der Solarmodule ist vorbelegt, wenn die Anlagen-Daten sie schon
 * kennen (F17). Ohne Box: dieselben zwei Kacheln, ohne den Überblick. Die
 * MaStR-Nummer ist ein Link „Aus dem Register holen“ (R4).
 *
 * „Später eintragen“ bestätigt kurz und lässt die Zahlen offen - die
 * Einrichtungs-Karte im Cockpit erinnert daran. Die reinen Regeln:
 * `../anlageBestaetigen.ts`.
 */
export function AnlageBestaetigen({
  site,
  mitBox,
  boxOnline = false,
  zeigtSteuerung = true,
  plz,
  ort,
  onFertig,
  entwurf = null,
  onEntwurf,
}: {
  site: Site;
  /** Eine Box ist verbunden (eben oder schon vorher). */
  mitBox: boolean;
  /** Meldet diese Box gerade ein Lebenszeichen (sonst nur „verbunden“, nie „online“ behaupten)? */
  boxOnline?: boolean;
  /** Nur-Messen-Konten haben keine Steuerung - der Überblick nennt dann keinen Steuerungs-Schritt. */
  zeigtSteuerung?: boolean;
  /** Postleitzahl und Ort der Anlage (Schritt 1) für den Abgleich mit dem Register. */
  plz: string | null;
  ort: string | null;
  onFertig: () => void;
  /** F9: Solar und Speicher aus dem Entwurf. */
  entwurf?: TeileEntwurf | null;
  onEntwurf?: (e: TeileEntwurf) => void;
}) {
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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spaeterBestaetigt, setSpaeterBestaetigt] = useState(false);

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

  // „Später eintragen“: kurz bestätigen, dann ins Cockpit (Bericht Abschnitt 6.1).
  useEffect(() => {
    if (!spaeterBestaetigt) return;
    const t = setTimeout(onFertig, SPAETER_BESTAETIGT_MS);
    return () => clearTimeout(t);
  }, [spaeterBestaetigt, onFertig]);

  const pv = pvLage(assets, []);
  const speicher = bekannterSpeicher(assets);

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

  const titel = mitBox ? 'So geht es weiter' : 'Was haben Sie?';
  const unterzeile = 'Zwei Zahlen genügen für die Sonnenprognose. Alles ist freiwillig.';

  if (spaeterBestaetigt) {
    return (
      <div className="vp-onboarding-step vp-anlage-bestaetigen">
        <p className="vp-muted" role="status">
          Gut, dann später – im Cockpit erinnert Sie die Karte „{SETUP_TITLE}“ daran.
        </p>
      </div>
    );
  }

  return (
    <div className="vp-onboarding-step vp-anlage-bestaetigen">
      <h3>{titel}</h3>
      <p className="vp-muted">{unterzeile}</p>

      {mitBox && (
        <ol className="vp-weiter-ueberblick" aria-label="So geht es weiter">
          <li className="is-done">Box {boxOnline ? 'online' : 'verbunden'}</li>
          <li className="is-current">Jetzt: Ihre Anlage</li>
          <li>Dann im Cockpit: Geräte verbinden</li>
          {zeigtSteuerung && <li>Zum Schluss: Steuerung wählen</li>}
        </ol>
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
          {busy ? 'Wird gespeichert…' : 'Weiter'}
        </Button>
      </Recht>
      <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
        <button type="button" className="vp-linklike" onClick={mitBox ? () => setSpaeterBestaetigt(true) : onFertig} disabled={busy}>
          {mitBox ? 'Nicht zur Hand? Später eintragen' : 'Später ergänzen'}
        </button>
      </p>
    </div>
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
