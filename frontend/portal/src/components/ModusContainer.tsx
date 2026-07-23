/**
 * v3.1-M2 — die **Modus-Container-Seite** (report `data/vp-portal-v31-design/`
 * §3, Meilenstein v3.1-M2).
 *
 * v3.1 macht jeden Modus zu einem Container: einschalten heißt konfigurieren
 * dürfen, und die thematisch zugehörigen Einstellungen leben IM Modus. Diese
 * Detailseite wird aus der Steuerungs-Kapsel geöffnet (eine antippbare
 * Profil-Zeile). Sie zeigt, in Abschnitten:
 *
 *   Kopf (Farb-Punkt der Modus-Tönung · Titel · Status-Pill · Schalter)
 *   → Nutzen-Satz + Beitrag (echte Zahlen aus `contributionRows`, sonst „—")
 *   → Einstellungen  — NUR bei aktivem Modus, Read-only-Zeilen aus
 *      `settingsForMode()` (die Bearbeiten-Formulare kommen in v3.1-M3;
 *      Owner-Korrektur: ein AUSGESCHALTETER Modus zeigt seine Einstellungen GAR
 *      NICHT — kein gesperrter Teaser)
 *   → Voraussetzungen (`requirementChips`, M3-Copy wörtlich)
 *   → Ansichten dieses Modus (dieselben Einträge wie die Sidebar-Gruppe —
 *      EINE Ableitung `manifest.deepViews` → `modeViewItems`)
 *   → Herkunft / „Flow öffnen" (`originLine`, „Flow öffnen" nur mit auflösbarem
 *      `flowRef` — §1.2-Ehrlichkeit).
 *
 * Reiner Renderer: jede Ableitung/Formulierung kommt aus `profiles.ts`,
 * `steuerungArea.ts`, `modeSettings.ts`, `surface.ts` und `anlageNav.ts`. Der
 * Schalter schreibt nur den Willen (der Server schaltet frei); die Gates bleiben
 * unverändert.
 */
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { EarningsSite } from '../api';
import { modeViewItems, type NavTarget } from '../anlageNav';
import { settingsForMode } from '../modeSettings';
import {
  benefitLine,
  originLine,
  requirementChips,
  type ProfileState,
  type SiteProfile,
} from '../profiles';
import { contributionRows } from '../steuerungArea';
import { modeDeepViews, type ActiveMode, type ModeKind } from '../surface';
import '../components/Profile.css';
import './ModusContainer.css';

/** Modus-Tönung des Farb-Punkts (dieselben Töne wie die Sidebar-Gruppen). */
const TONE_BY_ID: Record<string, string> = {
  marktvermarktung: 'markt',
  lastspitzenkappung: 'peak',
  eigenverbrauch: 'eigen',
  'atypische-netznutzung': 'atyp',
};

export interface ModusContainerProps {
  /** Das Profil, dessen Container geöffnet ist. */
  profile: SiteProfile;
  /** Der zugehörige AKTIVE Modus (null, wenn das Profil aus ist). */
  mode: ActiveMode | null;
  /** Alle aktiven Modi — für die erst-aktiver-gewinnt-Dedupe der Einstellungen. */
  activeModes: ActiveMode[];
  /** Die Erlös-Antwort (fail-soft; null = keine Zahlen → „—"). */
  earnings: EarningsSite | null;
  /** Der Schalter ist gerade in Bearbeitung. */
  busy: boolean;
  /** Der Schalter schreibt NUR den Willen; der Server schaltet frei. */
  onToggle: (id: string, next: ProfileState) => void;
  /** Zurück zur Steuerung (die zwei Kapseln). */
  onBack: () => void;
  /** Eine Ansicht dieses Modus öffnen (Sidebar-Ziel). */
  onNavigate: (target: NavTarget) => void;
  /** „Flow öffnen" — nur mit auflösbarem `flowRef`. */
  onOpenFlow: (flowRef: { flowId: string; name: string }) => void;
}

