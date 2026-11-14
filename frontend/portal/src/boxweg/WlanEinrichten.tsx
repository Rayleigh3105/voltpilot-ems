import { Button } from '../../designsystem/components/core/Button';
import { KennungKachel } from '../components/KoppelKachel';
import { WLAN_EINRICHTEN } from '../koppelTexte';
import '../components/KoppelBand.css';
import './BoxWeg.css';

/**
 * Über WLAN (Konzept vp-edge-light-wlan-s5, Bericht Abschnitt 0.1, Bildschirme
 * 2W/2W'): die Box bleibt ohne Netzwerkkabel am Platz, der Kunde verbindet
 * sein eigenes Gerät mit dem Einrichtungs-WLAN der Box und trägt dort die
 * Kennung ein, die hier steht - dieselbe, mit der er die Box gerade verbunden
 * hat. Was danach auf der Seite der Box passiert (S3/S4), ist nicht Teil
 * dieses Auftrags; „Weiter" führt in denselben `BoxWeg` wie beim Kabel.
 */
export function WlanEinrichten({
  externalRef,
  onWeiter,
  onZurueck,
}: {
  /** Die rohe Kennung der Box (`Device.externalRef`); `KennungKachel` druckt sie selbst. */
  externalRef: string;
  onWeiter: () => void;
  onZurueck: () => void;
}) {
  return (
    <section className="vp-koppel-seite vp-wlan-einrichten" aria-labelledby="wlan-einrichten-titel">
      <h3 id="wlan-einrichten-titel">{WLAN_EINRICHTEN.titel}</h3>
      <ol className="vp-koppel-schritte vp-wlan-schritte">
        {WLAN_EINRICHTEN.schritte.map((s) => (
          <li key={s}>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <KennungKachel kennung={externalRef} titel={WLAN_EINRICHTEN.kennungTitel} zeile={WLAN_EINRICHTEN.kennungZeile} kopieren />
      <div className="vp-koppel-handlung">
        <Button variant="primary" size="lg" fullWidth className="vp-koppel-knopf" onClick={onWeiter}>
          {WLAN_EINRICHTEN.weiter}
        </Button>
        <Button variant="ghost" onClick={onZurueck}>
          {WLAN_EINRICHTEN.zurueck}
        </Button>
      </div>
    </section>
  );
}
