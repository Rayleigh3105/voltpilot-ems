import { useEffect, useId, useState, type FormEvent } from 'react';
import { GrenzSatz } from './GrenzSatz';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  type BewertungKriterienFassung,
  type BewertungKriterienWerte,
  type BewertungRanglisteEinsatz,
  type EnergieeinsatzEinstufungFassung,
} from '../api';
import { ABBRECHEN, einstufungText, prozentText, SPEICHERN, tag, zahlMitEinheit } from '../bewertung';
import {
  GRUND_WOERTER,
  gruendeText,
  KRITERIEN_EINLEITUNG,
  KRITERIEN_REIHENFOLGE,
  kriterienAenderungen,
  kriterienAntrag,
  kriterienFeldLabel,
  kriterienMeldung,
  kriterienSaetze,
  kriterienStartwert,
  vorbehaltSaetze,
  vorschlagBild,
  vorschlagSatz,
  zeitraumText,
} from '../bewertungErgebnis';
import { UEMS_WIE_VOLTPILOT_VORSCHLAEGT } from '../glossar';
import './BewertungErgebnis.css';

const fehlerText = (e: unknown) => e instanceof Error && e.message ? e.message : 'Das hat gerade nicht geklappt. Bitte versuchen Sie es noch einmal.';

export function EinstufungDialog({
  einsatz,
  onClose,
  onGespeichert,
}: {
  einsatz: BewertungRanglisteEinsatz;
  onClose: () => void;
  onGespeichert: (fassung: EnergieeinsatzEinstufungFassung) => void;
}) {
  const basis = `be-${useId().replace(/:/g, '')}`;
  // Ohne Messwerte gibt es keinen Vorschlag: dann weicht keine Wahl davon ab, und vorbelegt ist nichts Erfundenes.
  const bild = vorschlagBild(einsatz);
  const vorschlag = bild?.wesentlich ? 'wesentlich' : 'nicht_wesentlich';
  const [wahl, setWahl] = useState<'wesentlich' | 'nicht_wesentlich'>(vorschlag);
  const [grund, setGrund] = useState<('K1' | 'K2' | 'K3' | 'K4')[]>(() =>
    (['K1', 'K2', 'K3'] as const).filter((k) => einsatz.urteil[k] === 'ueber_schwelle'));
  const [begruendung, setBegruendung] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abweichung = bild !== null && wahl !== vorschlag;
  const vorbehalte = vorbehaltSaetze(einsatz);
  const grundlage = zeitraumText(einsatz.herkunft.zeitraum);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    if (!begruendung.trim()) {
      setFehler(abweichung ? 'Bitte begründen Sie ausdrücklich, warum Ihre Einstufung vom Vorschlag abweicht.' : 'Bitte geben Sie eine Begründung an.');
      document.getElementById(`${basis}-begruendung`)?.focus();
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      onGespeichert(await api.energieeinsatzEinstufen(einsatz.id, {
        einstufung: wahl, begruendung: begruendung.trim(), grund, herkunft: einsatz.herkunft,
      }));
    } catch (e) {
      setFehler(fehlerText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`${einsatz.name} einstufen`} footer={<>
      <Button variant="ghost" onClick={onClose}>{ABBRECHEN}</Button>
      <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="einstufung-speichern">{SPEICHERN}</Button>
    </>}>
      <form id={`${basis}-form`} className="vp-bw-form" noValidate onSubmit={(e) => void senden(e)} data-testid="einstufung-dialog">
        <div className="vp-be-vorschlag" data-testid="einstufung-vorschlag">
          <p className="vp-be-vorschlag-satz">{vorschlagSatz(einsatz)}</p>
          <p className="vp-be-leise">
            {[einsatz.kennzeichen, einsatz.anteil_prozent !== null ? `${prozentText(einsatz.anteil_prozent)} des Stroms` : null,
              einsatz.menge !== null ? zahlMitEinheit(einsatz.menge, einsatz.einheit) : null, grundlage].filter(Boolean).join(' · ')}
          </p>
          {vorbehalte.map((s) => <p key={s} className="vp-be-leise">{s}</p>)}
        </div>
        <fieldset className="vp-bw-gruppe">
          <legend>Einstufung</legend>
          <label className="vp-bw-wahl"><input type="radio" name={`${basis}-wahl`} checked={wahl === 'wesentlich'} onChange={() => setWahl('wesentlich')} /> wesentlich</label>
          <label className="vp-bw-wahl"><input type="radio" name={`${basis}-wahl`} checked={wahl === 'nicht_wesentlich'} onChange={() => setWahl('nicht_wesentlich')} /> nicht wesentlich</label>
        </fieldset>
        <fieldset className="vp-bw-gruppe">
          <legend>Gründe</legend>
          {(['K1', 'K2', 'K3', 'K4'] as const).map((k) => <label className="vp-bw-wahl" key={k}>
            <input type="checkbox" checked={grund.includes(k)} onChange={(e) => setGrund(e.target.checked ? [...grund, k] : grund.filter((x) => x !== k))} /> {GRUND_WOERTER[k]}
          </label>)}
        </fieldset>
        {abweichung && <p className="vp-alert vp-alert-warn" role="note" data-testid="abweichung-hinweis">
          Ihre Wahl weicht vom Vorschlag „{vorschlag === 'wesentlich' ? 'wesentlich' : 'nicht wesentlich'}“ ab. Die Begründung muss diese Abweichung ausdrücklich erklären.
        </p>}
        <label className="vp-bw-textarea-label" htmlFor={`${basis}-begruendung`}>Begründung</label>
        <textarea id={`${basis}-begruendung`} value={begruendung} onChange={(e) => setBegruendung(e.target.value)} aria-invalid={!!fehler} rows={4} />
        {fehler && <p className="vp-alert vp-alert-err" role="alert">{fehler}</p>}
        <p className="vp-bw-leise">Speichern legt eine neue Fassung an. Bei Vier-Augen bleibt sie vorgeschlagen und wartet auf Bestätigung.</p>
        <details className="vp-be-herkunft">
          <summary>Woher die Zahlen kommen</summary>
          <p>Kriterien-Fassung {einsatz.herkunft.kriterien_fassung}{grundlage ? ` · ${grundlage}` : ''}</p>
          <ul>{einsatz.herkunft.eingaenge.map((x, i) => <li key={`${x.objekt}-${i}`}>{x.objekt}: {zahlMitEinheit(x.wert, einsatz.einheit)} · Version {x.version ?? 'fehlt'} · {x.zustand ?? 'Zustand fehlt'}</li>)}</ul>
          {einsatz.herkunft.nenner && <>
            <p>Strom aller Anlagen: {zahlMitEinheit(einsatz.herkunft.nenner.wert, 'kWh')} · {einsatz.herkunft.nenner.anlagen} Anlagen</p>
            <ul>{einsatz.herkunft.nenner.bilanzwerte.map((x, i) => <li key={`${x.anlage}-${i}`}>{x.anlage}: {zahlMitEinheit(x.wert, 'kWh')} · Version {x.version} · {x.zustand}</li>)}</ul>
          </>}
        </details>
        <GrenzSatz className="vp-bw-grenze" />
      </form>
    </Modal>
  );
}

