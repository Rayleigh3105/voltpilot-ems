import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type Bezugsbasis, type BezugsbasisFassung, type BezugsbasisFassungKurz, type Kennzahl } from '../api';
import * as B from '../bezugsbasisAnlegen';
import * as F from '../bezugsbasisFassungen';
import type { BezugsbasisZustand } from '../bezugsbasisUebersicht';
import { UEMS_NORMGRENZE } from '../glossar';
import { ablehnungSatz } from '../kennzahlAnlegen';
import { heuteIn } from '../kennzahlKarte';
import { FreigabeFormular } from './BezugsbasisAssistent';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import './Bezugsbasis.css';

/** Was der Reiter für Fassung n + 1 an den Assistenten gibt (IP-18): Anpassung, Fassung n und ihre Vorbelegung. */
export type NeueFassung = { anpassung: F.Anpassung; vorgaengerin: BezugsbasisFassung | null; vorbelegung: F.Vorbelegung | null };

type Karte = BezugsbasisFassungKurz & Partial<BezugsbasisFassung>;

const code = (e: unknown): string | null => {
  const body = e instanceof ApiError ? (e.body as { code?: unknown } | undefined) : undefined;
  return typeof body?.code === 'string' ? body.code : null;
};
const pflegeSatz = (e: unknown) => F.PFLEGE_SATZ[code(e) ?? ''] ?? ablehnungSatz(e, B.AKTION_FEHLER);

/**
 * Lädt je Fassung der Basis die volle Antwort (`GET …/fassungen/{n}`: Anpassungsgründe, Freigeber, Faktoren) und den
 * Zustand aus der Übersicht von IP-17 (Frist, „Anstoß liegt vor“) — die Frist wird nie hier gerechnet. Scheitert eine
 * Fassung, bleibt ihre Kurzform aus der Liste stehen.
 */
function useFassungen(kennzahlId: string, basis: Bezugsbasis) {
  const [voll, setVoll] = useState<Record<number, BezugsbasisFassung>>({});
  const [zustand, setZustand] = useState<BezugsbasisZustand | null>(null);
  const schluessel = basis.fassungen.map((f) => `${f.fassung}:${f.freigabe_status}:${f.gilt_bis ?? ''}:${f.pruefsumme ?? ''}`).join('|');
  useEffect(() => {
    let aktiv = true;
    for (const k of basis.fassungen) {
      api
        .bezugsbasisFassung(kennzahlId, basis.id, k.fassung)
        .then((f) => aktiv && setVoll((alt) => ({ ...alt, [f.fassung]: f })))
        .catch(() => undefined);
    }
    // Rückfall (IP-17), solange die Route `frist`/`anstoesse` noch nicht liefert (Nachlese 3).
    if (F.laufendeFassung(basis.fassungen) && basis.frist === undefined) {
      api
        .bezugsbasisUebersicht()
        .then((u) => aktiv && setZustand(u.faellig.find((z) => z.bezugsbasis_id === basis.id) ?? null))
        .catch(() => undefined);
    }
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kennzahlId, basis.id, schluessel]);
  const karten: Karte[] = F.zeitleiste(basis.fassungen).map((k) => ({ ...k, ...(voll[k.fassung] ?? {}) }));
  return { karten, voll, zustand };
}

/**
 * Die Fassungen einer Bezugsbasis im Reiter (UEMS AP-17 IP-18, §5.5, R5/R7/R13): Frist-Zeile, Anstoß-Kasten mit den drei
 * Antworten (Fassung n + 1 · beenden · geprüft, bleibt — nur mit `bezugsbasis.verwalten`; Leser sehen den Kasten ohne
 * Knöpfe), die Zeitleiste (neueste oben; Fassung n bleibt sichtbar) mit Zustand, Gültigkeit, Freigeber,
 * Anpassungsgründen und statischen Faktoren. Der Grenz-Satz des Reiters steht einmal im Reiter; die Dialoge tragen ihn.
 */
