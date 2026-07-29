/**
 * Der **Modus-Container** (report `data/vp-portal-v31-design/` §3).
 *
 * v3.1 macht jeden Modus zu einem Container: einschalten heißt konfigurieren
 * dürfen, und die thematisch zugehörigen Einstellungen leben IM Modus. Diese
 * Detailseite wird aus der Steuerungs-Kapsel geöffnet (eine antippbare
 * Profil-Zeile). Sie zeigt, in Abschnitten:
 *
 *   Kopf (Farb-Punkt der Modus-Tönung · Titel · Status-Pill · Schalter)
 *   → Nutzen-Satz + Beitrag (echte Zahlen aus `contributionRows`, sonst „—")
 *   → Einstellungen — NUR bei aktivem Modus, LESE-ZUERST-Zeilen mit einem
 *      „Bearbeiten"-Inline-Formular je kunden-editierbarer Einstellung (v3.1-M3;
 *      Owner-Korrektur: ein AUSGESCHALTETER Modus zeigt seine Einstellungen GAR
 *      NICHT — kein gesperrter Teaser). Von-VoltPilot-Einstellungen bleiben
 *      read-only (v3.1-M4 trägt ihre Werte nach).
 *   → Voraussetzungen (`requirementChips`, M3-Copy wörtlich)
 *   → Ansichten dieses Modus (dieselben Einträge wie die Sidebar-Gruppe —
 *      EINE Ableitung `manifest.deepViews` → `modeViewItems`)
 *   → Herkunft / „Flow öffnen" (`originLine`, „Flow öffnen" nur mit auflösbarem
 *      `flowRef` — §1.2-Ehrlichkeit).
 *
 * v3.1-M3-Regressionsfalle (die wichtigste): der Site-Save ist eine
 * VOLL-Repräsentation (`buildSitePayload`), damit ein fokussierter Container-Save
 * kein Technik-Feld (Name, max. Einspeiseleistung, …) blankt — und umgekehrt.
 * Der Speicher-Save trägt die vollen Speicherparameter durch und sendet die
 * Speicherschonung nur bei Änderung. Die Schreibpfade sind unverändert
 * (`api.updateSite`/`api.saveBattery`); die Gates bleiben unangetastet.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type EarningsSite,
  type SiteAsset,
  type Site,
  type SupplyPriceUpdate,
  type TarifArt,
} from '../api';
import { modeViewItems, type NavTarget } from '../anlageNav';
import { buildSitePayload } from '../anlage';
import { settingsForMode, type ModeSettingDef } from '../modeSettings';
import { fmtNum } from '../format';
import {
  parsePremiumInput,
  premiumInputText,
  tarifArtLabel,
} from '../fleet';
import { presetOf, speicherschonungLabel, type SpeicherschonungPreset } from '../speicherschonung';
import {
  benefitLine,
  originLine,
  requirementChips,
  type ProfileState,
  type SiteProfile,
} from '../profiles';
import { contributionRows } from '../steuerungArea';
import { modeDeepViews, type ActiveMode, type ModeKind } from '../surface';
import { NetzladenBadge } from './NetzladenBadge';
import { SpeicherschonungField } from './SpeicherschonungField';
import { NetzladenField } from './NetzladenField';
import { AnzulegenderWertField } from './AnzulegenderWertField';
import { TariffFields } from './TariffFields';
import {
  buildSupplyPricePatch,
  supplyPriceFormValues,
  type SupplyPriceFormValues,
} from '../supplyPrice';
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
  /** Eine Ansicht dieses Modus öffnen (Sidebar-Ziel). */
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
                <ModusSettingRow
                  key={s.id}
                  setting={s}
                  site={site}
                  battery={battery}
                  onSiteSaved={onSiteSaved}
                  onBatterySaved={onBatterySaved}
                />
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

// ---------------------------------------------------------------------------
// Einstellungs-Zeile: Lese-zuerst + „Bearbeiten"-Inline-Formular (v3.1-M3)
// ---------------------------------------------------------------------------

/** Ein fail-soft „—" für einen fehlenden (von VoltPilot noch nicht gesetzten) Wert. */
const MISSING = <span className="vp-muted">—</span>;

