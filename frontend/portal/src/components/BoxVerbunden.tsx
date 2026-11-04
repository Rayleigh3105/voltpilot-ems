import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, deviceLiveStatus, deviceWaitedTooLong, type Device } from '../api';
import { fmtRelative } from '../format';
import { HelpLink } from '../help/HelpProvider';
import { kennungWieGedruckt } from '../koppelLink';
import { ERGEBNIS, FREMD } from '../koppelTexte';
import { KennungKachel } from './KoppelKachel';
import './KoppelBand.css';

/** Wie oft die Ergebnisseite die eigene Geräteliste fragt (dieselbe Route wie die Geräteseite). */
export const ERGEBNIS_TAKT_MS = 10_000;

/**
 * M8/M9 (Konzept vp-qr-einstieg, QE-4 A): das ehrliche Ergebnis nach dem Verbinden. Verbunden ist die
 * Box sofort (der Server prüft ihr Lebenszeichen nicht, Portal zuerst und Box später ist erlaubt); ob
 * sie sich meldet, zeigt erst ihr Herzschlag (`lastSeenAt`). Die Seite fragt die eigene Geräteliste
 * alle zehn Sekunden und geht von selbst auf „Ihre Box ist online“ über. Nach 15 Minuten ohne
 * Lebenszeichen (`deviceWaitedTooLong`) nennt sie den Weg zum Support - auch für eine Box, die der
 * Werkstatt nie begegnet ist (F-4); öffentlich wird das nie unterschieden.
 */
export function BoxErgebnis({
  box,
  anlageName,
  onWeiter,
  onSpaeter,
  weiterText = ERGEBNIS.weiter,
}: {
  box: Device;
  anlageName: string;
  /** Online: weiter (im Assistenten Schritt 3 „Geräte übernehmen“). Fehlt = der Wirt trägt die Knöpfe. */
  onWeiter?: () => void;
  /** Ohne Lebenszeichen: später anschließen, weiter zur Anlage. Fehlt = der Wirt trägt die Knöpfe. */
  onSpaeter?: () => void;
  weiterText?: string;
}) {
  const [stand, setStand] = useState<Device>(box);
  const [jetzt, setJetzt] = useState(() => new Date());
  useEffect(() => {
    let aktiv = true;
    const fragen = () => {
      setJetzt(new Date());
      api.listDevices().then(
        (liste) => {
          const neu = liste.eintraege.find((d) => d.id === box.id);
          if (aktiv && neu) setStand(neu);
        },
        () => {
          /* ein verpasster Takt ändert nichts an der Aussage; der nächste fragt wieder */
        },
      );
    };
    const takt = window.setInterval(fragen, ERGEBNIS_TAKT_MS);
    return () => {
      aktiv = false;
      window.clearInterval(takt);
    };
  }, [box.id]);

  const status = deviceLiveStatus(stand, jetzt);
  const gedruckt = kennungWieGedruckt(stand.externalRef);
  if (status === 'online') {
    return (
      <section className="vp-koppel-seite" aria-live="polite" aria-labelledby="box-ergebnis-titel">
        <Badge variant="ok" dot className="vp-koppel-chip">
          {`${ERGEBNIS.onlineChip} · Letzter Kontakt ${fmtRelative(stand.lastSeenAt, jetzt)}`}
        </Badge>
        <h3 id="box-ergebnis-titel">{ERGEBNIS.onlineTitel}</h3>
        <p className="vp-koppel-klein">{ERGEBNIS.onlineZeile}</p>
        {onWeiter && (
          <Button variant="primary" size="lg" fullWidth className="vp-koppel-knopf" onClick={onWeiter}>
            {weiterText}
          </Button>
        )}
      </section>
    );
  }
  const zuLange = deviceWaitedTooLong(stand, jetzt);
  return (
    <section className="vp-koppel-seite" aria-live="polite" aria-labelledby="box-ergebnis-titel">
      <Badge variant="warn" dot className="vp-koppel-chip">
        {ERGEBNIS.wartetChip}
      </Badge>
      <h3 id="box-ergebnis-titel">{status === 'stale' ? ERGEBNIS.stillTitel : ERGEBNIS.wartetTitel}</h3>
      <p className="vp-koppel-klein">{ERGEBNIS.wartetZeile(gedruckt, anlageName)}</p>
      <div>
        <h4>{ERGEBNIS.pruefenTitel}</h4>
        <ul className="vp-koppel-liste">
          {ERGEBNIS.pruefen.map((p) => (
            <li key={p}>
              <Icon name="check" size={14} strokeWidth={3} />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="vp-koppel-klein">
        {stand.lastSeenAt ? `Letzter Kontakt ${fmtRelative(stand.lastSeenAt, jetzt)}` : ERGEBNIS.letzterKontaktKeiner}
      </p>
      {zuLange && (
        <div className="vp-alert vp-alert-warn" role="status">
          <p style={{ margin: 0 }}>{ERGEBNIS.zuLange(gedruckt)}</p>
          <HelpLink article="kontakt">{ERGEBNIS.support}</HelpLink>
        </div>
      )}
      {onSpaeter && (
        <Button variant="outline" size="lg" fullWidth className="vp-koppel-knopf" onClick={onSpaeter}>
          {ERGEBNIS.spaeter}
        </Button>
      )}
    </section>
  );
}

/**
 * M11 (QE-5 A): Die Box gehört schon einem anderen Konto (Antwort 409). Nennt kein fremdes Konto und
 * keine Anlage, nur häufige Gründe, die Kennung zum Kopieren und den Weg zum Support.
 */
export function BoxFremdKonto({ kennung, onAndere }: { kennung: string; onAndere: () => void }) {
  return (
    <section className="vp-koppel-seite" role="alert" aria-labelledby="box-fremd-titel">
      <h3 id="box-fremd-titel">{FREMD.titel}</h3>
      <p className="vp-koppel-klein">{FREMD.datenschutz}</p>
      <div>
        <p className="vp-koppel-klein" style={{ marginBottom: 'var(--vp-space-2)' }}>{FREMD.gruendeTitel}</p>
        <ul className="vp-koppel-liste">
          {FREMD.gruende.map((g) => (
            <li key={g}>
              <Icon name="info" size={14} />
              <span>{g}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4>{FREMD.wegTitel}</h4>
        <p className="vp-koppel-klein">{FREMD.weg}</p>
      </div>
      <KennungKachel kennung={kennung} titel="Kennung" zeile={FREMD.kennungZeile} kopieren />
      <HelpLink article="kontakt">{ERGEBNIS.support}</HelpLink>
      <Button variant="ghost" onClick={onAndere}>
        {FREMD.andere}
      </Button>
    </section>
  );
}
