import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type MessstellenRegister, type MessstellenRegisterAnfrage } from '../api';
import {
  FERTIG,
  fortschritt,
  gespeichertText,
  rundeAus,
  rundenTitel,
  rundenUnter,
  rundeZaehltSatz,
  vorpruefung,
  zuletztText,
  type RundeZaehler,
} from '../ableseRunde';
import { ZUR_LISTE } from '../messstelleZuordnung';
import { lesen, ortszeit } from '../picker/zeitpunkt';
import { RechteStandort } from '../rollen';
import { Recht } from './Recht';
import { ErrorState, Skeleton } from './States';
import { VpZeitpunktPicker } from './VpZeitpunktPicker';
import './AbleseRunde.css';

/** Der Knopf „Fertig“ - nach dem letzten Feld springt „Weiter“ dorthin (der Knopf des Designsystems trägt keinen Ref). */
const FERTIG_ID = 'vp-ar-fertig';

type Zustand =
  | { art: 'offen' }
  | { art: 'speichert' }
  | { art: 'gespeichert'; satz: string }
  | { art: 'satz'; satz: string };

/**
 * Die Ablese-Runde je Gebäude (Konzept Messen m1, §6.5 Variante 3A): ein Zeitpunkt für alle, je Zähler der letzte Stand
 * und ein Feld. „Weiter“ (Enter) speichert die Reihe mit derselben Route wie „Ablesung eintragen“
 * (`POST …/ablesungen`) und springt zum nächsten Feld; der Satz einer Prüfung bleibt am Zähler, die Runde läuft
 * weiter. „Fertig“ speichert, was noch eingetragen und nicht gespeichert ist, und führt zurück in die Liste.
 */
