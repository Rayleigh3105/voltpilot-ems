/**
 * Die EINE Tür zu einer neuen REGEL — seit Steuerung Stufe 2 der BAUKASTEN
 * selbst (Konzept `vp-steuerung-konzept-b3` §3.3 „Der Builder (die EINE
 * Regel-Mechanik) … ohne Rezept-Galerie", Stufenplan Stufe 2; Captain-Entscheid
 * „nur Builder").
 *
 * ⚠ Die REZEPT-GALERIE als erste Tür ist ERSATZLOS entfallen. Die Rezepte
 * leben als VORBELEGUNGEN im Baukasten weiter (`regeln/rezepte.ts`
 * `vorbelegungen`) — sie füllen ihn, statt hinter dem Rücken des Kunden eine
 * fertige Regel zu erzeugen; die Maschinen dahinter (Verbraucher-Politik,
 * Wenn/Dann-Flow) sind unverändert. Der Grund war ZUSCHNITT: eine Anlage ohne
 * schaltbares Gerät zeigte dieselbe Sackgasse dreimal (Galerie → Baukasten →
 * Editor, Befund B7 des Konzepts).
 *
 * Der freie Editor bleibt als zweiter, ruhiger Weg — er ist eine ANDERE
 * Mechanik (freie Bausteine), keine zweite Fassung derselben.
 *
 * Reiner Renderer; der Baukasten ist der unveränderte `GuidedRuleBuilder`.
 */
import { useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import type { SiteTopology } from '../api';
import { GuidedRuleBuilder } from './GuidedRuleBuilder';
import type { EditorEntity, FlowDocument } from '../flows/model';
import type { GuidedRule } from '../flows/guidedBuilder';
import { showTechnicalLayer } from '../rollen';
import {
  KOMPONENTE_ANLEGEN,
  vorbelegungen as startpunkte,
  type RezeptId,
} from '../regeln/rezepte';
import './Steuerung.css';
import './Regeln.css';

/** Die Bedingungs-Arten des Baukastens (Spiegel von `GuidedRuleBuilder`). */
type CondKind = 'entity' | 'price' | 'schedule';

export function NeueRegelDialog({
  open,
  onClose,
  entities,
  topology = null,
  siteId,
  busy = false,
  lockedKinds = [],
  lockedHint,
  onRezept,
  onSolarUeberschuss,
  onKomponenteAnlegen,
  onBuilt,
  onOpenEditor,
  initialRule = null,
  initialName,
}: {
  open: boolean;
  onClose: () => void;
  entities: EditorEntity[];
  topology?: SiteTopology | null;
  siteId: string;
  busy?: boolean;
  lockedKinds?: CondKind[];
  lockedHint: string;
  /** Ein Rezept wurde gewählt — die Fläche entscheidet, welche Maschine läuft. */
  onRezept: (id: RezeptId) => void;
  /** Der Weg zur Solar-Überschuss-Regel (Stufe 2) — fehlt er, wird sie nicht angeboten. */
  onSolarUeberschuss?: () => void;
  /** Der Ausweg aus der Sackgasse: erst eine Komponente anlegen. */
  onKomponenteAnlegen: () => void;
  /** Der Baukasten hat eine Regel gebaut (Name + Dokument). */
  onBuilt: (name: string, doc: FlowDocument) => void;
  /** Der freie Editor mit einer leeren Fläche. */
  onOpenEditor: () => void;
  /**
   * Einheitsmodell Stufe 4, Anforderung 9 (die Brücke): eine VORBEFÜLLTE Regel
   * öffnet den Baukasten sofort - die Galerie davor wäre ein Zwischenschritt,
   * den der Kunde schon getroffen hat, als er die Komponente wählte. Absent =
   * der leere Baukasten mit seinen Startpunkten.
   */
  initialRule?: GuidedRule | null;
  initialName?: string;
}) {
  const [editorOffen, setEditorOffen] = useState(false);
  const start = useMemo(() => startpunkte({ entities, topology }), [entities, topology]);

  if (!open) return null;

  const close = () => {
    setEditorOffen(false);
    onClose();
  };

  return (
    <Drawer open onClose={close} title="Neue Regel" icon={<Icon name="zap" size={20} />}>
      <div className="vp-neuregel">
        {/* ⚠ Der Schlüssel ist tragend: der Baukasten liest `initialRule` NUR
            beim Montieren (`useState`-Seed). Ohne ihn bliebe das Formular
            stehen, wenn ein Startpunkt es vorbelegt, während der Dialog schon
            offen ist. */}
        <GuidedRuleBuilder
          key={initialName ?? 'leer'}
          entities={entities}
          siteId={siteId}
          busy={busy}
          lockedKinds={lockedKinds}
          lockedHint={lockedHint}
          allowDiagnosticActions={showTechnicalLayer()}
          onSolarUeberschuss={onSolarUeberschuss}
          initialRule={initialRule ?? undefined}
          initialName={initialName}
          vorbelegungen={start}
          onVorbelegung={onRezept}
          onCancel={close}
          onBuild={onBuilt}
        />

        {/* Die Sackgassen-Rettung: ohne schaltbares Gerät gibt es nichts zu
            schalten — dann steht hier der WEG, nicht ein weiterer Knopf, der
            dieselbe Antwort gibt. */}
        {start.brauchtKomponente && (
          <div className="vp-neuregel-bridge">
            <p>{KOMPONENTE_ANLEGEN}</p>
            <Button size="sm" disabled={busy} onClick={onKomponenteAnlegen}>
              Komponente anlegen
            </Button>
          </div>
        )}

        {/* Der zweite, ruhige Weg: eine ANDERE Mechanik, keine zweite Fassung
            derselben — deshalb steht er unten und nicht als gleichrangige Tür. */}
        <div className="vp-neuregel-editor">
          <button
            type="button"
            className="vp-neuauto-disclose"
            aria-expanded={editorOffen}
            onClick={() => setEditorOffen((v) => !v)}
          >
            <Icon name={editorOffen ? 'chevron-down' : 'chevron-right'} size={14} />
            Freier Editor (für Fortgeschrittene)
          </button>
          {editorOffen && (
            <>
              <p className="vp-neuauto-note">
                Die freie Fläche: Bausteine verbinden, wie Sie wollen. Vor jeder
                Aktivierung wird die Regel geprüft und simuliert.
              </p>
              <Button size="sm" variant="outline" disabled={busy} onClick={onOpenEditor}>
                Editor öffnen
              </Button>
            </>
          )}
        </div>
      </div>
    </Drawer>
  );
}
