import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { BoxUnterseite } from '../components/KoppelKachel';
import { api, type Device } from '../api';
import { fmtRelative } from '../format';
import { HelpLink } from '../help/HelpProvider';
import { kennungWieGedruckt } from '../koppelLink';
import { WEG } from '../koppelTexte';
import { BoxZeichnung } from './BoxZeichnung';
import { STATION_LABEL, STATION_REIHENFOLGE, wegLage, type StationKey, type StationState, type WegLage } from './wegLage';
import '../components/KoppelBand.css';
import './BoxWeg.css';

/** S1 (Bericht Abschnitt 7.1): Abfrage alle 5 s statt der früheren 10 s. */
export const WEG_TAKT_MS = 5000;

/**
 * Der Weg (E1 = B): fünf Stationen - Eingesteckt · Box startet · Anmeldung ·
 * Datenverbindung · Ihre Anlage - mit der echten Box als Zeichnung, der
 * verstrichenen Zeit im Chip und einer Prüf-Hilfe, sobald es länger als meist
 * dauert. Ersetzt die frühere Zweiteilung „online"/„wartet" (`BoxErgebnis`)
 * vollständig; dieselbe äußere Schnittstelle (`onWeiter`/`onSpaeter`), damit
 * der Assistent (`AnlageFlow.tsx`) sie unverändert einhängt.
 */
export function BoxWeg({
  box,
  anlageName,
  onWeiter,
  onSpaeter,
  onStandChange,
  weiterText = WEG.weiter,
}: {
  box: Device;
  anlageName: string;
  /** Online: weiter nach Schritt 3. Fehlt = der Wirt trägt die Knöpfe. */
  onWeiter?: () => void;
  /** Noch kein Lebenszeichen: später anschließen, weiter zur Anlage. Fehlt = der Wirt trägt die Knöpfe. */
  onSpaeter?: () => void;
  /** Der jeweils neueste Stand aus der eigenen Abfrage - der Wirt braucht ihn, um „online“ in Schritt 3 ehrlich weiterzutragen. */
  onStandChange?: (stand: Device) => void;
  weiterText?: string;
}) {
  const [stand, setStand] = useState<Device>(box);
  const [jetzt, setJetzt] = useState(() => new Date());
  const onStandChangeRef = useRef(onStandChange);
  onStandChangeRef.current = onStandChange;
  useEffect(() => {
    onStandChangeRef.current?.(stand);
  }, [stand]);
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
    const takt = window.setInterval(fragen, WEG_TAKT_MS);
    return () => {
      aktiv = false;
      window.clearInterval(takt);
    };
  }, [box.id]);

  const lage = wegLage(stand, jetzt);
  const gedruckt = kennungWieGedruckt(stand.externalRef);
  const zeigePruefHilfe = lage.hinweis === 'pruefen' || lage.hinweis === 'support';

  return (
    <section className="vp-koppel-seite vp-weg-seite" aria-live="polite" aria-labelledby="box-weg-titel">
      <div className="vp-weg-bild">
        <BoxZeichnung online={lage.online} hervorheben={zeigePruefHilfe ? '5v' : null} />
      </div>

      <Weg lage={lage} />

      <h3 id="box-weg-titel">{lage.titel}</h3>
      <p className="vp-koppel-klein">{lage.satz}</p>

      {zeigePruefHilfe && <PruefHilfe gedruckt={gedruckt} anlageName={anlageName} support={lage.hinweis === 'support'} />}

      {lage.hinweis === 'datensperre' && (
        <div className="vp-alert vp-alert-warn" role="status">
          <p style={{ margin: 0 }}>{WEG.datensperreHilfe(gedruckt)}</p>
        </div>
      )}

      <p className="vp-koppel-klein">{stand.lastSeenAt ? WEG.letzterKontakt(fmtRelative(stand.lastSeenAt, jetzt)) : WEG.letzterKontaktKeiner}</p>

      {lage.online && onWeiter && (
        <Button variant="primary" size="lg" fullWidth className="vp-koppel-knopf" onClick={onWeiter}>
          {weiterText}
        </Button>
      )}
      {!lage.online && onSpaeter && (
        <Button variant="outline" size="lg" fullWidth className="vp-koppel-knopf" onClick={onSpaeter}>
          {WEG.spaeter}
        </Button>
      )}
    </section>
  );
}

function Weg({ lage }: { lage: WegLage }) {
  return (
    <ol className="vp-weg-liste" aria-label="Fortschritt beim Verbinden">
      {STATION_REIHENFOLGE.map((key) => (
        <StationEintrag key={key} stationKey={key} zustand={lage.stationen[key]} aktiv={key === lage.aktiv} chipText={lage.chipText} warnung={lage.hinweis !== 'keiner'} />
      ))}
    </ol>
  );
}

function StationEintrag({
  stationKey,
  zustand,
  aktiv,
  chipText,
  warnung,
}: {
  stationKey: StationKey;
  zustand: StationState;
  aktiv: boolean;
  chipText: string | null;
  warnung: boolean;
}) {
  return (
    <li className={`vp-weg-station is-${zustand}`}>
      <span className={`vp-weg-marke${zustand === 'active' ? ' vp-ustate-busy' : ''}`} aria-hidden="true">
        {zustand === 'done' && <Icon name="check" size={14} strokeWidth={3} />}
        {zustand === 'problem' && <Icon name="alert-triangle" size={14} />}
        {zustand === 'active' && <span className="vp-ustate-dot" />}
      </span>
      <span className="vp-weg-label">
        {STATION_LABEL[stationKey]}
        {stationKey === 'eingesteckt' && zustand === 'dashed' && <em>{WEG.eingestecktSie}</em>}
      </span>
      {aktiv && chipText && (
        <Badge variant={warnung ? 'warn' : 'tint'} className="vp-weg-chip">
          {chipText}
        </Badge>
      )}
    </li>
  );
}

/** Ab 5:00: die drei Fragen, eine nach der anderen (Abschnitt 5/7.1). */
function PruefHilfe({ gedruckt, anlageName, support }: { gedruckt: string; anlageName: string; support: boolean }) {
  return (
    <div className="vp-weg-pruefen">
      <h4>{WEG.pruefenTitel}</h4>
      <ul className="vp-koppel-liste">
        {WEG.pruefen.map((p) => (
          <li key={p}>
            <Icon name="check" size={14} strokeWidth={3} />
            <span>{p}</span>
          </li>
        ))}
      </ul>
      <div className="vp-weg-frage3">
        <p className="vp-koppel-klein" style={{ marginBottom: 'var(--vp-space-2)' }}>
          {WEG.frage3}
        </p>
        <BoxUnterseite gedruckt={gedruckt} titel={WEG.erwarteteKennung(gedruckt)} />
      </div>
      {support && (
        <div className="vp-alert vp-alert-warn" role="status">
          <p style={{ margin: 0 }}>{WEG.zuLange(gedruckt, anlageName)}</p>
          <HelpLink article="kontakt">{WEG.support}</HelpLink>
        </div>
      )}
    </div>
  );
}
