/**
 * Die EINE Tür zu einer neuen REGEL (Einheitsmodell Stufe 5a, Konzept
 * `vp-komponenten-einheit-h2` Teil 5b.4) — Nachfolger des
 * „＋ Neue Automation"-Dialogs unter dem Naming Set A.
 *
 * Die Drei-Türen-Mechanik bleibt: **Rezept → geführter Baukasten → freier
 * Editor**. NEU ist nur die erste Tür — statt zweier Flow-Vorlagen eine
 * REZEPT-GALERIE, deren Karten über die BESTEHENDEN Wege bauen (die vier
 * Verbraucher-Absichten füllen den Regelbaukasten vor, „Speicher schützen"
 * den Wenn/Dann-Baukasten).
 *
 * Reiner Renderer; die Galerie ist `RezeptGalerieView` (sie hat einen zweiten
 * Wohnort: die leere Regeln-Kapsel), der Baukasten der unveränderte
 * `GuidedRuleBuilder`.
 */
import { useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import type { SiteTopology } from '../api';
import { GuidedRuleBuilder } from './GuidedRuleBuilder';
import { RezeptGalerieView } from './RezeptGalerie';
import type { EditorEntity, FlowDocument } from '../flows/model';
import { showTechnicalLayer } from '../rollen';
import { rezeptGalerie, type RezeptId } from '../regeln/rezepte';
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
  onKomponenteAnlegen,
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
  /** Ein Rezept wurde gewählt — die Fläche entscheidet, welche Maschine läuft. */
  onRezept: (id: RezeptId) => void;
  /** Der Ausweg aus der Sackgasse: erst eine Komponente anlegen. */
  onKomponenteAnlegen: () => void;
  /** Der Baukasten hat eine Regel gebaut (Name + Dokument). */
  onBuilt: (name: string, doc: FlowDocument) => void;
  /** Der freie Editor mit einer leeren Fläche. */
  onOpenEditor: () => void;
}) {
  const [guided, setGuided] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const galerie = useMemo(() => rezeptGalerie({ entities, topology }), [entities, topology]);

  if (!open) return null;

  const close = () => {
    setGuided(false);
    setShowHidden(false);
    onClose();
  };

  return (
    <Drawer open onClose={close} title="Neue Regel" icon={<Icon name="zap" size={20} />}>
      {guided ? (
        <GuidedRuleBuilder
          entities={entities}
          siteId={siteId}
          busy={busy}
          lockedKinds={lockedKinds}
          lockedHint={lockedHint}
          allowDiagnosticActions={showTechnicalLayer()}
          onCancel={() => setGuided(false)}
          onBuild={(name, doc) => {
            setGuided(false);
            onBuilt(name, doc);
          }}
        />
      ) : (
        <div className="vp-neuregel">
          <RezeptGalerieView
            galerie={galerie}
            busy={busy}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden((v) => !v)}
            onWaehlen={onRezept}
            onKomponenteAnlegen={onKomponenteAnlegen}
          />

          {/* 2 · Baukasten ------------------------------------------------- */}
          <h3 className="vp-neuauto-head">Eigene Wenn/Dann-Regel</h3>
          <p className="vp-neuauto-note">
            Wenn/Dann in Ihren Worten — Bedingung wählen, Gerät wählen, fertig.
          </p>
          <Button size="sm" disabled={busy} onClick={() => setGuided(true)}>
            Baukasten öffnen
          </Button>

          {/* 3 · Editor ---------------------------------------------------- */}
          <h3 className="vp-neuauto-head">Freier Editor (für Fortgeschrittene)</h3>
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
