import { Recht } from '../components/Recht';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import type { IconName } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { VpPicker } from '../components/VpPicker';
import {
  api,
  ApiError,
  type Device,
  type PlantKind,
  type Site,
  type SiteAsset,
  type SiteDeletionPreview,
} from '../api';
import { BATTERY_NO_DEVICE_WARNING, parseFeedInCapInput, premiumInputText, tarifArtLabel } from '../fleet';
import { buildSitePayload } from '../anlage';
import { fmtCoords, fmtNum, fmtRelative, plantKindLabel, zoneLabel } from '../format';
import { settingsPageSettings, type ModeSettingDef } from '../modeSettings';
import { parseSettingsAnchor, SETTING_HINT, settingsGroupFor, type TechnikAbschnitt } from '../settingsNav';
import {
  effectChips,
  honestyNote,
  honestyOf,
  PROTECTION_SETTINGS_INTRO,
  VOLTPILOT_ROW_NOTE,
  voltpilotRows,
} from '../settingsSurface';
import { VERAEUSSERUNGSFORM_FRAGE, VERAEUSSERUNGSFORM_LABEL, VERAEUSSERUNGSFORM_TIP } from '../glossar';
import { protectionItems } from '../steuerungArea';
import { PROVENIENZ } from '../provenienz';
import {
  presetOf,
  SPEICHERSCHONUNG_OPTIONS,
  speicherschonungLabel,
  type SpeicherschonungPreset,
} from '../speicherschonung';
import { anlageRoute, hashForRoute } from '../nav';
import { LocationMap } from '../components/LocationMap';
import { AnlageStandortZeile, useAnlageStandort } from '../components/AnlageStandortZeile';
import { koordinatenLabel } from '../anlageStandort';
import { BezugspreisPreview } from '../components/BezugspreisPreview';
import { DangerZone } from '../components/DangerZone';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InfoTip } from '../components/InfoTip';
import { PRESETS, PROFIL_UNGESETZT, profilAenderungsFolgen, profilLabel, type Profil } from '../anwendungen';
import { MastrDrawer } from '../components/MastrDrawer';
import { canEditSetting, SettingEditForm, settingReadValue } from '../components/SettingEditors';
import { ErrorState, TextSkeleton } from '../components/States';
import { GemeinsameSteuerungKarte, useGemeinsameSteuerung, type GemeinsameSteuerungDaten } from '../components/GemeinsameSteuerungKarte';
import type { VerlustVariante } from '../gemeinsameSteuerungFlaeche';
import { showTechnicalLayer, useRollen } from '../rollen';
import { FLAECHE } from '../uemsGemeinsameSteuerung';
import '../components/Profile.css';
import './Einstellungen.css';

/**
 * **„Einstellungen"** (Konzept „Anlage – neu gedacht", Entscheid E5 = A vom
 * 25.09.2026): eine kurze, sortierte Liste statt sieben erklärter Blöcke.
 *
 * - **Jede Zeile zeigt ihren aktuellen Wert.** Tippen öffnet ein kleines Blatt
 *   (das zentrierte `Modal`, am Telefon ein Vollbild-Blatt) mit dem
 *   Bearbeiten-Formular - und dort, nicht an der Zeile, stehen Erklärung und
 *   „Wirkt auf …".
 * - **Einfache Schalter wirken direkt**: Netzladen und der Umgang mit dem
 *   Speicher speichern beim Umlegen, sagen danach die Folge und bieten
 *   „Rückgängig". Was vorher gilt, steht schon vor dem Umlegen an der Zeile.
 * - **Schloss = von VoltPilot eingerichtet** (Stufe ②). Die Legende ①②③, die
 *   Suche und die Abschnitts-Navigation sind entfallen - bei gut einem Dutzend
 *   Zeilen steht alles auf einen Blick da.
 * - **Umgezogen:** die Box in den Aufbau (dort steht sie ohnehin), „Als App auf
 *   dem Handy" ins Konto-Menü (sie gilt dem Gerät, nicht der Anlage).
 *
 * Die Formulare und Speicherwege sind UNVERÄNDERT: `SettingEditForm` (Tarif,
 * anzulegender Wert, Umgang), `StammdatenEditForm`, `BatteryEditForm`, das
 * Profil über die schmale Route, die Löschung mit ihrer Folgenliste. Jeder
 * Site-Save bleibt eine Voll-Repräsentation (`buildSitePayload`).
 *
 * Die Direktlinks `…/technik?abschnitt=…` (`settingsNav.ts`) landen weiter auf
 * ihrer Gruppe; `geraet` führt in den Aufbau.
 *
 * **UEMS auf derselben Seite:** jede Zeile, die etwas ändert, trägt ihr Recht
 * (AP-03 IP-12, `recht=` - ohne Recht bleibt der Wert lesbar, der Hebel wird
 * zum Satz); „Anlage" nennt das Standort-Objekt über den Koordinaten
 * (AP-02 IP-8); die Karte „Gemeinsame Steuerung" (AP-15 IP-23/24) steht als
 * eigener Abschnitt `technik-gemeinsam` unter den Gruppen - nur an einer
 * steuernden Anlage mit mehr als einer Box.
 */

/** Die Folge nach dem Umlegen - sie steht, bis der nächste Schritt kommt. */
const NETZLADEN_FOLGE = {
  an: 'Ab dem nächsten Fahrplan darf der Speicher aus dem Netz laden.',
  aus: 'Ab dem nächsten Fahrplan lädt der Speicher nur aus Sonnenstrom.',
};

const SCHALT_FEHLER = 'Die Änderung wurde nicht gespeichert. Bitte versuchen Sie es erneut.';

