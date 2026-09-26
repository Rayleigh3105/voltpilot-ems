import { Card } from '../../designsystem/components/core/Card';
import type { SoVerdientView } from '../soVerdient';
import { Aufklapper } from './Aufklapper';
import { Balkenliste } from './erloese/Balkenliste';
import { KartenKopf } from './HistorieWelt';

// ⚠ `Erloese.css` hat im Portal keinen anderen Importeur — die Ebenen-Bausteine
//   (`.vp-e1`/`.vp-e2`, `ErloesEbenen.tsx`) und die Aufklapper-Regeln darin
//   hängen an diesem Import. Er bleibt, auch ohne die frühere Zeilen-Form.
import './Erloese.css';
import './SoVerdient.css';

/**
 * Die Karte **„So verdient Ihre Anlage · {Monat}"** — sie beantwortet die
 * Frage, die einzelne ct-Zahlen offenlassen: *ist das gut?*
 *
 * Blick-Reihenfolge: **Verdikt** (die Antwort) → **Balken** (der Beweis: Ø
 * aller Solaranlagen · Ihre Anlage · Ihr Erlös je kWh) → **Kernsatz** (die
 * Pointe) → **Prämien-Zeile** mit ihrem Geld; die Rechnung dahinter auf
 * Abruf. Die €-Antwort des ZEITRAUMS steht eine Karte höher; das einzige
 * eigene Geld dieser Karte ist die Prämie.
 *
 * Reiner Renderer: jedes Wort und jede Zahl kommt aus `soVerdient()`.
 */
export function SoVerdientCard({ view }: { view: SoVerdientView }) {
  return (
    <section className="vp-section">
      <Card padding="lg" radius="lg">
        <KartenKopf icon="sun" category="solar" titel={view.titel} art="bewertet" />
        <SoVerdientInhalt view={view} />
      </Card>
    </section>
  );
}

/**
 * Der INHALT der Karte ohne ihren Rahmen. Die Erlöse-Seite setzt ihn in ihre
 * eigene ruhige Karte; EIN Renderer für beide Fassungen, damit sie nie
 * Verschiedenes sagen.
 */
export function SoVerdientInhalt({ view }: { view: SoVerdientView }) {
  const { praemie } = view;
  // Kurze Stände („amtlich", „anteilig — …") in EINE Zeile; ganze Sätze
  // behalten ihre eigene.
  const kurz = praemie.hinweise.filter((h) => !/[.!?]$/.test(h));
  const saetze = praemie.hinweise.filter((h) => /[.!?]$/.test(h));
  return (
    <>
      {/* Die Antwort zuerst. „aufmerksam" ist ein ruhiger Warnton, kein
          Alarm — und er trägt seinen Grund im Text, nie nur in der Farbe. */}
      {view.verdict && <p className={`vp-sv-verdict vp-sv-${view.verdict.ton}`}>{view.verdict.text}</p>}

      {view.balken && <Balkenliste liste={view.balken} />}

      {/* S7: kein Bild ohne eigene Einspeisung — dafür der ehrliche Satz. */}
      {view.form === 'fallback' && view.hinweis && <p className="vp-sv-fallback">{view.hinweis}</p>}

      {view.rundung && <p className="vp-sv-rundung">{view.rundung}</p>}
      {view.kernsatz && <p className="vp-sv-kernsatz">{view.kernsatz}</p>}
      {view.form === 'balken' && view.hinweis && <p className="vp-sv-kernsatz">{view.hinweis}</p>}

      {/* Die Prämien-Zeile, wörtlich aus `marktpraemie()` — alle vier
          Zustände, inklusive der berechneten Null und des „—" mit Grund. */}
      <div className="vp-sv-praemie">
        <div className="vp-sv-praemie-row">
          <span className="vp-sv-praemie-lbl">{praemie.label}</span>
          <span className={praemie.vorhanden ? 'vp-sv-praemie-val' : 'vp-sv-praemie-val vp-sv-praemie-off'}>
            {praemie.wert}
          </span>
        </div>
        {!praemie.rechnung && <p className="vp-sv-praemie-note">{praemie.note}</p>}
        {kurz.length > 0 && <p className="vp-sv-praemie-hint">{kurz.join(' · ')}</p>}
        {saetze.map((h) => (
          <p key={h} className="vp-sv-praemie-hint">
            {h}
          </p>
        ))}
        {praemie.href && (
          <a className="vp-sv-praemie-link" href={praemie.href}>
            Zu den Einstellungen
          </a>
        )}
        {praemie.rechnung && (
          <Aufklapper titel="So wird die Prämie gerechnet" className="vp-sv-rechnung">
            <p className="vp-sv-praemie-note">{praemie.rechnung}</p>
          </Aufklapper>
        )}
      </div>
    </>
  );
}
