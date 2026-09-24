import type { ReactNode } from 'react';
import type { Ebene2 } from '../../erloesEbenen';
import type { Abrechnung, LastspitzeKontext, MehrwertBand } from '../../erloeseSeite';
import type { SekundaerZiel } from '../../erloesZeilen';
import { chartTheme } from '../../chartTheme';
import { Erklaert, VrKarte } from '../VerlaufRahmen';
import './ErloeseSeite.css';

/**
 * Die Karten der Erlöse-Seite neben dem Diagramm (Konzept „Verlauf-Rework",
 * Paket P2): die Erklärung der Kachel „VoltPilot-Steuerung", die ABRECHNUNG und der
 * Kontext darunter — Preise, Lastspitze. Reine Render-Bausteine über
 * `erloeseSeite.ts`.
 */

/** Die Rollenfarbe je Posten — dieselbe wie im Diagramm. */
export function postenFarbe(id: 'eigenverbrauch' | 'einspeisung' | 'netzbezug'): string {
  const t = chartTheme();
  return id === 'eigenverbrauch' ? t.cPv : id === 'einspeisung' ? t.cGrid : t.cGeldKosten;
}

/**
 * **Die Abrechnung** — Menge × Ø Preis = Betrag je Posten, darunter der Strich
 * mit dem Ergebnis. Der Mehrwert der Steuerung ist KEIN Anteil davon und
 * steht als eigene Kachel in der Kennzahlenzeile. Die
 * vermiedenen Leistungskosten stehen UNTER dem Strich: sie gehören einer
 * eigenen Abrechnungsperiode und sind nie ein Summand des Ergebnisses.
 */
export function AbrechnungKarte({
  a,
  periode,
  hrefFor,
}: {
  a: Abrechnung;
  periode: string;
  hrefFor: (ziel: SekundaerZiel) => string;
}) {
  return (
    <VrKarte
      titel="Abrechnung"
      sub={periode}
      info={{
        titel: 'Abrechnung',
        text: 'Bewertet mit Ihren Tarif- und Vergütungsangaben — keine Rechnung Ihres Versorgers. Ändern sich die Angaben, ändern sich auch vergangene Beträge.',
      }}
    >
      <table className="vp-vr-bill">
        <thead>
          <tr>
            <th scope="col">Posten · Menge · Ø Preis</th>
            <th scope="col">Betrag</th>
          </tr>
        </thead>
        <tbody>
          {a.posten.map((p) => (
            <tr key={p.id}>
              <th scope="row">
                <span className="vp-vr-bill-pos">
                  <span className="vp-vr-key" style={{ background: postenFarbe(p.id) }} aria-hidden="true" />
                  {p.name}
                  {p.info && <Erklaert info={{ titel: p.name, text: p.info }} />}
                </span>
                {p.unter && <span className="vp-vr-bill-unter">{p.unter}</span>}
                {p.hinweis && (
                  <span className="vp-vr-bill-hinweis">
                    {p.hinweis.text}
                    {p.hinweis.link && (
                      <a className="vp-vr-link" href={hrefFor(p.hinweis.link.ziel)}>
                        {p.hinweis.link.text}
                      </a>
                    )}
                  </span>
                )}
              </th>
              <td className={p.ton ?? undefined}>{p.betrag}</td>
            </tr>
          ))}
          <tr className="summe">
            <th scope="row">Ergebnis</th>
            <td className={a.ergebnis.ton ?? undefined}>{a.ergebnis.betrag}</td>
          </tr>
        </tbody>
      </table>
      {a.ausserhalb && (
        <div className="vp-vr-bill-extra">
          <div className="vp-vr-bill-extra-name">
            <span>{a.ausserhalb.name}</span>
            <span>
              {a.ausserhalb.periode} · nicht im Ergebnis
              <Erklaert info={{ titel: a.ausserhalb.name, text: a.ausserhalb.info }} />
            </span>
          </div>
          <span className="vp-vr-bill-extra-wert">{a.ausserhalb.betrag}</span>
        </div>
      )}
      <p className="vp-vr-foot">
        {a.grundlage}
        {a.rundung ? ` · ${a.rundung}` : ''}
      </p>
    </VrKarte>
  );
}

