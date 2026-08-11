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
// Der Schnellschalter ist der Haus-Schalter aus M3 (samt seiner >= 44-px-
// Trefferfläche über `::before`). Die Datei wird hier MITgeladen, damit die
// Karte nicht darauf angewiesen ist, dass ein Geschwister sie importiert.
import './Profile.css';
import './Regeln.css';

export function RegelKarteView({
  karte,
  busy,
  onToggle,
  onOpen,
}: {
  karte: RegelKarte;
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
        {karte.hinweis && <p className="vp-regel-hinweis">{karte.hinweis}</p>}
        {karte.chips.length > 0 && (
          <span className="vp-regel-chips">
            {karte.chips.map((c) => (
              <span key={c.key} className={`vp-regel-chip ton-${c.ton}`}>{c.label}</span>
            ))}
          </span>
        )}
      </div>
      <div className="vp-regel-actions">
        <button
          type="button"
          role="switch"
          aria-checked={karte.an}
          aria-label={`${karte.name} ${karte.an ? 'pausieren' : 'einschalten'}`}
          className={`vp-switch${karte.an ? ' on' : ''}`}
          disabled={busy}
          onClick={() => onToggle(karte, !karte.an)}
        >
          <span className="vp-switch-knob" aria-hidden="true" />
        </button>
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
      <Button variant="outline" size="sm" disabled={busy} onClick={onBeenden}>
        Jetzt beenden
      </Button>
    </div>
  );
}
