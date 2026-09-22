import { useEffect, useId, useState, type FormEvent } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  type BewertungKriterienFassung,
  type BewertungKriterienWerte,
  type BewertungRangliste,
  type BewertungRanglisteEinsatz,
  type EnergieeinsatzEinstufungFassung,
} from '../api';
import {
  ABBRECHEN,
  einstufungText,
  KRITERIEN_EINHEIT,
  KRITERIEN_NAMEN,
  prozentText,
  SPEICHERN,
  tag,
  urteilText,
  vorschlagText,
  zahlMitEinheit,
} from '../bewertung';
import { UEMS_NORMGRENZE } from '../glossar';
import { STARTWERTE } from '../uemsBewertung';

const fehlerText = (e: unknown) => e instanceof Error && e.message ? e.message : 'Das hat gerade nicht geklappt. Bitte versuchen Sie es noch einmal.';

export function RanglisteBereich({ rangliste, zeitraum, historien, darfEinstufen, darfKriterien, onEinstufung, onKriterien }: {
  rangliste: BewertungRangliste;
  zeitraum: string;
  historien: Record<string, EnergieeinsatzEinstufungFassung[]>;
  darfEinstufen: boolean;
  darfKriterien: boolean;
  onEinstufung: (id: string, f: EnergieeinsatzEinstufungFassung) => void;
  onKriterien: (f: BewertungKriterienFassung) => void;
}) {
  const [einstufen, setEinstufen] = useState<BewertungRanglisteEinsatz | null>(null);
  const [kriterien, setKriterien] = useState(false);
  const groesster = [...rangliste.anlagen].filter((a) => a.rest !== null).sort((a, b) => Number(b.rest) - Number(a.rest))[0];
  return <section className="vp-bw-rangliste" aria-labelledby="bw-rangliste" data-testid="rangliste">
    <div className="vp-bw-karte-kopf">
      <div><h2 id="bw-rangliste">Rangliste</h2><p className="vp-bw-leise">{zeitraum} · Kriterien-Fassung {rangliste.kriterien.fassung}</p></div>
      {darfKriterien && <Button size="sm" variant="outline" onClick={() => setKriterien(true)} data-testid="kriterien-oeffnen">Kriterien ändern</Button>}
    </div>
    <p className="vp-bw-rang-kopf">
      {rangliste.nenner.wert === null ? `Stromeinsatz ${zeitraum}: ohne vollständigen Nenner · ${rangliste.nenner.anlagen} Anlagen.` :
        `Stromeinsatz ${zeitraum}: ${zahlMitEinheit(rangliste.nenner.wert, 'kWh')} aus ${rangliste.nenner.anlagen} Anlagen · ${prozentText(rangliste.abdeckung_prozent)} Energieeinsätzen zugeordnet.`}
    </p>
    <p className="vp-bw-vorlaeufig">{urteilText(rangliste.urteil.K7)} · {rangliste.monate} von {rangliste.kriterien.werte.K7} Monaten</p>
    {rangliste.urteil.K7 === 'vorlaeufig' && <p className="vp-bw-leise">Datengrundlage {rangliste.monate} von {rangliste.kriterien.werte.K7} Monaten — vorläufig.</p>}
    {rangliste.einsaetze.length ? <div className="vp-bw-rang-scroll"><table className="vp-bw-rang-tabelle">
      <thead><tr><th>Rang</th><th>Energieeinsatz</th><th>Menge</th><th>Anteil</th><th>K1</th><th>K2</th><th>K3</th><th>K5</th><th>K6</th><th>Vorschlag</th><th>Einstufung</th></tr></thead>
      <tbody>{rangliste.einsaetze.map((e) => {
        const f = historien[e.id]?.[0];
        return <tr key={e.id} data-testid={`rang-${e.kennzeichen}`}>
          <td data-label="Rang">{e.rang ?? '—'}</td>
          <td data-label="Energieeinsatz"><strong>{e.kennzeichen} {e.name}</strong><span className="vp-bw-rang-balken"><i style={{ width: `${Math.min(100, Number(e.anteil_prozent ?? 0))}%` }} /></span></td>
          <td data-label="Menge">{zahlMitEinheit(e.menge, e.einheit)}</td><td data-label="Anteil">{prozentText(e.anteil_prozent)}</td>
          {(['K1', 'K2', 'K3'] as const).map((k) => <td key={k} data-label={k}>{urteilText(e.urteil[k])}</td>)}
          {(['K5', 'K6'] as const).map((k) => <td key={k} data-label={k}><Badge variant={e.urteil[k] === 'erfuellt' ? 'ok' : 'off'}>{urteilText(e.urteil[k])}</Badge></td>)}
          <td data-label="Vorschlag"><strong>{vorschlagText(e.vorschlag)}</strong></td>
          <td data-label="Einstufung">{f ? <><span>{einstufungText(f.einstufung)} · Fassung {f.fassung}</span>{f.freigabe_status === 'beantragt' && <small> vorgeschlagen, wartet auf Bestätigung</small>}</> : 'offen'}{darfEinstufen && <Button size="sm" variant="ghost" onClick={() => setEinstufen(e)}>Einstufen</Button>}</td>
        </tr>;
      })}
      <tr className="vp-bw-rest"><td>—</td><td><strong>nicht zugeordnet</strong></td><td>{zahlMitEinheit(rangliste.rest, 'kWh')}</td><td>{rangliste.rest && rangliste.nenner.wert ? prozentText(String(Number(rangliste.rest) / Number(rangliste.nenner.wert) * 100)) : '—'}</td><td colSpan={7}>K8 · {urteilText(rangliste.urteil.K8)}</td></tr>
      </tbody>
    </table></div> : <p className="vp-bw-leise">Noch keine Mengen für die Rangliste.</p>}
    {groesster && rangliste.rest && rangliste.nenner.wert && <p className="vp-bw-leise" data-testid="rest-satz">
      {zahlMitEinheit(rangliste.rest, 'kWh')} ({prozentText(String(Number(rangliste.rest) / Number(rangliste.nenner.wert) * 100))}) sind keinem Energieeinsatz zugeordnet — größter Block: {groesster.name} ({prozentText(groesster.rest_anteil_prozent)} der Anlage).
    </p>}
    <div className="vp-bw-rest-anlagen">{rangliste.anlagen.map((a) => <span key={a.id}>{a.name}: nicht zugeordnet {zahlMitEinheit(a.rest, 'kWh')}</span>)}</div>
    {rangliste.weitere_traeger.length > 0 && <div className="vp-bw-weitere" data-testid="weitere-traeger"><h3>Weitere Träger</h3>{rangliste.weitere_traeger.map((e) => <p key={e.id}><strong>{e.kennzeichen} {e.name}</strong>: {zahlMitEinheit(e.menge, e.einheit)} · ohne Anteil — {e.traeger} hat keinen gemeinsamen Nenner mit Strom.</p>)}</div>}
    {!darfEinstufen && <p className="vp-bw-leise">Sie sehen Rangliste, Vorschläge und Einstufungen. Einstufen können Kundenadministratoren und Energiemanager.</p>}
    <p className="vp-bw-grenze">{UEMS_NORMGRENZE}</p>
    {einstufen && <EinstufungDialog einsatz={einstufen} onClose={() => setEinstufen(null)} onGespeichert={(f) => { onEinstufung(einstufen.id, f); setEinstufen(null); }} />}
    {kriterien && <KriterienDialog onClose={() => setKriterien(false)} onGespeichert={(f) => { onKriterien(f); setKriterien(false); }} />}
  </section>;
}

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
  const vorschlag = einsatz.vorschlag === 'ueber_schwelle' ? 'wesentlich' : 'nicht_wesentlich';
  const [wahl, setWahl] = useState<'wesentlich' | 'nicht_wesentlich'>(vorschlag);
  const [grund, setGrund] = useState<('K1' | 'K2' | 'K3' | 'K4')[]>(einsatz.vorschlag === 'ueber_schwelle' ? ['K1'] : []);
  const [begruendung, setBegruendung] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abweichung = wahl !== vorschlag;

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
    <Modal open onClose={onClose} title={`${einsatz.kennzeichen} ${einsatz.name} einstufen`} footer={<>
      <Button variant="ghost" onClick={onClose}>{ABBRECHEN}</Button>
      <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="einstufung-speichern">{SPEICHERN}</Button>
    </>}>
      <form id={`${basis}-form`} className="vp-bw-form" noValidate onSubmit={(e) => void senden(e)} data-testid="einstufung-dialog">
        <div className="vp-bw-entscheidung-kopf">
          <span>Vorschlag</span>
          <strong>{vorschlagText(einsatz.vorschlag)}</strong>
          <span>{prozentText(einsatz.anteil_prozent)}</span>
        </div>
        <div className="vp-bw-urteile" aria-label="Urteil der Kriterien">
          {(['K1', 'K2', 'K3', 'K5', 'K6'] as const).map((k) => <span key={k}><b>{k}</b> {urteilText(einsatz.urteil[k])}</span>)}
        </div>
        <section className="vp-bw-herkunft" aria-label="Zahlen und Versionen">
          <h3>Zahlen · Kriterien-Fassung {einsatz.herkunft.kriterien_fassung}</h3>
          <p>Zeitraum {einsatz.herkunft.zeitraum} · Menge {zahlMitEinheit(einsatz.menge, einsatz.einheit)}</p>
          <ul>{einsatz.herkunft.eingaenge.map((x, i) => <li key={`${x.objekt}-${i}`}>{x.objekt}: {zahlMitEinheit(x.wert, einsatz.einheit)} · Version {x.version ?? 'fehlt'} · {x.zustand ?? 'Zustand fehlt'}</li>)}</ul>
          {einsatz.herkunft.nenner && <>
            <p><strong>Nenner:</strong> {zahlMitEinheit(einsatz.herkunft.nenner.wert, 'kWh')} · {einsatz.herkunft.nenner.anlagen} Anlagen</p>
            <ul>{einsatz.herkunft.nenner.bilanzwerte.map((x, i) => <li key={`${x.anlage}-${i}`}>{x.anlage}: {zahlMitEinheit(x.wert, 'kWh')} · Version {x.version} · {x.zustand}</li>)}</ul>
          </>}
        </section>
        <fieldset className="vp-bw-gruppe">
          <legend>Einstufung</legend>
          <label className="vp-bw-wahl"><input type="radio" name={`${basis}-wahl`} checked={wahl === 'wesentlich'} onChange={() => setWahl('wesentlich')} /> wesentlich</label>
          <label className="vp-bw-wahl"><input type="radio" name={`${basis}-wahl`} checked={wahl === 'nicht_wesentlich'} onChange={() => setWahl('nicht_wesentlich')} /> nicht wesentlich</label>
        </fieldset>
        <fieldset className="vp-bw-gruppe">
          <legend>Grundlage</legend>
          {(['K1', 'K2', 'K3', 'K4'] as const).map((k) => <label className="vp-bw-wahl" key={k}>
            <input type="checkbox" checked={grund.includes(k)} onChange={(e) => setGrund(e.target.checked ? [...grund, k] : grund.filter((x) => x !== k))} /> {k}{k === 'K4' ? ' · begründete Einschätzung' : ''}
          </label>)}
        </fieldset>
        {abweichung && <p className="vp-alert vp-alert-warn" role="note" data-testid="abweichung-hinweis">
          Ihre Wahl weicht vom Vorschlag „{vorschlagText(einsatz.vorschlag)}“ ab. Die Begründung muss diese Abweichung ausdrücklich erklären.
        </p>}
        <label className="vp-bw-textarea-label" htmlFor={`${basis}-begruendung`}>Begründung</label>
        <textarea id={`${basis}-begruendung`} value={begruendung} onChange={(e) => setBegruendung(e.target.value)} aria-invalid={!!fehler} rows={4} />
        {fehler && <p className="vp-alert vp-alert-err" role="alert">{fehler}</p>}
        <p className="vp-bw-leise">Speichern legt eine neue Fassung an. Bei Vier-Augen bleibt sie vorgeschlagen und wartet auf Bestätigung.</p>
        <p className="vp-bw-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

