import { useRef, useState } from 'react';
import { api, type UemsGeraet } from '../api';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { VpZeitpunktPicker } from './VpZeitpunktPicker';
import { lesen, ortszeit } from '../picker/zeitpunkt';
import { zeitText } from '../uemsEreignis';

/** Zweig des bestehenden Zählerwechsel-Dialogs für einen angekündigten Wechsel. */
export function WechselzeitpunktDialog({ geraet, zone, jetzt, darf, onClose, onBerichtigt }: {
  geraet: UemsGeraet; zone: string; jetzt: string; darf: boolean; onClose: () => void; onBerichtigt?: () => void;
}) {
  const bisher = geraet.ausgebaut_am!;
  const [eingabe, setEingabe] = useState(() => ortszeit(bisher, zone));
  const [grund, setGrund] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gespeichert, setGespeichert] = useState<string | null>(null);
  const sperre = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const zeitpunkt = lesen(eingabe, zone).wert;
  const speichern = async () => {
    if (!darf || sperre.current) return;
    if (!zeitpunkt || Date.parse(zeitpunkt) <= Math.max(Date.parse(jetzt), Date.now()) || Date.parse(zeitpunkt) === Date.parse(bisher)) {
      setFehler('Wählen Sie einen anderen Zeitpunkt in der Zukunft.');
      form.current?.querySelector<HTMLInputElement>('input')?.focus(); return;
    }
    sperre.current = true; setBusy(true); setFehler(null);
    try {
      const v = await api.wechselzeitpunktBerichtigen(geraet.id, { bisher, zeitpunkt, grund: grund.trim() || undefined });
      setGespeichert(v.zeitpunkt); onBerichtigt?.();
    } catch (e) { setFehler(e instanceof Error ? e.message : 'Der Zeitpunkt konnte nicht berichtigt werden.'); }
    finally { sperre.current = false; setBusy(false); }
  };
  return <Modal open title={gespeichert ? 'Zeitpunkt berichtigt' : 'Zeitpunkt berichtigen'} onClose={() => { if (!busy) onClose(); }}
    footer={gespeichert ? <Button onClick={onClose}>Schließen</Button> : <>
      <Button variant="ghost" disabled={busy} onClick={onClose}>Abbrechen</Button>
      <Button disabled={busy || !darf} onClick={() => void speichern()}>{busy ? 'Wird gespeichert …' : 'Zeitpunkt berichtigen'}</Button>
    </>}>
    <div className="vp-zw">
      <p>{geraet.einbau_kennzeichen} · Zählerwechsel angekündigt {zeitText(bisher, zone)}</p>
      {gespeichert ? <p role="status">Geändert: {zeitText(bisher, zone)} → {zeitText(gespeichert, zone)}. Die Berichtigung steht im Änderungsprotokoll.</p>
        : <form ref={form} onSubmit={e => { e.preventDefault(); void speichern(); }}>
          <VpZeitpunktPicker value={eingabe} zone={zone} onChange={setEingabe} disabled={busy} />
          <Input label="Begründung (optional)" value={grund} onChange={e => setGrund(e.target.value)} disabled={busy} />
          <p>Gerät, Karten, Quellen und übernommene Einstellungen wechseln gemeinsam zum neuen Zeitpunkt. Die ursprüngliche Ankündigung bleibt im Protokoll.</p>
          {fehler && <p role="alert" className="vp-zw-fehler">{fehler}</p>}
        </form>}
    </div>
  </Modal>;
}