export function KriterienDialog({ onClose, onGespeichert }: { onClose: () => void; onGespeichert: (f: BewertungKriterienFassung) => void }) {
  const basis = `bk-${useId().replace(/:/g, '')}`;
  const [fassung, setFassung] = useState<BewertungKriterienFassung | null>(null);
  const [werte, setWerte] = useState<BewertungKriterienWerte | null>(null);
  const [begruendung, setBegruendung] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.bewertungKriterien().then((f) => { setFassung(f); setWerte({ ...f.werte }); }, (e) => setFehler(fehlerText(e))); }, []);
  async function senden(ev: FormEvent) {
    ev.preventDefault();
    if (!werte) return;
    if (!begruendung.trim()) {
      setFehler('Bitte geben Sie eine Begründung an.');
      document.getElementById(`${basis}-begruendung`)?.focus();
      return;
    }
    setBusy(true); setFehler(null);
    try { onGespeichert(await api.bewertungKriterienSpeichern({ werte, begruendung: begruendung.trim() })); }
    catch (e) { setFehler(fehlerText(e)); }
    finally { setBusy(false); }
  }
  return <Modal open onClose={onClose} title="Kriterien ändern" footer={<>
    <Button variant="ghost" onClick={onClose}>{ABBRECHEN}</Button>
    <Button type="submit" form={`${basis}-form`} disabled={busy || !werte} data-testid="kriterien-speichern">{SPEICHERN}</Button>
  </>}>
    <form id={`${basis}-form`} className="vp-bw-form" noValidate onSubmit={(e) => void senden(e)} data-testid="kriterien-dialog">
      {fassung && werte ? <>
        <p>{KRITERIEN_EINLEITUNG}</p>
        <p className="vp-bw-leise">Es gilt Fassung {fassung.fassung}{fassung.gueltig_ab ? ` seit ${tag(fassung.gueltig_ab)}` : ' mit den Startwerten von VoltPilot'}. Neue Kriterien ändern nur den Vorschlag, keine Einstufung.</p>
        <div className="vp-bw-kriterien">
          {KRITERIEN_REIHENFOLGE.map((k) => <div className="vp-bw-kriterium" key={k}>
            <Input id={`${basis}-${k}`} label={kriterienFeldLabel(k)} type="number" min="0" step={k === 'K7' || k === 'mindest_monate' ? '1' : '0.1'} value={werte[k]}
              onChange={(e) => setWerte({ ...werte, [k]: k === 'K7' || k === 'mindest_monate' ? Number(e.target.value) : e.target.value })}
              hint={kriterienStartwert(k)} />
          </div>)}
        </div>
        <label className="vp-bw-textarea-label" htmlFor={`${basis}-begruendung`}>Begründung</label>
        <textarea id={`${basis}-begruendung`} value={begruendung} onChange={(e) => setBegruendung(e.target.value)} rows={4} aria-invalid={!!fehler} />
      </> : !fehler && <p>Kriterien werden geladen …</p>}
      {fehler && <p className="vp-alert vp-alert-err" role="alert">{fehler}</p>}
      <GrenzSatz className="vp-bw-grenze" />
    </form>
  </Modal>;
}

