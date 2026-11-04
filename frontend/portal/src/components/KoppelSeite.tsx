import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { deviceLiveStatus, type Device, type Site } from '../api';
import { fmtRelative } from '../format';
import { kennungWieGedruckt } from '../koppelLink';
import { OHNE_RECHT, SCHON_DEINS, WAHL } from '../koppelTexte';
import { KennungKachel } from './KoppelKachel';
import './KoppelBand.css';

/** Was nach der Anmeldung eine eigene Seite braucht (Konzept vp-qr-einstieg, QE-2 A). */
export type KoppelSeiteArt =
  | { art: 'wahl' }
  | { art: 'schonDeins'; deviceId: string; siteId: string }
  | { art: 'ohneRecht' };

/**
 * Die Seiten nach der Anmeldung, die weder Assistent noch Aufbau sind: Wahl der Anlage bei mehreren,
 * „Diese Box gehört schon zu Ihnen“ (M10, geprüft in der eigenen Geräteliste) und „Für das Verbinden
 * fehlt Ihnen das Recht“ (M12, Namen aus der eigenen Selbstauskunft). Verbunden wird hier nie.
 */
export function KoppelSeite({
  seite,
  kennung,
  sites,
  devices,
  kundenadministratoren,
  onAnlage,
  onBoxAnsehen,
  onCockpit,
  onSchliessen,
}: {
  seite: KoppelSeiteArt;
  kennung: string;
  sites: readonly Site[];
  devices: readonly Device[];
  /** Aus der Selbstauskunft: wer im Konto Boxen verbinden kann. */
  kundenadministratoren: readonly { name: string }[];
  /** Wahl: Aufbau dieser Anlage mit der Kennung im Feld. */
  onAnlage: (siteId: string) => void;
  onBoxAnsehen: (siteId: string) => void;
  onCockpit: (siteId: string) => void;
  /** Später verbinden (Wahl) oder „Zur Übersicht“ (M12). */
  onSchliessen: () => void;
}) {
  const gedruckt = kennungWieGedruckt(kennung);
  if (seite.art === 'wahl') {
    return (
      <Card padding="lg" radius="lg" className="vp-koppel-karte">
        <section className="vp-koppel-seite" aria-labelledby="koppel-wahl-titel">
          <h2 id="koppel-wahl-titel">{WAHL.titel}</h2>
          <p className="vp-koppel-klein">{WAHL.zeile(gedruckt)}</p>
          <div className="vp-koppel-handlung">
            {sites.map((s) => (
              <Button key={s.id} variant="outline" size="lg" fullWidth onClick={() => onAnlage(s.id)}>
                {s.name}
              </Button>
            ))}
          </div>
          <Button variant="ghost" onClick={onSchliessen}>
            {WAHL.spaeter}
          </Button>
        </section>
      </Card>
    );
  }
  if (seite.art === 'schonDeins') {
    const box = devices.find((d) => d.id === seite.deviceId) ?? null;
    const anlage = sites.find((s) => s.id === seite.siteId)?.name ?? '';
    const online = box ? deviceLiveStatus(box) === 'online' : false;
    return (
      <Card padding="lg" radius="lg" className="vp-koppel-karte">
        <section className="vp-koppel-seite" aria-labelledby="koppel-deins-titel">
          <h2 id="koppel-deins-titel">
            <Icon name="check" size={18} strokeWidth={3} style={{ verticalAlign: '-2px', marginRight: 8, color: 'var(--vp-ok-ink)' }} />
            {SCHON_DEINS.titel}
          </h2>
          <p className="vp-koppel-klein">{SCHON_DEINS.zeile(gedruckt, anlage)}</p>
          {box && (
            <Badge variant={online ? 'ok' : 'warn'} dot className="vp-koppel-chip">
              {box.lastSeenAt
                ? `${online ? 'Verbunden' : 'Meldet sich gerade nicht'} · Letzter Kontakt ${fmtRelative(box.lastSeenAt)}`
                : 'Wartet auf erste Daten'}
            </Badge>
          )}
          <div className="vp-koppel-handlung">
            <Button variant="primary" size="lg" fullWidth onClick={() => onBoxAnsehen(seite.siteId)}>
              {SCHON_DEINS.ansehen}
            </Button>
            <Button variant="outline" size="lg" fullWidth onClick={() => onCockpit(seite.siteId)}>
              {SCHON_DEINS.cockpit}
            </Button>
          </div>
        </section>
      </Card>
    );
  }
  return (
    <Card padding="lg" radius="lg" className="vp-koppel-karte">
      <section className="vp-koppel-seite" aria-labelledby="koppel-recht-titel">
        <h2 id="koppel-recht-titel">
          <Icon name="lock" size={18} style={{ verticalAlign: '-2px', marginRight: 8 }} />
          {OHNE_RECHT.titel}
        </h2>
        <p className="vp-koppel-klein">{OHNE_RECHT.zeile}</p>
        {kundenadministratoren.length > 0 ? (
          <>
            <p className="vp-koppel-klein">{OHNE_RECHT.bitte(gedruckt)}</p>
            <ul className="vp-koppel-liste">
              {kundenadministratoren.map((p) => (
                <li key={p.name}>
                  <Icon name="users" size={14} />
                  <span>{p.name}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="vp-koppel-klein">{OHNE_RECHT.niemand(gedruckt)}</p>
        )}
        <KennungKachel kennung={kennung} titel="Kennung" zeile={OHNE_RECHT.kennungZeile} kopieren />
        <Button variant="outline" onClick={onSchliessen}>
          {OHNE_RECHT.uebersicht}
        </Button>
      </section>
    </Card>
  );
}
