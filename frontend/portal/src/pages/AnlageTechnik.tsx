import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import type { IconName } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import {
  api,
  ApiError,
  type Device,
  type PlantKind,
  type Site,
  type SiteAsset,
  type SiteDeletionPreview,
} from '../api';
import {
  BATTERY_NO_DEVICE_WARNING,
  netzladenBadge,
  parseFeedInCapInput,
  premiumInputText,
  tarifArtLabel,
} from '../fleet';
import { buildSitePayload } from '../anlage';
import { deviceKindLabel, fmtCoords, fmtNum, fmtRelative, plantKindLabel, zoneLabel } from '../format';
import { settingsPageSettings } from '../modeSettings';
import {
  einstellungenHash,
  geldGroupSummary,
  parseSettingsAnchor,
  SETTING_HINT,
  settingsGroupFor,
  type SettingsGroupId,
} from '../settingsNav';
import {
  AUTHORITY,
  AUTHORITY_ORDER,
  BOX_ADDRESS_NOTE,
  BOX_RULE,
  PROTECTION_SETTINGS_INTRO,
  voltpilotRows,
  ZUSTAENDIG_BOX,
  ZUSTAENDIG_PORTAL,
} from '../settingsSurface';
import {
  VERAEUSSERUNGSFORM_FRAGE,
  VERAEUSSERUNGSFORM_LABEL,
  VERAEUSSERUNGSFORM_TIP,
} from '../glossar';
import { protectionItems } from '../steuerungArea';
import { LocationMap } from '../components/LocationMap';
import { BezugspreisPreview } from '../components/BezugspreisPreview';
import { DangerZone } from '../components/DangerZone';
import { AddDeviceDrawer, DeviceDetailDrawer, DeviceStatusBadge } from '../components/DeviceDrawers';
import { InfoTip } from '../components/InfoTip';
import { MastrDrawer } from '../components/MastrDrawer';
import { SettingRow } from '../components/SettingEditors';
import { SettingsSearch } from '../components/SettingsSearch';
import { ErrorState, TextSkeleton } from '../components/States';
import './Einstellungen.css';

/**
 * "Einstellungen" (Captain-Entscheid D2) - the gear subpage of the Anlage, the
 * calm, editorial page of what the plant *is* and how it should behave: a slim
 * left jump-navigation and six explained sections on the right. Four principles
 * drive it: group by meaning (not DB table), read first + edit on demand,
 * collapse the installer jargon behind "Technische Details", and explain every
 * section in plain German with an info-tooltip per Fachbegriff.
 *
 * **E1 (Settings-UX, Captain-Entscheid D1 vom 31.07.2026) gab der Gruppe
 * „Strompreis & Vergütung" ihren Ort.** v3.1-M3 hatte die Geld-Einstellungen in
 * die Modus-Container verschoben, und weil seither ALLE vier nur noch vom
 * Markt-Modus beansprucht werden, waren sie auf einer gewöhnlichen
 * PV-+-Speicher-Hausanlage über KEINE Fläche mehr erreichbar (Konzept
 * `data/vp-settings-ux-konzept/report.md` §3 - inklusive der Sackgasse, dass der
 * Markt-Modus seinerseits einen dynamischen Tarif voraussetzt). Seit E1 wohnen
 * sie wieder hier, auf JEDER Anlage, unabhängig vom Anlagentyp und von jedem
 * Modus; der Modus-Container spiegelt sie read-only mit einem Deep-Link hierher.
 * Verteilt nach dem Entwurf (§7 P4): Stromtarif/Vergütung/Netzladen in die neue
 * Geld-Gruppe, der „Umgang mit dem Speicher" zu „Mein Speicher" - er ist eine
 * Verhaltens-, keine Geld-Einstellung. Die Formulare selbst leben EINMAL in
 * `components/SettingEditors.tsx`.
 *
 * **E4-E7 (Settings-UX, 31.07.2026) sind der eigentliche UX-Gewinn darauf:**
 *  - **E4** macht die drei Autoritäts-Stufen sichtbar (① Sie · ② VoltPilot ·
 *    ③ automatisch). Captain-Entscheid **D4**: die von VoltPilot eingerichteten
 *    Vertragswerte der Lastspitzenkappung sind für Kunden jetzt read-only
 *    SICHTBAR mit Abzeichen statt unsichtbar (Befund B4) - und der Schutz-
 *    Streifen ③ zieht als Seitenfuß mit um.
 *  - **E5** sagt an jeder Zeile, worauf sie wirkt, und zeigt unter dem Tarif den
 *    LEBENDEN Bezugspreis aus derselben einen Preis-Wahrheit, mit der der
 *    Optimierer plant (`BezugspreisPreview` - keine zweite Preisrechnung).
 *  - **E6** gibt der Seite ein Suchfeld über Label UND Synonym (`glossar.ts`)
 *    und benennt um (D6): Anlagentyp -> Veräußerungsform, „Ihr Strompreis" ->
 *    Arbeitspreis.
 *  - **E7** spricht die Grenze zur Geräteseite beidseitig aus (D5: die Box
 *    bleibt eine eigene Seite).
 * Alle Regeln liegen rein in `settingsSurface.ts` + `glossar.ts`.
 */

