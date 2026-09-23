import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  type Bezugsbasis,
  type BezugsbasisFassung,
  type FaktorenVorschlag,
  type Kennzahl,
  type VariablenVorschlag,
} from '../api';
import * as B from '../bezugsbasisAnlegen';
import { UEMS_EINFLUSSGROESSE, UEMS_NORMGRENZE, UEMS_REFERENZPERIODE, UEMS_STATISCHER_FAKTOR } from '../glossar';
import { ablehnungSatz } from '../kennzahlAnlegen';
import { heuteIn } from '../kennzahlKarte';
import { useRollen } from '../rollen';
import { datumText } from '../uemsOrtsbaum';
import { zahlText } from '../zahl';
import { VpPicker } from './VpPicker';
import './Gesamtwert.css';
import './Bezugsbasis.css';

const code = (e: unknown): string | null => {
  const body = e instanceof ApiError ? (e.body as { code?: unknown } | undefined) : undefined;
  return typeof body?.code === 'string' ? body.code : null;
};

/**
 * Der Assistent „Bezugsbasis anlegen“ (UEMS AP-17 IP-9, §5.1, R1) in fünf Schritten: Referenzperiode (ganze,
 * abgeschlossene Monate; „Monate prüfen“ bildet den Entwurf und zeigt je Monat vorhanden · vorläufig · fehlt), Methode
 * (Katalog IP-5 mit Datenbedarf; unter zwölf Monaten nur das Verhältnis, G1 — „kommt“ nur nach `methode_noch_nicht_gebaut`),
 * Einflussgrößen (Vorschlag IP-11a: Variable 1
 * ist der Nenner), statische Faktoren (Vorschlag IP-16a, gespeichert mit dem Entwurf nach IP-16b) und Vorschau (Grundlage,
 * Basiswert, Datenlage, Prüfsumme) mit „Als Entwurf speichern“ und danach „Zur Freigabe beantragen“.
 *
 * Die Basis BB-… entsteht beim ersten „Monate prüfen“ (`POST …/bezugsbasen`), jeder Entwurf über `POST …/fassungen`
 * (der offene Entwurf wird neu gebildet). Gerechnet wird nur auf dem Server — hier steht, was er antwortet.
 */
