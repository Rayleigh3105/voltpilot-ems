/**
 * **Die EINE Wahrheit je Geld-/Verhaltens-Einstellung** — Lese-Wert, Zeile und
 * Inline-Formular (E1, Konzept `data/vp-settings-ux-konzept/report.md` §7 P2).
 *
 * Bis E1 lebten diese Formulare als private Funktionen IM `ModusContainer` —
 * der einzige Ort, an dem Stromtarif, Netzladen, anzulegender Wert und der
 * Umgang mit dem Speicher überhaupt bearbeitbar waren. Der Captain-Entscheid D1
 * dreht den Besitz um: die **Einstellungs-Seite der Anlage** besitzt sie
 * (`modeSettings.home === 'einstellungen'`), der Modus-Container SPIEGELT sie
 * read-only mit einem Deep-Link hierher. Damit rendern zwei Flächen dieselbe
 * Einstellung — also wohnt sie hier EINMAL, statt zweimal zu existieren und
 * auseinanderzulaufen.
 *
 * Was das Modul liefert:
 *   - `settingReadValue` — die Lese-Anzeige eines Werts (beide Flächen).
 *   - `SettingRow` — die Zeile: Label · Wert · Aktion, plus das inline
 *     aufklappende Formular. Die Aktion ist entweder `{kind:'edit'}` (die
 *     Einstellungs-Seite bearbeitet) oder `{kind:'link'}` (der Container
 *     verweist) — es gibt bewusst KEINE Doppel-Editierbarkeit.
 *   - die vier Editoren + `canEditSetting`.
 *
 * **Die Regressionsfalle, die mit umgezogen ist:** der Site-Save ist eine
 * VOLL-Repräsentation (`buildSitePayload`), damit ein fokussierter Save hier
 * kein Nachbarfeld (Name, max. Einspeiseleistung, …) blankt — und umgekehrt.
 * Der Speicher-Save trägt die vollen Speicherparameter durch und sendet die
 * Speicherschonung nur bei einer echten Änderung.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type Site,
  type SiteAsset,
  type SupplyPriceUpdate,
  type TarifArt,
} from '../api';
import { buildSitePayload } from '../anlage';
import { fmtNum } from '../format';
import { parsePremiumInput, premiumInputText, tarifArtLabel } from '../fleet';
import type { ModeSettingDef } from '../modeSettings';
import { presetOf, speicherschonungLabel, type SpeicherschonungPreset } from '../speicherschonung';
import {
  buildSupplyPricePatch,
  showSupplyPriceFields,
  supplyPriceFormValues,
  type SupplyPriceFormValues,
} from '../supplyPrice';
import {
  clearSupplyPricePatch,
  initialPriceMode,
  type PriceMode,
} from '../tariffInput';
import { AnzulegenderWertField } from './AnzulegenderWertField';
import { NetzladenBadge } from './NetzladenBadge';
import { NetzladenField } from './NetzladenField';
import { SpeicherschonungField } from './SpeicherschonungField';
import { TariffFields } from './TariffFields';
import './SettingEditors.css';

/** Ein fail-soft „—" für einen fehlenden (von VoltPilot noch nicht gesetzten) Wert. */
const MISSING = <span className="vp-muted">—</span>;

/** Die Abrechnungsperiode des Leistungspreises in Kundendeutsch. */
function abrechnungLabel(v: 'jahr' | 'monat' | null | undefined): ReactNode {
  if (v === 'jahr') return 'jährlich';
  if (v === 'monat') return 'monatlich';
  return MISSING;
}

/**
 * Die Lese-Wert-Anzeige einer Einstellung — von BEIDEN Flächen benutzt (die
 * Einstellungs-Seite und der Modus-Container-Spiegel), damit derselbe Wert
 * nirgends anders aussieht als anderswo.
 */
