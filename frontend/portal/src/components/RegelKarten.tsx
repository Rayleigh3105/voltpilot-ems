import { Recht } from './Recht';
/**
 * Die REGEL-LISTE als KARTEN (Einheitsmodell Stufe 5a, Konzept
 * `vp-komponenten-einheit-h2` Teil 5b.2) — reiner Renderer.
 *
 * Je Karte: Name → Klartext-Satz → Zustands-Zeile → Komponenten-Chips, rechts
 * der Schnellschalter und „Öffnen". Sortiert wird „Aufmerksamkeit zuerst";
 * beides entscheidet die reine `regeln/zustand.ts`, hier wird nichts abgeleitet.
 *
 * Der Schnellschalter, ehrlich: AUS geht IMMER (Pausieren ist nirgends
 * gate-pflichtig). AN prüft der Server erneut — eine Ablehnung bleibt AUS und
 * die Fläche zeigt den deutschen Server-Grund, nie ein Schein-Erfolg.
 */
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import type { RegelKarte } from '../regeln/zustand';
import { komponenteHash } from '../nav';
// Der Schnellschalter ist der Haus-Schalter aus M3 (samt seiner >= 44-px-
// Trefferfläche über `::before`). Die Datei wird hier MITgeladen, damit die
// Karte nicht darauf angewiesen ist, dass ein Geschwister sie importiert.
import './Profile.css';
import './Regeln.css';
import { AUFBAU_REITER } from '../ebenenNav';

export function RegelKarteView({
  karte,
  siteId,
  busy,
  onToggle,
  onOpen,
}: {
  karte: RegelKarte;
  /**
   * Anlagen-Zentrale Stufe 3 (PR 3c): der Weg ZURÜCK auf die Komponente. Ohne
   * Anlage (Test, Vorschau) bleiben die Chips reiner Text - ein Link, der
   * nirgends hinführt, wird gar nicht erst angeboten.
   */
  siteId?: string;
  busy: boolean;
  onToggle: (karte: RegelKarte, an: boolean) => void;
  onOpen: (karte: RegelKarte) => void;
}) {
  const z = karte.zustand;
  return (
    <li className={`vp-regel vp-regel-${z.ton}`}>
      <span className={`vp-rowdot ${z.ton}`} aria-hidden="true" />
      <div className="vp-regel-text">
        <strong className="vp-regel-name">{karte.name}</strong>
        <p className="vp-regel-satz">{karte.satz ?? karte.ersatz}</p>
        <p className={`vp-regel-zustand ton-${z.ton}`}>{z.zeile}</p>
        {/* Die Zähler-Zeile des Regel-Protokolls (Stufe 5b). Ohne Beleg steht
            hier NICHTS - nie eine erfundene 0. */}
        {karte.aktivitaet && <p className="vp-regel-aktivitaet">{karte.aktivitaet}</p>}
        {karte.hinweis && <p className="vp-regel-hinweis">{karte.hinweis}</p>}
        {/* Der NACHTEIL-BELEG (Stufe 7): was der Vorrang dieser Regel den
            Fahrplan bisher gekostet hat. Er steht NEBEN dem Hinweis - der
            warnt vorher, dieser berichtet laufend. Ohne belastbare Zahl
            steht hier nichts. */}
        {karte.nachteil && <p className="vp-regel-nachteil">{karte.nachteil}</p>}
        {karte.chips.length > 0 && (
          <span className="vp-regel-chips">
            {karte.chips.map((c) =>
              // ⚠ Nur ein Chip, der eine LEBENDE Komponente benennt, führt
              // irgendwohin: eine entfernte („warn") hat keine Zeile mehr, und
              // ein Nachweis-Chip benennt gar keine Komponente. Ein Link ins
              // Leere wäre schlimmer als kein Link.
              siteId && c.ton === 'plain' && !c.key.includes(':') ? (
                <a
                  key={c.key}
                  className={`vp-regel-chip ton-${c.ton} is-link`}
                  href={komponenteHash(siteId, c.key)}
                  title={`„${c.label}" unter „${AUFBAU_REITER}" zeigen`}
                >
                  {c.label}
                </a>
              ) : (
                <span key={c.key} className={`vp-regel-chip ton-${c.ton}`}>{c.label}</span>
              ),
            )}
          </span>
        )}
      </div>
      <div className="vp-regel-actions">
        <Recht aktion="betriebsweise.aendern"><button
          type="button"
          role="switch"
          aria-checked={karte.an}
          aria-label={`${karte.name} ${karte.an ? 'pausieren' : 'einschalten'}`}
          className={`vp-switch${karte.an ? ' on' : ''}`}
          disabled={busy}
          onClick={() => onToggle(karte, !karte.an)}
        >
          <span className="vp-switch-knob" aria-hidden="true" />
        </button></Recht>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpen(karte)}>
          Öffnen
        </Button>
      </div>
    </li>
  );
}

/**
 * Das Banner über der Liste, solange eine Sofortaktion läuft — mit dem einen
 * Knopf, der sie beendet („Automatik fortsetzen" heißt hier „Jetzt beenden").
 */
export function SofortBanner({
  text,
  hinweis,
  busy,
  onBeenden,
}: {
  text: string;
  hinweis: string;
  busy: boolean;
  onBeenden: () => void;
}) {
  return (
    <div className="vp-regel-sofort" role="status">
      <Icon name="alert-triangle" size={16} />
      <div className="vp-regel-sofort-text">
        <strong>{text}</strong>
        <p>{hinweis}</p>
      </div>
      <Recht aktion="handeingriff.setzen"><Button variant="outline" size="sm" disabled={busy} onClick={onBeenden}>
        Jetzt beenden
      </Button></Recht>
    </div>
  );
}
