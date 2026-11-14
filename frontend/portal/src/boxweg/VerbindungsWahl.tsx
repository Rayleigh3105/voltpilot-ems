import { Button } from '../../designsystem/components/core/Button';
import { VERBINDUNG_WAHL } from '../koppelTexte';
import '../components/KoppelBand.css';
import './BoxWeg.css';

/**
 * „Wie soll Ihre Box ins Internet?" (Konzept vp-edge-light-wlan-s5, E5=A,
 * Bericht Abschnitt 0.1, Bildschirm 1): zwei gleichwertige Karten, direkt
 * nach dem Verbinden mit der Kennung. „Mit Netzwerkkabel" führt unverändert
 * in den bisherigen Weg (`BoxWeg`); „Über WLAN" zuerst zur Anleitung
 * (`WlanEinrichten`). Beide Wege laufen danach im selben `BoxWeg` zusammen -
 * die Wahl ändert nur, WAS vorher gezeigt wird, nie, WIE die Box verfolgt wird.
 */
export function VerbindungsWahl({ onWahl }: { onWahl: (wahl: 'kabel' | 'wlan') => void }) {
  return (
    <section className="vp-koppel-seite vp-verbindung-wahl" aria-labelledby="verbindung-wahl-titel">
      <h3 id="verbindung-wahl-titel">{VERBINDUNG_WAHL.titel}</h3>
      <div className="vp-koppel-handlung">
        <Button variant="outline" size="lg" fullWidth className="vp-wahl-karte" onClick={() => onWahl('kabel')}>
          <span className="vp-wahl-karte-titel">{VERBINDUNG_WAHL.kabelTitel}</span>
          <span className="vp-wahl-karte-zeile">{VERBINDUNG_WAHL.kabelZeile}</span>
        </Button>
        <Button variant="outline" size="lg" fullWidth className="vp-wahl-karte" onClick={() => onWahl('wlan')}>
          <span className="vp-wahl-karte-titel">{VERBINDUNG_WAHL.wlanTitel}</span>
          <span className="vp-wahl-karte-zeile">{VERBINDUNG_WAHL.wlanZeile}</span>
        </Button>
      </div>
      <p className="vp-koppel-klein">{VERBINDUNG_WAHL.hinweis}</p>
    </section>
  );
}