export function settingReadValue(
  id: ModeSettingDef['id'],
  site: Site,
  battery: SiteAsset | null,
): ReactNode {
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
 * Darf der Kunde diese Einstellung hier bearbeiten? Die Speicherschonung
 * braucht zusätzlich einen VOLL konfigurierten Speicher, weil `saveBattery`
 * eine Voll-Repräsentation der Speicherparameter ist — ohne Kapazität/Leistungen
 * gäbe es nichts durchzutragen.
 */
export function canEditSetting(setting: ModeSettingDef, battery: SiteAsset | null): boolean {
  const batteryReady =
    battery != null &&
    battery.capacityKwh != null &&
    battery.maxChargeKw != null &&
    battery.maxDischargeKw != null;
  return (
    setting.editability === 'customer' &&
    setting.editForm != null &&
    (setting.id !== 'speicherschonung' || batteryReady)
  );
}

/**
 * Die Aktion einer Zeile. `edit` = diese Fläche BESITZT den Wert und klappt das
 * Formular auf; `link` = diese Fläche spiegelt ihn nur und verweist auf seine
 * Heimat. Nie beides — Doppel-Editierbarkeit ist genau das, was E1 abschafft.
 */
export type SettingRowAction =
  | { kind: 'edit' }
  | { kind: 'link'; href: string; label: string };

/**
 * Eine Einstellungs-Zeile: Label + Lese-Wert + Aktion; das Formular klappt
 * inline auf (das AnlageTechnik-Muster). Von-VoltPilot-Einstellungen
 * (`editability: 'voltpilot'`) bleiben read-only mit ihrer Notiz.
 */
export function SettingRow({
  setting,
  site,
  battery,
  action,
  hint,
  onSiteSaved,
  onBatterySaved,
}: {
  setting: ModeSettingDef;
  site: Site;
  battery: SiteAsset | null;
  action: SettingRowAction;
  /** Eine ruhige Erklärzeile unter Label · Wert (die Einstellungs-Seite nutzt sie). */
  hint?: ReactNode;
  onSiteSaved: (updated: Site) => void;
  onBatterySaved: (assets: SiteAsset[]) => void;
}) {
  const [editing, setEditing] = useState(false);

  const editable = canEditSetting(setting, battery);
  // Eine von-VoltPilot-eingerichtete Einstellung zeigt ihren WERT (read-only,
  // fail-soft „—") plus die Notiz — der Kunde SIEHT sie, bearbeitet sie nicht.
  const readonlyByVoltpilot = setting.editability === 'voltpilot';

  return (
    <li className={`vp-setting${editing ? ' editing' : ''}`}>
      <div className="vp-setting-top">
        <span className="vp-setting-label">{setting.label}</span>
        {editing ? null : (
          <span className="vp-setting-val">{settingReadValue(setting.id, site, battery)}</span>
        )}
        {!editing && action.kind === 'edit' && editable ? (
          <button type="button" className="vp-setting-btn" onClick={() => setEditing(true)}>
            <Icon name="pencil" size={14} />
            Bearbeiten
          </button>
        ) : null}
        {!editing && action.kind === 'link' && editable ? (
          <a className="vp-setting-btn" href={action.href}>
            {action.label}
            <Icon name="chevron-right" size={14} />
          </a>
        ) : null}
      </div>
      {hint && !editing ? <span className="vp-setting-hint">{hint}</span> : null}
      {readonlyByVoltpilot && !editing ? (
        <span className="vp-setting-hint">Von VoltPilot eingerichtet</span>
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
export function SettingEditForm({
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
    <div className="vp-setting-editactions">
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
    <div className="vp-setting-editform">
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
    <div className="vp-setting-editform">
      <div className="vp-form-stack">
        <NetzladenField value={netzladen} onChange={setNetzladen} idPrefix="setting-netzladen" />
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
    <div className="vp-setting-editform">
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
  // E2/D3: „Schnell" (eine Zahl) oder „Genau" (Preisblatt) — serverseitig ein
  // Entweder/Oder, also hier eine ausdrückliche Wahl. `stored` ist der Weg, in
  // dem die Anlage GESPEICHERT ist; er entscheidet, ob ein Wechsel auf
  // „Schnell" beim Speichern ein Preisblatt entwertet.
  const [storedMode, setStoredMode] = useState<PriceMode>('schnell');
  const [mode, setMode] = useState<PriceMode>('schnell');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .supplyPrice(site.id)
      .then((sheet) => {
        if (!alive) return;
        setSupply(supplyPriceFormValues(sheet));
        setStoredMode(initialPriceMode(sheet));
        setMode(initialPriceMode(sheet));
      })
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
    // Eine Preis-Wahrheit (D3): „Genau" schreibt das Preisblatt, „Schnell"
    // ENTFERNT ein zuvor gepflegtes - sonst gewänne es serverseitig weiter
    // (pricing.py: das Preisblatt ersetzt den Sammelaufschlag) und die
    // Oberfläche würde behaupten, die eingetippte Zahl zähle.
    let supplyPatch: SupplyPriceUpdate | null = null;
    if (supply && showSupplyPriceFields(tarifArt)) {
      if (mode === 'genau') {
        const built = buildSupplyPricePatch(supply);
        if ('error' in built) {
          setError(built.error);
          return;
        }
        supplyPatch = built.patch;
      } else if (storedMode === 'genau') {
        supplyPatch = clearSupplyPricePatch();
      }
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
    <div className="vp-setting-editform">
      <div className="vp-form-stack">
        <TariffFields
          tarifArt={tarifArt}
          onTarifArt={setTarifArt}
          param={param}
          onParam={setParam}
          idPrefix="setting-tarif"
          supplyValues={supply ?? undefined}
          onSupplyChange={changeSupply}
          priceMode={mode}
          onPriceMode={setMode}
          storedPriceMode={storedMode}
        />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <EditActions busy={busy} onCancel={onCancel} onSave={save} />
    </div>
  );
}
