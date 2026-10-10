import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { ApiError, GESAMTABZUG_ERKLAERUNG, GESAMTABZUG_KNOPF, ladeGesamtabzug } from '../api';
import './GesamtabzugKnopf.css';

/**
 * UEMS AP-20 IP-17: der Knopf „Gesamtabzug laden“ mit seiner Erklärung (§5.8) — im Hinweis „beendet“ und unter
 * „Unternehmen › Einstellungen“. Nur für den Kundenadministrator eingeblendet; die API entscheidet trotzdem selbst
 * (403 für jede andere Person). Der Abzug wird beim Abruf gebildet, das kann bei vielen Messreihen dauern.
 */
export function GesamtabzugKnopf() {
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  async function laden() {
    setLaeuft(true);
    setFehler(null);
    try {
      await ladeGesamtabzug();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Der Gesamtabzug konnte nicht geladen werden.');
    } finally {
      setLaeuft(false);
    }
  }
  return <div className="vp-gesamtabzug">
    <p>{GESAMTABZUG_ERKLAERUNG}</p>
    <Button variant="outline" onClick={() => void laden()} disabled={laeuft} data-testid="gesamtabzug-laden">
      {laeuft ? 'Gesamtabzug wird gebildet …' : GESAMTABZUG_KNOPF}
    </Button>
    {fehler && <p role="alert" className="vp-alert vp-alert-err">{fehler}</p>}
  </div>;
}
