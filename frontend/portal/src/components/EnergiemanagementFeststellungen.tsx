import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type Feststellung } from '../api';
import * as A from '../auditFeststellung';
import { SAETZE } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_FESTSTELLUNGEN, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { EinsichtRecht } from './EinsichtRecht';
import { FeststellungErfassenDialog } from './FeststellungDialoge';
import { ablehnung } from './InternesAuditDialoge';

/**
 * Reiter „Feststellungen“ (UEMS AP-19 IP-20, §5.4, FS1): offene zuerst, die am längsten überfälligen oben, dann
 * abgeschlossene mit Ergebnis — die Reihenfolge und „seit n Tagen fällig“ kommen von der Route. „Feststellung erfassen“
 * geht auch ohne Audit (eigene, von außen). `saetze` zeigt die zwei Sätze, wo der Reiter allein steht.
 */
export function EnergiemanagementFeststellungen({ onFeststellung, saetze = false }: { onFeststellung: (id: string) => void; saetze?: boolean }) {
  const [liste, setListe] = useState<Feststellung[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [erfassen, setErfassen] = useState(false);
  useEffect(() => {
    let aktiv = true;
    api.energiemanagementFeststellungen().then(
      (r) => aktiv && setListe(r.feststellungen),
      (e) => aktiv && setFehler(ablehnung(e)),
    );
    return () => {
      aktiv = false;
    };
  }, []);
  return (
    <section className="vp-ez-karte" aria-label={UEMS_FESTSTELLUNGEN} data-testid="feststellungen-register">
      <div className="vp-em-kopf">
        <h2>{UEMS_FESTSTELLUNGEN}</h2>
        <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
          <Button onClick={() => setErfassen(true)} data-testid="feststellung-erfassen">
            {A.KNOPF_FESTSTELLUNG}
          </Button>
        </EinsichtRecht>
      </div>
      {fehler ? (
        <p className="vp-ez-fehler" role="alert">{fehler}</p>
      ) : liste === null ? (
        <p className="vp-ez-leise">Wird geladen …</p>
      ) : liste.length === 0 ? (
        <p className="vp-ez-satz" data-testid="feststellungen-leer">{SAETZE.verzeichnis_leer}</p>
      ) : (
        <table className="vp-ez-tafel">
          <thead>
            <tr>
              <th scope="col">Feststellung</th>
              <th scope="col">Quelle</th>
              <th scope="col">Verantwortlich</th>
              <th scope="col">Frist</th>
              <th scope="col">Zustand</th>
            </tr>
          </thead>
          <tbody>
            {liste.map((f) => (
              <tr key={f.id} data-testid={`feststellung-zeile-${f.kennzeichen}`}>
                <td>
                  <button type="button" className="vp-ez-zeile-knopf" onClick={() => onFeststellung(f.id)}>
                    {f.kennzeichen}
                  </button>
                  <span className="vp-ez-leise vp-em-zeile-text">{f.wortlaut}</span>
                </td>
                <td data-label="Quelle">{A.quelleWort(f.quelle)}</td>
                <td data-label="Verantwortlich">{f.verantwortlich.name}</td>
                <td data-label="Frist">
                  {f.zustand === 'offen' ? `${E.tagText(f.frist)}${f.lage.satz ? ` · ${f.lage.satz}` : ''}` : '—'}
                </td>
                <td data-label="Zustand">
                  {f.zustand === 'abgeschlossen' && f.ergebnis ? `abgeschlossen: ${A.ERGEBNIS_WORT[f.ergebnis]}` : A.FESTSTELLUNG_ZUSTAND_WORT[f.zustand]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {erfassen && (
        <FeststellungErfassenDialog
          audit={null}
          onClose={() => setErfassen(false)}
          onErfasst={(f) => {
            setErfassen(false);
            onFeststellung(f.feststellung.id);
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
