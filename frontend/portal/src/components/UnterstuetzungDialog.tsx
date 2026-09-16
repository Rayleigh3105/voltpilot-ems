import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import { Input } from '../../designsystem/components/forms/Input';
import type { Unterstuetzung, UnterstuetzungAnfrage } from '../api';
import { useRollen } from '../rollen';
import { datumZeit } from '../rechte';
import { heute, hoechstesEnde, pruefeUnterstuetzung, UMFANG, unterstuetzungApi, unterstuetzungFehler, vorgabeEnde, enddatum } from '../unterstuetzung';
import { VpPicker } from './VpPicker';
import { VpDatePicker } from './VpDatePicker';
import { StartpasswortAnzeige } from './StartpasswortAnzeige';
import './Unterstuetzung.css';

export function UnterstuetzungFolgen() {
  return <section className="vp-unterstuetzung-folgen" aria-label="Folgen der Unterstützung"><strong>Was Unterstützung nie erlaubt</strong>
    <p>Steuerung starten, Steuern freigeben, Korrekturen, Berichte freigeben, Exporte, Löschen und Benutzer verwalten.</p>
    <p>Alle betroffenen Benutzer sehen einen Hinweis, solange der Zugriff gilt. Jede Handlung nennt die unterstützende Person. Der Vorgang wird protokolliert.</p></section>;
}
export function UnterstuetzungDialog({ onClose, onSaved, anfrage, verlaengern }: {
  onClose: () => void; onSaved: () => void; anfrage?: UnterstuetzungAnfrage; verlaengern?: Unterstuetzung;
}) {
  const rechte = useRollen();
  const [standorte, setStandorte] = useState<{ id: string; name: string }[]>([]);
  const [orteLaden, setOrteLaden] = useState(true);
  const [art, setArt] = useState('installateur');
  const [email, setEmail] = useState('');
  const [orte, setOrte] = useState(anfrage?.standorte ?? verlaengern?.standorte ?? (standorte.length === 1 ? [standorte[0].id] : []));
  const [umfang, setUmfang] = useState(anfrage?.umfang ?? 'einrichten_und_bedienen');
  const [bis, setBis] = useState(anfrage?.gueltig_bis ?? verlaengern?.gueltig_bis ?? vorgabeEnde());
  const [grund, setGrund] = useState(anfrage?.grund ?? '');
  const [fehler, setFehler] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwort, setPasswort] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const orteRef = useRef<HTMLDivElement>(null);
  const datumRef = useRef<HTMLDivElement>(null);
  const trigger = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    let aktiv = true; setOrteLaden(true);
    void unterstuetzungApi.standorte().then(orte => {
      if (!aktiv) return; setStandorte(orte); setOrteLaden(false);
      if (!anfrage && !verlaengern && orte.length === 1) setOrte([orte[0].id]);
    }).catch(() => { if (aktiv) { setOrteLaden(false); setFehler('Die Standorte konnten nicht geladen werden. Schließen Sie den Dialog und versuchen Sie es erneut.'); } });
    return () => { aktiv = false; };
  }, [rechte.selbst?.kundenbereich?.id]);
  const schliessen = () => { if (!busy) { setPasswort(null); onClose(); requestAnimationFrame(() => trigger.current?.focus()); } };
  const titel = verlaengern ? 'Unterstützung verlängern' : anfrage ? 'Anfrage bestätigen oder ändern' : 'Unterstützung gewähren';
  async function speichern() {
    if (busy || orteLaden || !rechte.darf('unterstuetzung.verwalten', null)) return;
    const ungueltig = form.current?.querySelector<HTMLInputElement>('input:invalid');
    if (ungueltig) { setFehler('Bitte geben Sie eine gültige E-Mail-Adresse ein.'); ungueltig.focus(); return; }
    const problem = verlaengern?.gueltig_bis && bis <= verlaengern.gueltig_bis ? 'Wählen Sie ein späteres Enddatum.' : pruefeUnterstuetzung(orte, bis);
    if (problem) { setFehler(problem); (orte.length ? datumRef : orteRef).current?.querySelector<HTMLElement>('button,[role="combobox"]')?.focus(); return; }
    setBusy(true); setFehler('');
    try {
      const neu = verlaengern ? await unterstuetzungApi.verlaengern(verlaengern.id, bis) : await unterstuetzungApi.gewaehren({
        ...(anfrage ? { anfrage_id: anfrage.id } : { art: 'installateur', email: email.trim() }), standorte: orte, umfang, gueltig_bis: bis, grund: grund.trim() || null,
      });
      onSaved(); void unterstuetzungApi.aktualisieren().catch(() => {});
      if (neu.startpasswort) setPasswort(neu.startpasswort); else { onClose(); requestAnimationFrame(() => trigger.current?.focus()); }
    } catch (e) { setFehler(unterstuetzungFehler(e)); } finally { setBusy(false); }
  }
  return <Modal open onClose={schliessen} title={passwort ? 'Unterstützung gewährt' : titel} footer={<>
    <Button variant="ghost" disabled={busy} onClick={schliessen}>{passwort ? 'Schließen' : 'Abbrechen'}</Button>
    {!passwort && (art !== 'voltpilot' || anfrage || verlaengern) && <Button disabled={busy || orteLaden} onClick={() => void speichern()}>{busy ? 'Wird gespeichert…' : verlaengern ? 'Verlängern' : anfrage ? 'Unterstützung bestätigen' : 'Unterstützung gewähren'}</Button>}
  </>}>
    {passwort ? <StartpasswortAnzeige passwort={passwort} /> : <form className="vp-unterstuetzung-form" ref={form} onSubmit={e => { e.preventDefault(); void speichern(); }}>
      {!anfrage && !verlaengern && <VpPicker label="Art" value={art} onChange={setArt} options={[{ value: 'installateur', label: 'Installateur' }, { value: 'voltpilot', label: 'VoltPilot-Support' }]} />}
      {art === 'voltpilot' && !anfrage && !verlaengern ? <p>VoltPilot-Support fragt Unterstützung an. Bestätigen oder ändern Sie die Anfrage in der Karte „Unterstützung“.</p> : <>
        {anfrage ? <p>VoltPilot-Support · {anfrage.angefragt_von.name}<br />Angefragt am {datumZeit(anfrage.angefragt_am)}</p> : verlaengern ? <p>{verlaengern.unterstuetzer.name} · bisher bis {enddatum(verlaengern)}</p>
          : <Input label="E-Mail-Adresse des Partners" type="email" required value={email} onChange={e => { setEmail(e.target.value); setFehler(''); }} />}
        {!verlaengern && <><div ref={orteRef}><VpPicker label="Standorte" disabled={orteLaden} values={orte} options={standorte.map(s => ({ value: s.id, label: s.name }))} onChangeMany={ids => { setOrte(ids); setFehler(''); }} error={fehler.includes('Standort') ? fehler : undefined} /></div>
          <VpPicker label="Umfang" value={umfang} onChange={v => setUmfang(v as typeof umfang)} options={Object.entries(UMFANG).map(([value, label]) => ({ value, label }))} /></>}
        <div ref={datumRef}><VpDatePicker label="Gültig bis einschließlich" value={bis} onChange={v => { setBis(v); setFehler(''); }} error={fehler.includes('Enddatum') ? fehler : undefined} min={heute()} max={hoechstesEnde()} /></div>
        <p className="vp-note">Vorgabe: 30 Tage · höchstens 12 Monate. Sie erhalten sieben Tage vor Ablauf eine Erinnerung.</p>
        {!verlaengern && <Input label="Grund (optional)" value={grund} onChange={e => setGrund(e.target.value)} />}
        <UnterstuetzungFolgen />
      </>}
      {fehler && <p role="alert">{fehler}</p>}
    </form>}
  </Modal>;
}

