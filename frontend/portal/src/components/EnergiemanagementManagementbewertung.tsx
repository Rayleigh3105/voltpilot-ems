import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type Bericht } from '../api';
import { SAETZE } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_MANAGEMENTBEWERTUNG, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import * as M from '../managementbewertung';
import type { Wiedervorlage } from '../wiedervorlage';
import { EinsichtRecht } from './EinsichtRecht';
import { ManagementbewertungAnlegenDialog } from './ManagementbewertungDialoge';

/**
 * Reiter „Managementbewertung“ (UEMS AP-19 IP-24, §5.5, MG1, MG7): die Managementbewertungen je Jahr — Kennung,
 * Jahr, Entwurf oder Stand Nr. n — aus der Liste der Berichte (Vorlage `managementbewertung`; „Einsicht“ liest sie über
 * `energiemanagement.ansehen`) und „nächste fällig“ aus der Wiedervorlage (MG7 rechnet die Route: letzte Sitzung +
 * Rhythmus der Einstellung — hier wird nur gelesen). „Managementbewertung anlegen“ nur mit `energiemanagement.verwalten`.
 * `saetze` zeigt Grenz- und Verantwortungs-Satz, wo der Reiter allein steht (im Bereich stehen sie am Fuß).
 */
export function EnergiemanagementManagementbewertung({
  onOeffnen,
  heute = () => new Date().toISOString().slice(0, 10),
  saetze = false,
}: {
  onOeffnen: (kennung: string) => void;
  heute?: () => string;
  saetze?: boolean;
}) {
  const [liste, setListe] = useState<Bericht[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [anlegen, setAnlegen] = useState(false);
  const [wv, setWv] = useState<Wiedervorlage | null | 'fehlt'>(null);
  useEffect(() => {
    let aktiv = true;
    api.berichte().then(
      (r) => aktiv && setListe(M.managementbewertungen(r.berichte)),
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    api.energiemanagementWiedervorlage().then(
      (w) => aktiv && setWv(w),
      () => aktiv && setWv('fehlt'),
    );
    return () => {
      aktiv = false;
    };
  }, []);
  return (
    <section className="vp-ez-karte" aria-label={UEMS_MANAGEMENTBEWERTUNG} data-testid="managementbewertung-register">
      <div className="vp-em-kopf">
        <h2>{UEMS_MANAGEMENTBEWERTUNG}</h2>
        <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
          <Button onClick={() => setAnlegen(true)} data-testid="mb-anlegen">
            {M.KNOPF_MB_ANLEGEN}
          </Button>
        </EinsichtRecht>
      </div>
      {liste !== null && wv !== null && wv !== 'fehlt' && (
        <p className="vp-ez-satz" data-testid="mb-naechste">
          {M.naechsteSatz(wv, liste)}
        </p>
      )}
      {fehler ? (
        <p className="vp-ez-fehler" role="alert">{fehler}</p>
      ) : liste === null ? (
        <p className="vp-ez-leise">Wird geladen …</p>
      ) : liste.length === 0 ? (
        <p className="vp-ez-satz" data-testid="managementbewertung-leer">{SAETZE.verzeichnis_leer}</p>
      ) : (
        <ul className="vp-mb-liste" data-testid="managementbewertung-liste">
          {liste.map((b) => (
            <li key={b.kennung} className="vp-mb-zeile" data-testid={`mb-zeile-${b.kennung}`}>
              <button type="button" className="vp-ez-zeile-knopf" onClick={() => onOeffnen(b.kennung)}>
                {`${UEMS_MANAGEMENTBEWERTUNG} ${b.zeitraum}`}
              </button>
              <span className="vp-wv-kz">{b.kennung}</span>
              <span className={b.neueste_nr ? 'vp-mb-stand' : 'vp-ez-leise'}>{M.listenZustand(b)}</span>
            </li>
          ))}
        </ul>
      )}
      {anlegen && (
        <ManagementbewertungAnlegenDialog
          heute={heute()}
          onClose={() => setAnlegen(false)}
          onAngelegt={(kennung) => {
            setAnlegen(false);
            onOeffnen(kennung);
          }}
        />
      )}
      {saetze && (
        <div className="vp-em-saetze">
          <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
          <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
        </div>
      )}
    </section>
  );
}
