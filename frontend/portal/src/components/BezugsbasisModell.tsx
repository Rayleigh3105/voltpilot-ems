import { useEffect, useState } from 'react';
import { api, type BezugsbasisFassung, type Kennzahl } from '../api';
import { datenlageSaetze, dezimal, methodeWort, monatText } from '../bezugsbasisAnlegen';
import * as M from '../bezugsbasisModell';
import { BezugsbasisModellGrafik } from './BezugsbasisModellGrafik';
import './BezugsbasisModell.css';

/**
 * Die Modell-Ansicht einer Fassung (UEMS AP-17 IP-14, §5.2, §5.8): der Kopfsatz in Kundenwörtern („Grundlast 10 523 kWh ·
 * je kg 0,2343 kWh · Streuung ± 0,8 % · gilt für 254 000–341 000 kg“), die Monatspaare als Punkte mit der Geraden, daneben
 * die Tafel mit Güte, Streuung, Spannweite je Einflussgröße, Datenlage und Kennzeichen; darunter die abgelehnte zweite
 * Variable (G4) und die Monate der Grundlage. Beim Verhältnis stattdessen der Basiswert-Satz und die Monatsliste.
 *
 * Steht im Reiter „Bezugsbasis“ an der gespeicherten Fassung und im Schritt „Vorschau“ des Assistenten — beide tragen den
 * Grenz-Satz (SP3); diese Ansicht wiederholt ihn nicht. Alle Sätze kommen aus `bezugsbasisModell.ts`, nichts wird
 * nachgerechnet.
 */