const keys = ['K1', 'K2', 'K3', 'K5', 'K6', 'K7', 'K8', 'mindest_monate'] as const;

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
        <p><strong>Aktuelle Fassung {fassung.fassung}</strong>{fassung.gueltig_ab ? ` · seit ${tag(fassung.gueltig_ab)}` : ' · Startwerte'}</p>
        <div className="vp-bw-kriterien">
          {keys.map((k) => <div className="vp-bw-kriterium" key={k}>
            <Input id={`${basis}-${k}`} label={KRITERIEN_NAMEN[k]} type="number" min="0" step={k === 'K7' || k === 'mindest_monate' ? '1' : '0.1'} value={werte[k]}
              onChange={(e) => setWerte({ ...werte, [k]: k === 'K7' || k === 'mindest_monate' ? Number(e.target.value) : e.target.value })}
              hint={`Startwert ${STARTWERTE[k]} ${KRITERIEN_EINHEIT[k]}`} />
          </div>)}
        </div>
        <label className="vp-bw-textarea-label" htmlFor={`${basis}-begruendung`}>Begründung</label>
        <textarea id={`${basis}-begruendung`} value={begruendung} onChange={(e) => setBegruendung(e.target.value)} rows={4} aria-invalid={!!fehler} />
      </> : !fehler && <p>Kriterien werden geladen …</p>}
      {fehler && <p className="vp-alert vp-alert-err" role="alert">{fehler}</p>}
      <p className="vp-bw-grenze">{UEMS_NORMGRENZE}</p>
    </form>
  </Modal>;
}

