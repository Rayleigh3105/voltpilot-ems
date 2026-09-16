import { useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Bezugsgroesse, type BezugsgroesseWert, type BezugswertAntwort } from '../api';
import { useRollen } from '../rollen';
import { istGanzzahlig } from '../bezugsdaten';
import { schluesselVon } from '../bezugsPeriode';
import { heuteIn } from '../kennzahlKarte';
import { zahlText } from '../zahl';
import { fehlerSatz } from '../bezugsgroesseListe';
import { betrag, letzteFreiePeriode, periodenFehler, wertFehler } from '../werteEingabe';
import { VpDatePicker } from './VpDatePicker';

export function BezugswertDialog({ bezug, werte, alt, standort, zone, onClose, onSaved, onBerichtigen }: { bezug: Bezugsgroesse; werte: BezugsgroesseWert[]; alt: BezugsgroesseWert | null; standort: string | null; zone: string; onClose: () => void; onSaved: (a: BezugswertAntwort) => void; onBerichtigen?: (w: BezugsgroesseWert) => void }) {
  const art = bezug.periode_art!;
  const heute = heuteIn(zone, Date.now());
  const [periode, setPeriode] = useState(() => alt?.periode_von ? schluesselVon(alt.periode_von, art) : letzteFreiePeriode(heute, art, werte));
  const [wert, setWert] = useState(alt?.wirksamer_betrag?.replace('.', ',') ?? '');
  const [grund, setGrund] = useState('');
  const [fehler, setFehler] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const { darf } = useRollen();
  const erlaubt = !bezug.archiviert_am && darf('bezugsgroesse.eingeben', standort);
  const vorhanden = !alt ? werte.find(w => w.periode_von && schluesselVon(w.periode_von, art) === periode) : null;
  const speichern = async () => {
    if (busy || !erlaubt || vorhanden) return;
    const f: Record<string, string> = {};
    const pf = periodenFehler(periode, art, heute), wf = wertFehler(wert, bezug.einheit);
    if (pf) f.periode = pf;
    if (wf) f.wert = wf;
    if (alt && (grund.trim().length < 10 || grund.trim().length > 500)) f.grund = 'Bitte begründen Sie die Berichtigung (10 bis 500 Zeichen).';
    setFehler(f);
    if (Object.keys(f).length) { requestAnimationFrame(() => form.current?.querySelector<HTMLElement>(`#wert-${Object.keys(f)[0]}`)?.focus()); return; }
    setBusy(true);
    try { onSaved(alt ? await api.bezugswertBerichtigen(bezug.id, periode, { wert: zahlText(wert)!, begruendung: grund.trim() }) : await api.bezugswertEingeben(bezug.id, { periode, wert: zahlText(wert)! })); }
    catch (e) { setFehler({ senden: fehlerSatz(e) }); requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[role="alert"]')?.focus()); }
    finally { setBusy(false); }
  };
  return <Modal open title={alt ? 'Wert berichtigen' : 'Wert eingeben'} onClose={() => { if (!busy) onClose(); }} footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Abbrechen</Button>{erlaubt && !vorhanden && <Button type="submit" form="bezugswert-form" disabled={busy}>{busy ? 'Wird gespeichert …' : 'Speichern'}</Button>}</>}>
    <form id="bezugswert-form" ref={form} className="vp-bz-form" noValidate onSubmit={e => { e.preventDefault(); void speichern(); }}>
      <p>{bezug.kennzeichen} · {bezug.name}</p><p>Zeitzone: {zone}</p>
      {alt && <p>Bisher wirksam: {betrag(alt.wirksamer_betrag)} {bezug.einheit} · Fassung {alt.wirksame_fassung}. Bis zu einer erforderlichen Freigabe gilt dieser Wert weiter.</p>}
      {art === 'jahr' ? <Input id="wert-periode" label="Jahr" value={periode} onChange={e => setPeriode(e.target.value)} disabled={busy || !!alt} error={fehler.periode} /> : <VpDatePicker id="wert-periode" label="Periode" art={art} value={periode} onChange={setPeriode} disabled={busy || !!alt} error={fehler.periode} />}
      {vorhanden && <div><p>Für diese Periode gibt es bereits {betrag(vorhanden.wirksamer_betrag)} {bezug.einheit}.</p>{erlaubt && !vorhanden.vorschlag && onBerichtigen && <Button variant="outline" onClick={() => onBerichtigen(vorhanden)}>Vorhandenen Wert berichtigen</Button>}{vorhanden.vorschlag && <p>Ein Vorschlag wartet bereits auf Freigabe.</p>}</div>}
      <Input id="wert-wert" label={`Wert (${bezug.einheit})`} inputMode="decimal" autoFocus value={wert} onChange={e => { setWert(e.target.value); setFehler({}); }} disabled={busy} error={fehler.wert} hint={istGanzzahlig(bezug.einheit) ? 'Ganze Zahlen, zum Beispiel 48.200.' : 'Dezimalkomma und Tausenderpunkte sind erlaubt.'} />
      {alt && <Input id="wert-grund" label="Begründung" value={grund} onChange={e => { setGrund(e.target.value); setFehler({}); }} disabled={busy} error={fehler.grund} maxLength={500} />}
      {fehler.senden && <p role="alert" tabIndex={-1}>{fehler.senden}</p>}
    </form>
  </Modal>;
}
