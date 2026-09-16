import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import { benutzerApi, benutzerFehler, type BenutzerAnlage, type BenutzerAngelegt, type BenutzerKonto } from '../benutzer';
import { useRollen } from '../rollen';
import { StartpasswortAnzeige } from './StartpasswortAnzeige';

/** N3: IP-13 übergibt die Person, Rolle und ausgewählten Standorte aus N2. */
export function BenutzerAnlegenDialog({ open, onClose, anlage, rollenname, standortnamen, onCreated }: {
  open: boolean; onClose: () => void; anlage: BenutzerAnlage; rollenname: string;
  standortnamen: string[]; onCreated: (konto: BenutzerKonto) => void;
}) {
  const rechte = useRollen();
  const [antwort, setAntwort] = useState<BenutzerAngelegt | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState('');
  useEffect(() => { if (!open) { setAntwort(null); setFehler(''); } }, [open]);
  const erlaubt = rechte.darf('benutzer.verwalten');
  const schliessen = () => { if (!busy) { setAntwort(null); setFehler(''); onClose(); } };
  async function anlegen() {
    if (!erlaubt || busy) return;
    setBusy(true); setFehler('');
    try {
      const neu = await benutzerApi.anlegen(anlage);
      setAntwort(neu);
      onCreated(neu.benutzer);
    } catch (e) { setFehler(benutzerFehler(e)); }
    finally { setBusy(false); }
  }
  return <Modal open={open} onClose={schliessen} title={antwort ? 'Benutzer angelegt' : 'Benutzer anlegen'}
    footer={<><Button variant="ghost" onClick={schliessen} disabled={busy}>{antwort ? 'Schließen' : 'Zurück'}</Button>
      {!antwort && erlaubt && <Button variant="primary" onClick={() => void anlegen()} disabled={busy}>
        {busy ? 'Wird angelegt…' : 'Benutzer anlegen'}</Button>}</>}>
    <p><strong>{anlage.vorname || anlage.nachname ? `${anlage.vorname ?? ''} ${anlage.nachname ?? ''}`.trim() : anlage.username}</strong><br />{anlage.email}</p>
    {antwort ? <StartpasswortAnzeige passwort={antwort.startpasswort} /> : <>
      <p><strong>{rollenname}</strong><br />{standortnamen.length ? standortnamen.join(' · ') : 'Alle Standorte des Unternehmens'}</p>
      <p>Sie vergeben ein Startpasswort. Es wird beim Anlegen für Sie erstellt und einmal angezeigt. Bei der ersten Anmeldung muss die Person ein eigenes Passwort festlegen.</p>
      {!erlaubt && <p role="alert">Nur der Kundenadministrator kann Benutzer anlegen.</p>}
    </>}
    {fehler && <p role="alert" className="vp-alert vp-alert-err">{fehler}</p>}
  </Modal>;
}