/** „… — Tarif hinterlegen ›": der Weg am Ende eines Preis-Werts wird ein Link. */
function preisWert(wert: string, hrefFor: (ziel: SekundaerZiel) => string): ReactNode {
  const i = wert.lastIndexOf(' — ');
  if (i < 0 || !wert.trim().endsWith('›')) return wert;
  const weg = wert.slice(i + 3);
  const ziel: SekundaerZiel = /verknüpf/i.test(weg) ? 'mastr' : 'tarif';
  const text = weg.replace(/^nicht verknüpft:\s*/, '');
  return (
    <>
      {wert.slice(0, i)}
      {' · '}
      <a className="vp-vr-link" href={hrefFor(ziel)}>
        {text}
      </a>
    </>
  );
}

/** **Preise im Zeitraum** — die Zeilen von Ebene 2, Begriffe im ⓘ. */
export function PreiseKarte({
  ebene2,
  hrefFor,
}: {
  ebene2: Ebene2;
  hrefFor: (ziel: SekundaerZiel) => string;
}) {
  return (
    <VrKarte
      titel="Preise im Zeitraum"
      info={
        ebene2.glossar.length > 0
          ? {
              titel: 'Begriffe',
              text: (
                <dl className="vp-vr-begriffe">
                  {ebene2.glossar.map((g) => (
                    <div key={g.begriff}>
                      <dt>{g.begriff}</dt>
                      <dd>{g.erklaerung}</dd>
                    </div>
                  ))}
                </dl>
              ),
            }
          : null
      }
    >
      <dl className="vp-vr-liste">
        {ebene2.zeilen.map((z) => (
          <div key={z.label}>
            <dt>{z.label}</dt>
            <dd>{preisWert(z.wert, hrefFor)}</dd>
          </div>
        ))}
      </dl>
    </VrKarte>
  );
}

/**
 * Der Inhalt des ⓘ der Kachel „VoltPilot-Steuerung": die Sätze aus
 * `mehrwertBand` und darunter die Rechnung mit den eingesetzten Zahlen.
 */
export function MehrwertErklaerung({ band, rechnung }: { band: MehrwertBand; rechnung?: ReactNode }) {
  return (
    <div className="vp-vr-mw-info">
      {band.info.map((t) => (
        <p key={t}>{t}</p>
      ))}
      {rechnung}
    </div>
  );
}

/** **Lastspitze** — gehaltene Spitze gegen dieselbe Anlage ohne Speichereinsatz. */
export function LastspitzeKarte({ k, detailHref }: { k: LastspitzeKontext; detailHref?: string }) {
  const t = chartTheme();
  return (
    <VrKarte
      titel="Lastspitze"
      sub={k.periode}
      info={{ titel: 'Vermiedene Leistungskosten', text: k.info }}
      aktionen={<span className="vp-vr-card-value">{k.betrag}</span>}
    >
      {k.ohne && k.gehalten ? (
        <div className="vp-vr-bullet" role="group" aria-label="Spitze ohne und mit Speichereinsatz">
          <div className="vp-vr-bullet-zeile">
            <span>ohne Speichereinsatz</span>
            <b>{k.ohne}</b>
          </div>
          <div className="vp-vr-bullet-spur" aria-hidden="true">
            <i style={{ width: '100%', background: t.cPrice2, opacity: 0.35 }} />
          </div>
          <div className="vp-vr-bullet-zeile">
            <span>gehalten</span>
            <b>{k.gehalten}</b>
          </div>
          <div className="vp-vr-bullet-spur" aria-hidden="true">
            <i style={{ width: `${k.anteilPct ?? 0}%`, background: t.cGrid }} />
          </div>
        </div>
      ) : (
        <p className="vp-vr-empty">In der laufenden Abrechnungsperiode liegen noch keine Messwerte vor.</p>
      )}
      {k.rechnung && <p className="vp-vr-foot">{k.rechnung} · nicht im Ergebnis</p>}
      {detailHref && (
        <a className="vp-vr-link" href={detailHref}>
          Alle Abrechnungsperioden ›
        </a>
      )}
    </VrKarte>
  );
}