/** The six sections, in the concept's order; ids double as scroll anchors. */
const SECTIONS = [
  { key: 'anlage', icon: 'home' as IconName, label: 'Meine Anlage' },
  { key: 'geld', icon: 'euro' as IconName, label: 'Strompreis & Vergütung' },
  { key: 'geraet', icon: 'cpu' as IconName, label: 'Mein Gerät' },
  { key: 'speicher', icon: 'battery' as IconName, label: 'Mein Speicher' },
  { key: 'registrierung', icon: 'file-text' as IconName, label: 'Registrierung' },
  { key: 'loeschen', icon: 'trash' as IconName, label: 'Anlage löschen', danger: true },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

const anchorId = (key: SectionKey) => `technik-${key}`;

/** Der Abschnitt zu einem Schlüssel - robuster als ein Index in `SECTIONS`. */
function sectionOf(key: SectionKey): (typeof SECTIONS)[number] {
  const s = SECTIONS.find((x) => x.key === key);
  if (!s) throw new Error(`Unbekannter Abschnitt ${key}`);
  return s;
}

/**
 * Die per Deep-Link angesprungene Gruppe (E1). Der Modus-Container spiegelt die
 * Geld-/Verhaltens-Werte read-only und verlinkt hierher; ohne das Ziel wäre der
 * Spiegel eine Sackgasse. Gelesen beim Aufbau UND bei jedem Hash-Wechsel, damit
 * ein Klick aus einer bereits offenen Anlage heraus auch wirkt.
 */
function useSettingsAnchor(): SettingsGroupId | null {
  const [group, setGroup] = useState<SettingsGroupId | null>(() =>
    typeof window === 'undefined' ? null : parseSettingsAnchor(window.location.hash),
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHash = () => setGroup(parseSettingsAnchor(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return group;
}

/** Matches the phone breakpoint where sections turn into collapsible cards. */
function useIsPhone(): boolean {
  const query = '(max-width: 720px)';
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setIsPhone(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isPhone;
}

/** Highlights the jump-nav item of the section currently in view (desktop). */
function useScrollSpy(keys: readonly SectionKey[], enabled: boolean): SectionKey | null {
  const [active, setActive] = useState<SectionKey | null>(keys[0] ?? null);
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return;
    const observed = keys
      .map((k) => document.getElementById(anchorId(k)))
      .filter((el): el is HTMLElement => el != null);
    if (observed.length === 0) return;
    const seen = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.intersectionRatio);
        let best: { key: SectionKey; ratio: number } | null = null;
        for (const k of keys) {
          const ratio = seen.get(anchorId(k)) ?? 0;
          if (ratio > 0 && (best == null || ratio > best.ratio)) best = { key: k, ratio };
        }
        if (best) setActive(best.key);
      },
      { rootMargin: '-96px 0px -55% 0px', threshold: [0, 0.2, 0.5, 1] },
    );
    observed.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [keys, enabled]);
  return active;
}

/** The desktop jump-navigation: a hairline left rail that scrolls to a section. */
function JumpNav({ active }: { active: SectionKey | null }) {
  return (
    <nav className="vp-technik-nav" aria-label="Abschnitte">
      {SECTIONS.map((s) => (
        <a
          key={s.key}
          href={`#${anchorId(s.key)}`}
          className={`${active === s.key ? 'on' : ''}${'danger' in s && s.danger ? ' danger' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            document
              .getElementById(anchorId(s.key))
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        >
          <Icon name={s.icon} size={16} />
          {s.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * One explained section. On desktop it is an airy, borderless block (icon tile +
 * title + one explaining sentence + an optional edit affordance, then its
 * content). On the phone it becomes a bordered, collapsible card - a calm list
 * when closed, tap to open. An `alwaysVisible` node (a real warning) stays
 * shown even when the phone card is collapsed.
 */
function TechCard({
  section,
  explain,
  summary,
  action,
  alwaysVisible,
  deepLinked = false,
  children,
}: {
  section: (typeof SECTIONS)[number];
  explain: string;
  /** The one-line status shown under the title on a collapsed phone card. */
  summary?: ReactNode;
  /** Desktop: rendered in the header (e.g. the edit pencil). Phone: in the body. */
  action?: ReactNode;
  alwaysVisible?: ReactNode;
  /**
   * Diese Gruppe wurde per Deep-Link angesprungen (E1): am Telefon klappt sie
   * dann von selbst auf - sonst landete der Spiegel-Link auf einer zugeklappten
   * Karte und der Kunde stünde wieder vor einer verschlossenen Tür.
   */
  deepLinked?: boolean;
  children: ReactNode;
}) {
  const isPhone = useIsPhone();
  const [open, setOpen] = useState(deepLinked);
  useEffect(() => {
    if (deepLinked) setOpen(true);
  }, [deepLinked]);
  const danger = 'danger' in section && section.danger;
  const showBody = !isPhone || open;

  const head = (
    <>
      <span className="vp-tech-cico">
        <Icon name={section.icon} size={19} />
      </span>
      <span className="vp-tech-ct">
        <span className="vp-tech-title">{section.label}</span>
        <span className="vp-tech-exp">{isPhone && !open && summary ? summary : explain}</span>
      </span>
    </>
  );

  return (
    <section
      id={anchorId(section.key)}
      className={`vp-tech-card${danger ? ' danger' : ''}${isPhone && open ? ' open' : ''}`}
    >
      {isPhone ? (
        <button
          type="button"
          className="vp-tech-card-h toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {head}
          <Icon name="chevron-down" size={18} className="vp-tech-chev" />
        </button>
      ) : (
        <div className="vp-tech-card-h">
          {head}
          {action && <span className="vp-tech-action">{action}</span>}
        </div>
      )}

      {alwaysVisible}

      {showBody && (
        <div className="vp-tech-card-body">
          {isPhone && action && <div className="vp-tech-action-phone">{action}</div>}
          {children}
        </div>
      )}
    </section>
  );
}

/** The inline "Technische Details" disclosure - installer values, one click away. */
function TechnischeDetails({ hint, children }: { hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="vp-tech-disc-wrap">
      <button
        type="button"
        className={`vp-tech-disc${open ? ' open' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevron-down" size={16} className="vp-tech-disc-chev" />
        Technische Details
        <span className="lbl">{hint}</span>
        <span className="cv">{open ? 'ausblenden' : 'einblenden'}</span>
      </button>
      {open && <div className="vp-tech-disc-body">{children}</div>}
    </div>
  );
}

/** An outlined "Bearbeiten" affordance matching the mockup's restrained pencil. */
function EditPencil({ onClick, label = 'Bearbeiten' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="vp-tech-edit" onClick={onClick}>
      <Icon name="pencil" size={15} />
      {label}
    </button>
  );
}

export function TechnikSection({
  site,
  devices,
  sites,
  onReload,
  onSiteSaved,
  onSiteDeleted,
}: {
  site: Site;
  /** All devices of the tenant; the section filters to this site's. */
  devices: Device[];
  /** For the device drawers (site picker inside the claim form). */
  sites: Site[];
  onReload: (selectSiteId?: string) => void;
  onSiteSaved: (updated: Site) => void;
  onSiteDeleted: () => void;
}) {
  const [assets, setAssets] = useState<SiteAsset[] | null>(null);
  const [assetsError, setAssetsError] = useState(false);
  const [assetsReloadKey, setAssetsReloadKey] = useState(0);
  const [editSection, setEditSection] = useState<'anlage' | null>(null);
  const [mastrOpen, setMastrOpen] = useState(false);
  const [preview, setPreview] = useState<SiteDeletionPreview | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deviceDetailId, setDeviceDetailId] = useState<string | null>(null);
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);

  const isPhone = useIsPhone();
  const activeSection = useScrollSpy(
    SECTIONS.map((s) => s.key),
    !isPhone,
  );
  const anchored = useSettingsAnchor();
  // E6: der Sprung aus der Suche. Er benutzt dieselbe Maschine wie der
  // Deep-Link (scrollen + am Telefon aufklappen) und schreibt die Adresse
  // kanonisch mit (`replaceState`, kein Verlaufseintrag pro Tastendruck), damit
  // ein Neuladen an derselben Gruppe landet.
  const [jumped, setJumped] = useState<SettingsGroupId | null>(null);
  const [jumpTick, setJumpTick] = useState(0);

  function jumpToGroup(group: SettingsGroupId) {
    setJumped(group);
    setJumpTick((t) => t + 1);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', einstellungenHash(site.id, group));
    }
  }

  // Ein Deep-Link aus einem Modus-Container scrollt seine Gruppe in den Blick
  // (am Telefon klappt die Karte zusätzlich von selbst auf, siehe `TechCard`).
  useEffect(() => {
    if (!anchored) return;
    const el = document.getElementById(anchorId(anchored));
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [anchored, site.id]);

  useEffect(() => {
    if (!jumped) return;
    document.getElementById(anchorId(jumped))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [jumped, jumpTick]);

  /** Ist diese Gruppe gerade angesprungen (Deep-Link ODER Suche)? */
  const opened = (key: SectionKey): boolean => anchored === key || jumped === key;

  const siteDevices = devices.filter((d) => d.siteId === site.id);
  const deviceDetail = siteDevices.find((d) => d.id === deviceDetailId) ?? null;

  useEffect(() => {
    setEditSection(null);
    setPreview(null);
    setDeleteError(null);
    let cancelled = false;
    setAssets(null);
    setAssetsError(false);
    api
      .siteAssets(site.id)
      .then((a) => {
        if (!cancelled) setAssets(a);
      })
      .catch(() => {
        // Distinguish "couldn't load" from "you have none": a backend/RLS
        // failure must not masquerade as an empty section.
        if (!cancelled) setAssetsError(true);
      });
    api
      .siteDeletionPreview(site.id)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch(() => {
        // The delete stays available; the consequence list just shows less detail.
      });
    return () => {
      cancelled = true;
    };
  }, [site.id, assetsReloadKey]);

  async function deleteSite() {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteSite(site.id);
      onSiteDeleted();
      onReload();
    } catch (e) {
      setDeleteError(
        e instanceof ApiError && e.status === 409
          ? 'Die Anlage hat noch Geräte. Bitte entfernen Sie zuerst alle Geräte dieser Anlage.'
          : 'Die Anlage konnte nicht gelöscht werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setDeleteBusy(false);
    }
  }

  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('de-DE');

  function deleteConsequences(): string[] {
    const items = [`Die Anlage „${site.name}" mit allen Daten`];
    if (preview && preview.telemetryCount > 0 && preview.telemetryFrom && preview.telemetryTo) {
      items.push(
        `Alle Messdaten (${fmtNum(preview.telemetryCount, '', 0)} Messwerte vom ${fmtDay(preview.telemetryFrom)} bis ${fmtDay(preview.telemetryTo)})`,
      );
    } else {
      items.push('Alle aufgezeichneten Messdaten dieser Anlage');
    }
    if (preview && (preview.forecastCount > 0 || preview.scheduleCount > 0)) {
      items.push('Alle Prognosen und Fahrpläne dieser Anlage');
    }
    if (preview && preview.weatherCount > 0) {
      items.push('Die gespeicherten Wetterdaten dieser Anlage');
    }
    return items;
  }

  const linkedAssets = (assets ?? []).filter((a) => a.registry != null);
  const pvAsset = linkedAssets.find((a) => a.type === 'pv');
  // The battery is sourced from ALL assets (not just registry-linked): a plant
  // not in the MaStR keeps its battery by hand, and its control-path warning
  // must show regardless of provenance.
  const batteryAsset = (assets ?? []).find((a) => a.type === 'battery') ?? null;
  const lastFetched = linkedAssets
    .map((a) => a.registryFetchedAt)
    .filter((t): t is string => t != null)
    .sort()
    .pop();

  // --- Section: Meine Anlage (Stammdaten + Netzanschluss) -----------------
  const anlageEditing = editSection === 'anlage';
  const anlageCard = (
    <TechCard
      key="anlage"
      section={sectionOf('anlage')}
      deepLinked={opened('anlage')}
      explain="Die Grunddaten Ihrer Anlage - Name, Standort, Veräußerungsform und Netzanschluss."
      summary={site.name}
      action={anlageEditing ? undefined : <EditPencil onClick={() => setEditSection('anlage')} />}
    >
      {anlageEditing ? (
        <StammdatenEditForm
          site={site}
          onCancel={() => setEditSection(null)}
          onSaved={(updated) => {
            setEditSection(null);
            onSiteSaved(updated);
            onReload(updated.id);
          }}
        />
      ) : (
        <>
          <dl className="vp-kv">
            <div className="vp-kv-row">
              <dt className="vp-kv-k">Name</dt>
              <dd className="vp-kv-v">{site.name}</dd>
            </div>
            <div className="vp-kv-row">
              <dt className="vp-kv-k">Standort</dt>
              <dd className="vp-kv-v">
                {fmtCoords(site.latitude, site.longitude) ?? (
                  <span className="vp-muted">noch nicht hinterlegt</span>
                )}
                {' · '}
                {zoneLabel(site.biddingZone)}
              </dd>
            </div>
            {/* E6/D6: „Anlagentyp" hieß ein Vertragsfakt nach einem Technik-
                Wort. Der Kunde liest die Frage, der InfoTip nennt den
                kanonischen Begriff (Zwei-Register-Modell des Begriffs-Audits). */}
            <div className="vp-kv-row">
              <dt className="vp-kv-k">
                {VERAEUSSERUNGSFORM_LABEL}
                <InfoTip title={VERAEUSSERUNGSFORM_LABEL}>{VERAEUSSERUNGSFORM_TIP}</InfoTip>
                <small className="vp-note">{VERAEUSSERUNGSFORM_FRAGE}</small>
              </dt>
              <dd className="vp-kv-v">{plantKindLabel(site.plantKind)}</dd>
            </div>
            <div className="vp-kv-row">
              <dt className="vp-kv-k">
                Maximale Einspeiseleistung
                <InfoTip title="Maximale Einspeiseleistung am Netzanschlusspunkt">
                  Die Leistungsgrenze, bis zu der Ihre Anlage am Netzanschlusspunkt
                  einspeisen darf. Der Fahrplan hält sie automatisch ein - der Bezug
                  aus dem Netz ist davon nicht betroffen.
                </InfoTip>
              </dt>
              <dd className="vp-kv-v">
                {site.maxFeedInKw != null ? (
                  fmtNum(site.maxFeedInKw, 'kW', 1)
                ) : (
                  <span className="vp-muted">keine Grenze hinterlegt</span>
                )}
              </dd>
            </div>
          </dl>
          {site.latitude != null && site.longitude != null ? (
            <div className="vp-tech-map">
              <LocationMap lat={site.latitude} lon={site.longitude} onChange={() => {}} readonly />
            </div>
          ) : (
            <div className="vp-alert vp-alert-info" style={{ marginBottom: 0 }}>
              Ohne Standort auf der Karte gibt es keine Wettervorhersage für diese Anlage.
              Tippen Sie auf „Bearbeiten", um ihn zu setzen.
            </div>
          )}
        </>
      )}
    </TechCard>
  );

  // --- Section: Strompreis & Vergütung (E1, „Gruppe B bekommt ihren Ort") --
  // Die vier Einstellungen, die der Kunde selbst stellt, WOHNEN hier - auf
  // jeder Anlage, unabhängig von Anlagentyp und aktivem Modus. Die Registry
  // (`settingsPageSettings`) ist die eine Wahrheit darüber, welche das sind;
  // die Sichtbarkeitsregel bleibt unverändert, dass der anzulegende Wert ein
  // Direktvermarktungs-Fakt ist (`settingRelevant`).
  const geldSettings = settingsPageSettings({ plantKind: site.plantKind }).filter(
    (s) => settingsGroupFor(s.id) === 'geld',
  );
  // E4/D4: die Stufe-②-Werte dieser Gruppe (Leistungspreis + Abrechnungsperiode).
  const geldVoltpilot = voltpilotRows('geld', site);
  const geldCard = (
    <TechCard
      key="geld"
      section={sectionOf('geld')}
      deepLinked={opened('geld')}
      explain="Womit VoltPilot für Sie rechnet: Ihr Strompreis, Ihre Vergütung und ob der Speicher aus dem Netz laden darf."
      summary={geldGroupSummary({
        tarifLabel: tarifArtLabel(site.tarifArt, site.tarifParamCtKwh),
        netzladenLabel: netzladenBadge(site.netzladenErlaubt).label,
        anzulegenderWertLabel:
          site.plantKind === 'direktvermarktung' && site.anzulegenderWertCtKwh != null
            ? fmtNum(site.anzulegenderWertCtKwh, 'ct/kWh', 2)
            : null,
      })}
    >
      {/* Diese Werte hängen alle an der ANLAGE, nicht an ihren Assets - ein
          fehlgeschlagener Asset-Abruf darf den Stromtarif nie verstecken. */}
      <ul className="vp-setting-list">
        {geldSettings.map((s) => (
          <SettingRow
            key={s.id}
            setting={s}
            site={site}
            battery={batteryAsset}
            action={{ kind: 'edit' }}
            hint={SETTING_HINT[s.id]}
            enriched
            // E5: die lebende Vorschau steht dort, wo Geld eingegeben wird -
            // ein falsch getippter Preis wird SOFORT sichtbar.
            preview={
              s.id === 'stromtarif' ? (
                <BezugspreisPreview siteId={site.id} tarifArt={site.tarifArt} />
              ) : undefined
            }
            onSiteSaved={onSiteSaved}
            onBatterySaved={(a) => setAssets(a)}
          />
        ))}
        {/* E4/D4: die von VoltPilot eingerichteten Vertragswerte - read-only
            SICHTBAR mit Abzeichen ②, ohne Aktionsknopf (der Vertrieb läuft
            persönlich). Sie erscheinen nur, wenn die Anlage sie wirklich
            trägt; eine Hausanlage ohne Lastspitzenkappung zeigt hier nichts. */}
        {geldVoltpilot.map((s) => (
          <SettingRow
            key={s.id}
            setting={s}
            site={site}
            battery={batteryAsset}
            action={{ kind: 'edit' }}
            enriched
            onSiteSaved={onSiteSaved}
            onBatterySaved={(a) => setAssets(a)}
          />
        ))}
      </ul>
    </TechCard>
  );

  // --- Section: Mein Gerät (Wechselrichter) -------------------------------
  const geraetSummary =
    siteDevices.length === 0 ? (
      'Noch kein Gerät verbunden'
    ) : siteDevices.length === 1 ? (
      <DeviceStatusBadge device={siteDevices[0]} />
    ) : (
      `${siteDevices.length} Geräte`
    );
  const geraetCard = (
    <TechCard
      key="geraet"
      section={sectionOf('geraet')}
      deepLinked={opened('geraet')}
      explain="Der Wechselrichter, der Ihre Anlage steuert und Messwerte sendet."
      summary={geraetSummary}
    >
      {siteDevices.length === 0 ? (
        <>
          <p className="vp-muted" style={{ marginTop: 0 }}>
            Noch kein Gerät verbunden. Fügen Sie Ihr Gerät mit seiner Geräte-ID hinzu -
            es verbindet sich selbst, sobald es eingeschaltet ist.
          </p>
          <Button
            variant="outline"
            iconLeft={<Icon name="plus" size={16} />}
            onClick={() => setAddDeviceOpen(true)}
          >
            Gerät hinzufügen
          </Button>
        </>
      ) : (
        <>
          <div className="vp-tech-devices">
            {siteDevices.map((d) => (
              <button
                type="button"
                key={d.id}
                className="vp-tech-device"
                onClick={() => setDeviceDetailId(d.id)}
              >
                <span className="vp-tech-device-main">
                  <span className="vp-tech-device-name">{d.name || d.externalRef}</span>
                  <span className="vp-note">{deviceKindLabel(d.kind)}</span>
                </span>
                <span className="vp-tech-device-status">
                  <DeviceStatusBadge device={d} />
                  <span className="vp-note">{fmtRelative(d.lastSeenAt)}</span>
                </span>
                <Icon name="chevron-right" size={18} className="vp-tech-device-chev" />
              </button>
            ))}
          </div>
          <TechnischeDetails hint="Geräte-ID, Typ, Verlauf">
            <dl className="vp-kv">
              {siteDevices.map((d) => (
                <div className="vp-kv-row" key={d.id}>
                  <dt className="vp-kv-k">{d.name || 'Geräte-ID'}</dt>
                  <dd className="vp-kv-v vp-mono">{d.externalRef}</dd>
                </div>
              ))}
            </dl>
            <p className="vp-note">
              Tippen Sie ein Gerät oben an, um Typ, Verlauf und weitere Aktionen zu öffnen.
            </p>
            <Button
              variant="outline"
              size="sm"
              iconLeft={<Icon name="plus" size={16} />}
              onClick={() => setAddDeviceOpen(true)}
            >
              Weiteres Gerät hinzufügen
            </Button>
          </TechnischeDetails>
        </>
      )}
      <div className="vp-tech-sub">
        <h3 className="vp-tech-sub-title">Weitere Geräte</h3>
        <p className="vp-note" style={{ marginTop: 0 }}>
          Zusätzliche Erzeuger, Zähler und Verbraucher sehen Sie gebündelt im{' '}
          <a href={`#/anlage/${site.id}/modell`}>Anlagen-Modell</a> - dort erscheinen sie
          automatisch, sobald Ihr Gerät sie meldet.
        </p>
      </div>
      {/* E7 (D5): die Box bleibt eine eigene Seite - also wird die Grenze
          beidseitig ausgesprochen. Bewusst OHNE Link: die Geräteseite steht im
          Heimnetz des Kunden, ihre Adresse kennt das Portal nicht. */}
      <div className="vp-set-box">
        <span className="vp-set-box-h">
          <Icon name="cpu" size={16} />
          Ihre VoltPilot-Box
        </span>
        <p>{ZUSTAENDIG_BOX}</p>
        <p>{ZUSTAENDIG_PORTAL}</p>
        <p>{BOX_ADDRESS_NOTE}</p>
        <p>{BOX_RULE}</p>
      </div>
    </TechCard>
  );

  // --- Section: Mein Speicher ---------------------------------------------
  // The battery-without-device warning is a real failure, so it is surfaced at
  // the card's always-visible slot (shown even on a collapsed phone card),
  // NOT buried in the collapsible body.
  const batteryNeedsDevice = batteryAsset != null && batteryAsset.deviceId == null;
  const speicherSettings = settingsPageSettings({ plantKind: site.plantKind }).filter(
    (s) => settingsGroupFor(s.id) === 'speicher',
  );
  // E4/D4: die Lastspitzen-Reserve ist eine Speicher-Reservierung, die
  // VoltPilot einrichtet - sichtbar, sobald sie gesetzt ist.
  const speicherVoltpilot = voltpilotRows('speicher', site);
  const speicherCard = (
    <TechCard
      key="speicher"
      section={sectionOf('speicher')}
      deepLinked={opened('speicher')}
      explain="Ihr Batteriespeicher - so lädt und entlädt ihn der Fahrplan optimal."
      summary={
        batteryNeedsDevice ? (
          <span className="vp-tech-warn-summary">Speicher ohne Gerät</span>
        ) : batteryAsset?.capacityKwh != null ? (
          fmtNum(batteryAsset.capacityKwh, 'kWh', 1)
        ) : (
          'Kein Speicher hinterlegt'
        )
      }
      alwaysVisible={
        assets != null && batteryNeedsDevice ? (
          <div
            className="vp-alert vp-alert-warn"
            style={{ marginTop: 'var(--vp-space-3)', marginBottom: 0 }}
          >
            {BATTERY_NO_DEVICE_WARNING}
          </div>
        ) : undefined
      }
    >
      {assetsError ? (
        <ErrorState
          message="Die Anlagendaten konnten nicht geladen werden."
          onRetry={() => setAssetsReloadKey((k) => k + 1)}
        />
      ) : assets === null ? (
        <TextSkeleton lines={3} />
      ) : (
        <>
          <BatteryControlSection
            siteId={site.id}
            battery={batteryAsset}
            devices={siteDevices}
            onSaved={(a) => setAssets(a)}
            hideWarning
          />
          {/* E1: „Umgang mit dem Speicher" wohnt hier, nicht im Modus-Container
              (Entwurf §7 P4, Gruppe C) - es ist eine Verhaltens-, keine
              Geld-Einstellung. Ohne hinterlegten Speicher gibt es nichts zu
              schonen; dann führt die Karte oben zuerst zum „Speicher
              hinzufügen", statt hier eine wirkungslose Zeile zu zeigen. */}
          {(speicherSettings.length > 0 && batteryAsset != null) || speicherVoltpilot.length > 0 ? (
            <ul className="vp-setting-list vp-tech-settings">
              {(batteryAsset != null ? speicherSettings : []).map((s) => (
                <SettingRow
                  key={s.id}
                  setting={s}
                  site={site}
                  battery={batteryAsset}
                  action={{ kind: 'edit' }}
                  hint={SETTING_HINT[s.id]}
                  enriched
                  onSiteSaved={onSiteSaved}
                  onBatterySaved={(a) => setAssets(a)}
                />
              ))}
              {speicherVoltpilot.map((s) => (
                <SettingRow
                  key={s.id}
                  setting={s}
                  site={site}
                  battery={batteryAsset}
                  action={{ kind: 'edit' }}
                  enriched
                  onSiteSaved={onSiteSaved}
                  onBatterySaved={(a) => setAssets(a)}
                />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </TechCard>
  );

  // --- Section: Registrierung (Marktstammdaten) ---------------------------
  const registrierungCard = (
    <TechCard
      key="registrierung"
      section={sectionOf('registrierung')}
      deepLinked={opened('registrierung')}
      explain="Die offizielle Registrierung Ihrer Anlage - brauchen Sie nur selten."
      summary={linkedAssets.length > 0 ? 'MaStR verknüpft' : 'Nicht verknüpft'}
    >
      {assetsError ? (
        <ErrorState
          message="Die Anlagendaten konnten nicht geladen werden."
          onRetry={() => setAssetsReloadKey((k) => k + 1)}
        />
      ) : assets === null ? (
        <TextSkeleton lines={2} />
      ) : linkedAssets.length === 0 ? (
        <>
          <p className="vp-muted" style={{ marginTop: 0 }}>
            Optional: Verknüpfen Sie Ihre PV-Anlage (und ggf. den Speicher) mit dem
            Marktstammdatenregister, damit Prognose und Optimierung mit den amtlich
            registrierten Werten rechnen.
          </p>
          <Button
            variant="outline"
            iconLeft={<Icon name="sun" size={16} />}
            onClick={() => setMastrOpen(true)}
          >
            Anlage verknüpfen
          </Button>
        </>
      ) : (
        <>
          <div className="vp-tech-reg-status">
            <Badge variant="ok" dot>
              MaStR verknüpft
            </Badge>
            {lastFetched && (
              <span className="vp-note">Zuletzt abgerufen {fmtRelative(lastFetched)}</span>
            )}
          </div>
          <TechnischeDetails hint="Registrierte Werte, MaStR-Nummern">
            <dl className="vp-kv">
              {pvAsset && (
                <>
                  <div className="vp-kv-row">
                    <dt className="vp-kv-k">PV-Leistung</dt>
                    <dd className="vp-kv-v">
                      {pvAsset.pvCapacityKwp != null ? fmtNum(pvAsset.pvCapacityKwp, 'kWp', 2) : '-'}
                      {pvAsset.moduleCount != null ? ` · ${pvAsset.moduleCount} Module` : ''}
                    </dd>
                  </div>
                  <div className="vp-kv-row">
                    <dt className="vp-kv-k">Ausrichtung / Neigung</dt>
                    <dd className="vp-kv-v">
                      {pvAsset.azimuthDeg != null ? fmtNum(pvAsset.azimuthDeg, '°', 0) : 'Standard (Süd)'}
                      {' / '}
                      {pvAsset.tiltDeg != null ? fmtNum(pvAsset.tiltDeg, '°', 0) : 'Standard (30°)'}
                    </dd>
                  </div>
                  <div className="vp-kv-row">
                    <dt className="vp-kv-k">MaStR-Nummer PV</dt>
                    <dd className="vp-kv-v vp-mono">{pvAsset.registryUnitId}</dd>
                  </div>
                </>
              )}
            </dl>
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<Icon name="refresh-cw" size={16} />}
              onClick={() => setMastrOpen(true)}
            >
              Neu aus dem Register abrufen
            </Button>
          </TechnischeDetails>
        </>
      )}
    </TechCard>
  );

  // --- Section: Anlage löschen --------------------------------------------
  const loeschenCard = (
    <TechCard
      key="loeschen"
      section={sectionOf('loeschen')}
      deepLinked={opened('loeschen')}
      explain="Entfernt die Anlage und alle ihre Daten unwiderruflich."
      summary="Unwiderruflich"
    >
      <DangerZone
        actionLabel="Anlage löschen"
        description="Eine gelöschte Anlage kann nicht wiederhergestellt werden."
        consequences={deleteConsequences()}
        confirmLabel="Anlage endgültig löschen"
        disabledReason={
          siteDevices.length > 0
            ? `Die Anlage kann nicht gelöscht werden, solange ihr Geräte zugeordnet sind (${siteDevices.length} Gerät${siteDevices.length === 1 ? '' : 'e'}). Entfernen Sie zuerst das Gerät oben unter „Mein Gerät".`
            : null
        }
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => void deleteSite()}
      />
    </TechCard>
  );

  return (
    <div className="vp-technik">
      <JumpNav active={activeSection} />
      <div className="vp-technik-sections">
        {/* E6: das Suchfeld über allen Gruppen - „Wo stelle ich meinen
            Strompreis ein?" ist damit in einer Geste beantwortet. */}
        <SettingsSearch onJump={jumpToGroup} />
        {/* E4: die Legende der drei Stufen, damit die Abzeichen an den Zeilen
            lesbar sind. */}
        <ul className="vp-set-legend" aria-label="Wer stellt was ein">
          {AUTHORITY_ORDER.map((level) => (
            <li key={level} title={AUTHORITY[level].note}>
              <i aria-hidden="true">{AUTHORITY[level].mark}</i>
              {AUTHORITY[level].label}
            </li>
          ))}
        </ul>
        {anlageCard}
        {geldCard}
        {geraetCard}
        {speicherCard}
        {registrierungCard}
        {loeschenCard}
        {/* E4 · Stufe ③: was ganz ohne Einstellung mitläuft. Derselbe
            Schutz-Streifen wie auf der Steuerung, aus derselben einen
            Ableitung (`steuerungArea.protectionItems`) - „EEG: nur
            Solarladen" erscheint nur, wenn es wirklich gilt. */}
        <div className="vp-set-schutz">
          <span className="vp-set-schutz-h">
            <i aria-hidden="true">{AUTHORITY[3].mark}</i>
            {PROTECTION_SETTINGS_INTRO}
          </span>
          <ul className="vp-set-schutz-items">
            {protectionItems(site).map((p) => (
              <li key={p.key} title={p.tip}>
                {p.label}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <MastrDrawer
        site={site}
        open={mastrOpen}
        onClose={() => setMastrOpen(false)}
        onApplied={(a) => setAssets(a)}
      />
      <AddDeviceDrawer
        open={addDeviceOpen}
        onClose={() => setAddDeviceOpen(false)}
        sites={sites}
        onClaimed={() => onReload(site.id)}
      />
      <DeviceDetailDrawer
        device={deviceDetail}
        sites={sites}
        onClose={() => setDeviceDetailId(null)}
        onChanged={() => onReload(site.id)}
      />
    </div>
  );
}

/**
 * Inline edit form of the Anlage's Grunddaten + Netzanschluss: name, Gebotszone,
 * Anlagentyp, the location map and the maximale Einspeiseleistung (moved up here
 * in v3.1-M3 - a Netzanschluss fact, not a mode lever). The mode-specific money
 * fields (netzladen/anzulegender Wert/tariff) now live in the mode containers.
 * This still carries the WHOLE site through unchanged via the shared
 * `buildSitePayload` (full-representation), so a focused save here never blanks
 * a field a mode container owns.
 */
export function StammdatenEditForm({
  site,
  onCancel,
  onSaved,
}: {
  site: Site;
  onCancel: () => void;
  onSaved: (updated: Site) => void;
}) {
  const [name, setName] = useState(site.name);
  const [biddingZone, setBiddingZone] = useState(site.biddingZone);
  const [plantKind, setPlantKind] = useState<PlantKind>(site.plantKind ?? 'eigenverbrauch');
  const [lat, setLat] = useState<number | null>(site.latitude ?? null);
  const [lon, setLon] = useState<number | null>(site.longitude ?? null);
  const [maxFeedIn, setMaxFeedIn] = useState(premiumInputText(site.maxFeedInKw ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return;
    const maxFeedInValue = parseFeedInCapInput(maxFeedIn);
    if (maxFeedInValue === undefined) {
      setError('Bitte geben Sie die maximale Einspeiseleistung als Zahl in kW an, z. B. 75.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateSite(
        site.id,
        buildSitePayload(site, {
          name: name.trim(),
          biddingZone,
          latitude: lat,
          longitude: lon,
          plantKind,
          maxFeedInKw: maxFeedInValue,
        }),
      );
      onSaved(updated);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Eingabe. Bitte prüfen Sie Name und Koordinaten.'
          : 'Die Änderungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-tech-editform">
      <div className="vp-form-stack">
        <Input
          label="Name *"
          value={name}
          autoFocus
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="edit-site-zone" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Gebotszone
          </label>
          <select
            id="edit-site-zone"
            className="vp-select"
            value={biddingZone}
            onChange={(e) => setBiddingZone(e.target.value)}
          >
            <option value="DE-LU">DE-LU (Deutschland/Luxemburg)</option>
            <option value="AT">AT (Österreich)</option>
            <option value="CH">CH (Schweiz)</option>
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="edit-site-plant-kind" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            {VERAEUSSERUNGSFORM_LABEL}
          </label>
          <select
            id="edit-site-plant-kind"
            className="vp-select"
            value={plantKind}
            onChange={(e) => setPlantKind(e.target.value as PlantKind)}
          >
            <option value="eigenverbrauch">Eigenverbrauch (Haushalt/Gewerbe)</option>
            <option value="direktvermarktung">Direktvermarktung (Einspeisung am Markt)</option>
          </select>
          <p className="vp-note" style={{ margin: 0 }}>
            {VERAEUSSERUNGSFORM_FRAGE} {VERAEUSSERUNGSFORM_TIP}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label style={{ fontSize: '0.9rem', fontWeight: 600 }}>Standort auf der Karte</label>
          <LocationMap
            lat={lat}
            lon={lon}
            onChange={(la, lo) => {
              setLat(la);
              setLon(lo);
            }}
          />
          <p className="vp-note" style={{ margin: 0 }}>
            Verschieben Sie den Pin auf Ihren Standort - nötig für die Wettervorhersage. Optional.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <Input
            label="Maximale Einspeiseleistung am Netzanschlusspunkt (kW)"
            placeholder="z. B. 75"
            inputMode="decimal"
            value={maxFeedIn}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaxFeedIn(e.target.value)}
          />
          <p className="vp-note" style={{ margin: 0 }}>
            Steht in Ihrer Netzanschluss-Zusage bzw. im Einspeisevertrag. Optional -
            wenn angegeben, plant VoltPilot die Einspeisung nie über diese Grenze
            hinaus. Ihr Bezug aus dem Netz ist davon nicht betroffen.
          </p>
        </div>
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <div className="vp-tech-editactions">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Abbrechen
        </Button>
        <Button variant="primary" size="sm" onClick={save} disabled={busy || !name.trim()}>
          {busy ? 'Wird gespeichert…' : 'Änderungen speichern'}
        </Button>
      </div>
    </div>
  );
}

/**
 * "Mein Speicher" body: the battery master data (the optimizer's inputs) and
 * the controlling-device link, read-first (only Kapazität on top) with the
 * installer values behind "Technische Details". It is also the only place a
 * plant NOT in the Marktstammdatenregister can maintain its battery at all.
 * When the battery has no controlling device it shows the plain-German warning
 * that the plan cannot be executed (ALWAYS visible - a real failure), and
 * offers the fix.
 */
export function BatteryControlSection({
  siteId,
  battery,
  devices,
  onSaved,
  hideWarning = false,
}: {
  siteId: string;
  battery: SiteAsset | null;
  devices: Device[];
  onSaved: (assets: SiteAsset[]) => void;
  /**
   * The Technik page renders the no-device warning at the section's always-
   * visible slot (so a collapsed phone card still shows it), so it suppresses
   * the internal one here. Default false keeps the warning for standalone use.
   */
  hideWarning?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setEditing(false);
  }, [siteId]);

  const controllingDevice = battery?.deviceId
    ? devices.find((d) => d.id === battery.deviceId)
    : null;
  const needsDevice = battery != null && battery.deviceId == null;

  if (editing) {
    return (
      <BatteryEditForm
        siteId={siteId}
        battery={battery}
        devices={devices}
        onCancel={() => setEditing(false)}
        onSaved={(a) => {
          setEditing(false);
          onSaved(a);
        }}
      />
    );
  }

  if (battery == null) {
    return (
      <>
        <p className="vp-muted" style={{ marginTop: 0 }}>
          Kein Speicher hinterlegt. Tragen Sie die Speicherdaten ein, damit der
          Fahrplan Ihren Speicher optimal lädt und entlädt.
        </p>
        <Button
          variant="outline"
          iconLeft={<Icon name="battery" size={16} />}
          onClick={() => setEditing(true)}
        >
          Speicher hinzufügen
        </Button>
      </>
    );
  }

  return (
    <>
      {needsDevice && !hideWarning && (
        <div className="vp-alert vp-alert-warn" style={{ marginTop: 0 }}>
          {BATTERY_NO_DEVICE_WARNING}
        </div>
      )}
      <dl className="vp-kv">
        <div className="vp-kv-row">
          <dt className="vp-kv-k">Kapazität</dt>
          <dd className="vp-kv-v">
            {battery.capacityKwh != null ? fmtNum(battery.capacityKwh, 'kWh', 1) : '-'}
          </dd>
        </div>
      </dl>
      <TechnischeDetails hint="Lade-/Entladeleistung, Wirkungsgrad, steuerndes Gerät">
        <dl className="vp-kv">
          <div className="vp-kv-row">
            <dt className="vp-kv-k">Lade-/Entladeleistung</dt>
            <dd className="vp-kv-v">
              {battery.maxChargeKw != null ? fmtNum(battery.maxChargeKw, 'kW', 2) : '-'}
              {' / '}
              {battery.maxDischargeKw != null ? fmtNum(battery.maxDischargeKw, 'kW', 2) : '-'}
            </dd>
          </div>
          <div className="vp-kv-row">
            <dt className="vp-kv-k">
              Wirkungsgrad
              <InfoTip title="Wirkungsgrad">
                Round-Trip-Wirkungsgrad: der Anteil der eingespeicherten Energie, der beim Laden und
                Entladen erhalten bleibt. Der Rest geht als Verlust verloren. Standard 92 %.
              </InfoTip>
            </dt>
            <dd className="vp-kv-v">
              {battery.roundtripEfficiencyPct != null
                ? fmtNum(battery.roundtripEfficiencyPct, '%', 0)
                : 'Standard (92 %)'}
            </dd>
          </div>
          <div className="vp-kv-row">
            <dt className="vp-kv-k">Steuerndes Gerät</dt>
            <dd className="vp-kv-v">
              {controllingDevice ? (
                controllingDevice.name || controllingDevice.externalRef
              ) : (
                <span className="vp-muted">nicht zugeordnet</span>
              )}
            </dd>
          </div>
          {battery.registryUnitId && (
            <div className="vp-kv-row">
              <dt className="vp-kv-k">MaStR-Nummer Speicher</dt>
              <dd className="vp-kv-v vp-mono">{battery.registryUnitId}</dd>
            </div>
          )}
        </dl>
        <p className="vp-note" style={{ marginTop: 0 }}>
          Ihr Wechselrichter steuert diesen Speicher - er führt den Fahrplan aus.
        </p>
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<Icon name="pencil" size={16} />}
          onClick={() => setEditing(true)}
        >
          Speicher bearbeiten
        </Button>
      </TechnischeDetails>
    </>
  );
}

/**
 * Inline editor for the battery params + controlling device. Numbers accept
 * German comma decimals; the device select offers "Automatisch" (auto-link the
 * site's single device) plus every device at the site so a multi-device plant
 * can pick the inverter that controls the battery.
 */
function BatteryEditForm({
  siteId,
  battery,
  devices,
  onCancel,
  onSaved,
}: {
  siteId: string;
  battery: SiteAsset | null;
  devices: Device[];
  onCancel: () => void;
  onSaved: (assets: SiteAsset[]) => void;
}) {
  const [capacity, setCapacity] = useState(numText(battery?.capacityKwh));
  const [maxCharge, setMaxCharge] = useState(numText(battery?.maxChargeKw));
  const [maxDischarge, setMaxDischarge] = useState(numText(battery?.maxDischargeKw));
  const [efficiency, setEfficiency] = useState(numText(battery?.roundtripEfficiencyPct));
  const [deviceId, setDeviceId] = useState(battery?.deviceId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const cap = parseNum(capacity);
    const chg = parseNum(maxCharge);
    const dis = parseNum(maxDischarge);
    const eff = efficiency.trim() === '' ? null : parseNum(efficiency);
    if (cap == null || cap <= 0 || chg == null || chg <= 0 || dis == null || dis <= 0) {
      setError('Bitte geben Sie Kapazität, Lade- und Entladeleistung als positive Zahlen an.');
      return;
    }
    if (eff !== null && (eff == null || eff <= 0 || eff > 100)) {
      setError('Der Wirkungsgrad muss zwischen 1 und 100 % liegen.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const assets = await api.saveBattery(siteId, {
        capacityKwh: cap,
        maxChargeKw: chg,
        maxDischargeKw: dis,
        roundtripEfficiencyPct: eff,
        deviceId: deviceId || null,
        // "Umgang mit dem Speicher" (Speicherschonung) moved to the mode
        // containers (v3.1-M3): omitting it here keeps the stored value, so a
        // battery-param edit never overwrites the customer's preset.
      });
      onSaved(assets);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Eingabe. Bitte prüfen Sie die Werte.'
          : 'Die Speicherdaten konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-tech-editform">
      <div className="vp-form-stack">
        <Input
          label="Kapazität (kWh) *"
          placeholder="z. B. 10"
          inputMode="decimal"
          value={capacity}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCapacity(e.target.value)}
        />
        <Input
          label="Max. Ladeleistung (kW) *"
          placeholder="z. B. 5"
          inputMode="decimal"
          value={maxCharge}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaxCharge(e.target.value)}
        />
        <Input
          label="Max. Entladeleistung (kW) *"
          placeholder="z. B. 5"
          inputMode="decimal"
          value={maxDischarge}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaxDischarge(e.target.value)}
        />
        <Input
          label="Wirkungsgrad (%)"
          placeholder="Standard 92"
          inputMode="decimal"
          value={efficiency}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEfficiency(e.target.value)}
          hint="Round-Trip-Wirkungsgrad. Leer lassen für den Standardwert (92 %)."
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="battery-device" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Steuerndes Gerät
          </label>
          <select
            id="battery-device"
            className="vp-select"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
          >
            <option value="">Automatisch (einziges Gerät der Anlage)</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name || d.externalRef}
              </option>
            ))}
          </select>
          <p className="vp-note" style={{ margin: 0 }}>
            Der Wechselrichter, der den Speicher steuert und den Fahrplan ausführt.
            Bei nur einem Gerät genügt „Automatisch“.
          </p>
        </div>
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <div className="vp-tech-editactions">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Abbrechen
        </Button>
        <Button variant="primary" size="sm" onClick={save} disabled={busy}>
          {busy ? 'Wird gespeichert…' : 'Speicher speichern'}
        </Button>
      </div>
    </div>
  );
}

/** German decimal text for a form field (empty for null). */
function numText(value: number | null | undefined): string {
  return value == null ? '' : String(value).replace('.', ',');
}

/** Parse a German-or-plain decimal; null when not a finite number. */
function parseNum(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (normalized === '') return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
