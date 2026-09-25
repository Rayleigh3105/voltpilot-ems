import { useEffect, useState } from 'react';
import { api, type EnergiemanagementStandortKurz, type EnergiemanagementVergleich } from '../api';
import * as E from '../energiemanagementPortal';
import { UEMS_ANWENDUNGSBEREICH, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';

const orte = (liste: EnergiemanagementStandortKurz[]) => liste.map((s) => s.name ?? s.kurzzeichen ?? '').join(', ') || '—';

/**
 * Anwendungsbereich neben dem Betrachtungsumfang der energetischen Bewertung (UEMS AP-19 IP-9, DK7, W5, R2): der Leser
 * `GET …/dokumente/{id}/vergleich` — beide Mengen nebeneinander und die Sätze der Route, ohne Urteil; der Vergleich
 * ändert nichts. `saetze` zeigt Grenz- und Verantwortungs-Satz, wo der Vergleich allein steht.
 */
export function AnwendungsbereichVergleich({ dokumentId, stand, saetze = false }: { dokumentId: string; stand?: unknown; saetze?: boolean }) {
  const [v, setV] = useState<EnergiemanagementVergleich | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => {
    let aktiv = true;
    api.energiemanagementVergleich(dokumentId).then(
      (r) => aktiv && setV(r),
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [dokumentId, stand]);
  return (
    <section className="vp-ez-karte" aria-label="Vergleich mit dem Betrachtungsumfang" data-testid="anwendungsbereich-vergleich">
      <h2>{UEMS_ANWENDUNGSBEREICH} und Betrachtungsumfang</h2>
      {fehler && <p className="vp-ez-fehler" role="alert">{fehler}</p>}
      {v && (
        <>
          <dl className="vp-em-dl">
            <dt>{UEMS_ANWENDUNGSBEREICH}{v.fassung ? ` (Fassung ${v.fassung})` : ''}</dt>
            <dd>{v.anwendungsbereich ? `${orte(v.anwendungsbereich.standorte)} · ${v.anwendungsbereich.traeger.join(', ')}` : 'noch keine freigegebene Fassung'}</dd>
            <dt>Betrachtungsumfang der energetischen Bewertung</dt>
            <dd>
              {v.betrachtungsumfang
                ? `Fassung ${v.betrachtungsumfang.fassung}, ab ${E.tagText(v.betrachtungsumfang.gueltig_ab)}: ${orte(v.betrachtungsumfang.standorte)} · ${v.betrachtungsumfang.traeger.join(', ')}`
                : 'nicht festgelegt'}
            </dd>
          </dl>
          {v.saetze.map((s) => (
            <p key={s} className="vp-ez-satz" data-testid="vergleich-satz">
              {s}
            </p>
          ))}
        </>
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