export function EinstufungHistorie({ einsatzId, fassungen, darfBestaetigen, onBestaetigt }: {
  einsatzId: string; fassungen: EnergieeinsatzEinstufungFassung[]; darfBestaetigen: boolean; onBestaetigt?: (f: EnergieeinsatzEinstufungFassung) => void;
}) {
  const [fehler, setFehler] = useState<string | null>(null);
  const offen = fassungen.find((f) => f.freigabe_status === 'beantragt');
  return <section className="vp-bw-karte" aria-labelledby="ee-einstufung-historie" data-testid="einstufung-historie">
    <div className="vp-bw-karte-kopf"><h2 id="ee-einstufung-historie">Einstufung · Historie</h2>{offen && <Badge variant="tint">wartet auf Bestätigung</Badge>}</div>
    {fassungen.length === 0 ? <p className="vp-bw-leise">Noch keine Einstufung — der Vorschlag entscheidet nichts.</p> : <ol className="vp-bw-historie">
      {fassungen.map((f) => <li key={f.fassung}>
        <p><strong>Fassung {f.fassung} · {einstufungText(f.einstufung)}</strong></p>
        <p>{f.gueltig_ab ? `gilt ab ${tag(f.gueltig_ab)}` : `vorgeschlagen am ${tag(f.vorgeschlagen_ab)}, wartet auf Bestätigung`} {f.rueckwirkend ? '· rückwirkend' : ''}</p>
        <p>{f.akteur.name}: „{f.begruendung}“</p>
        <p className="vp-bw-leise">Grundlage {f.herkunft.zeitraum} · Kriterien-Fassung {f.herkunft.kriterien_fassung} · {f.grund.length ? f.grund.join(' · ') : 'Einschätzung der Person'}</p>
      </li>)}
    </ol>}
    {offen && darfBestaetigen && onBestaetigt && <Button size="sm" variant="outline" onClick={() => {
      setFehler(null); api.energieeinsatzEinstufungBestaetigen(einsatzId).then(onBestaetigt, (e) => setFehler(fehlerText(e)));
    }}>Einstufung bestätigen</Button>}
    {fehler && <p className="vp-alert vp-alert-err" role="alert">{fehler}</p>}
    <p className="vp-bw-grenze">{UEMS_NORMGRENZE}</p>
  </section>;
}
