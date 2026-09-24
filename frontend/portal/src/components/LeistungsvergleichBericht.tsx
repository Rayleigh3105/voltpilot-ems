import { useState } from 'react';
import { api, type BerichtDetail } from '../api';
import { vergleichBild } from '../bezugsbasisVergleich';
import type { BerichtRechte } from '../berichtDialoge';
import { UEMS_NORMGRENZE } from '../glossar';
import {
  ABSCHNITT_TITEL,
  ausgabeAbgerufen,
  ausgabeFehler,
  basisZeilen,
  faktorZeilen,
  grenzenZeilen,
  KEINE_FAKTOREN,
  kennzahlZeilen,
  kopfZeilen,
  quellenZeilen,
  standSatz,
  vergleichAusAbzug,
  type LeistungsvergleichAbzug,
  type LvZeile,
} from '../leistungsvergleichBericht';
import * as B from '../uemsBericht';
import { MonateTafel, ZeitraumKopf } from './BezugsbasisVergleich';
import './BezugsbasisVergleich.css';

/**
 * UEMS AP-17 IP-24 (S1–S5, R8): der Leistungsvergleich in der Bericht-Fläche — die acht Abschnitte des Abzugs (IP-21b)
 * in der Folge der Vorlage. Entwurf und Stand zeigen dasselbe; der Stand-Satz (§5.8) sagt, ob es ein Nachweis ist.
 * „Vergleich je Periode“ und „Urteil“ sind die Tafel und der Zeitraum-Kopf von IP-20 (`BezugsbasisVergleich`) mit den
 * Daten des Abzugs — roh ohne Urteil, bereinigt mit Band; hier wird nichts gerechnet. Am Stand die Dateien PDF und CSV
 * (IP-22, `GET …/staende/{nr}/pdf|csv`); eine Ablehnung spricht ihren Satz.
 */
export function LeistungsvergleichBericht({
  abzug: a,
  detail,
  stand,
  rechte,
}: {
  abzug: LeistungsvergleichAbzug;
  detail: BerichtDetail;
  stand: { nr: number; freigegeben_am: string; pruefsumme: string } | null;
  rechte: BerichtRechte;
}) {
  const [abruf, setAbruf] = useState<{ satz: string; fehler: boolean } | null>(null);
  const [laeuft, setLaeuft] = useState<string | null>(null);
  const bild = vergleichBild(vergleichAusAbzug(a));
  const satz = standSatz(a, detail, stand);
  const b = detail.bericht;
  const darfCsv =
    b.geltung_art === 'unternehmen'
      ? rechte.unternehmen.includes(B.kennung('csv', 'unternehmen'))
      : (rechte.standorte.get(b.geltung_id) ?? []).includes(B.kennung('csv', 'standort'));
  // PDF braucht das Recht zum Abrufen — die Seite hat den Bericht gelesen, also hat die Person es (G1, G2).
  const formate = (['pdf', 'csv'] as const).filter((f) => f === 'pdf' || darfCsv);
  const faktoren = faktorZeilen(a);

  async function abrufen(nr: number, format: 'pdf' | 'csv') {
    setLaeuft(format);
    setAbruf(null);
    try {
      const blob = await api.berichtDatei(b.kennung, nr, format);
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = `bericht-${b.kennung}-nr${nr}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      setAbruf({ satz: ausgabeAbgerufen(format, nr), fehler: false });
    } catch (e) {
      setAbruf({ satz: ausgabeFehler(e), fehler: true });
    } finally {
      setLaeuft(null);
    }
  }

  return (
    <div className="vp-lv" data-testid="leistungsvergleich">
      {satz && (
        <p className="vp-lv-stand" data-testid="leistungsvergleich-stand">
          {satz}
        </p>
      )}
      {stand && formate.length > 0 && (
        <div className="vp-br-knoepfe" data-testid="leistungsvergleich-dateien">
          {formate.map((f) => (
            <button key={f} type="button" className="vp-br-knopf" disabled={laeuft !== null} onClick={() => void abrufen(stand.nr, f)}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      {abruf && (
        <p className={abruf.fehler ? 'vp-alert vp-alert-err' : 'vp-muted'} role={abruf.fehler ? 'alert' : 'status'} data-testid="leistungsvergleich-abruf">
          {abruf.satz}
        </p>
      )}

      <Abschnitt schluessel="kopf">
        <Angaben zeilen={kopfZeilen(a)} />
        <p className="vp-bbv-grenze" data-testid="leistungsvergleich-grenze">{UEMS_NORMGRENZE}</p>
      </Abschnitt>
      <Abschnitt schluessel="kennzahl">
        <Angaben zeilen={kennzahlZeilen(a)} />
      </Abschnitt>
      <Abschnitt schluessel="bezugsbasis">
        <Angaben zeilen={basisZeilen(a)} />
      </Abschnitt>
      <Abschnitt schluessel="vergleich_je_periode">
        {bild.art === 'vergleich' && (
          <div className="vp-bbv">
            <MonateTafel monate={bild.monate} />
          </div>
        )}
      </Abschnitt>
      <Abschnitt schluessel="urteil">
        {bild.art === 'vergleich' && (
          <div className="vp-bbv">
            <ZeitraumKopf z={bild.zeitraum} />
          </div>
        )}
      </Abschnitt>
      <Abschnitt schluessel="grenzen_und_vorbehalte">
        <Angaben zeilen={grenzenZeilen(a)} />
      </Abschnitt>
      <Abschnitt schluessel="statische_faktoren">
        {faktoren.length === 0 ? <p className="vp-br-leer">{KEINE_FAKTOREN}</p> : <Angaben zeilen={faktoren} />}
      </Abschnitt>
      <Abschnitt schluessel="quellenverzeichnis">
        <Angaben zeilen={quellenZeilen(a)} />
      </Abschnitt>
    </div>
  );
}

function Abschnitt({ schluessel, children }: { schluessel: string; children: React.ReactNode }) {
  const titel = ABSCHNITT_TITEL[schluessel];
  return (
    <section className="vp-br-block" aria-label={titel} data-testid={`bericht-abschnitt-${schluessel}`}>
      <h2>{titel}</h2>
      {children}
    </section>
  );
}

function Angaben({ zeilen }: { zeilen: LvZeile[] }) {
  return (
    <dl className="vp-br-dl">
      {zeilen.map((z, i) => (
        <div key={`${z.name}-${i}`}>
          <dt>{z.name}</dt>
          <dd>{z.wert}</dd>
        </div>
      ))}
    </dl>
  );
}
