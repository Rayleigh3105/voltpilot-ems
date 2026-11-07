import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Betriebsart, type Funktionen } from '../api';
import { LADEPUNKT_DAUERN, boostDauer, type SiteCharging } from '../ladepunkte';
import { useRollen } from '../rollen';
import {
  SCHNELL_DAUER_VORGABE,
  SCHNELL_KNOPF,
  SCHNELL_ZURUECK,
  schnellFolgenKarte,
  schnellZeilen,
  type SchnellZeile,
} from '../schnellLaden';
import { funktionsLage } from '../steuerung/funktion';
import { HandeingriffDialog } from './HandeingriffDialog';

import './SchnellLadenZeile.css';

/**
 * „Auto steckt · Jetzt schnell laden“ - die eine Handlung im Cockpit
 * (Kapitän 07.11.2026, F3 b). Erscheint nur für Privatkunden, nur solange ein
 * Auto steckt und „Schnell“ etwas ändern kann (`schnellZeilen`), nur mit dem
 * Recht `handeingriff.setzen` und nicht, solange die Steuerung ruht.
 *
 * Der Knopf öffnet den BESTEHENDEN Handeingriff-Dialog (Folgen, Dauer,
 * Bestätigen) - kein zweiter Weg; gesendet wird derselbe `POST
 * /charging-boost` wie im Reiter Laden.
 */
export function SchnellLadenZeile({
  siteId,
  charging,
  betriebsart,
  ladepunktAnzahl,
  nowMs,
  onGesendet,
}: {
  siteId: string;
  charging: SiteCharging | null;
  betriebsart: Betriebsart | null | undefined;
  ladepunktAnzahl: number | null | undefined;
  nowMs: number;
  /** Nach dem Senden: die Ladepunkte bald neu lesen (die Box meldet alle 15 s). */
  onGesendet: () => void;
}) {
  const darf = useRollen().darf('handeingriff.setzen');
  const zeilen = darf ? schnellZeilen({ charging, betriebsart, ladepunktAnzahl, nowMs }) : [];
  // Ob die Steuerung ruht, fragt die Zeile erst, wenn sie etwas anbieten will:
  // ein Cockpit ohne angestecktes Auto lädt dafür nichts nach.
  const [funktionen, setFunktionen] = useState<Funktionen | null | undefined>(undefined);
  const brauchtFunktionen = zeilen.length > 0 && funktionen === undefined;
  useEffect(() => {
    if (!brauchtFunktionen) return undefined;
    let aktiv = true;
    api.funktionen().then(
      (f) => aktiv && setFunktionen(f),
      () => aktiv && setFunktionen(null),
    );
    return () => {
      aktiv = false;
    };
  }, [brauchtFunktionen]);
  const [dialog, setDialog] = useState<SchnellZeile | null>(null);
  const [dauerKey, setDauerKey] = useState(SCHNELL_DAUER_VORGABE);
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ text: string; fehler: boolean } | null>(null);

  if (!darf) return null;
  // Unbekannt (noch nicht geladen, Fehler) behauptet keine Ruhe - wie die Steuerung selbst.
  if (funktionen && funktionsLage(funktionen, siteId).sperre != null) return null;
  if (zeilen.length === 0) return meldung?.fehler ? <p className="vp-schnell-meldung is-fehler" role="alert">{meldung.text}</p> : null;

  const senden = async (z: SchnellZeile, minuten: number | null, zurueck: boolean) => {
    setBusy(true);
    setMeldung(null);
    try {
      await api.chargingBoost(siteId, zurueck
        ? { chargePointId: z.chargePointId, connectorId: z.connectorId, cancel: true }
        : { chargePointId: z.chargePointId, connectorId: z.connectorId, action: 'voll', ...boostDauer(minuten) });
      // „Gesendet“ heißt nicht „übernommen“ (Konzept k1): die Zeile folgt der Meldung der Box.
      setMeldung({ text: zurueck ? `${z.name}: wieder Smart. Gesendet.` : `${z.name}: Schnell gesendet. Ob die Box übernimmt, steht gleich hier.`, fehler: false });
      onGesendet();
    } catch (e) {
      setMeldung({ text: e instanceof ApiError || e instanceof Error ? e.message || 'Das hat gerade nicht geklappt.' : 'Das hat gerade nicht geklappt.', fehler: true });
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  const andere = Math.max(0, (charging?.chargers.length ?? 1) - 1);
  const dauer = LADEPUNKT_DAUERN.find((d) => d.key === dauerKey) ?? LADEPUNKT_DAUERN[LADEPUNKT_DAUERN.length - 1];

  return (
    <section className="vp-schnell" aria-label={SCHNELL_KNOPF}>
      {zeilen.map((z) => (
        <div key={z.key} className={`vp-schnell-zeile${z.laeuft ? ' is-laeuft' : ''}`}>
          <span className="vp-schnell-ico" aria-hidden="true">
            <Icon name={z.laeuft ? 'zap' : 'car'} size={22} />
          </span>
          <span className="vp-schnell-text">
            <b>{z.name}</b>
            <small>{z.satz}</small>
          </span>
          {z.laeuft ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void senden(z, null, true)}>
              {SCHNELL_ZURUECK}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              iconLeft={<Icon name="zap" size={16} />}
              onClick={() => {
                setDauerKey(SCHNELL_DAUER_VORGABE);
                setMeldung(null);
                setDialog(z);
              }}
            >
              {SCHNELL_KNOPF}
            </Button>
          )}
        </div>
      ))}
      {meldung && (
        <p className={`vp-schnell-meldung${meldung.fehler ? ' is-fehler' : ''}`} role={meldung.fehler ? 'alert' : 'status'}>
          {meldung.text}
        </p>
      )}
      <HandeingriffDialog
        folgen={dialog ? schnellFolgenKarte(dialog.budget, dauer, andere) : null}
        busy={busy}
        withDuration
        dauern={LADEPUNKT_DAUERN}
        dauerKey={dauerKey}
        onDauer={setDauerKey}
        onConfirm={(m) => dialog && void senden(dialog, m, false)}
        onCancel={() => !busy && setDialog(null)}
      />
    </section>
  );
}
