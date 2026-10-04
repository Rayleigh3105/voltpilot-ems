import { useEffect, useId, useState } from 'react';
import {
  ABGRENZUNG_VERLANGT,
  istPauschal,
  jahresEuro,
  kurzfassung,
  mispelCheckApi,
  PAUSCHAL_VERLANGT,
  spanneLage,
  type MispelCheckAnsicht,
} from '../mispelCheck';
import './MispelCheckKarte.css';

/**
 * Der MiSpeL-Check in Schritt 1 des Dialogs „Förderweg ändern“ (MP-48, BK-48 Variante A „Urteil zuerst“): oben der
 * Betrag im Jahr mit Vorzeichen (mittlere Schätzung), ein Satz Grund und die Spanne ungünstig bis günstig; „Wie
 * gerechnet?“ öffnet im selben Schritt die Posten mit Vorzeichen und was die Abgrenzungsoption verlangt. Verglichen
 * wird dieselbe Anlage heute gegen die Abgrenzungsoption, nie gegen „ohne Speicher“. Ohne Ergebnis „wird gerechnet“.
 */
export function MispelCheckKarte({ check, anlageName }: { check: MispelCheckAnsicht | null; anlageName: string }) {
  const basis = useId();
  const [offen, setOffen] = useState(false);
  const k = kurzfassung(check);
  // MP-27 (Befund aus MP-29): der Check Haushalt vergleicht heute gegen die Pauschaloption — eigene Wörter.
  const pauschal = istPauschal(check?.formelsatz);
  const option = pauschal ? 'Pauschaloption' : 'Abgrenzungsoption';
  const kopf = (
    <p className="vp-mc-kopf" id={`${basis}-kopf`}>
      MiSpeL-Check · {anlageName}
    </p>
  );

  if (k.art === 'wird_gerechnet') {
    return (
      <section className="vp-mc is-wird" aria-labelledby={`${basis}-kopf`} data-testid="mispel-check" data-stand="wird_gerechnet">
        {kopf}
        <p className="vp-mc-wird" role="status">
          wird gerechnet
        </p>
        <p className="vp-mc-satz">
          Der Check rechnet ein ganzes Jahr mit echten Viertelstundenpreisen und den Werten genau dieser Anlage. Sobald
          er fertig ist, steht hier, was die {option} gegenüber heute bringt oder kostet.
        </p>
      </section>
    );
  }
  if (k.art === 'hinweis') {
    return (
      <section className="vp-mc is-hinweis" aria-labelledby={`${basis}-kopf`} data-testid="mispel-check" data-stand={k.stand}>
        {kopf}
        <p className="vp-mc-satz">{k.satz}</p>
      </section>
    );
  }

  const lage = spanneLage(k.ungunstig, k.mittel, k.guenstig);
  const spanne = `${jahresEuro(k.ungunstig)} bis ${jahresEuro(k.guenstig)}`;
  return (
    <section className={`vp-mc is-${k.ton}`} aria-labelledby={`${basis}-kopf`} data-testid="mispel-check" data-stand="fertig">
      <div className="vp-mc-urteil">
        {kopf}
        <p className="vp-mc-betrag" data-testid="mispel-check-betrag">
          {k.betrag} im Jahr
        </p>
        <p className="vp-mc-satz">
          <b>{k.urteil}</b> {k.grund}
        </p>
        <div
          className="vp-mc-spanne"
          role="img"
          aria-label={`Spanne ${spanne}, mittlere Schätzung ${k.betrag}`}
          data-testid="mispel-check-spanne"
        >
          <span className="vp-mc-spanne-linie" />
          <span className="vp-mc-spanne-band" style={{ left: `${lage.von}%`, width: `${Math.max(lage.bis - lage.von, 0.5)}%` }} />
          <span className="vp-mc-spanne-null" style={{ left: `${lage.null}%` }}>
            <span>0{' '}€</span>
          </span>
          <span className="vp-mc-spanne-mitte" style={{ left: `${lage.mitte}%` }} />
        </div>
        <p className="vp-mc-spanne-lab">
          <span>ungünstig {jahresEuro(k.ungunstig)}</span>
          <span>günstig {jahresEuro(k.guenstig)}</span>
        </p>
        <p className="vp-mc-klein">
          Mittlere Schätzung, Spanne {spanne}
          {k.fenster ? ` · Ganzjahr ${k.fenster}, echte Viertelstundenpreise` : ''} · Vergleich: dieselbe Anlage mit
          demselben Speicher und VoltPilot, heute gegen {option} — nie gegen „ohne Speicher“.
        </p>
        {k.hinweis && (
          <p className="vp-mc-hinweis" data-testid="mispel-check-hinweis">
            {k.hinweis}
          </p>
        )}
      </div>
      <button
        type="button"
        className="vp-mc-wie"
        aria-expanded={offen}
        aria-controls={`${basis}-rechnung`}
        onClick={() => setOffen((o) => !o)}
      >
        {offen ? 'Rechnung schließen' : 'Wie gerechnet?'}
      </button>
      {offen && (
        <div className="vp-mc-rechnung" id={`${basis}-rechnung`} data-testid="mispel-check-rechnung">
          <p className="vp-mc-label">Woraus es sich zusammensetzt</p>
          <dl className="vp-mc-posten">
            {k.posten.map((p) => (
              <div key={p.art} data-art={p.art}>
                <dt>
                  {p.wort}
                  {p.erklaerung && <small>{p.erklaerung}</small>}
                </dt>
                <dd className={Math.round(p.eur) > 0 ? 'is-plus' : Math.round(p.eur) < 0 ? 'is-minus' : ''}>
                  {jahresEuro(p.eur)}
                </dd>
              </div>
            ))}
            <div className="vp-mc-summe">
              <dt>Unterschied im Jahr</dt>
              <dd className={`is-${k.ton}`}>{jahresEuro(k.summe)}</dd>
            </div>
          </dl>
          <p className="vp-mc-label">Was die {option} verlangt</p>
          <ul className="vp-mc-verlangt">
            {(pauschal ? PAUSCHAL_VERLANGT : ABGRENZUNG_VERLANGT).map((v) => (
              <li key={v.satz}>
                {v.satz} <small>{v.fundstelle}</small>
              </li>
            ))}
          </ul>
          {k.angenommen.length > 0 && (
            <p className="vp-mc-klein">Angenommen, weil noch nicht gemessen: {k.angenommen.join(' · ')}.</p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Lädt den Check der Anlage (nur lesend) und zeigt die Karte; bis zur Antwort steht kein Betrag. `option`: unter
 * welcher Wahl die Karte steht — ein Check der anderen Option (Formelsatz A… unter der Pauschaloption oder P… unter
 * der Abgrenzungsoption) erscheint dort nicht, statt die falsche Option zu bewerten.
 */
export function MispelCheckPlatz({
  siteId,
  anlageName,
  option = 'abgrenzung',
}: {
  siteId: string;
  anlageName: string;
  option?: 'abgrenzung' | 'pauschal';
}) {
  const [check, setCheck] = useState<MispelCheckAnsicht | null | 'laedt' | 'fehler'>('laedt');
  useEffect(() => {
    let lebt = true;
    setCheck('laedt');
    mispelCheckApi
      .lesen(siteId)
      .then((c) => lebt && setCheck(c))
      .catch(() => lebt && setCheck('fehler'));
    return () => {
      lebt = false;
    };
  }, [siteId]);
  if (check === 'laedt') {
    return (
      <section className="vp-mc is-wird" data-testid="mispel-check" data-stand="laedt" aria-busy="true">
        <p className="vp-mc-kopf">MiSpeL-Check · {anlageName}</p>
        <p className="vp-mc-satz">wird geladen …</p>
      </section>
    );
  }
  if (check === 'fehler') {
    return (
      <section className="vp-mc is-hinweis" data-testid="mispel-check" data-stand="fehler">
        <p className="vp-mc-kopf">MiSpeL-Check · {anlageName}</p>
        <p className="vp-mc-satz">Der MiSpeL-Check ist gerade nicht abrufbar. Sie können trotzdem weiter einrichten.</p>
      </section>
    );
  }
  if (check && check.stand !== 'wird_gerechnet' && check.formelsatz != null && istPauschal(check.formelsatz) !== (option === 'pauschal')) {
    return null;
  }
  return <MispelCheckKarte check={check} anlageName={anlageName} />;
}
