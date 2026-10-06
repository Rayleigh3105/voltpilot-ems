import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import * as A from '../abweichungen';
import { api, type AuffaelligkeitenAlle, type Auffaelligkeit } from '../api';
import { monatWort } from '../bezugsbasisVergleich';
import { abweichungRoute, hashForRoute } from '../nav';
import { AuffaelligkeitBlatt } from './AuffaelligkeitBlatt';
import { GrenzSatz } from './GrenzSatz';
import { Recht } from './Recht';
import '../pages/Abweichungen.css';

/**
 * Der Hinweis am Energieziel (Verbessern-Konzept v1 §6.3/§6.4, Entscheid 4): liegt für die Kennzahl eines laufenden
 * Energieziels eine offene Auffälligkeit vor, steht sie vor dem Stand - erst klären, woran der Monat lag, dann wissen
 * Sie, welche Maßnahme hilft. „Beantworten“ öffnet das Antwort-Blatt an Ort und Stelle. Lädt die Liste nicht, schweigt
 * der Hinweis (er ist ein Zusatz, die Seite steht ohne ihn).
 */
export function AuffaelligkeitHinweis({
  kennzahlen,
  art,
}: {
  /** Die Kennzahlen, deren offene Auffälligkeiten hier zählen (laufende Energieziele). */
  kennzahlen: readonly string[];
  /** `reiter`: im Reiter „Energieziele“ · `seite`: auf der Seite eines Energieziels. */
  art: 'reiter' | 'seite';
}) {
  const [liste, setListe] = useState<AuffaelligkeitenAlle | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [blatt, setBlatt] = useState<Auffaelligkeit | null>(null);
  const schluessel = [...kennzahlen].sort().join(',');

  useEffect(() => {
    if (!schluessel) return undefined;
    let aktiv = true;
    api.alleAuffaelligkeiten('offen').then(
      (l) => aktiv && setListe(l),
      () => aktiv && setListe(null),
    );
    return () => {
      aktiv = false;
    };
  }, [schluessel, versuch]);

  if (!liste) return null;
  const offen = liste.vermerke.filter((v) => v.zustand === 'offen' && kennzahlen.includes(v.kennzahl.id));
  if (offen.length === 0) return null;
  const v = offen[offen.length - 1];
  const z = A.anlassZahlen(v.anlass_inhalt);
  const ueber = z?.delta && Number(z.delta) > 0 ? `${A.kennzahlName(v.kennzahl)} lag ${A.zahlDe(z.delta, 1)} % über der Erwartung.` : null;
  const kopf = offen.length === 1 ? `Auffälligkeit zu ${monatWort(v.periode)} · offen.` : `${offen.length} Auffälligkeiten offen, zuletzt ${monatWort(v.periode)}.`;
  const satz =
    art === 'reiter'
      ? `${ueber ?? ''} Klären Sie zuerst, woran es lag - dann wissen Sie, welche Maßnahme hilft.`.trim()
      : 'VoltPilot hat den Monat vermerkt, weil er über der Bezugsbasis liegt. Ob das eine Abweichung ist, sagt eine Person.';

  return (
    <>
      <div className="vp-abw-hinweis" role="note" data-testid={`auffaelligkeit-hinweis-${art}`}>
        <Icon name="info" size={16} />
        <span>
          <b>{kopf}</b> {satz}{' '}
          <Recht aktion="verbesserung.verwalten" standort={v.standort_id}>
            <button type="button" className="vp-abw-link" onClick={() => setBlatt(v)} data-testid="auffaelligkeit-hinweis-beantworten">
              {A.KNOPF_BEANTWORTEN}
            </button>
          </Recht>
        </span>
        {blatt && (
          <AuffaelligkeitBlatt
            vermerk={blatt}
            alle={liste.vermerke}
            abruf={liste.abruf}
            onClose={() => setBlatt(null)}
            onFertig={(x) => {
              setBlatt(null);
              setVersuch((n) => n + 1);
              if (x.abweichung) location.hash = hashForRoute(abweichungRoute(x.abweichung.id));
            }}
          />
        )}
      </div>
      <GrenzSatz className="vp-abw-leise" />
    </>
  );
}