/** Die Ablehnung einer beantragten Kriterien-Fassung: nur mit Begründung (422 `begruendung_fehlt`). */
function KriterienAblehnenDialog({ fassung, onClose, onAbgelehnt }: {
  fassung: BewertungKriterienFassung; onClose: () => void; onAbgelehnt: (f: BewertungKriterienFassung) => void;
}) {
  const basis = `ba-${useId().replace(/:/g, '')}`;
  const [begruendung, setBegruendung] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function senden(ev: FormEvent) {
    ev.preventDefault();
    if (!begruendung.trim()) {
      setFehler('Bitte begründen Sie die Ablehnung.');
      document.getElementById(`${basis}-begruendung`)?.focus();
      return;
    }
    setBusy(true); setFehler(null);
    try { onAbgelehnt(await api.bewertungKriterienAblehnen(fassung.fassung, begruendung.trim())); }
    catch (e) { setFehler(fehlerText(e)); }
    finally { setBusy(false); }
  }
  return <Modal open onClose={onClose} title="Neue Kriterien ablehnen" footer={<>
    <Button variant="ghost" onClick={onClose}>{ABBRECHEN}</Button>
    <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="kriterien-ablehnen-senden">Ablehnen</Button>
  </>}>
    <form id={`${basis}-form`} className="vp-bw-form" noValidate onSubmit={(e) => void senden(e)} data-testid="kriterien-ablehnen-dialog">
      <p>Abgelehnt gelten weiter die bisherigen Kriterien. Die Person, die sie beantragt hat, liest Ihre Begründung in der Fassung.</p>
      <label className="vp-bw-textarea-label" htmlFor={`${basis}-begruendung`}>Begründung</label>
      <textarea id={`${basis}-begruendung`} value={begruendung} onChange={(e) => setBegruendung(e.target.value)} rows={4} aria-invalid={!!fehler} />
      {fehler && <p className="vp-alert vp-alert-err" role="alert">{fehler}</p>}
    </form>
  </Modal>;
}