export function ModusContainer({
  profile,
  mode,
  activeModes,
  earnings,
  busy,
  onToggle,
  onBack,
  onNavigate,
  onOpenFlow,
}: ModusContainerProps) {
  const on = profile.active;
  const reason = on ? profile.blockedReason : null;
  const tone = TONE_BY_ID[profile.id] ?? 'automation';

  // Der Status-Pill: aktiv / läuft-noch-nicht / inaktiv.
  const status: { variant: 'ok' | 'warn' | 'off'; label: string } = !on
    ? { variant: 'off', label: 'Inaktiv' }
    : reason
      ? { variant: 'warn', label: 'Läuft noch nicht' }
      : { variant: 'ok', label: 'Aktiv' };

  // Der Beitrag (echte Zahlen) — nur bei aktivem Modus.
  const contrib = on && mode ? contributionRows(mode, earnings) : [];

  // Einstellungen — Owner-Korrektur: NUR bei AKTIVEM Modus, kein Teaser bei aus.
  const settings = on && mode ? settingsForMode(mode, activeModes) : [];

  const requirements = requirementChips(profile);

  // Ansichten dieses Modus — dieselbe Ableitung wie die Sidebar-Gruppe. Bei
  // ausgeschaltetem Modus gibt es kein ActiveMode-Objekt, also die Views je Art.
  const deepViews = mode?.manifest.deepViews ?? modeDeepViews(profile.id as ModeKind);
  const views = modeViewItems(deepViews);

  const origin = originLine(profile);
  const flowRef = mode?.flowRef ?? null;
  const canOpenFlow = on && mode?.manifest.steuerungCard.action === 'open-flow' && flowRef != null;

  return (
    <div className="vp-modus">
      <button type="button" className="vp-fleet-back" onClick={onBack}>
        <Icon name="chevron-left" size={18} />
        Zur Steuerung
      </button>

      <Card padding="lg" radius="lg" className="vp-modus-card" style={{ minWidth: 0 }}>
        {/* --- Kopf: Farb-Punkt · Titel · Status-Pill · Schalter ------------- */}
        <div className="vp-modus-head">
          <span className={`vp-modus-dot ${tone}`} aria-hidden="true" />
          <h2 className="vp-modus-title">{profile.label}</h2>
          <Badge variant={status.variant}>{status.label}</Badge>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={`${profile.label} ${on ? 'ausschalten' : 'einschalten'}`}
            className={`vp-switch${on ? ' on' : ''}`}
            disabled={busy}
            onClick={() => onToggle(profile.id, on ? 'aus' : 'an')}
          >
            <span className="vp-switch-knob" aria-hidden="true" />
          </button>
        </div>

        {/* --- Nutzen + Beitrag --------------------------------------------- */}
        <p className="vp-modus-benefit">{benefitLine(profile)}</p>

        {reason ? (
          <p className="vp-modus-blocked">
            <Icon name="info" size={16} />
            {reason}
          </p>
        ) : null}

        {contrib.length > 0 ? (
          <section className="vp-modus-sect" aria-label="Beitrag">
            <h3 className="vp-modus-secthead">Was es bringt</h3>
            <ul className="vp-modus-contrib">
              {contrib.map((row) => (
                <li key={row.id} className="vp-modus-contribrow">
                  <div className="vp-modus-contribtext">
                    <span className="vp-modus-contriblabel">{row.label}</span>
                    {row.note ? <span className="vp-modus-contribnote">{row.note}</span> : null}
                  </div>
                  <span className={`vp-modus-contribval${row.value == null ? ' muted' : ''}`}>
                    {row.value ?? '—'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* --- Einstellungen (NUR aktiv; Owner-Korrektur: kein Teaser) ------- */}
        {settings.length > 0 ? (
          <section className="vp-modus-sect" aria-label="Einstellungen">
            <h3 className="vp-modus-secthead">Einstellungen</h3>
            <ul className="vp-modus-settings">
              {settings.map((s) => (
                <li key={s.id} className="vp-modus-setting">
                  <span className="vp-modus-settinglabel">{s.label}</span>
                  {s.editability === 'voltpilot' ? (
                    <span className="vp-modus-settingnote">Von VoltPilot eingerichtet</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* --- Voraussetzungen ---------------------------------------------- */}
        {requirements.length > 0 ? (
          <section className="vp-modus-sect" aria-label="Voraussetzungen">
            <h3 className="vp-modus-secthead">Voraussetzungen</h3>
            <ul className="vp-profile-chips">
              {requirements.map((r) => (
                <li key={r.label} className={`vp-profile-chip req${r.met ? ' met' : ' missing'}`}>
                  <Icon name={r.met ? 'check' : 'alert-triangle'} size={14} />
                  {r.text}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* --- Ansichten dieses Modus --------------------------------------- */}
        {views.length > 0 ? (
          <section className="vp-modus-sect" aria-label="Ansichten dieses Modus">
            <h3 className="vp-modus-secthead">Ansichten dieses Modus</h3>
            <ul className="vp-modus-views">
              {views.map((v) =>
                on ? (
                  <li key={v.key}>
                    <button
                      type="button"
                      className="vp-modus-view"
                      onClick={() => onNavigate(v.target)}
                    >
                      <Icon name={v.icon} size={16} />
                      <span>{v.label}</span>
                      <Icon name="chevron-right" size={16} />
                    </button>
                  </li>
                ) : (
                  <li key={v.key} className="vp-modus-view off">
                    <Icon name={v.icon} size={16} />
                    <span>{v.label}</span>
                  </li>
                ),
              )}
            </ul>
            {!on ? (
              <p className="vp-modus-viewsnote">
                Diese Ansichten werden verfügbar, sobald Sie den Modus einschalten.
              </p>
            ) : null}
          </section>
        ) : null}

        {/* --- Herkunft / Flow öffnen --------------------------------------- */}
        {origin || canOpenFlow ? (
          <div className="vp-modus-origin">
            {origin ? <p className="vp-modus-originline">{origin}</p> : null}
            {canOpenFlow && flowRef ? (
              <button
                type="button"
                className="vp-modus-openflow"
                onClick={() => onOpenFlow(flowRef)}
              >
                <Icon name="zap" size={16} />
                Flow öffnen
              </button>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
