// The calm "Steuerung" strip on the Anlagen-Seite (captain decision 4): one
// plain-German line "Ihr Gerät regelt gerade auf X -> Wechselrichter bestätigt Y" with a
// healthy | mismatch | stale | off | pending dot and a "geprüft vor X" note -
// PLUS, since 2026-07-30, the plan's own reason for that setpoint underneath.
// Without the reason the line read like a stubborn order (the owner's Pilsting
// question); with it the card answers "warum gerade das?" itself.
// Render-only; all derivation is the pure controlStrip() in src/control.ts.
import { lazy, Suspense, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { ControlStripView } from '../control';
import type { ExportGuardView } from '../curtailment';
import type { ErzeugerBlatt, ErzeugerKette } from '../erzeuger';
import type { Programmstand } from '../programmstand';
import type { SteuerSpalte } from '../kacheln';
import type { AnlagenSub } from '../nav';
import { tonAus } from './steuerTon';

/**
 * Das Blatt „Warum?“ ist ein eigenes, nachgeladenes Stück: die Zeile steht im Einstieg (das Cockpit
 * ist das erste Bild), Modal, Blatt und Gliederung erst beim ersten Tipp (`test/bundle-smoke.sh`).
 */
const SteuerWarum = lazy(() => import('./SteuerWarum').then((m) => ({ default: m.SteuerWarum })));

/**
 * `card`  — die eigenständige Karte (Befehle-Seite, unverändert).
 * `zeile` — die Steuerzeile des Cockpits (Konzept b1, 20.10.2026): EINE Zeile
 *           Auftrag › Gerät › Wirkung mit „Warum?“; Plan, Gründe, Grenze und ein
 *           Befund der Einspeisegrenze stehen im Blatt (Telefon `BottomSheet`,
 *           Rechner das zentrierte `Modal`). Am Rechner steht sie rechts unter
 *           der Leitkachel, am Telefon am Fuß der Bühne (`CockpitHero`). Vorher
 *           standen dort bis zu drei Absätze Fließtext unter den drei Spalten.
 */
export type ControlStripVariant = 'card' | 'zeile';

/**
 * Die Soll-Kette einer Erzeugeranlage, die VoltPilot nur liest (Konzept „Erzeuger am WAGO-Modbus-Server“,
 * EZ-8, Entscheid EW-11 A): „Netzbetreiber 60 % › Direktvermarkter 80 kW › ✓ Anlage 58,9 kW“ in derselben
 * Zeile und mit derselben Geste wie beim Speicher; das Blatt zeigt die ganze Kette, „Warum“ und „Grenze“.
 */
export interface ErzeugerZeile {
  kette: ErzeugerKette;
  blatt: ErzeugerBlatt;
  /** UEMS EZ-16: der Programmstand der Anlagensteuerung; ein alter Stand steht im Blatt unter „Warum“. */
  programmstand?: Programmstand | null;
}

/**
 * Der Einspeisewächter („Grenzen & Wächter" Stufe 0) — eine STEHENDE Aussage
 * über die Anlage, kein Live-Zustand der Batterie-Steuerung.
 *
 * **Deshalb hängt er ausdrücklich NICHT an `view`:** ein Gerät ohne
 * Batterie-Rücklesung liefert gar keine Steuerzeile, hält aber sehr wohl eine
 * Einspeisegrenze — genau die Konstellation in Herzogau. Die Grenze hinter
 * einem fremden Tor zu verstecken war der Fehler, den diese Stufe behebt, also
 * rendert der Streifen auch dann, wenn NUR der Wächter etwas zu sagen hat.
 */
function GuardLines({ guard }: { guard: ExportGuardView }) {
  return (
    <>
      <p className={`vp-guard-line tone-${guard.tone}`}>
        {guard.line}
        {guard.agoNote && <span className="vp-note vp-guard-ago"> {guard.agoNote}</span>}
      </p>
      {guard.deviceLimitLine && (
        <p className="vp-guard-line tone-warn">{guard.deviceLimitLine}</p>
      )}
    </>
  );
}

export function ControlStrip({
  view,
  variant = 'card',
  guard = null,
  spalten = null,
  isPhone = false,
  onOpenSub,
  erzeuger = null,
}: {
  view: ControlStripView | null;
  variant?: ControlStripVariant;
  guard?: ExportGuardView | null;
  /**
   * Auftrag · Gerät · Wirkung getrennt (Konzept „Cockpit als Tagesfilm“). Nur
   * im gesunden, abweichenden oder veralteten Zustand - sonst trägt der Satz.
   */
  spalten?: SteuerSpalte[] | null;
  /** `zeile`: Blatt am Telefon, sonst Modal. */
  isPhone?: boolean;
  /** `zeile`: die Wege aus dem Blatt („Zur Steuerung“, „Prüfen“ in die Einstellungen). */
  onOpenSub?: (sub: AnlagenSub) => void;
  /** `zeile`: Erzeugeranlage - die Kette ersetzt Auftrag › Gerät › Wirkung. */
  erzeuger?: ErzeugerZeile | null;
}) {
  if (!view && !guard && !(variant === 'zeile' && erzeuger)) return null;
  if (variant === 'zeile') {
    return <Steuerzeile view={view} guard={guard} spalten={spalten} isPhone={isPhone} onOpenSub={onOpenSub} erzeuger={erzeuger} />;
  }
  return (
    <section className="vp-section" aria-label="Steuerung">
      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        <span className="vp-card-label">Steuerung</span>
        {view && (
          <div className="vp-control-strip">
            <span className={`vp-control-dot tone-${view.tone}`} aria-hidden="true" />
            <p className="vp-control-sentence">{view.sentence}</p>
            {view.agoNote && <span className="vp-note vp-control-ago">{view.agoNote}</span>}
          </div>
        )}
        {view && (
          <>
            {/* Was das GERÄT selbst geändert hat (PR 3) - nur wenn es das meldete. */}
            {view.execution && <p className="vp-control-reason">{view.execution}</p>}
            {/* Die EINSPEISE-Begrenzung ist ein anderer Steuerpfad als der
                Batterie-Sollwert oben - nur mit Beleg, nie behauptet. */}
            {view.curtailment && <p className="vp-control-reason">{view.curtailment}</p>}
            {/* The WHY - only present when the plan actually recorded one. */}
            {view.reason && <p className="vp-control-reason">{view.reason}</p>}
            {/* Der Ausblick aus dem Fahrplan - nur im Ruhefall, Action-Blau. */}
            {view.outlook && <p className="vp-outlook">{view.outlook}</p>}
          </>
        )}
        {guard && <GuardLines guard={guard} />}
      </Card>
    </section>
  );
}

function TonZeichen({ ton }: { ton: 'ok' | 'warn' | 'ruhig' }) {
  if (ton === 'ok') return <Icon name="check" size={14} />;
  if (ton === 'warn') return <i className="vp-steuer-punkt" aria-hidden="true" />;
  return null;
}

interface Glied {
  key: string;
  titel: string | null;
  text: string;
  /** Am Telefon sichtbar statt `text` („NB 60 %“); `text` bleibt für den Bildschirmleser. */
  kurz?: string | null;
  ton: 'ok' | 'warn' | 'ruhig';
}

/** Die Glieder der Zeile: die Soll-Kette des Erzeugers, Auftrag › Gerät › Wirkung, sonst der eine Satz, sonst die Einspeisegrenze. */
function glieder(view: ControlStripView | null, guard: ExportGuardView | null, spalten: SteuerSpalte[] | null, erzeuger: ErzeugerZeile | null): Glied[] {
  if (erzeuger) return erzeuger.kette.glieder.map((g) => ({ key: g.key, titel: g.titel, text: g.text, kurz: g.kurz, ton: g.ton }));
  if (view && spalten && spalten.length > 0) {
    return spalten.map((sp) => ({ key: sp.titel, titel: sp.titel, text: sp.text, ton: tonAus(sp.ton) }));
  }
  if (view) return [{ key: 'satz', titel: null, text: view.sentence, ton: tonAus(view.tone) }];
  return guard ? [{ key: 'grenze', titel: null, text: guard.kurz, ton: tonAus(guard.tone) }] : [];
}

function Steuerzeile({
  view,
  guard,
  spalten,
  isPhone,
  onOpenSub,
  erzeuger,
}: {
  view: ControlStripView | null;
  guard: ExportGuardView | null;
  spalten: SteuerSpalte[] | null;
  isPhone: boolean;
  onOpenSub?: (sub: AnlagenSub) => void;
  erzeuger: ErzeugerZeile | null;
}) {
  const [offen, setOffen] = useState(false);
  // Einmal geöffnet, bleibt das Blatt montiert - so schließt es mit seiner Bewegung statt zu verschwinden.
  const [geladen, setGeladen] = useState(false);
  const kette = glieder(view, guard, spalten, erzeuger);
  // Was eine Prüfung verdient, zählt die Zeile nur - lesen lässt es sich im Blatt (und als Befund im Zustand).
  const hinweise = (guard?.deviceLimitLine ? 1 : 0) + (guard?.tone === 'warn' ? 1 : 0);
  // Beim Erzeuger sagt die Pille, wer strenger ist - oder sie zählt die Hinweise der Kette.
  const pille = erzeuger
    ? erzeuger.kette.pille
    : hinweise > 0 ? { text: hinweise === 1 ? '1 Hinweis' : `${hinweise} Hinweise`, ton: 'warn' as const } : null;
  const alter = erzeuger ? erzeuger.kette.alter : !spalten?.length ? view?.agoNote ?? null : null;
  const weiter = (sub: AnlagenSub) => {
    setOffen(false);
    onOpenSub?.(sub);
  };
  return (
    <section className="vp-steuer" aria-label="Steuerung">
      <button
        type="button"
        className="vp-steuer-knopf"
        aria-haspopup="dialog"
        onClick={() => { setGeladen(true); setOffen(true); }}
      >
        <span className="vp-steuer-kopf">
          <Icon name="zap" size={14} />
          <span className="vp-steuer-titel">Steuerung</span>
          {pille && <span className={`vp-steuer-hinweis${pille.ton === 'info' ? ' is-info' : ''}`}>{pille.text}</span>}
          <span className="vp-steuer-warum">
            Warum?
            <Icon name="chevron-right" size={14} />
          </span>
        </span>
        <span className="vp-steuer-kette">
          {/* Der Pfeil hängt am Ende eines Glieds: bricht die Zeile um, beginnt die nächste mit einem Glied, nie mit „›“. */}
          {kette.map((g, i) => (
            <span key={g.key} className="vp-steuer-teil">
              <span className={`vp-steuer-glied tone-${g.ton}`}>
                {g.titel && !g.text.startsWith(g.titel) && <span className="vp-sr-only">{g.titel}: </span>}
                <TonZeichen ton={g.ton} />
                {isPhone && g.kurz ? (
                  <>
                    <span aria-hidden="true">{g.kurz}</span>
                    <span className="vp-sr-only">{g.text}</span>
                  </>
                ) : (
                  g.text
                )}
              </span>
              {i < kette.length - 1 && <span className="vp-steuer-pfeil" aria-hidden="true">›</span>}
            </span>
          ))}
          {alter && <span className="vp-steuer-alter">{alter}</span>}
        </span>
      </button>
      {geladen && (
        <Suspense fallback={null}>
          <SteuerWarum
            offen={offen}
            isPhone={isPhone}
            onClose={() => setOffen(false)}
            view={view}
            guard={guard}
            spalten={spalten}
            erzeuger={erzeuger?.blatt ?? null}
            programmstand={erzeuger?.programmstand ?? null}
            onWeiter={onOpenSub ? weiter : undefined}
          />
        </Suspense>
      )}
    </section>
  );
}
