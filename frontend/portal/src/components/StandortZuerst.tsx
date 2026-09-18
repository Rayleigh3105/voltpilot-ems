import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type StandorteAmStichtag, type Unternehmen } from '../api';
import { STANDORT_ZUERST_SATZ, STANDORT_ZUERST_TITEL } from '../anlegeNurMessen';
import { Recht } from './Recht';
import { StandortDialog } from './StandortDialog';

/**
 * Der kleine Vorlauf des bestehenden Anlagen-Flusses für einen Kundenbereich
 * ohne Standort und ohne Anlage. Der vorhandene StandortDialog bleibt der eine
 * Schreibweg; nach dem Speichern geht es im Anlagen-Fluss weiter.
 */
export function StandortZuerst({ onGespeichert }: { onGespeichert: (standortId: string) => void }) {
  const [grundlage, setGrundlage] = useState<{
    standorte: StandorteAmStichtag;
    unternehmen: Unternehmen | null;
  } | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    let aktiv = true;
    Promise.all([api.standorte(), api.unternehmen().catch(() => null)]).then(
      ([standorte, unternehmen]) => {
        if (aktiv) setGrundlage({ standorte, unternehmen });
      },
      () => {
        if (aktiv) setFehler('Die Angaben zum Standort konnten nicht geladen werden.');
      },
    );
    return () => {
      aktiv = false;
    };
  }, []);

  return (
    <>
      {!dialog && (
        <div className="vp-onboarding-step" data-testid="standort-zuerst">
          <h3>{STANDORT_ZUERST_TITEL}</h3>
          <p className="vp-muted">{STANDORT_ZUERST_SATZ}</p>
          <Recht aktion="standort.verwalten">
            <Button
              variant="primary"
              size="lg"
              fullWidth
              onClick={() => setDialog(true)}
              disabled={!grundlage}
            >
              Standort anlegen
            </Button>
          </Recht>
          {!grundlage && !fehler && <p className="vp-note" aria-busy="true">Standort wird vorbereitet …</p>}
          {fehler && <p className="vp-alert vp-alert-err" role="alert">{fehler}</p>}
        </div>
      )}

      {dialog && grundlage && (
        <StandortDialog
          open
          standort={null}
          unternehmen={grundlage.unternehmen}
          standorte={grundlage.standorte.standorte}
          heute={grundlage.standorte.stichtag}
          onClose={() => setDialog(false)}
          onGespeichert={(standort) => onGespeichert(standort.id)}
        />
      )}
    </>
  );
}
