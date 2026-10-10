import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import { benutzerApi, benutzerFehler, type BenutzerAngelegt } from '../benutzer';
import { useRollen } from '../rollen';
import { StartpasswortAnzeige } from './StartpasswortAnzeige';

/** Hebel für die Benutzerzeile N1. Die Verwaltung hängt ihn mit sub und Anzeigename ein. */
export function StartpasswortNeuVergeben({ sub, name }: { sub: string; name: string }) {
  const rechte = useRollen();
  const [open, setOpen] = useState(false);
  const [antwort, setAntwort] = useState<BenutzerAngelegt | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState('');
  useEffect(() => { setOpen(false); setAntwort(null); setFehler(''); }, [sub]);
  if (!rechte.darf('benutzer.verwalten', null)) return null;
  const schliessen = () => { if (!busy) { setOpen(false); setAntwort(null); setFehler(''); } };
  async function vergeben() {
    if (busy) return;
    setBusy(true); setFehler('');
    try { setAntwort(await benutzerApi.startpasswort(sub)); }
    catch (e) { setFehler(benutzerFehler(e)); }
    finally { setBusy(false); }
  }
  return <><Button variant="outline" size="sm" onClick={(event) => { event.currentTarget.focus(); setOpen(true); }}>Startpasswort neu vergeben</Button>
    <Modal open={open} onClose={schliessen} title="Startpasswort neu vergeben"
      footer={<><Button variant="ghost" onClick={schliessen} disabled={busy}>{antwort ? 'Schließen' : 'Abbrechen'}</Button>
        {!antwort && <Button variant="primary" onClick={() => void vergeben()} disabled={busy}>{busy ? 'Wird vergeben…' : 'Startpasswort vergeben'}</Button>}</>}>
      <p><strong>{name}</strong></p>
      {antwort ? <StartpasswortAnzeige passwort={antwort.startpasswort} />
        : <p>Das bisherige Passwort wird ersetzt. Bei der nächsten Anmeldung muss die Person ein eigenes Passwort festlegen. Ihre Rolle und Standorte bleiben erhalten.</p>}
      {fehler && <p role="alert" className="vp-alert vp-alert-err">{fehler}</p>}
    </Modal>
  </>;
}
