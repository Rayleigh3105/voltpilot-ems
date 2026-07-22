/**
 * Portal v3 · M4 — die EINE Tür zu einer neuen Automation
 * (`docs/portal-v3/M4-steuerung.md`).
 *
 * Vorher gab es drei Einstiege nebeneinander (Baukasten-Knopf, „Profi-Ansicht",
 * Vorlagen-Galerie) und daneben noch die Werkzeugkiste. Jetzt gibt es EINEN
 * Knopf, und dieser Dialog bietet die drei Wege in der Reihenfolge an, in der
 * sie helfen: **Vorlage → geführter Baukasten → Editor**.
 *
 * Vorlagen, die diese Anlage nicht fahren kann, sind AUSGEBLENDET (nicht
 * ausgegraut) — hinter einer gezählten, ehrlichen Zeile zum Aufklappen; jede
 * eingeblendete Karte nennt, was fehlt (`flows/templateFilter.ts`).
 *
 * Reiner Renderer: die Auswahl-Regel liegt im unit-getesteten `templateFilter`,
 * der Baukasten bleibt der unveränderte `GuidedRuleBuilder`.
 */
import { useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import type { SiteTopology } from '../api';
import { GuidedRuleBuilder } from './GuidedRuleBuilder';
import { CUSTOMER_TEMPLATES, type CustomerTemplateDef } from '../flows/customerTemplates';
import type { EditorEntity, FlowDocument } from '../flows/model';
import { hiddenDisclosure, partition } from '../flows/templateFilter';
import './Steuerung.css';

/** Die Bedingungs-Arten des Baukastens (Spiegel von `GuidedRuleBuilder`). */
type CondKind = 'entity' | 'price' | 'schedule';

export function NeueAutomationDialog({
  open,
  onClose,
  entities,
  topology = null,
  siteId,
  busy = false,
  lockedKinds = [],
  lockedHint,
  onUseTemplate,
  onBuilt,
  onOpenEditor,
}: {
  open: boolean;
  onClose: () => void;
  entities: EditorEntity[];
  topology?: SiteTopology | null;
  siteId: string;
  busy?: boolean;
  lockedKinds?: CondKind[];
  lockedHint: string;
  onUseTemplate: (def: CustomerTemplateDef) => void;
  /** Der Baukasten hat eine Regel gebaut (Name + Dokument). */
  onBuilt: (name: string, doc: FlowDocument) => void;
  /** „Node-RED-Editor" — der leere Editor (M5 löst ihn später ab). */
  onOpenEditor: () => void;
}) {
  const [guided, setGuided] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const part = useMemo(() => partition(CUSTOMER_TEMPLATES, { entities, topology }), [entities, topology]);
  const disclosure = hiddenDisclosure(part);

  if (!open) return null;

  const close = () => {
    setGuided(false);
    setShowHidden(false);
    onClose();
  };

  return (
    <Drawer
      open
      onClose={close}
      title="Neue Automation"
      icon={<Icon name="zap" size={20} />}
    >
      {guided ? (
        <GuidedRuleBuilder
          entities={entities}
          siteId={siteId}
          busy={busy}
          lockedKinds={lockedKinds}
          lockedHint={lockedHint}
          onCancel={() => setGuided(false)}
          onBuild={(name, doc) => {
            setGuided(false);
            onBuilt(name, doc);
          }}
        />
      ) : (
        <div className="vp-neuauto">
          <p className="vp-neuauto-intro">
            Am schnellsten geht es mit einer Vorlage. Wollen Sie etwas anderes,
            führt Sie der Baukasten Schritt für Schritt — und wer mag, baut frei
            im Editor.
          </p>

          {/* 1 · Vorlagen -------------------------------------------------- */}
          <h3 className="vp-neuauto-head">1 · Vorlage verwenden</h3>
          {part.fitting.length === 0 ? (
            <p className="vp-neuauto-note">
              Für Ihre Anlage passt derzeit keine Vorlage. Nutzen Sie den Baukasten.
            </p>
          ) : (
            <ul className="vp-neuauto-list">
              {part.fitting.map((def) => (
                <li key={def.id} className="vp-neuauto-item">
                  <div className="vp-neuauto-itemtext">
                    <strong>{def.name}</strong>
                    <p>{def.description}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onUseTemplate(def)}
                  >
                    Verwenden
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {disclosure && (
            <div className="vp-neuauto-hidden">
              <button
                type="button"
                className="vp-neuauto-disclose"
                aria-expanded={showHidden}
                onClick={() => setShowHidden((v) => !v)}
              >
                <Icon name={showHidden ? 'chevron-down' : 'chevron-right'} size={14} />
                {disclosure} — trotzdem zeigen
              </button>
              {showHidden && (
                <ul className="vp-neuauto-list muted">
                  {part.notFitting.map(({ template, reason }) => (
                    <li key={template.id} className="vp-neuauto-item">
                      <div className="vp-neuauto-itemtext">
                        <strong>{template.name}</strong>
                        <p>{template.description}</p>
                        <p className="vp-neuauto-reason">{reason}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 2 · Baukasten ------------------------------------------------- */}
          <h3 className="vp-neuauto-head">2 · Geführter Baukasten</h3>
          <p className="vp-neuauto-note">
            Wenn/Dann in Ihren Worten — Bedingung wählen, Gerät wählen, fertig.
          </p>
          <Button size="sm" disabled={busy} onClick={() => setGuided(true)}>
            Baukasten öffnen
          </Button>

          {/* 3 · Editor ---------------------------------------------------- */}
          <h3 className="vp-neuauto-head">3 · Node-RED-Editor</h3>
          <p className="vp-neuauto-note">
            Die freie Fläche: Bausteine verbinden, wie Sie wollen. Vor jeder
            Aktivierung wird die Regel geprüft und simuliert.
          </p>
          <Button size="sm" variant="outline" disabled={busy} onClick={onOpenEditor}>
            Editor öffnen
          </Button>
        </div>
      )}
    </Drawer>
  );
}
