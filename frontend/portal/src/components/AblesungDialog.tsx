import { useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type Ablesung, type AblesungAntwort } from '../api';
import { useRollen } from '../rollen';
import { betrag, monatsZuordnung, periodenText, wertFehler, zaehltSatz, zeitText, wirksameAblesungen } from '../werteEingabe';
import { dezText } from '../bezugsdaten';
import { lesen, ortszeit } from '../picker/zeitpunkt';
import { zahlText } from '../zahl';
import { VpZeitpunktPicker } from './VpZeitpunktPicker';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

/**
 * Eine Ablesung eintragen oder berichtigen (Konzept Messen m1, §6.5): die letzte Ablesung zum Vergleich, „Abgelesen am“
 * mit dem Kürzel der Zone am Feld, der Zählerstand mit seiner Einheit, darunter der Satz, zu welchem Monat die Ablesung
 * zählt. Die Wahl des Monats steht nur, wenn der Zeitraum seit der letzten Ablesung mehr als einen Monat berührt.
 */
export function AblesungDialog({ kennzeichen, name = null, einheit, zone, alle, alt, onClose, onSaved, onBerichtigen }: { kennzeichen: string; name?: string | null; einheit: string; zone: string; alle: Ablesung[]; alt: Ablesung | null; onClose: () => void; onSaved: (a: AblesungAntwort) => void; onBerichtigen?: (a: Ablesung) => void }) {
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
  const wirksam = wirksameAblesungen(alle);
  const vorhanden = !alt && z.wert ? wirksam.find(a => Date.parse(a.zeitpunkt) === Date.parse(z.wert!)) : null;
  // Die Ablesung vor dem gewählten Zeitpunkt schließt den Zeitraum - sie steht zum Vergleich oben.
  const letzte = !alt ? (z.wert ? wirksam.filter(a => Date.parse(a.zeitpunkt) < Date.parse(z.wert!)).slice(-1)[0] : wirksam.slice(-1)[0]) ?? null : null;
  const gewaehlt = !zuordnung || wahl === 'keiner' ? null : wahl === 'anderer' ? monat : zuordnung.vorgabe;
  const anteil = zuordnung?.anteile.find(a => a.monat === zuordnung.vorgabe);
  // Ein Zeitraum in EINEM Monat zählt zu ihm - keine Wahl; berührt er mehr, wählt der Kunde (Vorgabe: der größte Anteil).
  const einMonat = zuordnung?.monateBeruehrt === 1 && zuordnung.vorgabe !== null;
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
      <p>{[kennzeichen, name].filter(Boolean).join(' ')} · Zählerstand in {einheit}</p>
      {letzte && <p className="vp-ablesung-letzte" data-testid="ablesung-letzte">Letzte Ablesung <strong>{betrag(letzte.stand)} {einheit}</strong> · {zeitText(letzte.zeitpunkt, zone)}</p>}
      {alt ? <><p>{zeitText(alt.zeitpunkt, zone)}</p><p>Bisher wirksam: {betrag(alt.stand)} {einheit} · Fassung {alt.fassung}. Bis zu einer erforderlichen Freigabe gilt dieser Stand weiter.</p></> : <VpZeitpunktPicker kopf="Abgelesen am" value={zeit} zone={zone} onChange={v => { setZeit(v); setWahl('vorgabe'); setFehler({}); }} disabled={busy} error={fehler.tag || fehler.zeit || fehler.variante} />}
      {vorhanden && <div><p>Zu diesem Zeitpunkt gibt es bereits {betrag(vorhanden.stand)} {einheit}.</p>{erlaubt && onBerichtigen && <Button variant="outline" onClick={() => onBerichtigen(vorhanden)}>Vorhandene Ablesung berichtigen</Button>}</div>}
      <div className="vp-einheit-feld">
        <label htmlFor="wert-stand">Zählerstand<span className="vp-sr-only"> ({einheit})</span></label>
        <div className="vp-einheit-feld-rahmen">
          <Input id="wert-stand" inputMode="decimal" value={stand} autoFocus onChange={e => { setStand(e.target.value); setFehler({}); }} disabled={busy}
            aria-invalid={fehler.stand ? true : undefined} aria-describedby={fehler.stand ? 'wert-stand-fehler' : undefined}
            style={{ paddingRight: '3.75rem', ...(fehler.stand ? { borderColor: 'var(--vp-industry)' } : {}) }} />
          <span className="vp-einheit-feld-einheit" aria-hidden="true">{einheit}</span>
        </div>
        {fehler.stand && <span id="wert-stand-fehler" className="vp-einheit-feld-fehler">{fehler.stand}</span>}
      </div>
      {zuordnung ? einMonat && !alt ? (
        <p className="vp-ablesung-zaehlt" data-testid="ablesung-zaehlt">{zaehltSatz(zuordnung.vorgabe!, letzte?.zeitpunkt ?? null, zone)}</p>
      ) : <>
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