export function UnterstuetzungBeenden({ zugriff, onClose, onSaved }: { zugriff: Unterstuetzung; onClose: () => void; onSaved: () => void }) {
  const rechte = useRollen();
  const [grund, setGrund] = useState(''); const [busy, setBusy] = useState(false); const [fehler, setFehler] = useState('');
  const trigger = useRef(document.activeElement as HTMLElement | null);
  const schliessen = () => { if (!busy) { onClose(); requestAnimationFrame(() => trigger.current?.isConnected && trigger.current.focus()); } };
  async function beenden() {
    if (busy || !rechte.darf('unterstuetzung.verwalten', null)) return;
    setBusy(true);
    try { await unterstuetzungApi.beenden(zugriff.id, grund); onSaved(); onClose(); void unterstuetzungApi.aktualisieren().catch(() => {}); }
    catch (e) { setFehler(unterstuetzungFehler(e)); } finally { setBusy(false); }
  }
  return <Modal open onClose={schliessen} title="Unterstützung beenden?" footer={<><Button variant="ghost" disabled={busy} onClick={schliessen}>Abbrechen</Button><Button disabled={busy} onClick={() => void beenden()}>Zugriff beenden</Button></>}>
    <p><strong>{zugriff.unterstuetzer.name}</strong> verliert diesen Zugriff sofort, auch in einer offenen Sitzung.</p>
    <ul><li>Wirkt mit der nächsten Anfrage.</li><li>Gesetzte Handeingriffe bleiben bis zu ihrem Ende oder bis eine berechtigte Person sie beendet.</li><li>Regeln und Betriebsmodelle bleiben unverändert.</li><li>Einträge bleiben im Protokoll; das Konto bleibt bestehen.</li></ul>
    <Input label="Grund (optional)" value={grund} onChange={e => setGrund(e.target.value)} />{fehler && <p role="alert">{fehler}</p>}
  </Modal>;
}