/** Die Abrechnungsperiode des Leistungspreises in Kundendeutsch. */
function abrechnungLabel(v: 'jahr' | 'monat' | null | undefined): ReactNode {
  if (v === 'jahr') return 'jährlich';
  if (v === 'monat') return 'monatlich';
  return MISSING;
}

/**
 * Die Lese-Wert-Anzeige einer Einstellung. Kunden-editierbare Zeilen (Markt/
 * Eigenverbrauch) UND die von-VoltPilot-eingerichteten Read-only-Werte der
 * Lastspitzenkappung (v3.1-M4: Leistungspreis · Abrechnungsperiode ·
 * Lastspitzen-Reserve — erstmals kunden-SICHTBAR, fail-soft „—" wo unkonfiguriert).
 */
function settingReadValue(id: ModeSettingDef['id'], site: Site, battery: SiteAsset | null): ReactNode {
  switch (id) {
    case 'speicherschonung':
      return battery == null ? (
        <span className="vp-muted">Kein Speicher hinterlegt</span>
      ) : (
        speicherschonungLabel(battery.speicherschonung)
      );
    case 'netzladen':
      return <NetzladenBadge erlaubt={site.netzladenErlaubt} small />;
    case 'anzulegender-wert':
      return site.anzulegenderWertCtKwh != null ? (
        fmtNum(site.anzulegenderWertCtKwh, 'ct/kWh', 2)
      ) : (
        <span className="vp-muted">nicht hinterlegt</span>
      );
    case 'stromtarif':
      return tarifArtLabel(site.tarifArt, site.tarifParamCtKwh);
    // --- v3.1-M4: die drei von VoltPilot eingerichteten Lastspitzen-Werte ----
    case 'leistungspreis':
      return site.leistungspreisEurKw != null ? fmtNum(site.leistungspreisEurKw, '€/kW', 2) : MISSING;
    case 'abrechnung-leistung':
      return abrechnungLabel(site.abrechnungLeistung);
    case 'lastspitzen-reserve':
      return site.peakReserveSocPct != null ? fmtNum(site.peakReserveSocPct, '%', 0) : MISSING;
    default:
      return null;
  }
}

/**
 * Eine Einstellungs-Zeile im Container: Label + Lese-Wert + „Bearbeiten"; das
 * Formular klappt inline auf (das AnlageTechnik-Muster). Von-VoltPilot-
 * Einstellungen (`editability: 'voltpilot'`) bleiben read-only mit der
 * M2-Notiz — v3.1-M4 trägt ihre Werte nach.
 */
function ModusSettingRow({
  setting,
  site,
  battery,
  onSiteSaved,
  onBatterySaved,
}: {
  setting: ModeSettingDef;
  site: Site;
  battery: SiteAsset | null;
  onSiteSaved: (updated: Site) => void;
  onBatterySaved: (assets: SiteAsset[]) => void;
}) {
  const [editing, setEditing] = useState(false);

  // Speicherschonung kann nur mit voll konfiguriertem Speicher gespeichert werden
  // (saveBattery ist eine Voll-Repräsentation der Speicherparameter).
  const batteryReady =
    battery != null &&
    battery.capacityKwh != null &&
    battery.maxChargeKw != null &&
    battery.maxDischargeKw != null;
  const canEdit =
    setting.editability === 'customer' &&
    setting.editForm != null &&
    (setting.id !== 'speicherschonung' || batteryReady);

  // v3.1-M4: eine von-VoltPilot-eingerichtete Einstellung zeigt jetzt ihren WERT
  // (read-only, fail-soft „—"), begleitet von der „Von VoltPilot eingerichtet"-
  // Notiz — der Kunde SIEHT sie erstmals, bearbeitet sie aber nicht (kein Knopf).
  const readonlyByVoltpilot = setting.editability === 'voltpilot';

  return (
    <li className={`vp-modus-setting${editing ? ' editing' : ''}`}>
      <div className="vp-modus-settingtop">
        <span className="vp-modus-settinglabel">{setting.label}</span>
        {editing ? null : (
          <span className="vp-modus-settingval">{settingReadValue(setting.id, site, battery)}</span>
        )}
        {canEdit && !editing ? (
          <button
            type="button"
            className="vp-modus-editbtn"
            onClick={() => setEditing(true)}
          >
            <Icon name="pencil" size={14} />
            Bearbeiten
          </button>
        ) : null}
      </div>
      {readonlyByVoltpilot && !editing ? (
        <span className="vp-modus-settinghint">Von VoltPilot eingerichtet</span>
      ) : null}
      {editing ? (
        <SettingEditForm
          setting={setting}
          site={site}
          battery={battery}
          onCancel={() => setEditing(false)}
          onSiteSaved={(updated) => {
            setEditing(false);
            onSiteSaved(updated);
          }}
          onBatterySaved={(assets) => {
            setEditing(false);
            onBatterySaved(assets);
          }}
        />
      ) : null}
    </li>
  );
}