export function BezugsbasisAssistent({
  kennzahl,
  basis: basisStart,
  zone,
  onClose,
}: {
  kennzahl: Kennzahl;
  basis: Bezugsbasis | null;
  zone: string;
  onClose: () => void;
}) {
  const heute = heuteIn(zone, Date.now());
  const start = B.vorschlagPeriode(heute);
  const monate = B.waehlbareMonate(heute);
  const rollen = useRollen();
  const verwalten = rollen.darf('bezugsbasis.verwalten', kennzahl.standort_id);
  const freigeben = rollen.darf('bezugsbasis.freigeben', kennzahl.standort_id);

  const [schritt, setSchritt] = useState(1);
  const [basis, setBasis] = useState<Pick<Bezugsbasis, 'id' | 'kennzeichen'> | null>(basisStart);
  const [von, setVon] = useState(start.von);
  const [bis, setBis] = useState(start.bis);
  const [vorschau, setVorschau] = useState<BezugsbasisFassung | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [methode, setMethode] = useState('verhaeltnis');
  const [nichtGebaut, setNichtGebaut] = useState<Set<string>>(new Set());
  const [variablen, setVariablen] = useState<VariablenVorschlag | null>(null);
  const [variablenFehler, setVariablenFehler] = useState(false);
  const [zweite, setZweite] = useState<string[]>([]);
  const [faktoren, setFaktoren] = useState<FaktorenVorschlag | null>(null);
  const [faktorenFehler, setFaktorenFehler] = useState(false);
  const [angekreuzt, setAngekreuzt] = useState<string[]>([]);
  const [wortlaut, setWortlaut] = useState('');
  const [toleranz, setToleranz] = useState('2');
  const [wiedervorlage, setWiedervorlage] = useState('12');
  const [gespeichert, setGespeichert] = useState<BezugsbasisFassung | null>(null);
  const [nachAntrag, setNachAntrag] = useState<string | null>(null);

  const referenzperiode = `${von}/${bis}`;
  const periodeFehler = B.periodeFehler(von, bis);
  const vorschauPasst = vorschau !== null && vorschau.referenzperiode === referenzperiode;
  const zweiGroessen = (B.METHODEN.find((m) => m.kennung === methode)?.variablen_anzahl ?? 1) > 1;

  // Die Vorschläge lesen nur (IP-11a, IP-16a) — sie übernehmen nichts. Scheitern sie, bleibt der Schritt mit Satz.
  useEffect(() => {
    if (schritt !== 3 || variablen) return;
    api.kennzahlVariablenVorschlag(kennzahl.id, referenzperiode).then(setVariablen, () => setVariablenFehler(true));
  }, [schritt, variablen, kennzahl.id, referenzperiode]);
  useEffect(() => {
    if (schritt !== 4 || faktoren || !vorschau) return;
    api.kennzahlFaktorenVorschlag(kennzahl.id, vorschau.gilt_ab).then(setFaktoren, () => setFaktorenFehler(true));
  }, [schritt, faktoren, kennzahl.id, vorschau]);

  const basisSicher = async (): Promise<Pick<Bezugsbasis, 'id' | 'kennzeichen'>> => {
    if (basis) return basis;
    try {
      const neu = await api.bezugsbasisAnlegen(kennzahl.id);
      setBasis(neu);
      return neu;
    } catch (e) {
      // B1: läuft schon eine (etwa aus einem abgebrochenen Assistenten), nennt die Route sie — dort weiter.
      const body = e instanceof ApiError ? (e.body as { bezugsbasis_id?: string; bezugsbasis?: string } | undefined) : undefined;
      if (code(e) === 'bezugsbasis_laeuft' && body?.bezugsbasis_id) {
        const da = { id: body.bezugsbasis_id, kennzeichen: body.bezugsbasis ?? '' };
        setBasis(da);
        return da;
      }
      throw e;
    }
  };

  const entwerfen = async (mitAllem: boolean) => {
    setLaeuft(true);
    setFehler(null);
    try {
      const b = await basisSicher();
      const v1 = variablen?.variable_1?.id;
      const antwort = await api.bezugsbasisEntwurf(kennzahl.id, b.id, {
        referenzperiode,
        methode,
        ...(mitAllem
          ? {
              variablen: v1 ? [v1, ...(zweiGroessen ? zweite : [])] : null,
              toleranz_prozent: (zahlText(toleranz) ?? toleranz).replace(/\./g, '').replace(',', '.'),
              wiedervorlage_monate: Number(wiedervorlage),
              faktoren: [
                ...(faktoren?.faktoren ?? []).filter((f) => angekreuzt.includes(f.objekt_id)).map((f) => ({ art: f.art, objekt_id: f.objekt_id })),
                ...(wortlaut.trim() ? [{ art: 'wortlaut', wortlaut: wortlaut.trim() }] : []),
              ],
            }
          : {}),
      });
      setVorschau(antwort);
      if (mitAllem) setGespeichert(antwort);
    } catch (e) {
      const c = code(e);
      if (c === 'methode_noch_nicht_gebaut') {
        setNichtGebaut((alt) => new Set(alt).add(methode));
        setMethode('verhaeltnis');
      }
      setFehler(ablehnungSatz(e, B.AKTION_FEHLER));
    } finally {
      setLaeuft(false);
    }
  };

  const monatOptionen = monate.map((m) => ({ value: m, label: B.monatText(m) }));
  const toleranzFehler = zahlText(toleranz) === null ? 'Bitte eine Zahl eingeben, etwa 2 oder 2,5.' : null;
  const wiedervorlageFehler = /^\d{1,3}$/.test(wiedervorlage) && Number(wiedervorlage) > 0 ? null : 'Bitte ganze Monate eingeben.';

  const weiterMoeglich = schritt === 1 ? vorschauPasst : schritt === 2 ? B.methodenWahl(vorschau?.monate ?? null, nichtGebaut).some((w) => w.methode.kennung === methode && w.grund === null) : true;

  return (
    <Modal open onClose={onClose} title={B.TITEL_ASSISTENT} footer={Fuss()}>
      <div className="vp-gw vp-bb-assistent" data-testid="bezugsbasis-assistent">
        <ol className="vp-steps" aria-label="Schritte">
          {B.SCHRITTE.map((wort, i) => {
            const n = i + 1;
            const state = n < schritt ? 'done' : n === schritt ? 'active' : 'todo';
            return (
              <li key={n} className={`vp-step vp-step-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
                <span className="vp-step-num" aria-hidden="true">
                  {state === 'done' ? <Icon name="check" size={13} strokeWidth={3} /> : n}
                </span>
                <span className="vp-step-label">{wort}</span>
              </li>
            );
          })}
        </ol>
        <p className="vp-kz-leise">
          {kennzahl.kennzeichen} · {kennzahl.name}
          {basis?.kennzeichen ? ` · ${basis.kennzeichen}` : ''}
        </p>
        {/* Als Funktionen aufgerufen (wie im Kennzahl-Assistenten): eine je Render neue Komponente mountete die Picker neu. */}
        {schritt === 1 && SchrittPeriode()}
        {schritt === 2 && SchrittMethode()}
        {schritt === 3 && SchrittVariablen()}
        {schritt === 4 && SchrittFaktoren()}
        {schritt === 5 && SchrittVorschau()}
        {fehler && (
          <p className="vp-alert vp-alert-err" role="alert" data-testid="bezugsbasis-fehler">
            {fehler}
          </p>
        )}
        <p className="vp-bb-grenze">{UEMS_NORMGRENZE}</p>
      </div>
    </Modal>
  );

  function SchrittPeriode() {
    const zustaende = vorschauPasst ? B.monatsZustaende(vorschau.grundlage.perioden) : [];
    const vorl = vorschauPasst ? B.vorlaeufigText(vorschau.monate, vorschau.mindest_monate) : null;
    return (
      <div className="vp-gw-step-body">
        <p>Die {UEMS_REFERENZPERIODE} ist ein fester Zeitraum ganzer, abgeschlossener Monate. Vorgeschlagen sind die letzten zwölf.</p>
        <div className="vp-bb-periode">
          <VpPicker label="Erster Monat" options={monatOptionen} value={von} onChange={setVon} />
          <VpPicker label="Letzter Monat" options={monatOptionen} value={bis} onChange={setBis} error={periodeFehler} />
        </div>
        <div className="vp-kz-aktionen">
          <Button variant="outline" size="sm" data-testid="bezugsbasis-monate-knopf" disabled={!!periodeFehler || laeuft || !verwalten} onClick={() => entwerfen(false)}>
            {B.KNOPF_MONATE}
          </Button>
        </div>
        {vorschauPasst && (
          <>
            <ul className="vp-bb-monate" data-testid="bezugsbasis-monate">
              {zustaende.map((z) => (
                <li key={z.monat} className={`vp-bb-monat is-${z.zustand}`}>
                  <span>{z.text}</span>
                  <Badge variant={z.zustand === 'vorhanden' ? 'ok' : 'warn'}>{B.MONAT_WORT[z.zustand]}</Badge>
                </li>
              ))}
            </ul>
            {vorl && (
              <p className="vp-bb-vorlaeufig" data-testid="bezugsbasis-vorlaeufig">
                {vorl}
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  function SchrittMethode() {
    return (
      <div className="vp-gw-step-body">
        <ul className="vp-bb-wahl" role="radiogroup" aria-label="Methode">
          {B.methodenWahl(vorschau?.monate ?? null, nichtGebaut).map(({ methode: m, grund }) => (
            <li key={m.kennung}>
              <label className={`vp-bb-option${grund ? ' is-aus' : ''}`}>
                <input
                  type="radio"
                  name="bezugsbasis-methode"
                  value={m.kennung}
                  checked={methode === m.kennung}
                  disabled={grund !== null}
                  onChange={() => setMethode(m.kennung)}
                />
                <span>
                  <strong>{m.kundenwort}</strong>
                  {grund === B.KOMMT && (
                    <>
                      {' '}
                      <Badge variant="off">{B.KOMMT}</Badge>
                    </>
                  )}
                  <span className="vp-bb-klein">{m.datenbedarf}</span>
                  {grund && grund !== B.KOMMT && <span className="vp-bb-klein">{grund}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  function SchrittVariablen() {
    if (variablenFehler) return <p className="vp-gw-step-body">Der Vorschlag der Einflussgrößen konnte nicht geladen werden. Einflussgröße 1 bleibt die Bezugsgröße der Kennzahl.</p>;
    if (!variablen) return <p className="vp-gw-step-body" aria-busy="true">Vorschlag wird geladen …</p>;
    const v1 = variablen.variable_1;
    return (
      <div className="vp-gw-step-body">
        <p>
          <strong>{UEMS_EINFLUSSGROESSE} 1</strong> ·{' '}
          {v1 ? `${v1.name} (${v1.kennzeichen}, ${v1.einheit}) — die Bezugsgröße der Kennzahl` : 'Die Kennzahl rechnet nicht je erfasster Bezugsgröße.'}
        </p>
        {!zweiGroessen && variablen.kandidaten.some((k) => k.vorschlag === 'variable') && <p className="vp-kz-leise">{B.VERHAELTNIS_EINE}</p>}
        {variablen.satz && <p>{variablen.satz}</p>}
        <ul className="vp-bb-wahl" data-testid="bezugsbasis-kandidaten">
          {variablen.kandidaten
            .filter((k) => k.vorschlag !== 'variable_1')
            .map((k) => {
              const z = B.kandidatZeile(k);
              const id = k.bezugsgroesse.id;
              return (
                <li key={id}>
                  <label className={`vp-bb-option${!z.waehlbar || !zweiGroessen ? ' is-aus' : ''}`}>
                    <input
                      type="checkbox"
                      checked={zweite.includes(id)}
                      disabled={!z.waehlbar || !zweiGroessen}
                      onChange={(e) => setZweite(e.target.checked ? [id] : [])}
                    />
                    <span>
                      <strong>{z.titel}</strong>
                      {z.hinweis && <span className="vp-bb-klein">{z.hinweis}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          {variablen.ohne_zahl.map((o) => (
            <li key={`${o.einsatz}-${o.wortlaut}`}>
              <label className="vp-bb-option is-aus">
                <input type="checkbox" disabled checked={false} readOnly />
                <span>
                  <strong>
                    {o.wortlaut} ({o.einsatz})
                  </strong>
                  <span className="vp-bb-klein">{o.satz}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  function SchrittFaktoren() {
    return (
      <div className="vp-gw-step-body">
        <p className="vp-kz-leise">{B.FAKTOREN_HINWEIS}</p>
        {faktorenFehler && <p>Der Vorschlag der statischen Faktoren konnte nicht geladen werden.</p>}
        {!faktoren && !faktorenFehler && <p aria-busy="true">Vorschlag wird geladen …</p>}
        {faktoren && (
          <>
            <ul className="vp-bb-wahl" data-testid="bezugsbasis-faktoren">
              {faktoren.faktoren.map((f) => (
                <li key={`${f.art}-${f.objekt_id}`}>
                  <label className="vp-bb-option">
                    <input
                      type="checkbox"
                      checked={angekreuzt.includes(f.objekt_id)}
                      onChange={(e) =>
                        setAngekreuzt((alt) => (e.target.checked ? [...alt, f.objekt_id] : alt.filter((x) => x !== f.objekt_id)))
                      }
                    />
                    <span>{f.satz}</span>
                  </label>
                </li>
              ))}
            </ul>
            {faktoren.flaeche && <p className="vp-kz-leise">{faktoren.flaeche.satz}</p>}
            <p className="vp-kz-leise">{faktoren.hinweis}</p>
          </>
        )}
        <Input label={`Weiterer ${UEMS_STATISCHER_FAKTOR} (Wortlaut)`} value={wortlaut} onChange={(e) => setWortlaut(e.target.value)} />
      </div>
    );
  }

  function SchrittVorschau() {
    const f = gespeichert ?? vorschau;
    if (!f) return null;
    // Vor dem Speichern stammt die Vorschau aus „Monate prüfen“ (Verhältnis); ein Modell rechnet erst das Speichern.
    const anderesModell = !gespeichert && f.methode !== methode;
    const modell = B.modellText(f, kennzahl.einheit_anzeige);
    return (
      <div className="vp-gw-step-body" data-testid="bezugsbasis-vorschau">
        <dl className="vp-kz-stamm">
          <div>
            <dt>{UEMS_REFERENZPERIODE}</dt>
            <dd>
              {B.referenzperiodeText(f.referenzperiode)} · gilt ab {datumText(f.gilt_ab)}
            </dd>
          </div>
          <div>
            <dt>Methode</dt>
            <dd>{B.methodeWort(anderesModell ? methode : f.methode)}</dd>
          </div>
          {anderesModell ? (
            <div>
              <dt>Modell</dt>
              <dd>Grundlast und Steigung entstehen mit „{B.KNOPF_ENTWURF}“.</dd>
            </div>
          ) : modell ? (
            <div>
              <dt>Modell</dt>
              <dd data-testid="bezugsbasis-modell">
                {modell}
                {f.r2 ? ` · R² ${B.dezimal(f.r2)}` : ''}
              </dd>
            </div>
          ) : (
            <div>
              <dt>Basiswert</dt>
              <dd data-testid="bezugsbasis-basiswert">
                {B.dezimal(f.basiswert)} {B.einheitJe(kennzahl.einheit_anzeige)}
              </dd>
            </div>
          )}
          <div>
            <dt>Datenlage</dt>
            <dd>{B.datenlageSaetze(f).join(' · ')}</dd>
          </div>
          {f.variablen.map((v) => (
            <div key={v.position}>
              <dt>
                {UEMS_EINFLUSSGROESSE} {v.position}
              </dt>
              <dd>
                {v.kennzeichen}
                {v.fassung ? `, Fassung ${v.fassung}` : ''}
                {v.spannweite_von && v.spannweite_bis ? ` · ${B.dezimal(v.spannweite_von)}–${B.dezimal(v.spannweite_bis)}` : ''}
              </dd>
            </div>
          ))}
          {(gespeichert ? gespeichert.faktoren.length : angekreuzt.length + (wortlaut.trim() ? 1 : 0)) > 0 && (
            <div>
              <dt>Statische Faktoren</dt>
              <dd data-testid="bezugsbasis-faktoren-zahl">
                {gespeichert ? `${gespeichert.faktoren.length} gespeichert` : `${angekreuzt.length + (wortlaut.trim() ? 1 : 0)} gewählt`}
              </dd>
            </div>
          )}
          <div>
            <dt>Prüfsumme</dt>
            <dd title={f.pruefsumme}>{B.pruefsummeKurz(f.pruefsumme)}</dd>
          </div>
        </dl>
        {!gespeichert && (
          <div className="vp-bb-periode">
            <Input label="Toleranz in %" inputMode="decimal" value={toleranz} onChange={(e) => setToleranz(e.target.value)} error={toleranzFehler ?? undefined} />
            <Input
              label="Überprüfung nach Monaten"
              inputMode="numeric"
              value={wiedervorlage}
              onChange={(e) => setWiedervorlage(e.target.value)}
              error={wiedervorlageFehler ?? undefined}
            />
          </div>
        )}
        {(f.abgelehnte_variablen ?? []).map((a) => (
          <p key={String(a.objekt)} data-testid="bezugsbasis-abgelehnt">
            {B.abgelehntSatz(a)}
          </p>
        ))}
        <p className="vp-kz-leise">{B.ENTWURF_HINWEIS}</p>
        {gespeichert && !nachAntrag && freigeben && (
          <FreigabeFormular
            kennzahl={kennzahl}
            basis={{ id: gespeichert.bezugsbasis_id }}
            fassung={gespeichert.fassung}
            art="entwurf"
            vieraugen={gespeichert.vieraugen ?? null}
            onFertig={(antwort) => setNachAntrag(B.nachAntragSatz(antwort))}
          />
        )}
        {nachAntrag && (
          <p className="vp-bb-erfolg" role="status" data-testid="bezugsbasis-nach-antrag">
            {nachAntrag}
          </p>
        )}
      </div>
    );
  }

  function Fuss() {
    return (
      <div className="vp-gw-foot">
        {schritt === 1 ? (
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
        ) : (
          <Button variant="ghost" disabled={!!gespeichert} onClick={() => setSchritt((s) => s - 1)}>
            Zurück
          </Button>
        )}
        {schritt < 5 ? (
          <Button data-testid="bezugsbasis-weiter" disabled={!weiterMoeglich || laeuft} onClick={() => setSchritt((s) => s + 1)}>
            Weiter
          </Button>
        ) : gespeichert ? (
          <Button data-testid="bezugsbasis-fertig" onClick={onClose}>
            Fertig
          </Button>
        ) : (
          <Button
            data-testid="bezugsbasis-entwurf-knopf"
            disabled={laeuft || !verwalten || !!toleranzFehler || !!wiedervorlageFehler}
            onClick={() => entwerfen(true)}
          >
            {B.KNOPF_ENTWURF}
          </Button>
        )}
      </div>
    );
  }
}

const SCHRITT_WORT = { beantragen: B.KNOPF_BEANTRAGEN, freigeben: B.KNOPF_FREIGEBEN, ablehnen: B.KNOPF_ABLEHNEN } as const;
type Schritt = keyof typeof SCHRITT_WORT;

/**
 * Begründung 10–500 und die Knöpfe der Freigabe (IP-8, F1/F2; Recht `bezugsbasis.freigeben`). Ein Entwurf wird ohne
 * Vier-Augen direkt freigegeben, mit Vier-Augen beantragt; kennt die Fläche die Einstellung nicht (`vieraugen` null),
 * nimmt sie „Freigeben“ und folgt der Route: 409 `vieraugen_beantragen` → beantragen, 409 `vieraugen_aus` → freigeben.
 * Ein Antrag wird von einer zweiten Person freigegeben oder abgelehnt (422 `vieraugen_urheber` steht als Satz der Route).
 */
export function FreigabeFormular({
  kennzahl,
  basis,
  fassung,
  art,
  vieraugen,
  onFertig,
}: {
  kennzahl: Pick<Kennzahl, 'id'>;
  basis: Pick<Bezugsbasis, 'id'>;
  fassung: number;
  art: 'entwurf' | 'antrag';
  vieraugen: boolean | null;
  onFertig: (f: BezugsbasisFassung) => void;
}) {
  const [text, setText] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const schritte: Schritt[] = art === 'antrag' ? ['freigeben', 'ablehnen'] : [vieraugen ? 'beantragen' : 'freigeben'];
  const id = `bb-begruendung-${basis.id}-${fassung}-${art}`;
  const senden = async (schritt: Schritt) => {
    const f = B.begruendungFehler(text);
    if (f) {
      setFehler(f);
      document.getElementById(id)?.focus();
      return;
    }
    setLaeuft(true);
    setFehler(null);
    const begruendung = text.trim();
    try {
      let antwort: BezugsbasisFassung;
      try {
        antwort = await api.bezugsbasisFreigabe(kennzahl.id, basis.id, fassung, schritt, begruendung);
      } catch (e) {
        const umweg = art === 'entwurf' ? ({ vieraugen_aus: 'freigeben', vieraugen_beantragen: 'beantragen' } as const)[code(e) ?? ''] : undefined;
        if (!umweg || umweg === schritt) throw e;
        antwort = await api.bezugsbasisFreigabe(kennzahl.id, basis.id, fassung, umweg, begruendung);
      }
      setLaeuft(false);
      onFertig(antwort);
    } catch (e) {
      setLaeuft(false);
      setFehler(ablehnungSatz(e, B.AKTION_FEHLER));
    }
  };
  return (
    <div className="vp-bb-freigabe" data-testid={`bezugsbasis-freigabe-${art}`}>
      <label className="vp-bb-label" htmlFor={id}>
        {B.BEGRUENDUNG}
      </label>
      <textarea id={id} rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!fehler} />
      {fehler && (
        <p className="vp-alert vp-alert-err" role="alert">
          {fehler}
        </p>
      )}
      <p className="vp-kz-leise">{B.VIERAUGEN_HINWEIS}</p>
      <div className="vp-kz-aktionen">
        {schritte.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={s === 'ablehnen' ? 'outline' : undefined}
            disabled={laeuft}
            data-testid={`bezugsbasis-${s}-knopf`}
            onClick={() => senden(s)}
          >
            {SCHRITT_WORT[s]}
          </Button>
        ))}
      </div>
    </div>
  );
}
