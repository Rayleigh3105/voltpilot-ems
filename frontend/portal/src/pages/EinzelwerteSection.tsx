import { useEffect, useState } from 'react';
import type { HistoryRange, Site } from '../api';
import { isoDate } from '../periodNav';
import { parseVerlaufParams, verlaufHash } from '../verlauf';
import { historieHash, WELTEN } from '../historieWelten';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { SUMMENWERT } from '../glossar';
import { Icon } from '../../designsystem/components/core/Icon';
import { ZeitLeiste } from '../components/HistorieWelt';
import { VerlaufStatus, VrKarte } from '../components/VerlaufRahmen';
import { VerlaufExplorer } from '../components/VerlaufExplorer';
import { SiteMeasurementComparison } from '../components/SiteMeasurementComparison';
import { GesamtwertKarten } from '../components/GesamtwertKarten';
import { GesamtwertDialog } from '../components/GesamtwertDialog';
import '../components/Historie.css';

/**
 * **Verlauf › Messwerte** (`#/anlage/{id}/einzelwerte`) — Konzept
 * „Verlauf-Rework", Paket P3, Entscheid E2 = A.
 *
 * Der frühere Aufklapper „Einzelne Messwerte vergleichen" der Energie-Seite
 * wird ein eigener Reiter mit derselben Zeitleiste: bis zu drei Messwerte
 * nebeneinander, darunter die Summenwerte als „berechnet". Alte Lesezeichen
 * mit `…/messwerte?m=…` leiten hierher um (`nav.ts`).
 */
export function EinzelwerteSection({ site }: { site: Site }) {
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(init.range);
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );
  const [gwOffen, setGwOffen] = useState(false);
  const [gwVersion, setGwVersion] = useState(0);

  const zeige = (r: HistoryRange, a: Date) => {
    setRange(r);
    setAnchor(a);
    // Die gewählten Messwerte bleiben in der Adresse — nur der Zeitraum wechselt.
    const p = parseVerlaufParams(window.location.hash);
    replaceCurrentNavigation(
      p.targets.length > 0
        ? verlaufHash(site.id, p.targets, r, isoDate(a))
        : historieHash(site.id, 'einzelwerte', r, isoDate(a)),
    );
  };

  useEffect(() => {
    const onHash = () => {
      const p = parseVerlaufParams(window.location.hash);
      setRange(p.range);
      setAnchor(p.at ? new Date(`${p.at}T12:00:00`) : new Date());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="vp-vr">
      <h1 className="vp-sr-only">Messwerte — Gemessen</h1>
      <ZeitLeiste
        range={range}
        anchor={anchor}
        onRange={(r) => zeige(r, anchor)}
        onAnchor={(a) => zeige(range, a)}
      />
      <VerlaufStatus
        art="gemessen"
        aufloesung="einzelne Messwerte Ihrer Geräte"
        info={{ titel: 'So entstehen die Werte', text: WELTEN.messwerte.fussText }}
      />
      <div className="vp-vr-body">
        <VrKarte titel="Messwerte vergleichen" sub="bis zu 3 gleichzeitig">
          <VerlaufExplorer site={site} range={range} anchor={anchor} initialTargets={init.targets} />
        </VrKarte>
        <VrKarte
          titel="Summenwerte"
          info={{
            titel: SUMMENWERT,
            text: 'Aus den Messwerten Ihrer Geräte zusammengestellte Werte. Sie erscheinen mit einem dezenten „berechnet".',
          }}
          aktionen={
            <button type="button" className="vp-vr-textbtn" onClick={() => setGwOffen(true)}>
              <Icon name="plus" size={15} /> {SUMMENWERT}
            </button>
          }
        >
          <GesamtwertKarten siteId={site.id} version={gwVersion} eingebettet />
        </VrKarte>
        {/* Die Zusätzlichen Messwerte tragen ihren eigenen Kopf und Zeitraum. */}
        <section className="vp-vr-card" aria-label="Zusätzliche Messwerte">
          <SiteMeasurementComparison siteId={site.id} />
        </section>
      </div>
      {gwOffen && (
        <GesamtwertDialog
          open
          siteId={site.id}
          onClose={() => setGwOffen(false)}
          onGespeichert={() => setGwVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}
