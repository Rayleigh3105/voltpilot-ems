import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { ApiError } from '../api';
import { consumersApi } from '../consumers/consumersApi';
import type { ManualOverride } from '../consumers/fulfillment';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import type { Consumer } from '../consumers/types';
import {
  abweichungHinweis,
  HEIZ_DAUERN,
  hoechstensKwh,
  kwText,
  phasen,
  reglerSatz,
  stufeText,
  zustandsSatz,
} from '../heizstab';
import { Recht } from './Recht';
import './Heizstab.css';

/** Die Stufen eines Heizstabs aus seinem Profil: kW je Stufe und daraus die Zahl der Phasen. */
export function heizStufen(consumer: Consumer, kanaele: number): { stufe: number; ausgaenge: number; kw: number }[] {
  const levels = (consumer.levelsKw ?? []).filter((k) => k > 0).sort((a, b) => a - b);
  const jeElement = consumer.ratedPowerKw > 0 && kanaele > 0 ? consumer.ratedPowerKw / kanaele : null;
  return levels.map((kw, i) => ({
    stufe: i + 1,
    ausgaenge: jeElement ? Math.max(1, Math.round(kw / jeElement)) : i + 1,
    kw,
  }));
}

/**
 * Der Heizstab auf seiner Geräteseite (Heizstab V1, Paket 4): was BESTÄTIGT läuft (Stufe, Phasen), warum
 * (der Regler der Box), eine Abweichung, die länger als 3 min anhält (HZ-4 B: der Stab heizt mit der
 * bestätigten Stufe weiter, nichts wird gesperrt), die angenommene Wärme des Tages aus den bestätigten
 * Stufen - und „Jetzt heizen“ mit Stufe und Dauer (Handeingriff, höchstens 4 h).
 */
export function HeizstabKarte({
  siteId,
  consumer,
  status,
  override,
  kanaele,
  jetzt,
  onGeaendert,
}: {
  siteId: string;
  consumer: Consumer;
  status: ConsumerRuntimeStatus | null;
  override: ManualOverride | null;
  kanaele: number;
  jetzt: Date;
  onGeaendert: () => void;
}) {
  const stufenListe = heizStufen(consumer, kanaele);
  const [wahl, setWahl] = useState<number>(stufenListe[0]?.stufe ?? 1);
  const [dauer, setDauer] = useState<number>(120);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const stufe = status?.stufe ?? null;
  const gewaehlt = stufenListe.find((s) => s.stufe === wahl) ?? null;
  const hinweis = abweichungHinweis(stufe, jetzt);
  const grund = reglerSatz(status?.heizstab ?? null);
  const handAn = override && override.kind === 'start' && new Date(override.endsAt).getTime() > jetzt.getTime();

  const heizen = async () => {
    setBusy(true);
    setFehler(null);
    try {
      await consumersApi.startOverride(siteId, consumer.id, { action: 'start', durationMinutes: dauer, stufe: wahl });
      onGeaendert();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Der Heizstab ließ sich nicht einschalten.');
    } finally {
      setBusy(false);
    }
  };
  const automatik = async () => {
    setBusy(true);
    setFehler(null);
    try {
      await consumersApi.clearOverride(siteId, consumer.id);
      onGeaendert();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Die Automatik ließ sich nicht fortsetzen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vp-hz" data-testid="heizstab-karte">
      <div className="vp-hz-abschnitt">
        <b>{zustandsSatz(stufe)}</b>
        <div className="vp-hz-phasen" aria-label="Phasen">
          {phasen(kanaele, stufe).map((p) => (
            <span
              key={p.label}
              className={`vp-hz-phase ${p.an === true ? 'is-an' : p.an === null ? 'is-unbekannt' : ''}`}
            >
              {p.label} {p.an === true ? 'an' : p.an === false ? 'aus' : '?'}
            </span>
          ))}
        </div>
        {grund && <p className="vp-hz-unter">{grund}</p>}
        {status?.stufeEnergieKwhHeute != null && (
          <p className="vp-hz-unter">
            Wärme heute ≈ {status.stufeEnergieKwhHeute.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            {' '}kWh (angenommen aus den bestätigten Stufen, ohne Messung)
          </p>
        )}
        {hinweis && (
          <p className="vp-hz-hinweis" role="status">
            <Icon name="alert-triangle" size={15} />
            <span>{hinweis}</span>
          </p>
        )}
      </div>

      <Recht aktion="handeingriff.setzen">
        <section className="vp-hz-abschnitt" aria-labelledby={`hz-jetzt-${consumer.id}`}>
          <h4 id={`hz-jetzt-${consumer.id}`}>Jetzt heizen</h4>
          {handAn ? (
            <>
              <p className="vp-hz-unter">
                Heizt von Hand bis{' '}
                {new Date(override!.endsAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}
                {override!.targetValue != null ? ` · ${kwText(override!.targetValue)}` : ''}.
              </p>
              <div className="vp-hz-knoepfe">
                <Button variant="outline" size="sm" onClick={() => void automatik()} disabled={busy}>Automatik fortsetzen</Button>
              </div>
            </>
          ) : (
            <>
              {stufenListe.length > 1 && (
                <ul className="vp-hz-wahl" aria-label="Stufe">
                  {stufenListe.map((s) => (
                    <li key={s.stufe}>
                      <button type="button" aria-pressed={wahl === s.stufe} onClick={() => setWahl(s.stufe)}>
                        <b>{stufeText(s.ausgaenge)}</b>
                        <small>{kwText(s.kw)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <ul className="vp-hz-wahl" aria-label="Dauer">
                {HEIZ_DAUERN.map((d) => (
                  <li key={d.minuten}>
                    <button type="button" aria-pressed={dauer === d.minuten} onClick={() => setDauer(d.minuten)}>
                      <b>{d.text}</b>
                    </button>
                  </li>
                ))}
              </ul>
              {gewaehlt && (
                <p className="vp-hz-unter">
                  {hoechstensKwh(gewaehlt.kw, dauer)} - ist das Wasser warm, schaltet das Thermostat des Stabs früher ab.
                </p>
              )}
              <div className="vp-hz-knoepfe">
                <Button variant="primary" size="sm" onClick={() => void heizen()} disabled={busy || !gewaehlt}>
                  {gewaehlt ? `${stufeText(gewaehlt.ausgaenge)} einschalten` : 'Jetzt heizen'}
                </Button>
              </div>
            </>
          )}
          {fehler && <p className="vp-hz-fehler" role="alert">{fehler}</p>}
        </section>
      </Recht>
    </div>
  );
}
