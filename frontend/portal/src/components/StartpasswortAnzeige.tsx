import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';

/** Gemeinsam in N3, bei Neuvergabe und beim ersten Kundenadministrator. */
export function StartpasswortAnzeige({ passwort }: { passwort: string }) {
  const [meldung, setMeldung] = useState('');
  async function kopieren() {
    try {
      await navigator.clipboard.writeText(passwort);
      setMeldung('Startpasswort kopiert.');
    } catch {
      setMeldung('Kopieren ist hier nicht möglich. Bitte markieren und kopieren Sie das Startpasswort.');
    }
  }
  return <div className="vp-form-stack">
    <p role="status">Das Startpasswort wird nur jetzt angezeigt. Nach dem Schließen können Sie es nicht wieder anzeigen.</p>
    <output aria-label="Startpasswort" className="vp-mono" style={{ display: 'block', padding: 'var(--vp-space-4)',
      background: 'var(--vp-bg-light)', border: '1px solid var(--vp-border)', borderRadius: 'var(--vp-radius-md)',
      overflowWrap: 'anywhere', userSelect: 'all' }}>{passwort}</output>
    <Button variant="outline" onClick={() => void kopieren()}>Startpasswort kopieren</Button>
    {meldung && <p role="status">{meldung}</p>}
    <p className="vp-note">Teilen Sie das Startpasswort persönlich oder telefonisch mit. Bei der ersten Anmeldung muss die Person ein eigenes Passwort festlegen.</p>
  </div>;
}