export function AbleseRunde({
  ort,
  zone,
  anfrage,
  onZurueck,
}: {
  /** Das Kurzzeichen des Orts (`G-1`) aus der Adresse (`?ablesen=G-1`). */
  ort: string;
  zone: string;
  /** Die Anfrage an das Register der Ebene (wie die Liste, ohne Filter). */
  anfrage: MessstellenRegisterAnfrage;
  onZurueck: () => void;
}) {
  const [register, setRegister] = useState<MessstellenRegister | null>(null);
  const [ladeFehler, setLadeFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  const [zeit, setZeit] = useState(() => ortszeit(Date.now(), zone));
  const [zeitFehler, setZeitFehler] = useState<string | null>(null);
  const [texte, setTexte] = useState<Record<string, string>>({});
  const [zustaende, setZustaende] = useState<Record<string, Zustand>>({});
  const [busy, setBusy] = useState(false);
  const felder = useRef(new Map<string, HTMLInputElement>());
  const schluessel = JSON.stringify(anfrage);

  useEffect(() => {
    let aktiv = true;
    setLadeFehler(false);
    api.messstellenRegister(anfrage).then(
      (r) => aktiv && setRegister(r),
      () => aktiv && setLadeFehler(true),
    );
    return () => {
      aktiv = false;
    };
    // `anfrage` ist ein neues Objekt je Render; ihr Inhalt steht in `schluessel`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schluessel, versuch]);

  const runde = useMemo(() => (register ? rundeAus(register, ort, zone) : null), [register, ort, zone]);
  const z = lesen(zeit, zone);
  const zustand = (id: string): Zustand => zustaende[id] ?? { art: 'offen' };
  const setze = (id: string, s: Zustand) => setZustaende((alt) => ({ ...alt, [id]: s }));

  const zurueck = (
    <button type="button" className="vp-mss-zurueck" onClick={onZurueck}>
      <Icon name="chevron-left" size={18} />
      {ZUR_LISTE}
    </button>
  );
  if (ladeFehler) {
    return (
      <div className="vp-ar" data-testid="ablese-runde">
        {zurueck}
        <ErrorState message="Die Zähler konnten nicht geladen werden." onRetry={() => setVersuch((v) => v + 1)} />
      </div>
    );
  }
  if (!register) {
    return (
      <div className="vp-ar" data-testid="ablese-runde" aria-busy="true">
        {zurueck}
        <Skeleton height={320} />
      </div>
    );
  }
  if (!runde) {
    return (
      <div className="vp-ar" data-testid="ablese-runde">
        {zurueck}
        <p className="vp-ar-leer">An diesem Ort wird kein Zähler von Hand abgelesen.</p>
      </div>
    );
  }

  const gespeichert = runde.zaehler.filter((x) => zustand(x.id).art === 'gespeichert').length;
  const f = fortschritt(gespeichert, runde.zaehler.length);
  const zaehltSatz = rundeZaehltSatz(runde, z.wert, zone);
  const erstesOffenes = runde.zaehler.find((x) => zustand(x.id).art !== 'gespeichert')?.id ?? null;

  /** Speichert eine Reihe; `true`, wenn sie danach gespeichert ist. */
  const speichere = async (x: RundeZaehler): Promise<boolean> => {
    const text = (texte[x.id] ?? '').trim();
    if (zustand(x.id).art === 'speichert') return false;
    if (!text || zustand(x.id).art === 'gespeichert') return zustand(x.id).art === 'gespeichert';
    if (!z.wert) {
      setZeitFehler(z.fehler ?? 'Bitte geben Sie Datum und Uhrzeit an.');
      return false;
    }
    if (Date.parse(z.wert) > Date.now()) {
      setZeitFehler('Eine Ablesung liegt nicht in der Zukunft.');
      return false;
    }
    const v = vorpruefung(x, text, z.wert, zone);
    if (v.art === 'satz') {
      setze(x.id, { art: 'satz', satz: v.satz });
      return false;
    }
    setze(x.id, { art: 'speichert' });
    try {
      const a = await api.ablesungEintragen(x.kennzeichen, { zeitpunkt: z.wert, stand: v.stand, zuordnung_monat: v.zuordnung_monat });
      const satz =
        a.urteil === 'vorschlag'
          ? 'Vorschlag gesendet - bis zur Freigabe gilt der bisherige Stand.'
          : a.urteil === 'wiederholung'
            ? 'bereits gespeichert'
            : gespeichertText(a.ablesezeitraum?.menge ?? null, x.einheit, x.zuletzt?.zeitpunkt ?? null, zone);
      setze(x.id, { art: 'gespeichert', satz });
      return true;
    } catch (e) {
      setze(x.id, { art: 'satz', satz: e instanceof ApiError ? e.message : 'Die Ablesung konnte nicht gespeichert werden.' });
      return false;
    }
  };

  /** „Weiter“: speichert und springt zum nächsten Feld, das noch nicht gespeichert ist; nach dem letzten auf „Fertig“. */
  const weiter = async (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const x = runde.zaehler[i];
    const ok = (texte[x.id] ?? '').trim() === '' || (await speichere(x));
    if (!ok) return;
    const naechster = runde.zaehler.slice(i + 1).find((y) => zustand(y.id).art !== 'gespeichert' && y.id !== x.id);
    if (naechster) felder.current.get(naechster.id)?.focus();
    else document.getElementById(FERTIG_ID)?.focus();
  };

  const fertig = async () => {
    if (busy) return;
    setBusy(true);
    let alleGut = true;
    for (const x of runde.zaehler) {
      const art = zustand(x.id).art;
      if (!(texte[x.id] ?? '').trim() || art === 'gespeichert') continue;
      // Ein abgelehnter Stand, seit der Ablehnung unverändert, geht nicht noch einmal hinaus - sein Satz bleibt stehen.
      if (art === 'satz') alleGut = false;
      else alleGut = (await speichere(x)) && alleGut;
    }
    setBusy(false);
    if (alleGut) onZurueck();
  };

  return (
    <RechteStandort.Provider value={runde.standortId}>
      <div className="vp-ar" data-testid="ablese-runde">
        {zurueck}
        <header className="vp-ar-kopf">
          <h1>{rundenTitel(runde)}</h1>
          <p className="vp-ar-unter">{rundenUnter(runde)}</p>
        </header>
        <Recht aktion="ablesung.erfassen">
          <div className="vp-ar-zeit">
            <VpZeitpunktPicker
              kopf="Abgelesen am"
              value={zeit}
              zone={zone}
              onChange={(v) => {
                setZeit(v);
                setZeitFehler(null);
              }}
              disabled={busy}
              error={zeitFehler ?? undefined}
            />
            {zaehltSatz && <p className="vp-ar-zaehlt">{zaehltSatz}</p>}
          </div>
          <div className="vp-ar-fortschritt" data-testid="ablese-runde-fortschritt">
            <span>
              <b>{f.zahl}</b> {f.wort}
            </span>
            <span className="vp-ar-balken" role="progressbar" aria-valuemin={0} aria-valuemax={runde.zaehler.length} aria-valuenow={gespeichert} aria-label="Eingetragen">
              <i style={{ width: `${(gespeichert / runde.zaehler.length) * 100}%` }} />
            </span>
          </div>
          <ol className="vp-ar-liste">
            {runde.zaehler.map((x, i) => {
              const s = zustand(x.id);
              const id = `vp-ar-${x.id}`;
              const unter = s.art === 'gespeichert' || s.art === 'satz' ? s.satz : zuletztText(x, runde, zone);
              return (
                <li key={x.id} className={`vp-ar-reihe is-${s.art}`} data-testid="ablese-runde-reihe">
                  <label htmlFor={id} className="vp-ar-name">
                    {x.name} <span className="vp-ar-kz">{x.kennzeichen}</span>
                    <span className="vp-sr-only"> ({x.einheit})</span>
                  </label>
                  <span className="vp-ar-satz" id={`${id}-satz`} role={s.art === 'satz' ? 'alert' : undefined}>
                    {unter}
                  </span>
                  <span className="vp-ar-feld">
                    <input
                      id={id}
                      ref={(el) => {
                        if (el) felder.current.set(x.id, el);
                        else felder.current.delete(x.id);
                      }}
                      inputMode="decimal"
                      enterKeyHint={i === runde.zaehler.length - 1 ? 'done' : 'next'}
                      autoComplete="off"
                      value={texte[x.id] ?? ''}
                      // Während des Speicherns nur lesbar, nie `disabled`: der Fokus bleibt im Feld, und nach einer
                      // Ablehnung korrigiert der Kunde ohne neuen Griff.
                      readOnly={busy || s.art === 'gespeichert' || s.art === 'speichert'}
                      aria-busy={s.art === 'speichert' || undefined}
                      aria-describedby={`${id}-satz`}
                      aria-invalid={s.art === 'satz' ? true : undefined}
                      // Konzept Wiedervorlage w1, Entscheid 7: der Schritt „Ablesungen eintragen“ landet im ersten offenen Feld.
                      data-entscheid={x.id === erstesOffenes ? 'zaehlerablesung' : undefined}
                      onChange={(e) => {
                        const wert = e.target.value;
                        setTexte((alt) => ({ ...alt, [x.id]: wert }));
                        if (s.art === 'satz') setze(x.id, { art: 'offen' });
                      }}
                      onKeyDown={(e) => void weiter(e, i)}
                    />
                    <span className="vp-ar-einheit" aria-hidden="true">
                      {s.art === 'gespeichert' ? <Icon name="check" size={16} /> : x.einheit}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="vp-ar-fuss">
            <Button id={FERTIG_ID} variant="primary" style={{ width: undefined }} onClick={() => void fertig()} disabled={busy}>
              {busy ? 'Wird gespeichert …' : FERTIG}
            </Button>
          </div>
        </Recht>
      </div>
    </RechteStandort.Provider>
  );
}