export function BezugsbasisFassungen({
  kennzahl,
  basis,
  zone,
  verwalten,
  freigeben,
  onNeu,
  onAssistent,
}: {
  kennzahl: Kennzahl;
  basis: Bezugsbasis;
  zone: string;
  /** `bezugsbasis.verwalten` an der Geltung und die Kennzahl nicht archiviert. */
  verwalten: boolean;
  freigeben: boolean;
  onNeu: () => void;
  onAssistent: (neu: NeueFassung | null) => void;
}) {
  const { karten, voll, zustand } = useFassungen(kennzahl.id, basis);
  const [dialog, setDialog] = useState<'neu' | 'beenden' | 'bleibt' | null>(null);
  const laufend = F.laufendeFassung(karten);
  const offen = F.offeneFassung(karten);
  const anstoesse = F.offeneAnstoesse(basis.anstoesse, laufend?.fassung ?? null);
  const anstossLiegtVor = anstoesse.length > 0 || (basis.anstoesse === undefined && zustand?.anstoss_liegt_vor === true);
  const frist = F.fristZeile(basis, laufend, zustand);
  const pflege = verwalten && laufend !== null && basis.beendet_zum === null;

  const Antworten = () =>
    pflege ? (
      <div className="vp-kz-aktionen" data-testid="bezugsbasis-antworten">
        <Button size="sm" data-testid="bezugsbasis-neue-fassung-knopf" disabled={offen !== null} onClick={() => setDialog('neu')}>
          {F.KNOPF_NEUE_FASSUNG}
        </Button>
        <Button size="sm" variant="outline" data-testid="bezugsbasis-beenden-knopf" onClick={() => setDialog('beenden')}>
          {F.KNOPF_BEENDEN}
        </Button>
        <Button size="sm" variant="outline" data-testid="bezugsbasis-bleibt-knopf" onClick={() => setDialog('bleibt')}>
          {F.KNOPF_BLEIBT}
        </Button>
      </div>
    ) : null;

  return (
    <div className="vp-bb-pflege">
      {frist && (
        <p className="vp-bb-frist" data-testid="bezugsbasis-frist">
          {frist}
        </p>
      )}
      {anstossLiegtVor && laufend ? (
        <div className="vp-bb-anstoss" role="note" aria-label={F.ANSTOSS_TITEL} data-testid="bezugsbasis-anstoss">
          <p className="vp-bb-label">{F.ANSTOSS_TITEL}</p>
          {anstoesse.length > 0 ? (
            <ul>
              {anstoesse.map((a, i) => (
                <li key={`${a.art}-${a.zeitpunkt}-${i}`}>{F.anstossSatz(basis, a)}</li>
              ))}
            </ul>
          ) : (
            <p>{F.anstossOhneAnlass(basis, laufend.fassung)}</p>
          )}
          <p className="vp-kz-leise">{F.ANTWORT_HINWEIS}</p>
          {Antworten()}
        </div>
      ) : (
        Antworten()
      )}
      {offen && pflege && <p className="vp-kz-leise">{`Fassung ${offen.fassung} ist noch ${B.FREIGABE_WORT[offen.freigabe_status]} — eine neue Fassung entsteht erst nach ihrer Entscheidung.`}</p>}
      <h3 className="vp-bb-titel">{F.FASSUNGEN_TITEL}</h3>
      <ol className="vp-bb-fassungen">
        {karten.map((f) => (
          <FassungKarte
            key={f.fassung}
            kennzahl={kennzahl}
            basis={basis}
            f={f}
            verwalten={verwalten}
            freigeben={freigeben}
            onNeu={onNeu}
            onBearbeiten={() => {
              const v = voll[f.fassung];
              // Ab Fassung 2 trägt jede Bildung ihre Anpassung — der Entwurf nimmt seine Gründe mit (A1, F4).
              if (f.fassung > 1 && v) {
                const vorgaengerin = voll[f.fassung - 1] ?? null;
                onAssistent({ anpassung: F.anpassungAus(v), vorgaengerin, vorbelegung: F.vorbelegung(v) });
              } else onAssistent(null);
            }}
          />
        ))}
      </ol>
      {dialog === 'neu' && laufend && (
        <NeueFassungDialog
          onClose={() => setDialog(null)}
          onWeiter={(anpassung) => {
            setDialog(null);
            const n = voll[laufend.fassung] ?? null;
            onAssistent({ anpassung, vorgaengerin: n, vorbelegung: n ? F.vorbelegung(n) : null });
          }}
        />
      )}
      {dialog === 'beenden' && (
        <BeendenDialog kennzahl={kennzahl} basis={basis} zone={zone} onClose={() => setDialog(null)} onFertig={onNeu} />
      )}
      {dialog === 'bleibt' && laufend && (
        <BleibtDialog kennzahl={kennzahl} basis={basis} fassung={laufend.fassung} onClose={() => setDialog(null)} onFertig={onNeu} />
      )}
    </div>
  );
}