/** Wählt das richtige Inline-Formular je Einstellungs-Id. */
function SettingEditForm({
  setting,
  site,
  battery,
  onCancel,
  onSiteSaved,
  onBatterySaved,
}: {
  setting: ModeSettingDef;
  site: Site;
  battery: SiteAsset | null;
  onCancel: () => void;
  onSiteSaved: (updated: Site) => void;
  onBatterySaved: (assets: SiteAsset[]) => void;
}) {
  switch (setting.id) {
    case 'speicherschonung':
      return battery ? (
        <SpeicherschonungEditor
          siteId={site.id}
          battery={battery}
          onCancel={onCancel}
          onSaved={onBatterySaved}
        />
      ) : null;
    case 'netzladen':
      return <NetzladenEditor site={site} onCancel={onCancel} onSaved={onSiteSaved} />;
    case 'anzulegender-wert':
      return <AnzulegenderWertEditor site={site} onCancel={onCancel} onSaved={onSiteSaved} />;
    case 'stromtarif':
      return <StromtarifEditor site={site} onCancel={onCancel} onSaved={onSiteSaved} />;
    default:
      return null;
  }
}

/** Actions-Fußzeile eines Inline-Formulars (Abbrechen / Speichern). */
function EditActions({
  busy,
  onCancel,
  onSave,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="vp-modus-editactions">
      <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
        Abbrechen
      </Button>
      <Button variant="primary" size="sm" onClick={onSave} disabled={busy}>
        {busy ? 'Wird gespeichert…' : 'Speichern'}
      </Button>
    </div>
  );
}

const SITE_SAVE_ERROR =
  'Die Änderungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.';

/**
 * Speicherschonung-Editor: der `SpeicherschonungField` + `api.saveBattery`. Er
 * trägt die vollen Speicherparameter durch (Kapazität/Lade-/Entladeleistung/
 * Wirkungsgrad/Gerät) und sendet die Speicherschonung nur bei einer echten
 * Änderung — genau die alte `BatteryEditForm`-Disziplin.
 */
function SpeicherschonungEditor({
  siteId,
  battery,
  onCancel,
  onSaved,
}: {
  siteId: string;
  battery: SiteAsset;
  onCancel: () => void;
  onSaved: (assets: SiteAsset[]) => void;
}) {
  const initial = presetOf(battery.speicherschonung);
  const [schonung, setSchonung] = useState<SpeicherschonungPreset | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const assets = await api.saveBattery(siteId, {
        capacityKwh: battery.capacityKwh!,
        maxChargeKw: battery.maxChargeKw!,
        maxDischargeKw: battery.maxDischargeKw!,
        roundtripEfficiencyPct: battery.roundtripEfficiencyPct,
        deviceId: battery.deviceId,
        // Nur eine aktiv geänderte Wahl wird gesendet; ein unberührtes Formular
        // behält den gespeicherten Wert (auch einen admin-konfigurierten).
        ...(schonung != null && schonung !== initial ? { speicherschonung: schonung } : {}),
      });
      onSaved(assets);
    } catch {
      setError(SITE_SAVE_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-modus-editform">
      <SpeicherschonungField
        current={battery.speicherschonung}
        value={schonung}
        onChange={setSchonung}
      />
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <EditActions busy={busy} onCancel={onCancel} onSave={save} />
    </div>
  );
}

