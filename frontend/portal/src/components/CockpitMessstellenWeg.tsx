import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api } from '../api';
import { cockpitWeg, type CockpitWeg } from '../uemsOberflaechen';
import './CockpitMessstellenWeg.css';

/**
 * UEMS AP-13 IP-11 (E2 = A, Q4, O18) — der EINE Weg, den das Anlagen-Cockpit von AP-13 bekommt:
 * „Messstellen dieser Anlage · 9 von 9 Messstellen liefern Daten“, ein Sprung ins Register, gefiltert
 * auf genau diese Anlage.
 *
 * ⚠ **Hier wird keine Zahl des Cockpits getauscht.** Die Leiste zeigt weiter die Rollups der Box; dass
 * „Netzbezug heute 1 212 kWh“ neben „MS-01 1 209 kWh“ steht, sind zwei Abtastungen desselben Zählers
 * (AP-07 W11) — kein Abgleich, keine Warnung. Die Umstellung des Cockpits auf Messstellen-Zahlen ist der
 * Bestätigungsschritt der Bestandsübernahme in AP-14, nicht eine Fläche dieses Pakets.
 *
 * ⚠ Gefragt wird das Register NUR, wenn der Standort dieser Anlage misst (`misst`). Ein reiner
 * Betriebskunde stellt damit keine Anfrage und sieht nichts Neues — kein Wort, kein Platzhalter (O18).
 */
export function CockpitMessstellenWeg({ siteId, misst }: { siteId: string; misst: boolean }) {
  const [weg, setWeg] = useState<CockpitWeg | null>(null);

  useEffect(() => {
    if (!misst) {
      setWeg(null);
      return;
    }
    let aktiv = true;
    api
      .messstellenRegister({ anlage: siteId })
      .then((r) => aktiv && setWeg(cockpitWeg(siteId, r.aggregat.unternehmen)))
      // Ohne Antwort steht kein Weg — ein Cockpit ohne diese Zeile ist das Cockpit von gestern.
      .catch(() => aktiv && setWeg(null));
    return () => {
      aktiv = false;
    };
  }, [siteId, misst]);

  if (!weg) return null;
  return (
    <a className="vp-cockpit-msweg" href={weg.sprung.hash} data-testid="cockpit-messstellen-weg">
      <span className="vp-cockpit-msweg-titel">{weg.titel}</span>
      <span className="vp-cockpit-msweg-text">{weg.text}</span>
      <Icon name="chevron-right" size={18} aria-hidden />
    </a>
  );
}
