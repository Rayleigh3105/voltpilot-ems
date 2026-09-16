import { Recht } from './Recht';
/**
 * Der **Anwendungs-Container** (report `data/vp-portal-v31-design/` §3).
 *
 * Das Kundenwort ist seit dem 24.08.2026 **Anwendung** (Captain-Vokabular); die
 * Code-Ids (`ModusContainer`, `ModeKind`, die `vp-modus-*`-Klassen) bleiben.
 *
 * v3.1 macht jede Anwendung zu einem Container: einschalten heißt konfigurieren
 * dürfen, und die thematisch zugehörigen Einstellungen leben IN ihr. Diese
 * Detailseite wird aus der Steuerungs-Kapsel geöffnet (eine antippbare
 * Profil-Zeile). Sie zeigt, in Abschnitten:
 *
 *   Kopf (Farb-Punkt der Anwendungs-Tönung · Titel · Status-Pill · Schalter)
 *   → Nutzen-Satz + Beitrag (echte Zahlen aus `contributionRows`, sonst „—")
 *   → Einstellungen — NUR bei aktiver Anwendung, LESE-ZUERST-Zeilen (Owner-
 *      Korrektur: eine AUSGESCHALTETE Anwendung zeigt ihre Einstellungen GAR NICHT
 *      — kein gesperrter Teaser).
 *      **Seit E1 ist dieser Abschnitt ein SPIEGEL** (Captain-Entscheid D1 vom
 *      31.07.2026): die Werte, die der Kunde selbst stellt, WOHNEN auf der
 *      Einstellungs-Seite der Anlage (`modeSettings.home === 'einstellungen'`)
 *      und sind dort auf JEDER Anlage erreichbar — auch auf einer, auf der gar
 *      keine Anwendung läuft. Der Container zeigt sie weiterhin, weil sie
 *      erklären, WOMIT diese Anwendung rechnet, aber read-only mit dem Deep-Link „In den
 *      Einstellungen ändern". Es gibt bewusst KEINE zweite Bearbeiten-Stelle:
 *      der frühere Zustand — Bearbeiten NUR hier — war die Sackgasse, die
 *      `data/vp-settings-ux-konzept/report.md` §3 belegt.
 *      Von-VoltPilot-Einstellungen bleiben read-only (v3.1-M4 trägt ihre Werte
 *      nach); sie wohnen weiter in der Anwendung, weil sie ohne sie sinnlos wären.
 *   → Voraussetzungen (`requirementChips`, M3-Copy wörtlich)
 *   → Ansichten dieser Anwendung (dieselben Einträge wie die Sidebar-Gruppe —
 *      EINE Ableitung `manifest.deepViews` → `modeViewItems`; was das
 *      BASISSURFACE ohnehin trägt (Fahrplan bei Speicher, Marktpreise bei
 *      Börsentarif) wird abgezogen, sonst behauptete der Abschnitt „wird
 *      verfügbar, sobald Sie die Anwendung einschalten" über eine Ansicht, die
 *      längst in der Navigation steht)
 *   → Herkunft / „Flow öffnen" (`originLine`, „Flow öffnen" nur mit auflösbarem
 *      `flowRef` — §1.2-Ehrlichkeit).
 *
 * Die Schreibpfade der gespiegelten Werte leben seit E1 in
 * `components/SettingEditors.tsx` (eine Wahrheit je Formular); die Gates bleiben
 * unangetastet.
 */
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { type EarningsSite, type SiteAsset, type Site } from '../api';
import { modeViewItems, type NavTarget } from '../ebenenNav';
import { settingsForMode } from '../modeSettings';
import {
  benefitLine,
  originLine,
  requirementChips,
  type ProfileState,
  type SiteProfile,
} from '../profiles';
import { contributionRows } from '../steuerungArea';
import { modeDeepViews, type ActiveMode, type DeepViewId, type ModeKind } from '../surface';
import {
  einstellungenHash,
  settingsGroupFor,
  SETTINGS_DEEPLINK_LABEL,
  SETTINGS_MIRROR_NOTE,
} from '../settingsNav';
import { canEditSetting, SettingRow } from './SettingEditors';
import { SteuerungFormel } from './SteuerungFormel';
import '../components/Profile.css';
import './ModusContainer.css';

/** Anwendungs-Tönung des Farb-Punkts (dieselben Töne wie die Sidebar-Gruppen). */
const TONE_BY_ID: Record<string, string> = {
  marktvermarktung: 'markt',
  lastspitzenkappung: 'peak',
  eigenverbrauch: 'eigen',
  'atypische-netznutzung': 'atyp',
  // Ladepunkte sind die Verbraucher-Rolle des Hauses (Mockups §2 Entscheidung 3).
  lastmanagement: 'laden',
};