/**
 * „Wie VoltPilot vorschlägt“ (Konzept Auswerten a1 §6.7, Befund 6): die Kriterien in Worten, „Kriterien ändern“ und —
 * mit Vier-Augen — die beantragte Fassung mit „Freigeben“ und „Ablehnen“ für eine zweite Person. Die Meldung nach dem
 * Speichern folgt dem Status der Fassung: gilt sie, oder wartet sie? Die Karte liest ihre Fassungen selbst; nach jeder
 * Änderung lädt die Seite den Vorschlag neu (`onGeaendert`).
 */
export function KriterienKarte({ darfAendern, ich, anstoss, onGeaendert }: {
  darfAendern: boolean;
  /** Die angemeldete Person (`/me`): wer beantragt hat, entscheidet nicht selbst. */
  ich: string | null;
  /** R15: der Satz zum Anstoß am freigegebenen Bewertungsstand, wenn neue Kriterien gelten. */
  anstoss: string | null;
  onGeaendert: () => void;
}) {
  const [lage, setLage] = useState<{ wirksam: BewertungKriterienFassung; beantragt: BewertungKriterienFassung | null } | null>(null);
  const [fehler, setFehler] = useState(false);
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState<'aendern' | 'ablehnen' | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [entscheidFehler, setEntscheidFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let aktiv = true;
    setFehler(false);
    Promise.all([api.bewertungKriterien(), api.bewertungKriterienHistorie()]).then(
      ([wirksam, h]) => aktiv && setLage({ wirksam, beantragt: h.fassungen.find((f) => f.freigabe_status === 'beantragt') ?? null }),
      () => aktiv && setFehler(true),
    );
    return () => { aktiv = false; };
  }, [version]);

  const fertig = (f: BewertungKriterienFassung) => {
    setMeldung(kriterienMeldung(f, f.freigabe_status === 'freigegeben' ? anstoss : null));
    setDialog(null);
    setVersion((v) => v + 1);
    onGeaendert();
  };

  async function freigeben(f: BewertungKriterienFassung) {
    setBusy(true); setEntscheidFehler(null);
    try { fertig(await api.bewertungKriterienFreigeben(f.fassung)); }
    catch (e) { setEntscheidFehler(fehlerText(e)); }
    finally { setBusy(false); }
  }

  const antrag = lage?.beantragt ? kriterienAntrag(lage.beantragt, { sub: ich, darf: darfAendern }) : null;
  const saetze = lage ? kriterienSaetze(lage.wirksam) : null;

  return (
    <section className="vp-be-karte" aria-labelledby="be-kriterien" data-testid="bewertung-kriterien">
      <div className="vp-be-blockkopf">
        <h2 id="be-kriterien">{UEMS_WIE_VOLTPILOT_VORSCHLAEGT}</h2>
        {darfAendern && lage && !lage.beantragt && (
          <button type="button" className="vp-be-link" onClick={() => { setMeldung(null); setDialog('aendern'); }} data-testid="kriterien-oeffnen">
            Kriterien ändern
          </button>
        )}
      </div>
      {meldung && <p className="vp-be-meldung" role="status" data-testid="kriterien-hinweis">{meldung}</p>}
      {fehler ? (
        <p className="vp-be-leise" role="status">
          Die Kriterien ließen sich gerade nicht laden.{' '}
          <button type="button" className="vp-be-link" onClick={() => setVersion((v) => v + 1)}>Erneut versuchen</button>
        </p>
      ) : !lage || !saetze ? (
        <span className="vp-skeleton is-zeile" aria-busy="true" />
      ) : (
        <>
          {lage.beantragt && antrag && (
            <div className="vp-be-hinweis is-warn" data-testid="kriterien-antrag">
              <span className="vp-be-hinweis-icon" aria-hidden="true"><Icon name="info" size={18} /></span>
              <div className="vp-be-hinweis-text">
                <b>Neue Kriterien warten auf Freigabe</b>
                <ul className="vp-be-aenderungen">
                  {kriterienAenderungen(lage.wirksam.werte, lage.beantragt.werte).map((z) => <li key={z}>{z}</li>)}
                </ul>
                <span>{antrag.satz}</span>
                {antrag.wer && <span>{antrag.wer}</span>}
                {antrag.darfEntscheiden && (
                  <span className="vp-be-knoepfe">
                    <Button size="sm" disabled={busy} onClick={() => void freigeben(lage.beantragt!)} data-testid="kriterien-freigeben">Freigeben</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDialog('ablehnen')} data-testid="kriterien-ablehnen">Ablehnen</Button>
                  </span>
                )}
                {entscheidFehler && <span className="vp-alert vp-alert-err" role="alert">{entscheidFehler}</span>}
              </div>
            </div>
          )}
          <p className="vp-be-satz">{KRITERIEN_EINLEITUNG}</p>
          <ul className="vp-be-krit">
            {saetze.saetze.map((s) => (
              <li key={s}>
                <span className="vp-be-krit-ico" aria-hidden="true"><Icon name="check" size={15} /></span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
          <p className="vp-be-fussnote">{saetze.fussnote}</p>
        </>
      )}
      {dialog === 'aendern' && <KriterienDialog onClose={() => setDialog(null)} onGespeichert={fertig} />}
      {dialog === 'ablehnen' && lage?.beantragt && (
        <KriterienAblehnenDialog fassung={lage.beantragt} onClose={() => setDialog(null)} onAbgelehnt={fertig} />
      )}
    </section>
  );
}

export function EinstufungHistorie({ einsatzId, fassungen, darfBestaetigen, onBestaetigt }: {
  einsatzId: string; fassungen: EnergieeinsatzEinstufungFassung[]; darfBestaetigen: boolean; onBestaetigt?: (f: EnergieeinsatzEinstufungFassung) => void;
}) {
  const [fehler, setFehler] = useState<string | null>(null);
  // Die Karte steht auf der Einsatzseite UND im Änderungsprotokoll — die Überschrift braucht je Ort eine eigene Kennung.
  const kopf = useId();
  const offen = fassungen.find((f) => f.freigabe_status === 'beantragt');
  return <section className="vp-bw-karte" aria-labelledby={kopf} data-testid="einstufung-historie">
    <div className="vp-bw-karte-kopf"><h2 id={kopf}>Einstufung · Historie</h2>{offen && <Badge variant="tint">wartet auf Bestätigung</Badge>}</div>
    {fassungen.length === 0 ? <p className="vp-bw-leise">Noch keine Einstufung — der Vorschlag entscheidet nichts.</p> : <ol className="vp-bw-historie">
      {fassungen.map((f) => {
        // Nur was die Fassung trägt: ältere Fassungen ohne Herkunft drucken keine leeren Platzhalter.
        const grundlage = [
          f.grund.length ? `Gründe: ${gruendeText(f.grund)}` : 'Einschätzung der Person',
          zeitraumText(f.herkunft?.zeitraum) ? `Zahlen aus ${zeitraumText(f.herkunft.zeitraum)}` : null,
          f.herkunft?.kriterien_fassung ? `Kriterien-Fassung ${f.herkunft.kriterien_fassung}` : null,
        ].filter(Boolean).join(' · ');
        return <li key={f.fassung}>
          <p><strong>Fassung {f.fassung} · {einstufungText(f.einstufung)}</strong></p>
          <p>{f.gueltig_ab ? `gilt ab ${tag(f.gueltig_ab)}` : `vorgeschlagen am ${tag(f.vorgeschlagen_ab)}, wartet auf Bestätigung`} {f.rueckwirkend ? '· rückwirkend' : ''}</p>
          <p>{f.akteur.name}: „{f.begruendung}“</p>
          <p className="vp-bw-leise">{grundlage}</p>
        </li>;
      })}
    </ol>}
    {offen && darfBestaetigen && onBestaetigt && <Button size="sm" variant="outline" onClick={() => {
      setFehler(null); api.energieeinsatzEinstufungBestaetigen(einsatzId).then(onBestaetigt, (e) => setFehler(fehlerText(e)));
    }}>Einstufung bestätigen</Button>}
    {fehler && <p className="vp-alert vp-alert-err" role="alert">{fehler}</p>}
    <GrenzSatz className="vp-bw-grenze" />
  </section>;
}