type BlattArt =
  | { art: 'stammdaten' }
  | { art: 'einstellung'; setting: ModeSettingDef }
  | { art: 'voltpilot'; setting: ModeSettingDef }
  | { art: 'speicher'; bearbeiten: boolean }
  | { art: 'registrierung' }
  | { art: 'loeschen' };

interface Folge {
  key: 'netzladen' | 'speicherschonung';
  text: string;
  zurueck: (() => void) | null;
}

/** Die per Direktlink angesprungene Gruppe - beim Aufbau UND bei jedem Hash-Wechsel. */
function useSettingsAnchor(): TechnikAbschnitt | null {
  const [group, setGroup] = useState<TechnikAbschnitt | null>(() =>
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

/**
 * Welches Recht ein Einstellungs-Formular braucht - dieselbe Regel wie `SettingRow`
 * (`SettingEditors.tsx`): der Umgang mit dem Speicher ist Geräte-Einrichtung,
 * alles andere Anlagen-Verwaltung.
 */
function einstellungsRecht(id: ModeSettingDef['id']): 'geraet.einrichten' | 'anlage.verwalten' {
  return id === 'speicherschonung' ? 'geraet.einrichten' : 'anlage.verwalten';
}

/**
 * AP-15 IP-24: das Betreiber-Blatt lädt nur für die Plattform-Rolle (eigener Chunk) — Kundenkonten laden es nie.
 */
const GemeinsameSteuerungBetreiberBlatt = lazy(() =>
  import('./admin/GemeinsameSteuerungBetreiberBlatt').then((m) => ({ default: m.GemeinsameSteuerungBetreiberBlatt })),
);

/**
 * Die Karte „Gemeinsame Steuerung“ (UEMS AP-15 IP-23, §5.2) als eigener Abschnitt der Einstellungen — erscheint
 * nur, wenn die Anlage steuert UND mehr als eine Box hat; wer nur misst, sieht sie nie. Seit „Anlage – neu
 * gedacht“ (E5) eine Gruppe wie die übrigen, unter ihnen; `?abschnitt=gemeinsam` springt sie an. Exportiert
 * für die E2E-Bühne.
 */
export function GemeinsameSteuerungAbschnitt({
  siteId,
  siteDevices,
  daten,
  jetzt,
  verlustVariante,
}: {
  siteId: string;
  siteDevices: readonly Device[];
  daten: GemeinsameSteuerungDaten;
  /** Früher klappte die Telefon-Karte beim Direktlink auf; die Gruppe steht jetzt immer offen. */
  deepLinked?: boolean;
  jetzt?: Date;
  verlustVariante?: VerlustVariante;
}) {
  if (!daten.sichtbar) return null;
  return (
    <section id="technik-gemeinsam" className="vp-einst-grp vp-einst-gemeinsam" aria-labelledby="technik-gemeinsam-h">
      <h3 id="technik-gemeinsam-h">Gemeinsame Steuerung</h3>
      <p className="vp-note">{FLAECHE.karte_erklaerung}</p>
      <GemeinsameSteuerungKarte siteId={siteId} siteDevices={siteDevices} daten={daten} jetzt={jetzt} verlustVariante={verlustVariante} />
      {/* IP-24: unter der Kundenkarte das Betreiber-Blatt — nur hinter dem EINEN Rollen-Tor, nur mit Einrichtung. */}
      {showTechnicalLayer() && daten.zustand?.eingerichtet && (
        <Suspense fallback={null}>
          <GemeinsameSteuerungBetreiberBlatt siteId={siteId} siteDevices={siteDevices} daten={daten} jetzt={jetzt} />
        </Suspense>
      )}
    </section>
  );
}

export function TechnikSection({
  site,
  devices,
  onReload,
  onSiteSaved,
  onSiteDeleted,
}: {
  site: Site;
  /** All devices of the tenant; the section filters to this site's. */
  devices: Device[];
  /** All Anlagen of the tenant (Teil des Seitenvertrags; die Box wohnt im Aufbau). */
  sites: Site[];
  onReload: (selectSiteId?: string) => void;
  onSiteSaved: (updated: Site) => void;
  onSiteDeleted: () => void;
}) {
  const [assets, setAssets] = useState<SiteAsset[] | null>(null);
  const [assetsError, setAssetsError] = useState(false);
  const [assetsReloadKey, setAssetsReloadKey] = useState(0);
  const [preview, setPreview] = useState<SiteDeletionPreview | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [blatt, setBlatt] = useState<BlattArt | null>(null);
  const [profilOffen, setProfilOffen] = useState(false);
  const [mastrOpen, setMastrOpen] = useState(false);
  const [folge, setFolge] = useState<Folge | null>(null);
  const [schaltBusy, setSchaltBusy] = useState<Folge['key'] | null>(null);
  const [schaltFehler, setSchaltFehler] = useState<{ key: Folge['key']; text: string } | null>(null);

  // Ein Rückgängig baut auf dem NEUESTEN Stand auf, nie auf dem des Klicks -
  // sonst setzte es eine inzwischen gespeicherte andere Änderung mit zurück.
  const siteRef = useRef(site);
  siteRef.current = site;

  const siteDevices = useMemo(() => devices.filter((d) => d.siteId === site.id), [devices, site.id]);
  const anchored = useSettingsAnchor();
  // UEMS AP-02 IP-8 (T6a, W4): das Objekt „Standort“ der Anlage. Ohne eines bleibt
  // die Gruppe „Anlage“ Zeichen für Zeichen, wie sie ist (AnlageTechnik.standort.test.tsx).
  const { anlageStandort, antwort: standortAntwort, neuLaden: standortNeuLaden } = useAnlageStandort(site.id);
  // UEMS AP-15 IP-23: die Karte „Gemeinsame Steuerung“ - sichtbar nur an steuernden Anlagen mit mehreren Boxen.
  const gemeinsam = useGemeinsameSteuerung(site.id, siteDevices);

  useEffect(() => {
    setBlatt(null);
    setFolge(null);
    setPreview(null);
    setDeleteError(null);
    let cancelled = false;
    setAssets(null);
    setAssetsError(false);
    api
      .siteAssets(site.id)
      .then((a) => !cancelled && setAssets(a))
      // „Nicht geladen" ist nicht „keine": ein Fehler zeigt sich als Fehler.
      .catch(() => !cancelled && setAssetsError(true));
    api
      .siteDeletionPreview(site.id)
      .then((p) => !cancelled && setPreview(p))
      .catch(() => {
        // Die Löschung bleibt möglich; die Folgenliste nennt dann weniger Zahlen.
      });
    return () => {
      cancelled = true;
    };
  }, [site.id, assetsReloadKey]);

  // Direktlinks: die Gruppe in den Blick holen. Die Box wohnt im Aufbau.
  useEffect(() => {
    if (!anchored) return;
    if (anchored === 'geraet') {
      window.location.replace(hashForRoute(anlageRoute(site.id, 'modell')));
      return;
    }
    document.getElementById(`technik-${anchored}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [anchored, site.id]);

  const battery = (assets ?? []).find((a) => a.type === 'battery') ?? null;
  const batteryRef = useRef(battery);
  batteryRef.current = battery;
  const linkedAssets = (assets ?? []).filter((a) => a.registry != null);
  const lastFetched = linkedAssets
    .map((a) => a.registryFetchedAt)
    .filter((t): t is string => t != null)
    .sort()
    .pop();

  const pageSettings = settingsPageSettings({ plantKind: site.plantKind });
  const geld = pageSettings.filter((s) => settingsGroupFor(s.id) === 'geld');
  const tarif = geld.find((s) => s.id === 'stromtarif') ?? null;
  const anzulegend = geld.find((s) => s.id === 'anzulegender-wert') ?? null;
  const netzladen = geld.find((s) => s.id === 'netzladen') ?? null;
  const schonung = pageSettings.find((s) => s.id === 'speicherschonung') ?? null;

  function oeffne(b: BlattArt) {
    // Ein offenes „Rückgängig" gilt nur, solange nichts anderes geändert wurde.
    setFolge(null);
    setBlatt(b);
  }
  const schliesse = () => setBlatt(null);

  // Das Modal blendet aus: sein Inhalt bleibt während der Ausblendung stehen.
  const letztesBlatt = useRef<BlattArt | null>(null);
  if (blatt) letztesBlatt.current = blatt;
  const blattInhalt = blatt ?? letztesBlatt.current;

  async function netzladenSetzen(erlaubt: boolean, mitRueckweg: boolean) {
    setSchaltBusy('netzladen');
    setSchaltFehler(null);
    try {
      const updated = await api.updateSite(site.id, buildSitePayload(siteRef.current, { netzladenErlaubt: erlaubt }));
      onSiteSaved(updated);
      setFolge({
        key: 'netzladen',
        text: erlaubt ? NETZLADEN_FOLGE.an : NETZLADEN_FOLGE.aus,
        zurueck: mitRueckweg ? () => void netzladenSetzen(!erlaubt, false) : null,
      });
    } catch {
      setSchaltFehler({ key: 'netzladen', text: SCHALT_FEHLER });
    } finally {
      setSchaltBusy(null);
    }
  }

  async function schonungSetzen(wahl: SpeicherschonungPreset, mitRueckweg: boolean) {
    const b = batteryRef.current;
    if (!b || b.capacityKwh == null || b.maxChargeKw == null || b.maxDischargeKw == null) return;
    const vorher = presetOf(b.speicherschonung);
    setSchaltBusy('speicherschonung');
    setSchaltFehler(null);
    try {
      // Dieselbe Voll-Repräsentation wie der Umgang-Editor: alle Parameter
      // reisen unverändert mit, nur die Wahl ist neu.
      const neu = await api.saveBattery(site.id, {
        capacityKwh: b.capacityKwh,
        maxChargeKw: b.maxChargeKw,
        maxDischargeKw: b.maxDischargeKw,
        roundtripEfficiencyPct: b.roundtripEfficiencyPct,
        deviceId: b.deviceId,
        speicherschonung: wahl,
      });
      setAssets(neu);
      setFolge({
        key: 'speicherschonung',
        text: SPEICHERSCHONUNG_OPTIONS.find((o) => o.value === wahl)?.sentence ?? '',
        zurueck: mitRueckweg && vorher ? () => void schonungSetzen(vorher, false) : null,
      });
    } catch {
      setSchaltFehler({ key: 'speicherschonung', text: SCHALT_FEHLER });
    } finally {
      setSchaltBusy(null);
    }
  }

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

  const folgeZeile = (key: Folge['key']) =>
    folge?.key === key || schaltFehler?.key === key ? (
      <div
        className={`vp-einst-folge${schaltFehler?.key === key ? ' is-fehler' : ''}`}
        role={schaltFehler?.key === key ? 'alert' : 'status'}
      >
        <Icon name={schaltFehler?.key === key ? 'alert-triangle' : 'info'} size={15} />
        <span>{schaltFehler?.key === key ? schaltFehler.text : folge?.text}</span>
        {folge?.key === key && folge.zurueck && schaltFehler?.key !== key && (
          <button type="button" className="vp-linklike" onClick={folge.zurueck} disabled={schaltBusy != null}>
            Rückgängig
          </button>
        )}
      </div>
    ) : null;

  const batteryNeedsDevice = battery != null && battery.deviceId == null;
  const coords = fmtCoords(site.latitude, site.longitude);
  const vpGeld = voltpilotRows('geld', site);
  const vpSpeicher = voltpilotRows('speicher', site);

  return (
    <div className="vp-einst">
      <div className="vp-einst-raster">
        {/* ---------- Anlage ---------- */}
        <Gruppe id="anlage" titel="Anlage">
          <Zeile icon="home" kat="home" label="Name" wert={site.name} recht="anlage.verwalten" onClick={() => oeffne({ art: 'stammdaten' })} />
          <Zeile
            icon="euro"
            kat="dynamic"
            label={VERAEUSSERUNGSFORM_LABEL}
            wert={plantKindLabel(site.plantKind)}
            recht="anlage.verwalten"
            onClick={() => oeffne({ art: 'stammdaten' })}
          />
          <Zeile icon="users" kat="home" label="Profil" wert={profilLabel(site.profil)} recht="betriebsweise.aendern" onClick={() => setProfilOffen(true)} />
          <Zeile
            icon="trending-up"
            kat="grid"
            label="Einspeisegrenze"
            wert={site.maxFeedInKw != null ? fmtNum(site.maxFeedInKw, 'kW', 1) : 'keine Grenze hinterlegt'}
            recht="anlage.verwalten"
            onClick={() => oeffne({ art: 'stammdaten' })}
          />
          {/* UEMS AP-02 IP-8: das Standort-OBJEKT über den Koordinaten - nur, wenn die Anlage eines hat. */}
          {anlageStandort && standortAntwort && (
            <li className="vp-einst-standort">
              <dl className="vp-kv">
                <AnlageStandortZeile
                  anlageStandort={anlageStandort}
                  antwort={standortAntwort}
                  onGeaendert={standortNeuLaden}
                />
              </dl>
            </li>
          )}
          <Zeile
            icon="map-pin"
            kat="navy"
            label={koordinatenLabel(anlageStandort)}
            wert={coords ? `${coords} · ${zoneLabel(site.biddingZone)}` : 'noch nicht hinterlegt'}
            sub={coords ? null : 'Ohne Standort auf der Karte gibt es keine Wettervorhersage.'}
            warn={!coords}
            recht="anlage.verwalten"
            onClick={() => oeffne({ art: 'stammdaten' })}
          />
        </Gruppe>

        {/* ---------- Strom & Geld ---------- */}
        <Gruppe id="geld" titel="Strom & Geld">
          {tarif && (
            <Zeile
              icon="zap"
              kat="dynamic"
              label={tarif.label}
              wert={tarifArtLabel(site.tarifArt, site.tarifParamCtKwh)}
              recht="anlage.verwalten"
              onClick={() => oeffne({ art: 'einstellung', setting: tarif })}
            />
          )}
          {anzulegend && (
            <Zeile
              icon="euro"
              kat="dynamic"
              label={anzulegend.label}
              wert={settingReadValue(anzulegend.id, site, battery)}
              recht="anlage.verwalten"
              onClick={() => oeffne({ art: 'einstellung', setting: anzulegend })}
            />
          )}
          {netzladen && (
            <li id="technik-netzladen">
              <div className="vp-einst-zeile is-statisch">
                <Kachel icon="battery-charging" kat="battery" />
                <span className="vp-einst-lab">
                  <b id="einst-netzladen-l">Netzladen</b>
                  <small>Speicher darf aus dem Netz laden – nur ohne EEG-Vergütung</small>
                </span>
                <span className="vp-einst-ende">
                  {canEditSetting(netzladen, battery) ? (
                    <Recht aktion="anlage.verwalten"><button
                      type="button"
                      role="switch"
                      aria-checked={site.netzladenErlaubt}
                      aria-labelledby="einst-netzladen-l"
                      className={`vp-switch${site.netzladenErlaubt ? ' on' : ''}`}
                      disabled={schaltBusy != null}
                      onClick={() => void netzladenSetzen(!site.netzladenErlaubt, true)}
                    >
                      <span className="vp-switch-knob" aria-hidden="true" />
                    </button></Recht>
                  ) : (
                    <span className="vp-einst-wert">{site.netzladenErlaubt ? 'erlaubt' : 'nur Solarladen'}</span>
                  )}
                </span>
              </div>
              {folgeZeile('netzladen')}
            </li>
          )}
          {vpGeld.map((s) => (
            <Zeile
              key={s.id}
              icon={s.id === 'abrechnung-leistung' ? 'calendar' : 'euro'}
              kat="grid"
              label={s.label}
              wert={settingReadValue(s.id, site, battery)}
              schloss
              onClick={() => oeffne({ art: 'voltpilot', setting: s })}
            />
          ))}
        </Gruppe>

        {/* ---------- Speicher ---------- */}
        <Gruppe
          id="speicher"
          titel="Speicher"
          vorne={
            batteryNeedsDevice ? (
              <div className="vp-alert vp-alert-warn vp-einst-warnung">
                <span>{BATTERY_NO_DEVICE_WARNING}</span>
                <Recht aktion="geraet.einrichten"><button type="button" className="vp-linklike" onClick={() => oeffne({ art: 'speicher', bearbeiten: true })}>
                  Gerät zuordnen
                </button></Recht>
              </div>
            ) : null
          }
        >
          {assetsError ? (
            <li className="vp-einst-platz">
              <ErrorState
                message="Die Speicherdaten konnten nicht geladen werden."
                onRetry={() => setAssetsReloadKey((k) => k + 1)}
              />
            </li>
          ) : assets === null ? (
            <li className="vp-einst-platz">
              <TextSkeleton lines={2} />
            </li>
          ) : battery == null ? (
            <Zeile
              icon="battery"
              kat="battery"
              label="Speicher hinzufügen"
              sub="Damit der Fahrplan ihn optimal lädt und entlädt."
              recht="geraet.einrichten"
              onClick={() => oeffne({ art: 'speicher', bearbeiten: true })}
            />
          ) : (
            <>
              <Zeile
                icon="battery"
                kat="battery"
                label="Kapazität"
                wert={battery.capacityKwh != null ? fmtNum(battery.capacityKwh, 'kWh', 1) : 'nicht hinterlegt'}
                sub="Leistung, Wirkungsgrad, steuerndes Gerät"
                onClick={() => oeffne({ art: 'speicher', bearbeiten: false })}
              />
              {schonung && (
                <UmgangZeile
                  setting={schonung}
                  battery={battery}
                  busy={schaltBusy != null}
                  onWahl={(w) => void schonungSetzen(w, true)}
                  onBlatt={() => oeffne({ art: 'einstellung', setting: schonung })}
                  folge={folgeZeile('speicherschonung')}
                />
              )}
            </>
          )}
          {vpSpeicher.map((s) => (
            <Zeile
              key={s.id}
              icon="shield"
              kat="battery"
              label={s.label}
              wert={settingReadValue(s.id, site, battery)}
              schloss
              onClick={() => oeffne({ art: 'voltpilot', setting: s })}
            />
          ))}
        </Gruppe>

        {/* ---------- Weiteres ---------- */}
        <Gruppe id="weiteres" titel="Weiteres">
          <Zeile
            id="technik-registrierung"
            icon="file-text"
            kat="navy"
            label="Registrierung (MaStR)"
            wert={
              assets === null && !assetsError
                ? 'wird geladen …'
                : linkedAssets.length > 0
                  ? `Verknüpft${lastFetched ? ` · abgerufen ${fmtRelative(lastFetched)}` : ''}`
                  : 'Nicht verknüpft'
            }
            recht={linkedAssets.length > 0 || assetsError ? undefined : 'anlage.verwalten'}
            onClick={() => (linkedAssets.length > 0 || assetsError ? oeffne({ art: 'registrierung' }) : setMastrOpen(true))}
          />
          <Zeile
            id="technik-loeschen"
            icon="trash"
            kat="gefahr"
            label="Anlage löschen"
            gefahr
            onClick={() => oeffne({ art: 'loeschen' })}
          />
        </Gruppe>
      </div>

      <GemeinsameSteuerungAbschnitt siteId={site.id} siteDevices={siteDevices} daten={gemeinsam} deepLinked={anchored === 'gemeinsam'} />

      {/* Stufe ③: was ohne Einstellung mitläuft - aus derselben Ableitung wie
          auf der Steuerung; „EEG: nur Solarladen" nur, wenn es gilt. */}
      <div className="vp-set-schutz">
        <span className="vp-set-schutz-h">
          <Icon name="shield" size={14} />
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
      <p className="vp-einst-grenze">
        Geräte und VoltPilot-Boxen richten Sie im{' '}
        <a href={hashForRoute(anlageRoute(site.id, 'modell'))}>Aufbau</a> ein.
      </p>

      {/* ---------- das eine Blatt ---------- */}
      <Modal open={blatt != null} onClose={schliesse} title={blattTitel(blattInhalt, battery)}>
        {blattInhalt?.art === 'stammdaten' && (
          <StammdatenEditForm
            site={site}
            onCancel={schliesse}
            onSaved={(updated) => {
              schliesse();
              onSiteSaved(updated);
              onReload(updated.id);
            }}
          />
        )}
        {blattInhalt?.art === 'einstellung' && (
          <div className="vp-einst-blatt">
            {SETTING_HINT[blattInhalt.setting.id] && <p className="vp-note">{SETTING_HINT[blattInhalt.setting.id]}</p>}
            <Wirkung id={blattInhalt.setting.id} />
            {blattInhalt.setting.id === 'stromtarif' && <BezugspreisPreview siteId={site.id} tarifArt={site.tarifArt} />}
            <Recht aktion={einstellungsRecht(blattInhalt.setting.id)}><SettingEditForm
              setting={blattInhalt.setting}
              site={site}
              battery={battery}
              onCancel={schliesse}
              onSiteSaved={(updated) => {
                schliesse();
                onSiteSaved(updated);
              }}
              onBatterySaved={(a) => {
                schliesse();
                setAssets(a);
              }}
            /></Recht>
          </div>
        )}
        {blattInhalt?.art === 'voltpilot' && (
          <div className="vp-einst-blatt">
            <p className="vp-einst-gross">{settingReadValue(blattInhalt.setting.id, site, battery)}</p>
            <p className="vp-note">{VOLTPILOT_ROW_NOTE}</p>
            <Wirkung id={blattInhalt.setting.id} />
          </div>
        )}
        {blattInhalt?.art === 'speicher' && (
          <div className="vp-einst-blatt">
            <BatteryControlSection
              key={blattInhalt.bearbeiten ? 'bearbeiten' : 'lesen'}
              siteId={site.id}
              battery={battery}
              devices={siteDevices}
              startEditing={blattInhalt.bearbeiten}
              onSaved={(a) => setAssets(a)}
            />
          </div>
        )}
        {blattInhalt?.art === 'registrierung' &&
          (assetsError ? (
            <ErrorState
              message="Die Anlagendaten konnten nicht geladen werden."
              onRetry={() => setAssetsReloadKey((k) => k + 1)}
            />
          ) : (
            <RegistrierungInhalt
              assets={linkedAssets}
              lastFetched={lastFetched ?? null}
              onAbrufen={() => {
                schliesse();
                setMastrOpen(true);
              }}
            />
          ))}
        {blattInhalt?.art === 'loeschen' && (
          <DangerZone
            recht="anlage.verwalten"
            variant="inline"
            actionLabel="Anlage löschen"
            description="Eine gelöschte Anlage kann nicht wiederhergestellt werden."
            consequences={deleteConsequences()}
            confirmLabel="Anlage endgültig löschen"
            disabledReason={
              siteDevices.length > 0
                ? `Die Anlage kann nicht gelöscht werden, solange ihr ${siteDevices.length === 1 ? 'eine VoltPilot-Box zugeordnet ist' : `${siteDevices.length} VoltPilot-Boxen zugeordnet sind`}. Entfernen Sie die Box zuerst im Aufbau.`
                : null
            }
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void deleteSite()}
          />
        )}
      </Modal>

      <ProfilDialog site={site} open={profilOffen} onClose={() => setProfilOffen(false)} onSaved={onSiteSaved} />
      <MastrDrawer site={site} open={mastrOpen} onClose={() => setMastrOpen(false)} onApplied={(a) => setAssets(a)} />
    </div>
  );
}

function blattTitel(b: BlattArt | null, battery: SiteAsset | null): string {
  switch (b?.art) {
    case 'stammdaten':
      return 'Anlage bearbeiten';
    case 'einstellung':
    case 'voltpilot':
      return b.setting.label;
    case 'speicher':
      return battery ? 'Speicher' : 'Speicher hinzufügen';
    case 'registrierung':
      return 'Registrierung (MaStR)';
    case 'loeschen':
      return 'Anlage löschen';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

type Kategorie = 'home' | 'dynamic' | 'grid' | 'navy' | 'battery' | 'gefahr';

function Kachel({ icon, kat }: { icon: IconName; kat: Kategorie }) {
  return (
    <span className={`vp-einst-tile is-${kat}`} aria-hidden="true">
      <Icon name={icon} size={16} />
    </span>
  );
}

/** Eine Gruppe: Überschrift und eine ruhige, weiße Liste. */
function Gruppe({
  id,
  titel,
  vorne,
  children,
}: {
  id: TechnikAbschnitt | 'weiteres';
  titel: string;
  vorne?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={`technik-${id}`} className="vp-einst-grp" aria-labelledby={`technik-${id}-h`}>
      <h3 id={`technik-${id}-h`}>{titel}</h3>
      {vorne}
      <ul className="vp-einst-liste">{children}</ul>
    </section>
  );
}

/**
 * Eine Zeile: Kachel · Name mit aktuellem Wert · Pfeil. Das Schloss ersetzt den
 * Pfeil, wo VoltPilot den Wert eingerichtet hat - getippt erklärt ein Blatt,
 * wie er sich ändern lässt.
 */
function Zeile({
  id,
  icon,
  kat,
  label,
  wert = null,
  sub = null,
  warn = false,
  schloss = false,
  gefahr = false,
  recht,
  onClick,
}: {
  id?: string;
  icon: IconName;
  kat: Kategorie;
  label: string;
  wert?: ReactNode;
  sub?: ReactNode;
  warn?: boolean;
  schloss?: boolean;
  gefahr?: boolean;
  /**
   * Das Recht, das die Änderung hinter dieser Zeile braucht (UEMS AP-03 IP-12). Ohne
   * es bleibt der Wert lesbar, die Zeile öffnet nichts, und der Grund steht darunter.
   */
  recht?: string;
  onClick: () => void;
}) {
  const rollen = useRollen();
  if (recht && !rollen.darf(recht)) {
    return (
      <li id={id}>
        <div className={`vp-einst-zeile is-statisch${gefahr ? ' is-gefahr' : ''}`}>
          <Kachel icon={icon} kat={kat} />
          <span className="vp-einst-lab">
            <b>{label}</b>
            {wert != null && <span className="vp-einst-wert">{wert}</span>}
            <small>
              <Recht aktion={recht}>{null}</Recht>
            </small>
          </span>
          <span />
        </div>
      </li>
    );
  }
  return (
    <li id={id}>
      <button
        type="button"
        className={`vp-einst-zeile${gefahr ? ' is-gefahr' : ''}`}
        onClick={onClick}
        aria-haspopup="dialog"
      >
        <Kachel icon={icon} kat={kat} />
        <span className="vp-einst-lab">
          <b>{label}</b>
          {wert != null && <span className="vp-einst-wert">{wert}</span>}
          {sub && <small className={warn ? 'is-warn' : undefined}>{sub}</small>}
        </span>
        <span className="vp-einst-ende">
          {schloss ? (
            <span className="vp-einst-schloss" title="Von VoltPilot eingerichtet">
              <Icon name="lock" size={15} />
              <span className="vp-visually-hidden">Von VoltPilot eingerichtet</span>
            </span>
          ) : (
            <Icon name="chevron-right" size={18} />
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * „Umgang mit dem Speicher": drei Stufen als Umschalter, die direkt wirken.
 * Eine von VoltPilot eingerichtete „individuelle" Einstellung öffnet
 * stattdessen das Blatt - dort steht, dass eine Wahl sie ersetzt (ein
 * Rückgängig könnte sie nicht wiederherstellen).
 */
function UmgangZeile({
  setting,
  battery,
  busy,
  onWahl,
  onBlatt,
  folge,
}: {
  setting: ModeSettingDef;
  battery: SiteAsset;
  busy: boolean;
  onWahl: (w: SpeicherschonungPreset) => void;
  onBlatt: () => void;
  folge: ReactNode;
}) {
  const editierbar = canEditSetting(setting, battery);
  const wahl = presetOf(battery.speicherschonung);
  if (editierbar && wahl == null) {
    return (
      <Zeile
        icon="shield"
        kat="battery"
        label={setting.label}
        wert={speicherschonungLabel(battery.speicherschonung)}
        recht="geraet.einrichten"
        onClick={onBlatt}
      />
    );
  }
  const aktuell = SPEICHERSCHONUNG_OPTIONS.find((o) => o.value === wahl);
  return (
    <li id="technik-umgang">
      <div className="vp-einst-zeile is-statisch">
        <Kachel icon="shield" kat="battery" />
        <span className="vp-einst-lab">
          <b id="einst-umgang-l">{setting.label}</b>
          <small>
            {editierbar
              ? aktuell?.recommended
                ? 'Empfohlen'
                : 'Wirkt ab dem nächsten Fahrplan'
              : 'Erst Kapazität und Leistungen eintragen'}
          </small>
        </span>
        <span />
      </div>
      <Recht aktion="geraet.einrichten"><div className="vp-einst-seg" role="radiogroup" aria-labelledby="einst-umgang-l">
        {SPEICHERSCHONUNG_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={wahl === o.value}
            title={o.sentence}
            disabled={!editierbar || busy}
            onClick={() => wahl !== o.value && onWahl(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div></Recht>
      {folge}
    </li>
  );
}

/** „Wirkt auf …" und die Art der Zahl - seit E5 im Blatt, nicht an der Zeile. */
function Wirkung({ id }: { id: ModeSettingDef['id'] }) {
  const chips = effectChips(id);
  const honesty = honestyOf(id);
  if (chips.length === 0 && !honesty) return null;
  return (
    <ul className="vp-setting-chips">
      {chips.map((c) => (
        <li key={c} className="vp-setting-chip">
          {c}
        </li>
      ))}
      {honesty && (
        <li className={`vp-setting-chip vp-setting-prov vp-setting-prov-${honesty}`} title={honestyNote(honesty)}>
          {PROVENIENZ[honesty].label}
        </li>
      )}
    </ul>
  );
}

/** Die registrierten Werte aus dem Marktstammdatenregister - mit dem Weg zum Neuabruf. */
function RegistrierungInhalt({
  assets,
  lastFetched,
  onAbrufen,
}: {
  assets: SiteAsset[];
  lastFetched: string | null;
  onAbrufen: () => void;
}) {
  const pv = assets.find((a) => a.type === 'pv');
  const speicher = assets.find((a) => a.type === 'battery');
  return (
    <div className="vp-einst-blatt">
      <p className="vp-note">
        Prognose und Optimierung rechnen mit den amtlich registrierten Werten
        {lastFetched ? ` · zuletzt abgerufen ${fmtRelative(lastFetched)}` : ''}.
      </p>
      <dl className="vp-kv">
        {pv && (
          <>
            <div className="vp-kv-row">
              <dt className="vp-kv-k">PV-Leistung</dt>
              <dd className="vp-kv-v">
                {pv.pvCapacityKwp != null ? fmtNum(pv.pvCapacityKwp, 'kWp', 2) : '-'}
                {pv.moduleCount != null ? ` · ${pv.moduleCount} Module` : ''}
              </dd>
            </div>
            <div className="vp-kv-row">
              <dt className="vp-kv-k">Ausrichtung / Neigung</dt>
              <dd className="vp-kv-v">
                {pv.azimuthDeg != null ? fmtNum(pv.azimuthDeg, '°', 0) : 'Standard (Süd)'}
                {' / '}
                {pv.tiltDeg != null ? fmtNum(pv.tiltDeg, '°', 0) : 'Standard (30°)'}
              </dd>
            </div>
            <div className="vp-kv-row">
              <dt className="vp-kv-k">MaStR-Nummer PV</dt>
              <dd className="vp-kv-v vp-mono">{pv.registryUnitId}</dd>
            </div>
          </>
        )}
        {speicher?.registryUnitId && (
          <div className="vp-kv-row">
            <dt className="vp-kv-k">MaStR-Nummer Speicher</dt>
            <dd className="vp-kv-v vp-mono">{speicher.registryUnitId}</dd>
          </div>
        )}
      </dl>
      <Recht aktion="anlage.verwalten"><Button variant="outline" size="sm" iconLeft={<Icon name="refresh-cw" size={16} />} onClick={onAbrufen}>
        Neu aus dem Register abrufen
      </Button></Recht>
    </div>
  );
}

/**
 * „Profil ändern" (Anwendungs-Programm Stufe 2).
 *
 * ⚠ Es ändert AUSDRÜCKLICH keinen Schalter — das Profil ist Vorauswahl +
 * Tonalität + Reset-Basis (Captain-Entscheid E3), und der Dialog SAGT das in
 * seiner Folgenliste. Geschrieben wird über die schmale Route
 * (`api.setAnwendungsPreset`): ein voll-repräsentatives `updateSite` für EIN
 * Feld wäre ein Überschreib-Risiko für alles andere.
 */
function ProfilDialog({
  site,
  open,
  onClose,
  onSaved,
}: {
  site: Site;
  open: boolean;
  onClose: () => void;
  onSaved: (s: Site) => void;
}) {
  const [wahl, setWahl] = useState<Profil | null>(site.profil ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setWahl(site.profil ?? null);
    setErr(null);
  }, [open, site.profil]);

  async function speichern() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      onSaved(await api.setAnwendungsPreset(site.id, wahl));
      onClose();
    } catch {
      setErr('Das Profil konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title="Profil ändern"
      intro="Wofür wird diese Anlage betrieben?"
      consequences={profilAenderungsFolgen(wahl)}
      confirmLabel={busy ? 'Speichere…' : 'Profil speichern'}
      busy={busy}
      onConfirm={speichern}
      onCancel={onClose}
      extra={
        <>
          <VpPicker
            id="profil-wahl"
            label="Profil"
            options={[
              ...PRESETS.map((p) => ({ value: p.id, label: p.label, sub: p.satz })),
              { value: '', label: PROFIL_UNGESETZT, sub: 'Wir schlagen dann nichts vor.' },
            ]}
            value={wahl ?? ''}
            onChange={(v) => setWahl(v === '' ? null : (v as Profil))}
          />
          {err && (
            <div className="vp-alert vp-alert-err" role="alert" style={{ marginTop: 8 }}>
              {err}
            </div>
          )}
        </>
      }
    />
  );
}

/**
 * Das Formular der Grunddaten im Blatt „Anlage bearbeiten": Name, Gebotszone,
 * Veräußerungsform, Standort auf der Karte und die Einspeisegrenze. Es trägt die
 * WHOLE site unverändert mit (`buildSitePayload`, Voll-Repräsentation), damit
 * ein fokussierter Save nie ein Feld blankt, das eine andere Zeile besitzt.
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
        <VpPicker
          id="edit-site-zone"
          label="Gebotszone"
          options={[
            { value: 'DE-LU', label: 'DE-LU (Deutschland/Luxemburg)' },
            { value: 'AT', label: 'AT (Österreich)' },
            { value: 'CH', label: 'CH (Schweiz)' },
          ]}
          value={biddingZone}
          onChange={setBiddingZone}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <VpPicker
            id="edit-site-plant-kind"
            label={VERAEUSSERUNGSFORM_LABEL}
            options={[
              { value: 'eigenverbrauch', label: 'Eigenverbrauch (Haushalt/Gewerbe)' },
              {
                value: 'direktvermarktung',
                label: 'Direktvermarktung (Einspeisung am Markt)',
              },
            ]}
            value={plantKind}
            onChange={(v) => setPlantKind(v as PlantKind)}
          />
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
        <Recht aktion="anlage.verwalten"><Button variant="primary" size="sm" onClick={save} disabled={busy || !name.trim()}>
          {busy ? 'Wird gespeichert…' : 'Änderungen speichern'}
        </Button></Recht>
      </div>
    </div>
  );
}

/**
 * Der Speicher im Blatt „Speicher": alle Werte auf einen Blick - Kapazität,
 * Leistungen, Wirkungsgrad, steuerndes Gerät - und „Speicher bearbeiten". Er ist
 * auch der einzige Ort, an dem eine Anlage OHNE Marktstammdaten ihren Speicher
 * pflegt. Ohne steuerndes Gerät steht die Warnung immer oben: der Fahrplan kann
 * dann nicht wirken.
 */
export function BatteryControlSection({
  siteId,
  battery,
  devices,
  onSaved,
  hideWarning = false,
  startEditing = false,
}: {
  siteId: string;
  battery: SiteAsset | null;
  devices: Device[];
  onSaved: (assets: SiteAsset[]) => void;
  /** Die Seite zeigt die Warnung selbst schon an der Gruppe. */
  hideWarning?: boolean;
  /** Direkt im Formular beginnen („Speicher hinzufügen", „Gerät zuordnen"). */
  startEditing?: boolean;
}) {
  const [editing, setEditing] = useState(startEditing);
  // Nur ein WECHSEL der Anlage beendet das Bearbeiten - nicht das erste Rendern.
  const ersteAnlage = useRef(siteId);
  useEffect(() => {
    if (ersteAnlage.current === siteId) return;
    ersteAnlage.current = siteId;
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
        <Recht aktion="geraet.einrichten"><Button
          variant="outline"
          iconLeft={<Icon name="battery" size={16} />}
          onClick={() => setEditing(true)}
        >
          Speicher hinzufügen
        </Button></Recht>
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
      <p className="vp-note">Ihr Wechselrichter steuert diesen Speicher - er führt den Fahrplan aus.</p>
      <Recht aktion="geraet.einrichten"><Button
        variant="outline"
        size="sm"
        iconLeft={<Icon name="pencil" size={16} />}
        onClick={() => setEditing(true)}
      >
        Speicher bearbeiten
      </Button></Recht>
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
        // Der „Umgang mit dem Speicher" hat seine eigene Zeile: ihn hier
        // wegzulassen behält den gespeicherten Wert - eine Parameter-Änderung
        // überschreibt nie die Wahl des Kunden.
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
          <VpPicker
            id="battery-device"
            label="Steuerndes Gerät"
            options={[
              { value: '', label: 'Automatisch (einziges Gerät der Anlage)' },
              ...devices.map((d) => ({ value: d.id, label: d.name || d.externalRef })),
            ]}
            value={deviceId}
            onChange={setDeviceId}
          />
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
        <Recht aktion="geraet.einrichten"><Button variant="primary" size="sm" onClick={save} disabled={busy}>
          {busy ? 'Wird gespeichert…' : 'Speicher speichern'}
        </Button></Recht>
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
