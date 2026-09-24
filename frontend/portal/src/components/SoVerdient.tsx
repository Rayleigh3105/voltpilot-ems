import { Card } from '../../designsystem/components/core/Card';
import type { SoVerdientView } from '../soVerdient';
import { KartenKopf } from './HistorieWelt';
import { SoVerdientChart } from './SoVerdientChart';

// Die Zeilen-Form (S8) trägt die absorbierten Kacheln in der Optik der
// Preis-Karte weiter — deshalb deren Blatt, nicht eine zweite Kopie davon.
import './Erloese.css';
import './SoVerdient.css';

/**
 * Die Karte **„So verdient Ihre Anlage · {Monat}"** — sie beantwortet die
 * Frage, die die drei ct-Kacheln offenließen: *ist das gut?*
 *
 * Blick-Reihenfolge (Konzept §6): Titel mit Monat → **Verdikt** (die Antwort)
 * → **Bild** (der Beweis) → **Kernsatz** (die Pointe) → **Prämien-Zeile** mit
 * ihrem Geld und ihren Hinweisen. Die €-Antwort des ZEITRAUMS steht eine Karte
 * höher; das einzige eigene Geld dieser Karte ist die Prämie.
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
 * Der INHALT der Karte ohne ihren Rahmen — Verdikt, Bild, Kernsatz und
 * Prämien-Zeile. Die Verlauf-Seite (P2) setzt ihn in ihre eigene ruhige Karte;
 * EIN Renderer für beide Fassungen, damit sie nie Verschiedenes sagen.
 */
export function SoVerdientInhalt({ view }: { view: SoVerdientView }) {
  const { praemie } = view;
  return (
    <>
      {/* Die Antwort zuerst. „aufmerksam" ist ein ruhiger Warnton, kein
          Alarm — und er trägt seinen Grund im Text, nie nur in der Farbe. */}
      {view.verdict && (
        <p className={`vp-sv-verdict vp-sv-${view.verdict.ton}`}>{view.verdict.text}</p>
      )}

      {view.chart && <SoVerdientChart data={view.chart} />}

      {/* S8: die absorbierten Export-Zeilen leben hier weiter — ohne Bild,
          weil ein einzelner Ø über zwölf Monatswerte eine Behauptung wäre. */}
      {view.form === 'rows' && view.zeilen.length > 0 && (
        <ul className="vp-preistreiber">
          {view.zeilen.map((z) => (
            <li key={z.id} className={z.vorhanden ? undefined : 'vp-pt-off'}>
              <span className="vp-pt-wert">{z.wert}</span>
              <span className="vp-pt-label">{z.label}</span>
              {z.note && <span className="vp-pt-note">{z.note}</span>}
              {z.hinweise.map((h) => (
                <span key={h} className="vp-pt-hint">
                  {h}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}

      {/* S7: kein Bild ohne eigene Säule — dafür der ehrliche Satz. */}
      {view.form === 'fallback' && view.hinweis && (
        <p className="vp-sv-fallback">{view.hinweis}</p>
      )}

      {view.kernsatz && <p className="vp-sv-kernsatz">{view.kernsatz}</p>}
      {view.form === 'rows' && view.hinweis && (
        <p className="vp-sv-kernsatz">{view.hinweis}</p>
      )}

      {/* Die Prämien-Zeile, wörtlich aus `marktpraemie()` — alle vier
          Zustände, inklusive der berechneten Null und des „—" mit Grund. */}
      <div className="vp-sv-praemie">
        <div className="vp-sv-praemie-row">
          <span className="vp-sv-praemie-lbl">{praemie.label}</span>
          <span
            className={
              praemie.vorhanden
                ? 'vp-sv-praemie-val'
                : 'vp-sv-praemie-val vp-sv-praemie-off'
            }
          >
            {praemie.wert}
          </span>
        </div>
        <p className="vp-sv-praemie-note">{praemie.note}</p>
        {praemie.hinweise.map((h) => (
          <p key={h} className="vp-sv-praemie-hint">
            {h}
          </p>
        ))}
        {praemie.href && (
          <a className="vp-sv-praemie-link" href={praemie.href}>
            Zu den Einstellungen
          </a>
        )}
      </div>
    </>
  );
}
