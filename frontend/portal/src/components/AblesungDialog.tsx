import { useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type Ablesung, type AblesungAntwort } from '../api';
import { useRollen } from '../rollen';
import { betrag, monatsZuordnung, periodenText, wertFehler, zeitText, wirksameAblesungen } from '../werteEingabe';
import { dezText } from '../bezugsdaten';
import { lesen, ortszeit } from '../picker/zeitpunkt';
import { zahlText } from '../zahl';
import { VpZeitpunktPicker } from './VpZeitpunktPicker';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

export function AblesungDialog({ kennzeichen, einheit, zone, alle, alt, onClose, onSaved, onBerichtigen }: { kennzeichen: string; einheit: string; zone: string; alle: Ablesung[]; alt: Ablesung | null; onClose: () => void; onSaved: (a: AblesungAntwort) => void; onBerichtigen?: (a: Ablesung) => void }) {
  const [zeit, setZeit] = useState(() => ortszeit(alt?.zeitpunkt ?? Date.now(), zone));
  const [stand, setStand] = useState(alt ? String(alt.stand).replace('.', ',') : '');
  const [wahl, setWahl] = useState(alt ? alt.monat ? 'anderer' : 'keiner' : 'vorgabe');
  const [monat, setMonat] = useState(alt?.monat?.slice(0, 7) ?? '');
  const [grund, setGrund] = useState('');
  const [fehler, setFehler] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const { darf } = useRollen();
  const erlaubt = darf('ablesung.erfassen');
  const z = lesen(zeit, zone), zuordnung = monatsZuordnung(alle, z.wert, zone);
  const vorhanden = !alt && z.wert ? wirksameAblesungen(alle).find(a => Date.parse(a.zeitpunkt) === Date.parse(z.wert!)) : null;
  const gewaehlt = !zuordnung || wahl === 'keiner' ? null : wahl === 'anderer' ? monat : zuordnung.vorgabe;
  const anteil = zuordnung?.anteile.find(a => a.monat === zuordnung.vorgabe);
  const speichern = async () => {
    if (busy || !erlaubt || vorhanden) return;
    const f: Record<string, string> = {};
    if (!z.wert) f[z.varianten.length ? 'variante' : zeit.tag ? 'zeit' : 'tag'] = z.fehler ?? 'Bitte geben Sie einen Zeitpunkt an.';
    else if (Date.parse(z.wert) > Date.now()) f.tag = 'Eine Ablesung liegt nicht in der Zukunft.';
    const wf = wertFehler(stand, einheit); if (wf) f.stand = wf;
    if (zuordnung && wahl === 'anderer' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(monat)) f.monat = 'Bitte wählen Sie einen Monat.';
    if (zuordnung && !zuordnung.vorgabe && wahl === 'vorgabe') f.monat = 'Ordnen Sie den Zeitraum einem Monat zu oder wählen Sie „Keinem Monat zuordnen“.';
    if (alt && (grund.trim().length < 10 || grund.trim().length > 500)) f.grund = 'Bitte begründen Sie die Berichtigung (10 bis 500 Zeichen).';
    setFehler(f);
    if (Object.keys(f).length) { requestAnimationFrame(() => form.current?.querySelector<HTMLElement>(`#wert-${Object.keys(f)[0]}`)?.focus()); return; }
    setBusy(true);
    try { onSaved(alt ? await api.ablesungBerichtigen(kennzeichen, alt.zeitpunkt, { stand: zahlText(stand)!, zuordnung_monat: gewaehlt, begruendung: grund.trim() }) : await api.ablesungEintragen(kennzeichen, { zeitpunkt: z.wert!, stand: zahlText(stand)!, zuordnung_monat: gewaehlt })); }
    catch (e) { setFehler({ senden: e instanceof ApiError ? e.message : 'Die Ablesung konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.' }); requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[role="alert"]')?.focus()); }
    finally { setBusy(false); }
  };
  return <Modal open title={alt ? 'Ablesung berichtigen' : 'Ablesung eintragen'} onClose={() => { if (!busy) onClose(); }} footer={<><Button variant="outline" onClick={onClose} disabled={busy}>Abbrechen</Button>{erlaubt && !vorhanden && <Button type="submit" form="ablesung-form" disabled={busy}>{busy ? 'Wird gespeichert …' : 'Speichern'}</Button>}</>}>
    <form id="ablesung-form" ref={form} className="vp-bz-form" onSubmit={e => { e.preventDefault(); void speichern(); }} noValidate>
      <p>{kennzeichen} · Zählerstand in {einheit}</p>
      {alt ? <><p>{zeitText(alt.zeitpunkt, zone)} · Zeitzone: {zone}</p><p>Bisher wirksam: {betrag(alt.stand)} {einheit} · Fassung {alt.fassung}. Bis zu einer erforderlichen Freigabe gilt dieser Stand weiter.</p></> : <VpZeitpunktPicker value={zeit} zone={zone} onChange={v => { setZeit(v); setWahl('vorgabe'); setFehler({}); }} disabled={busy} error={fehler.tag || fehler.zeit || fehler.variante} />}
      {vorhanden && <div><p>Zu diesem Zeitpunkt gibt es bereits {betrag(vorhanden.stand)} {einheit}.</p>{erlaubt && onBerichtigen && <Button variant="outline" onClick={() => onBerichtigen(vorhanden)}>Vorhandene Ablesung berichtigen</Button>}</div>}
      <Input id="wert-stand" label={`Zählerstand (${einheit})`} inputMode="decimal" value={stand} autoFocus onChange={e => { setStand(e.target.value); setFehler({}); }} disabled={busy} error={fehler.stand} />
      {zuordnung ? <>
        <p>Ablesezeitraum: {zuordnung.dauerText}.{anteil && ` Vorgabe: ${periodenText(anteil.monat, 'monat')} (${dezText(anteil.prozent).replace('.', ',')} % des Zeitraums).`}</p>
        {zuordnung.monateBeruehrt > 2 && <p>Dieser Zeitraum reicht über drei oder mehr Monate. Wählen Sie einen Monat oder lassen Sie ihn unzugeordnet. Ohne Zuordnung zeigen die Monate keine Werte.</p>}
        <VpPicker id="wert-monat" label="Zuordnung" value={wahl} onChange={v => setWahl(v ?? 'keiner')} options={[...(zuordnung.vorgabe ? [{ value: 'vorgabe', label: `Gilt für ${periodenText(zuordnung.vorgabe, 'monat')}` }] : []), { value: 'anderer', label: 'Anderer Monat' }, { value: 'keiner', label: 'Keinem Monat zuordnen' }]} disabled={busy} error={fehler.monat} />
        {wahl === 'anderer' && <VpDatePicker label="Gilt für Monat" art="monat" value={monat} onChange={setMonat} disabled={busy} />}
      </> : <p>Die erste Ablesung ist der Anfangsstand. Erst die nächste Ablesung schließt einen Zeitraum.</p>}
      {alt && <Input id="wert-grund" label="Begründung" value={grund} onChange={e => { setGrund(e.target.value); setFehler({}); }} disabled={busy} maxLength={500} error={fehler.grund} />}
      {fehler.senden && <p role="alert" tabIndex={-1}>{fehler.senden}</p>}
    </form>
  </Modal>;
}