function FassungKarte({
  kennzahl,
  basis,
  f,
  verwalten,
  freigeben,
  onNeu,
  onBearbeiten,
}: {
  kennzahl: Kennzahl;
  basis: Bezugsbasis;
  f: Karte;
  verwalten: boolean;
  freigeben: boolean;
  onNeu: () => void;
  onBearbeiten: () => void;
}) {
  const zustand = F.fassungZustand(f);
  const wer = f.freigabe !== undefined ? F.freigeberText({ freigabe_status: f.freigabe_status, freigabe: f.freigabe, entscheidung: f.entscheidung, freigegeben_am: f.freigegeben_am }) : null;
  const anpassung = F.anpassungText(f);
  const wert = f.basiswert
    ? F.wertText({ methode: f.methode, basiswert: f.basiswert, koeffizienten: f.koeffizienten, streuung_prozent: f.streuung_prozent, variablen: f.variablen ?? [] }, kennzahl.einheit_anzeige)
    : B.methodeWort(f.methode);
  return (
    <li className={`vp-bb-fassung is-${zustand}`} data-testid={`bezugsbasis-fassung-${f.fassung}`}>
      <p>
        <strong>Fassung {f.fassung}</strong> · {B.referenzperiodeText(f.referenzperiode)} <Badge variant={F.zustandTon(zustand)}>{F.ZUSTAND_WORT[zustand]}</Badge>
      </p>
      <p>
        {wert}
        {f.datenlage === 'vorlaeufig' ? ' · vorläufig' : ''} · {F.geltungText({ gilt_ab: f.gilt_ab, gilt_bis: f.gilt_bis ?? null })}
      </p>
      {wer && <p className="vp-kz-leise">{wer}</p>}
      {anpassung && <p data-testid={`bezugsbasis-anpassung-${f.fassung}`}>{anpassung}</p>}
      {f.fassung > 1 && f.begruendung && <p className="vp-kz-leise">{`${B.BEGRUENDUNG}: ${f.begruendung}`}</p>}
      {f.freigabe_status === 'abgelehnt' && f.entscheidungs_begruendung && <p className="vp-kz-leise">{`Abgelehnt, weil: ${f.entscheidungs_begruendung}`}</p>}
      {(f.faktoren ?? []).length > 0 && (
        <div className="vp-bb-faktoren" data-testid={`bezugsbasis-faktoren-${f.fassung}`}>
          <p className="vp-bb-label">{F.FAKTOREN_TITEL}</p>
          <ul>
            {(f.faktoren ?? []).map((x) => (
              <li key={x.position}>{F.faktorSatz(x)}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="vp-kz-leise">Prüfsumme {B.pruefsummeKurz(f.pruefsumme)}</p>
      {f.freigabe_status === 'entwurf' && verwalten && (
        <div className="vp-kz-aktionen">
          <Button variant="outline" size="sm" data-testid="bezugsbasis-bearbeiten-knopf" onClick={onBearbeiten}>
            {B.KNOPF_WEITER_BEARBEITEN}
          </Button>
        </div>
      )}
      {f.freigabe_status === 'entwurf' && freigeben && (
        <FreigabeFormular kennzahl={kennzahl} basis={basis} fassung={f.fassung} art="entwurf" vieraugen={f.vieraugen ?? null} onFertig={onNeu} />
      )}
      {f.freigabe_status === 'beantragt' && freigeben && (
        <FreigabeFormular kennzahl={kennzahl} basis={basis} fassung={f.fassung} art="antrag" vieraugen={f.vieraugen ?? null} onFertig={onNeu} />
      )}
    </li>
  );
}

/** Die Vorschau alt/neu (§5.5) im Schritt „Vorschau“ des Assistenten — Fassung n neben dem gespeicherten Entwurf. */
export function VorschauAltNeu({ alt, neu, einheit }: { alt: BezugsbasisFassung; neu: BezugsbasisFassung; einheit: string | null }) {
  return (
    <div className="vp-bb-altneu" data-testid="bezugsbasis-alt-neu">
      <p className="vp-bb-label">{F.VORSCHAU_ALT_NEU}</p>
      <table>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">Fassung {alt.fassung}</th>
            <th scope="col">Fassung {neu.fassung}</th>
          </tr>
        </thead>
        <tbody>
          {F.vorschauAltNeu(alt, neu, einheit).map((z) => (
            <tr key={z.wort} className={z.anders ? 'is-anders' : undefined}>
              <th scope="row">{z.wort}</th>
              <td data-label={`Fassung ${alt.fassung}`}>{z.alt}</td>
              <td data-label={`Fassung ${neu.fassung}`}>{z.neu}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Begruendung({ id, wert, onWert, fehler }: { id: string; wert: string; onWert: (t: string) => void; fehler: string | null }) {
  return (
    <div className="vp-bb-freigabe">
      <label className="vp-bb-label" htmlFor={id}>
        {B.BEGRUENDUNG}
      </label>
      <textarea id={id} rows={3} value={wert} onChange={(e) => onWert(e.target.value)} aria-invalid={!!fehler} />
      {fehler && (
        <p className="vp-alert vp-alert-err" role="alert">
          {fehler}
        </p>
      )}
    </div>
  );
}

/** Fassung n + 1, erster Schritt: Anpassungsgründe (A1, mehrere; `sonstiger` mit Wortlaut), Begründung, `gilt_ab`. */
export function NeueFassungDialog({ onClose, onWeiter }: { onClose: () => void; onWeiter: (a: F.Anpassung) => void }) {
  const [a, setA] = useState<F.Anpassung>({ gruende: [], wortlaut: '', begruendung: '', giltAb: '' });
  const [geprueft, setGeprueft] = useState(false);
  const fehler = F.anpassungFehler(a);
  const zeige = (t: string | null) => (geprueft ? t : null);
  const weiter = () => {
    setGeprueft(true);
    if (!fehler.gruende && !fehler.wortlaut && !fehler.begruendung) onWeiter(a);
  };
  const umschalten = (g: string) => setA((x) => ({ ...x, gruende: x.gruende.includes(g) ? x.gruende.filter((y) => y !== g) : [...x.gruende, g] }));
  return (
    <Modal
      open
      onClose={onClose}
      title={F.TITEL_NEUE_FASSUNG}
      footer={
        <div className="vp-gw-foot vp-bb-fuss">
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button data-testid="bezugsbasis-anpassung-weiter" onClick={weiter}>
            {F.KNOPF_WEITER_ZUM_ASSISTENTEN}
          </Button>
        </div>
      }
    >
      <div className="vp-gw vp-bb-assistent" data-testid="bezugsbasis-neue-fassung">
        <fieldset className="vp-bb-gruende">
          <legend className="vp-bb-label">{F.ANPASSUNGSGRUENDE_TITEL}</legend>
          <ul className="vp-bb-wahl">
            {F.ANPASSUNGSGRUENDE.map((g) => (
              <li key={g}>
                <label className="vp-bb-option">
                  <input type="checkbox" name="bezugsbasis-anpassungsgrund" value={g} checked={a.gruende.includes(g)} onChange={() => umschalten(g)} />
                  <span>{F.grundWort(g)}</span>
                </label>
              </li>
            ))}
          </ul>
          {zeige(fehler.gruende) && (
            <p className="vp-alert vp-alert-err" role="alert">
              {fehler.gruende}
            </p>
          )}
        </fieldset>
        {a.gruende.includes('sonstiger') && (
          <Input label="Sonstiger Grund" value={a.wortlaut} onChange={(e) => setA({ ...a, wortlaut: e.target.value })} error={zeige(fehler.wortlaut) ?? undefined} />
        )}
        <Begruendung id="bb-neue-fassung-begruendung" wert={a.begruendung} onWert={(t) => setA({ ...a, begruendung: t })} fehler={zeige(fehler.begruendung)} />
        <VpDatePicker label="Gilt ab (wahlfrei)" value={a.giltAb || null} onChange={(t) => setA({ ...a, giltAb: t })} hint={F.GILT_AB_HINWEIS} />
        <p className="vp-kz-leise">{B.ENTWURF_HINWEIS}</p>
        <p className="vp-bb-grenze">{UEMS_NORMGRENZE}</p>
      </div>
    </Modal>
  );
}

/** F4: beenden mit Tag (letzter eingeschlossener), Grund aus A1 und Begründung; vor heute rückwirkend. */
export function BeendenDialog({
  kennzahl,
  basis,
  zone,
  onClose,
  onFertig,
}: {
  kennzahl: Pick<Kennzahl, 'id'>;
  basis: Pick<Bezugsbasis, 'id' | 'kennzeichen'>;
  zone: string;
  onClose: () => void;
  onFertig: () => void;
}) {
  const heute = heuteIn(zone, Date.now());
  const [b, setB] = useState({ tag: heute, grund: '', begruendung: '' });
  const [geprueft, setGeprueft] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [ergebnis, setErgebnis] = useState<BezugsbasisZustand | null>(null);
  const f = F.beendenFehler(b);
  const zeige = (t: string | null) => (geprueft ? t : null);
  const rueck = F.rueckwirkend(b.tag, heute);
  const senden = async () => {
    setGeprueft(true);
    if (f.tag || f.grund || f.begruendung) return;
    setLaeuft(true);
    setFehler(null);
    try {
      setErgebnis(await api.bezugsbasisBeenden(kennzahl.id, basis.id, { tag: b.tag, grund: b.grund, begruendung: b.begruendung.trim(), ...(rueck ? { rueckwirkend: true } : {}) }));
    } catch (e) {
      setFehler(pflegeSatz(e));
    } finally {
      setLaeuft(false);
    }
  };
  const schliessen = () => {
    if (ergebnis) onFertig();
    onClose();
  };
  return (
    <Modal
      open
      onClose={schliessen}
      title={F.TITEL_BEENDEN}
      footer={
        <div className="vp-gw-foot vp-bb-fuss">
          <Button variant="ghost" onClick={schliessen}>
            {ergebnis ? 'Fertig' : 'Abbrechen'}
          </Button>
          {!ergebnis && (
            <Button data-testid="bezugsbasis-beenden-senden" disabled={laeuft} onClick={senden}>
              {F.TITEL_BEENDEN}
            </Button>
          )}
        </div>
      }
    >
      <div className="vp-gw vp-bb-assistent" data-testid="bezugsbasis-beenden">
        {ergebnis ? (
          <p className="vp-bb-erfolg" role="status" data-testid="bezugsbasis-beendet">
            {F.nachBeendenSatz(ergebnis) ?? `${basis.kennzeichen} ist beendet.`}
          </p>
        ) : (
          <>
            <VpDatePicker label="Letzter Tag" value={b.tag || null} onChange={(t) => setB({ ...b, tag: t })} error={zeige(f.tag) ?? undefined} hint={rueck ? F.RUECKWIRKEND_HINWEIS : undefined} />
            <VpPicker
              label="Grund"
              options={F.ANPASSUNGSGRUENDE.map((g) => ({ value: g, label: F.grundWort(g) }))}
              value={b.grund || null}
              onChange={(g) => setB({ ...b, grund: g ?? '' })}
              error={zeige(f.grund)}
            />
            <Begruendung id="bb-beenden-begruendung" wert={b.begruendung} onWert={(t) => setB({ ...b, begruendung: t })} fehler={zeige(f.begruendung)} />
            <p className="vp-kz-leise">{F.BEENDEN_HINWEIS}</p>
          </>
        )}
        {fehler && (
          <p className="vp-alert vp-alert-err" role="alert" data-testid="bezugsbasis-pflege-fehler">
            {fehler}
          </p>
        )}
        <p className="vp-bb-grenze">{UEMS_NORMGRENZE}</p>
      </div>
    </Modal>
  );
}

/** F5/A4: „geprüft, bleibt“ mit Begründung — die Fassung bleibt byte-gleich, die Frist beginnt neu. */
export function BleibtDialog({
  kennzahl,
  basis,
  fassung,
  onClose,
  onFertig,
}: {
  kennzahl: Pick<Kennzahl, 'id'>;
  basis: Pick<Bezugsbasis, 'id'>;
  fassung: number;
  onClose: () => void;
  onFertig: () => void;
}) {
  const [text, setText] = useState('');
  const [geprueft, setGeprueft] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [ergebnis, setErgebnis] = useState<BezugsbasisZustand | null>(null);
  const eingabe = B.begruendungFehler(text);
  const senden = async () => {
    setGeprueft(true);
    if (eingabe) return;
    setLaeuft(true);
    setFehler(null);
    try {
      setErgebnis(await api.bezugsbasisBleibt(kennzahl.id, basis.id, text.trim()));
    } catch (e) {
      setFehler(pflegeSatz(e));
    } finally {
      setLaeuft(false);
    }
  };
  const schliessen = () => {
    if (ergebnis) onFertig();
    onClose();
  };
  return (
    <Modal
      open
      onClose={schliessen}
      title={`${F.TITEL_BLEIBT}: Fassung ${fassung}`}
      footer={
        <div className="vp-gw-foot vp-bb-fuss">
          <Button variant="ghost" onClick={schliessen}>
            {ergebnis ? 'Fertig' : 'Abbrechen'}
          </Button>
          {!ergebnis && (
            <Button data-testid="bezugsbasis-bleibt-senden" disabled={laeuft} onClick={senden}>
              {F.KNOPF_BLEIBT}
            </Button>
          )}
        </div>
      }
    >
      <div className="vp-gw vp-bb-assistent" data-testid="bezugsbasis-bleibt">
        {ergebnis ? (
          <p className="vp-bb-erfolg" role="status" data-testid="bezugsbasis-geprueft">
            {F.nachBleibtSatz(ergebnis)}
          </p>
        ) : (
          <>
            <Begruendung id="bb-bleibt-begruendung" wert={text} onWert={setText} fehler={geprueft ? eingabe : null} />
            <p className="vp-kz-leise">{F.BLEIBT_HINWEIS}</p>
          </>
        )}
        {fehler && (
          <p className="vp-alert vp-alert-err" role="alert" data-testid="bezugsbasis-pflege-fehler">
            {fehler}
          </p>
        )}
        <p className="vp-bb-grenze">{UEMS_NORMGRENZE}</p>
      </div>
    </Modal>
  );
}
