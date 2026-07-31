import { useRef, useState } from 'react';
import { Input } from '../../designsystem/components/forms/Input';
import type { TarifArt } from '../api';
import { SupplyPriceFields } from './SupplyPriceFields';
import { showSupplyPriceFields, type SupplyPriceFormValues } from '../supplyPrice';
import {
  initialDrafts,
  priceModeCards,
  priceModeConsequence,
  priceModeExplain,
  priceModeMirror,
  switchTarifArt,
  tarifParamField,
  tarifParamWarning,
  tarifSwitchNote,
  type PriceMode,
  type TarifDrafts,
} from '../tariffInput';
import './TariffFields.css';

/**
 * Die Tarif-Eingabe einer Anlage — Tarifart, die EINE Zahl dieser Tarifart und
 * (bei den strukturierten Tarifarten) die ausdrückliche Wahl **Schnell /
 * Genau**. Sie lebt hier EINMAL für alle drei Flächen, die einen Tarif
 * aufnehmen: die Einstellungs-Seite (`SettingEditors` — die Heimat des Werts),
 * den Anlege-Assistenten und den Admin-Anlegen-Drawer.
 *
 * **E2 („Bedeutungsfalle", Konzept `data/vp-settings-ux-konzept/report.md` §4.1
 * + §7 P6, Captain-Entscheid D3):** bis E2 speiste EIN `param` beide Felder, und
 * das Umschalten der Tarifart deutete die Zahl stumm um (18 als Aufschlag wurde
 * zu 18 als Strompreis; 32,5 ct Festpreis zu 32,5 ct Aufschlag ⇒ Bezugspreis
 * ≈ 55 ct/kWh, mit dem der Optimierer dann PLANT). Die Komponente hält deshalb
 * je Tarifart einen eigenen Entwurf (`TarifDrafts`, intern — der Vertrag nach
 * außen bleibt „ein `param` für die AKTUELLE Art", also brauchte das Backend
 * keine Änderung), sagt beim Wechsel an, was passiert, und warnt bei
 * unplausiblen Werten, ohne je zu sperren.
 *
 * Der Zustand des Formulars gehört weiter dem Elternteil (es speichert), nur
 * die verworfenen Entwürfe der anderen Tarifart liegen hier — sie sind reine
 * Eingabe-Ergonomie und werden nie gespeichert. Alle Regeln stehen rein in
 * `src/tariffInput.ts`.
 */