export function BezugsbasisModell({
  fassung: f,
  einheit,
  groessen = {},
  imAssistenten = false,
}: {
  fassung: BezugsbasisFassung;
  /** Die Einheit der Kennzahl („kWh/kg“) — Energie und Einheit der Einflussgröße 1. */
  einheit: string | null;
  groessen?: M.Groessen;
  /** Im Schritt „Vorschau“ nennt die Liste darüber schon Basiswert und Datenlage — hier nicht noch einmal. */
  imAssistenten?: boolean;
}) {
  const modell = M.istModell(f);
  const kopf = M.kopfSatz(f, einheit, groessen);
  const sw = M.spannweiten(f, einheit, groessen);
  const g = M.grafik(f);
  const zwei = sw.find((s) => s.position === 2);
  const abgelehnt = f.abgelehnte_variablen ?? [];
  const kennzeichen = M.kennzeichenListe(f);
  const zeilen = M.monatsZeilen(f, einheit, zwei?.einheit ?? '');
  const paare = M.monatspaare(f);
  const titel = Object.fromEntries(zeilen.map((z, i) => [f.grundlage.perioden?.[i]?.periode ?? String(i), z]));
  const energien = paare.map((p) => p.energie);
  const yMarken =
    energien.length > 0
      ? [...new Set([minText(energien), maxText(energien)])].map((t) => ({ wert: Number(t), text: M.ganzText(t) }))
      : [];
  const eins = sw.find((s) => s.position === 1);
  const xMarken = eins ? [...new Set([eins.von, eins.bis])].map((t) => ({ wert: Number(t), text: dezimal(t) })) : [];

  return (
    <section
      className={`vp-bbm${imAssistenten ? ' is-schmal' : ''}`}
      aria-label={`${modell ? M.TITEL_MODELL : M.TITEL_VERHAELTNIS} ${f.fassung}`}
      data-testid="bezugsbasis-modell-ansicht"
    >
      <h3>
        {modell ? M.TITEL_MODELL : M.TITEL_VERHAELTNIS} {f.fassung} · {methodeWort(f.methode)}
      </h3>
      {modell && kopf ? (
        <p className="vp-bbm-kopf" data-testid="bezugsbasis-modell-kopf">
          {kopf}
        </p>
      ) : (
        !imAssistenten && (
          <p className="vp-bbm-kopf" data-testid="bezugsbasis-modell-basiswert">
            {M.basiswertSatz(f, einheit)}
          </p>
        )
      )}
      {modell && (
        <div className="vp-bbm-raster">
          {g && kopf && (
            <figure className="vp-bbm-grafik">
              <BezugsbasisModellGrafik
                g={g}
                beschreibung={M.grafikBeschreibung(kopf, g.punkte.length)}
                achsen={M.achsen(f, einheit, groessen)}
                xMarken={xMarken}
                yMarken={yMarken}
                punktTitel={(periode) => titel[periode] ?? monatText(periode)}
              />
              <figcaption>
                <ul className="vp-bbm-legende">
                  <li>
                    <span className="vp-bbm-zeichen is-punkt" aria-hidden="true" />
                    {M.LEGENDE_PUNKT}
                  </li>
                  <li>
                    <span className="vp-bbm-zeichen is-gerade" aria-hidden="true" />
                    {M.LEGENDE_GERADE}
                  </li>
                  <li>
                    <span className="vp-bbm-zeichen is-band" aria-hidden="true" />
                    {M.LEGENDE_BAND}
                  </li>
                </ul>
                {zwei && g.zweiteBei !== null && (
                  <p className="vp-bbm-hinweis" data-testid="bezugsbasis-modell-zweite">
                    {M.zweiteHinweis(zwei, g.zweiteBei)}
                  </p>
                )}
              </figcaption>
            </figure>
          )}
          <dl className="vp-bbm-tafel" data-testid="bezugsbasis-modell-tafel">
            {f.r2 && (
              <div>
                <dt>{M.GUETE}</dt>
                <dd data-testid="bezugsbasis-modell-guete">{M.gueteSatz(f.r2)}</dd>
              </div>
            )}
            {f.streuung_prozent && (
              <div>
                <dt>{M.STREUUNG}</dt>
                <dd data-testid="bezugsbasis-modell-streuung">{M.streuungSatz(f.streuung_prozent)}</dd>
              </div>
            )}
            {sw.map((s) => (
              <div key={s.position}>
                <dt>{M.SPANNWEITE}</dt>
                <dd data-testid={`bezugsbasis-modell-spannweite-${s.position}`}>{M.spannweiteSatz(s)}</dd>
              </div>
            ))}
            {!imAssistenten && (
              <div>
                <dt>{M.DATENLAGE}</dt>
                <dd data-testid="bezugsbasis-modell-datenlage">{datenlageSaetze(f).join(' · ')}</dd>
              </div>
            )}
            {kennzeichen.length > 0 && (
              <div>
                <dt>{M.KENNZEICHEN}</dt>
                <dd data-testid="bezugsbasis-modell-kennzeichen">{kennzeichen.join(' · ')}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
      {!modell && !imAssistenten && (
        <dl className="vp-bbm-tafel">
          <div>
            <dt>{M.DATENLAGE}</dt>
            <dd data-testid="bezugsbasis-modell-datenlage">{datenlageSaetze(f).join(' · ')}</dd>
          </div>
          {kennzeichen.length > 0 && (
            <div>
              <dt>{M.KENNZEICHEN}</dt>
              <dd data-testid="bezugsbasis-modell-kennzeichen">{kennzeichen.join(' · ')}</dd>
            </div>
          )}
        </dl>
      )}
      {abgelehnt.map((a) => (
        <p key={String(a.objekt)} className="vp-bbm-abgelehnt" data-testid="bezugsbasis-abgelehnt">
          {M.abgelehntSatz(a, f.variablen[0]?.kennzeichen ?? null, groessen)}
        </p>
      ))}
      {zeilen.length > 0 &&
        (modell ? (
          <details className="vp-bbm-monate">
            <summary>
              {M.MONATE} ({paare.length})
            </summary>
            <MonatsListe zeilen={zeilen} />
          </details>
        ) : (
          <div className="vp-bbm-monate">
            <p className="vp-bbm-unter">{M.MONATE}</p>
            <MonatsListe zeilen={zeilen} />
          </div>
        ))}
    </section>
  );
}

function MonatsListe({ zeilen }: { zeilen: string[] }) {
  return (
    <ul data-testid="bezugsbasis-modell-monate">
      {zeilen.map((z) => (
        <li key={z}>{z}</li>
      ))}
    </ul>
  );
}

/** Kleinster und größter Dezimaltext über den Wert — nur, um die Achse mit Texten der Fassung zu beschriften. */
const minText = (ts: string[]) => ts.reduce((m, t) => (Number(t) < Number(m) ? t : m));
const maxText = (ts: string[]) => ts.reduce((m, t) => (Number(t) > Number(m) ? t : m));

/**
 * Die Modell-Ansicht an der gespeicherten Fassung im Reiter: Namen und Einheiten der Einflussgrößen kommen aus dem
 * Variablen-Vorschlag (IP-11a) derselben Referenzperiode — ohne ihn stehen die Kennzeichen da.
 */
export function BezugsbasisModellAnFassung({ kennzahl, fassung }: { kennzahl: Kennzahl; fassung: BezugsbasisFassung }) {
  const [groessen, setGroessen] = useState<M.Groessen>({});
  const brauchtNamen = M.istModell(fassung) || (fassung.abgelehnte_variablen ?? []).length > 0;
  useEffect(() => {
    if (!brauchtNamen) return;
    let aktiv = true;
    api
      .kennzahlVariablenVorschlag(kennzahl.id, fassung.referenzperiode)
      .then((v) => aktiv && setGroessen(M.groessenAusVorschlag(v)))
      .catch(() => undefined);
    return () => {
      aktiv = false;
    };
  }, [kennzahl.id, fassung.referenzperiode, brauchtNamen]);
  return <BezugsbasisModell fassung={fassung} einheit={kennzahl.einheit_anzeige} groessen={groessen} />;
}