export interface ModusContainerProps {
  /** Das Profil, dessen Container geöffnet ist. */
  profile: SiteProfile;
  /** Die zugehörige AKTIVE Anwendung (null, wenn sie aus ist). */
  mode: ActiveMode | null;
  /** Alle aktiven Anwendungen — für die erst-aktiver-gewinnt-Dedupe der Einstellungen. */
  activeModes: ActiveMode[];
  /**
   * Die BASIS-Ansichten der Anlage (`surface.base.deepViews`). Sie werden von
   * „Ansichten dieser Anwendung" abgezogen: der Fahrplan einer Speicher-Anlage
   * ist anwendungs-unabhängig erreichbar, also darf der Container ihn nicht als
   * Freischaltung dieser Anwendung ausweisen. Fehlt die Angabe, wird nichts
   * abgezogen (Verhalten wie vor dem Hotfix).
   */
  baseViews?: readonly DeepViewId[];
  /** Die Anlage (Quelle der Site-Einstellungen + Ziel der Voll-Repräsentation). */
  site: Site;
  /** Der Speicher-Asset der Anlage (null = keiner); Quelle der Speicherschonung. */
  battery: SiteAsset | null;
  /** Die Erlös-Antwort (fail-soft; null = keine Zahlen → „—"). */
  earnings: EarningsSite | null;
  /** Der Schalter ist gerade in Bearbeitung. */
  busy: boolean;
  /** Der Schalter schreibt NUR den Willen; der Server schaltet frei. */
  onToggle: (id: string, next: ProfileState) => void;
  /** Zurück zur Steuerung (die zwei Kapseln). */
  onBack: () => void;
  /** Eine Ansicht dieser Anwendung öffnen (Sidebar-Ziel). */
  onNavigate: (target: NavTarget) => void;
  /** „Flow öffnen" — nur mit auflösbarem `flowRef`. */
  onOpenFlow: (flowRef: { flowId: string; name: string }) => void;
  /** Eine Site-Einstellung wurde gespeichert (Voll-Repräsentation zurück). */
  onSiteSaved: (updated: Site) => void;
  /** Eine Speicher-Einstellung wurde gespeichert (Assets zurück). */
  onBatterySaved: (assets: SiteAsset[]) => void;
}

export function ModusContainer({
  profile,
  mode,
  activeModes,
  baseViews = [],
  site,
  battery,
  earnings,
  busy,
  onToggle,
  onBack,
  onNavigate,
  onOpenFlow,
  onSiteSaved,
  onBatterySaved,
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

  // Der Beitrag (echte Zahlen) — nur bei aktiver Anwendung.
  const contrib = on && mode ? contributionRows(mode, earnings) : [];

  // Einstellungen — Owner-Korrektur: NUR bei AKTIVER Anwendung, kein Teaser bei aus.
  // Der Anlagen-Kontext filtert zusätzlich alles heraus, was für DIESE Anlage
  // wirkungslos wäre (der anzulegende Wert ist ein Direktvermarktungs-Fakt).
  // Seit E1 ist die Liste ein SPIEGEL: was der Kunde selbst stellt, wird hier
  // gezeigt und in den Einstellungen geändert.
  const settings = on && mode ? settingsForMode(mode, activeModes, { plantKind: site.plantKind }) : [];
  const mirrored = settings.some((s) => s.home === 'einstellungen' && canEditSetting(s, battery));

  const requirements = requirementChips(profile);

  // Ansichten dieser Anwendung — dieselbe Ableitung wie die Sidebar-Gruppe. Bei
  // ausgeschalteter Anwendung gibt es kein ActiveMode-Objekt, also die Views je Art.
  // Was die Basis ohnehin trägt (Fahrplan/Marktpreise), wird abgezogen.
  const deepViews = mode?.manifest.deepViews ?? modeDeepViews(profile.id as ModeKind);
  const views = modeViewItems(deepViews, baseViews);

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
          <Recht aktion="betriebsweise.aendern"><button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={`${profile.label} ${on ? 'ausschalten' : 'einschalten'}`}
            className={`vp-switch${on ? ' on' : ''}`}
            disabled={busy}
            onClick={() => onToggle(profile.id, on ? 'aus' : 'an')}
          >
            <span className="vp-switch-knob" aria-hidden="true" />
          </button></Recht>
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
                    {/* „Wie wird das berechnet?" — nur an der Zeile mit der
                        Steuerungs-Zurechnung (Captain 01.09.2026). */}
                    {row.formel ? <SteuerungFormel input={row.formel} /> : null}
                  </div>
                  <span className={`vp-modus-contribval${row.value == null ? ' muted' : ''}`}>
                    {row.value ?? '—'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* --- Einstellungen: der SPIEGEL (E1) ------------------------------- */}
        {settings.length > 0 ? (
          <section className="vp-modus-sect" aria-label="Einstellungen">
            <h3 className="vp-modus-secthead">Einstellungen</h3>
            <ul className="vp-setting-list">
              {settings.map((s) => (
                <SettingRow
                  key={s.id}
                  setting={s}
                  site={site}
                  battery={battery}
                  // Kein Bearbeiten hier: der Wert wohnt auf der Einstellungs-
                  // Seite, dieser Container zeigt ihn nur — mit dem Weg dorthin.
                  action={{
                    kind: 'link',
                    href: einstellungenHash(site.id, settingsGroupFor(s.id)),
                    label: SETTINGS_DEEPLINK_LABEL,
                  }}
                  onSiteSaved={onSiteSaved}
                  onBatterySaved={onBatterySaved}
                />
              ))}
            </ul>
            {mirrored ? <p className="vp-modus-viewsnote">{SETTINGS_MIRROR_NOTE}</p> : null}
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

        {/* --- Ansichten dieser Anwendung ------------------------------------ */}
        {views.length > 0 ? (
          <section className="vp-modus-sect" aria-label="Ansichten dieses Betriebsmodells">
            <h3 className="vp-modus-secthead">Ansichten dieses Betriebsmodells</h3>
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
                Diese Ansichten werden verfügbar, sobald Sie das Betriebsmodell einschalten.
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