export function TariffFields({
  tarifArt,
  onTarifArt,
  param,
  onParam,
  idPrefix,
  supplyValues,
  onSupplyChange,
  priceMode,
  onPriceMode,
  storedPriceMode,
}: {
  tarifArt: TarifArt;
  onTarifArt: (art: TarifArt) => void;
  param: string;
  onParam: (text: string) => void;
  idPrefix: string;
  /**
   * Die strukturierten Bezugspreis-Komponenten (Stufe 2). Nur mit ihnen (und
   * `priceMode`) rendert die Schnell/Genau-Wahl; ohne sie bleibt das schlanke
   * Tarif-Formular (Admin-Anlegen-Drawer).
   */
  supplyValues?: SupplyPriceFormValues;
  onSupplyChange?: (field: keyof SupplyPriceFormValues, value: string) => void;
  /** Der gewählte Weg. Der Elternteil hält ihn, weil er beim Speichern zählt. */
  priceMode?: PriceMode;
  onPriceMode?: (mode: PriceMode) => void;
  /** Der GESPEICHERTE Weg — für den Spiegel und die Folgen-Ansage. */
  storedPriceMode?: PriceMode;
}) {
  // Die Entwürfe der jeweils anderen Tarifart. Bewusst lokal: sie sind reine
  // Eingabe-Ergonomie, gespeichert wird immer nur der Wert der aktuellen Art.
  const [drafts, setDrafts] = useState<TarifDrafts>(() => initialDrafts(tarifArt, param));
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  const paramRef = useRef<HTMLInputElement>(null);

  const field = tarifParamField(tarifArt);
  const warning = field ? tarifParamWarning(tarifArt, param) : null;

  const structured = showSupplyPriceFields(tarifArt);
  const modeChoice =
    supplyValues && onSupplyChange && priceMode && onPriceMode && structured;
  const stored: PriceMode = storedPriceMode ?? 'schnell';
  // Bei „Fest" gewinnt der all-in Preis serverseitig; bei den strukturierten
  // Tarifarten zeigt die Wahl den einen gültigen Weg. Ohne Wahl (Admin-Drawer)
  // bleibt es beim schlanken Formular von früher.
  const showParam = field != null && (!modeChoice || priceMode === 'schnell');
  const mirror =
    modeChoice && priceMode
      ? priceModeMirror(priceMode, tarifArt, param, supplyValues, stored)
      : null;
  const consequence =
    modeChoice && priceMode ? priceModeConsequence(stored, priceMode, tarifArt) : null;

  function changeArt(next: TarifArt) {
    const sw = switchTarifArt(drafts, tarifArt, param, next);
    setDrafts(sw.drafts);
    onTarifArt(next);
    onParam(sw.param);
    const note = tarifSwitchNote(sw, tarifArt, next);
    setSwitchNote(note);
    if (note && tarifParamField(next)) {
      // Der Fokus gehört dorthin, wo jetzt etwas fehlt bzw. neu bewertet werden
      // muss — nach dem Rendern des (evtl. erst jetzt sichtbaren) Felds.
      window.setTimeout(() => paramRef.current?.focus(), 0);
    }
  }

  return (
    <>
      <div className="vp-tarif-field">
        <label htmlFor={`${idPrefix}-tarifart`} className="vp-tarif-label">
          Stromtarif
        </label>
        <select
          id={`${idPrefix}-tarifart`}
          className="vp-select"
          value={tarifArt}
          onChange={(e) => changeArt(e.target.value as TarifArt)}
        >
          <option value="dynamisch">Dynamisch (Börsenpreis-gekoppelt)</option>
          <option value="fest">Fest (ct/kWh)</option>
          <option value="ohne">Ohne Angabe</option>
        </select>
        <p className="vp-note" style={{ margin: 0 }}>
          Für den Wert Ihres Eigenverbrauchs. Bei „Ohne Angabe" zeigen wir den
          Eigenverbrauch nur in kWh, nie einen erfundenen Euro-Wert.
        </p>
      </div>

      {modeChoice && (
        <fieldset className="vp-pricemode">
          <legend className="vp-tarif-label">Wie genau möchten Sie den Bezugspreis angeben?</legend>
          <div className="vp-pricemode-cards">
            {priceModeCards(tarifArt).map((card) => (
              <label
                key={card.id}
                className={`vp-pricemode-card${priceMode === card.id ? ' selected' : ''}`}
              >
                <input
                  type="radio"
                  name={`${idPrefix}-pricemode`}
                  value={card.id}
                  checked={priceMode === card.id}
                  onChange={() => onPriceMode?.(card.id)}
                />
                <span>
                  <b>{card.label}</b>
                  <small>{card.hint}</small>
                </span>
              </label>
            ))}
          </div>
          <p className="vp-note" style={{ margin: 0 }}>
            {priceModeExplain(priceMode!, tarifArt)} Es zählt immer nur einer der
            beiden Wege - nie beide zusammen.
          </p>
        </fieldset>
      )}

      {/* Die Wechsel-Ansage gehört zum Zahlenfeld: ohne sichtbares Feld (in
          „Genau" bzw. bei „Ohne Angabe") gäbe es nichts, worauf sie zeigt. */}
      {switchNote && showParam && (
        <p className="vp-tarif-switchnote" role="status">
          {switchNote}
        </p>
      )}

      {showParam && field && (
        <div className="vp-tarif-field">
          <Input
            ref={paramRef}
            id={`${idPrefix}-param`}
            label={field.label}
            placeholder={field.placeholder}
            inputMode="decimal"
            value={param}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              // Wer tippt, hat die Ansage gelesen - „bitte neu eintragen" darf
              // nicht über einem gefüllten Feld stehen bleiben.
              if (switchNote) setSwitchNote(null);
              onParam(e.target.value);
            }}
          />
          <p className="vp-note" style={{ margin: 0 }}>
            {field.help}
          </p>
          {warning && <p className="vp-tarif-warn">{warning}</p>}
        </div>
      )}

      {modeChoice && priceMode === 'genau' && (
        <SupplyPriceFields
          tarifArt={tarifArt}
          values={supplyValues!}
          onChange={onSupplyChange!}
          idPrefix={`${idPrefix}-supply`}
        />
      )}

      {modeChoice && mirror && <p className="vp-tarif-mirror">{mirror}</p>}
      {modeChoice && consequence && <p className="vp-tarif-warn">{consequence}</p>}

      {supplyValues && onSupplyChange && !structured && (
        <SupplyPriceFields
          tarifArt={tarifArt}
          values={supplyValues}
          onChange={onSupplyChange}
          idPrefix={`${idPrefix}-supply`}
        />
      )}
    </>
  );
}