/** Netzladen-Editor: der `NetzladenField` + `api.updateSite` (Voll-Repräsentation). */
function NetzladenEditor({
  site,
  onCancel,
  onSaved,
}: {
  site: Site;
  onCancel: () => void;
  onSaved: (updated: Site) => void;
}) {
  const [netzladen, setNetzladen] = useState<boolean>(site.netzladenErlaubt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateSite(
        site.id,
        buildSitePayload(site, { netzladenErlaubt: netzladen }),
      );
      onSaved(updated);
    } catch {
      setError(SITE_SAVE_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-modus-editform">
      <div className="vp-form-stack">
        <NetzladenField value={netzladen} onChange={setNetzladen} idPrefix="modus-netzladen" />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <EditActions busy={busy} onCancel={onCancel} onSave={save} />
    </div>
  );
}

/** Anzulegender-Wert-Editor: der `AnzulegenderWertField` + `api.updateSite`. */
function AnzulegenderWertEditor({
  site,
  onCancel,
  onSaved,
}: {
  site: Site;
  onCancel: () => void;
  onSaved: (updated: Site) => void;
}) {
  const [text, setText] = useState(premiumInputText(site.anzulegenderWertCtKwh ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const value = parsePremiumInput(text);
    if (value === undefined) {
      setError('Bitte geben Sie den anzulegenden Wert als Zahl in ct/kWh an, z. B. 8,11.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateSite(
        site.id,
        buildSitePayload(site, { anzulegenderWertCtKwh: value }),
      );
      onSaved(updated);
    } catch {
      setError(SITE_SAVE_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-modus-editform">
      <div className="vp-form-stack">
        <AnzulegenderWertField value={text} onChange={setText} />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <EditActions busy={busy} onCancel={onCancel} onSave={save} />
    </div>
  );
}

/** Stromtarif-Editor: die geteilten `TariffFields` + `api.updateSite`. */
function StromtarifEditor({
  site,
  onCancel,
  onSaved,
}: {
  site: Site;
  onCancel: () => void;
  onSaved: (updated: Site) => void;
}) {
  const [tarifArt, setTarifArt] = useState<TarifArt>(site.tarifArt ?? 'ohne');
  const [param, setParam] = useState(premiumInputText(site.tarifParamCtKwh ?? null));
  // The structured Bezugspreis-Komponenten sheet, loaded lazily (Stufe 2). Null
  // until fetched; the form prefills the researched suggestions for a site
  // without a maintained sheet.
  const [supply, setSupply] = useState<SupplyPriceFormValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .supplyPrice(site.id)
      .then((sheet) => alive && setSupply(supplyPriceFormValues(sheet)))
      .catch(() => alive && setSupply(supplyPriceFormValues(null)));
    return () => {
      alive = false;
    };
  }, [site.id]);

  function changeSupply(field: keyof SupplyPriceFormValues, value: string) {
    setSupply((s) => (s ? { ...s, [field]: value } : s));
  }

  async function save() {
    const paramValue = tarifArt === 'ohne' ? null : parsePremiumInput(param);
    if (paramValue === undefined) {
      setError(
        tarifArt === 'dynamisch'
          ? 'Bitte geben Sie den Aufschlag als Zahl in ct/kWh an, z. B. 18.'
          : 'Bitte geben Sie Ihren Strompreis als Zahl in ct/kWh an, z. B. 32,5.',
      );
      return;
    }
    let supplyPatch: SupplyPriceUpdate | null = null;
    if (supply) {
      const built = buildSupplyPricePatch(supply);
      if ('error' in built) {
        setError(built.error);
        return;
      }
      supplyPatch = built.patch;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateSite(
        site.id,
        buildSitePayload(site, { tarifArt, tarifParamCtKwh: paramValue }),
      );
      // The sheet is a separate row; persist it so the operator's maintained
      // components activate the structured import price (Stufe-1 semantics).
      if (supplyPatch) {
        await api.updateSupplyPrice(site.id, supplyPatch);
      }
      onSaved(updated);
    } catch {
      setError(SITE_SAVE_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-modus-editform">
      <div className="vp-form-stack">
        <TariffFields
          tarifArt={tarifArt}
          onTarifArt={setTarifArt}
          param={param}
          onParam={setParam}
          idPrefix="modus-tarif"
          supplyValues={supply ?? undefined}
          onSupplyChange={changeSupply}
        />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <EditActions busy={busy} onCancel={onCancel} onSave={save} />
    </div>
  );
}
