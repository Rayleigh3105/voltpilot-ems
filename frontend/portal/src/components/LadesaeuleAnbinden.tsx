import { useEffect, useState, type ChangeEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { api, ApiError, type Device } from '../api';
import {
  ANBINDEN_ALLOWLIST,
  ANBINDEN_EINSTIEG,
  type ChargingConfig,
  type SiteCharging,
} from '../ladepunkte';
import {
  ENDPUNKT_ZWEI_FORMEN,
  ENTFERNEN_HINWEIS,
  KEINE_EINGETRAGEN,
  KENNUNG_HILFE,
  abschluss,
  eingetrageneZeilen,
  endpunkt,
  entfernenFolgen,
  entfernenFrage,
  kennungFehler,
  kennungVorschlag,
  meldung,
  schritte,
  cockpitHinweis,
} from '../ladesaeuleAnbinden';
import { ConfirmDialog } from './ConfirmDialog';
import './LadesaeuleAnbinden.css';

/**
 * Der ANBINDE-ASSISTENT einer Ladesäule (Geräteseiten Stufe 3, Captain-Entscheid
 * **E1**) — der KÖRPER, ohne Rahmen.
 *
 * Er hat ZWEI Wirte und existiert deshalb genau einmal: den eigenen Drawer der
 * Ladevorgänge-Seite und die Ladesäulen-Tür des Anlege-Assistenten. Eine zweite
 * Kopie hieße, jeden Satz und jede Regel zweimal zu pflegen (das
 * `AdminGeraetKarten`-Muster).
 *
 * Er RENDERT nur: jede Regel, jeder Satz und jede Ablehnung kommt aus dem reinen
 * `src/ladesaeuleAnbinden.ts`.
 */
export function LadesaeuleAnbinden({
  siteId,
  device,
  onChanged,
}: {
  siteId: string;
  /** Die Box dieser Anlage — sie kennt die Adresse (D5). Ohne sie: der Weg. */
  device?: Device;
  /** Der Wirt darf seine eigene Sicht auffrischen, sobald etwas passiert ist. */
  onChanged?: () => void;
}) {
  const [name, setName] = useState('');
  const [kennung, setKennung] = useState('');
  // ⚠ Die Kennung folgt dem Namen nur, solange NIEMAND sie angefasst hat - ab
  // dem ersten Tastendruck gewinnt der Mensch, immer.
  const [selbstGetippt, setSelbstGetippt] = useState(false);
  const [config, setConfig] = useState<ChargingConfig | null>(null);
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [kopiert, setKopiert] = useState<string | null>(null);
  // Die Kennung, deren Rücknahme gerade zur Rückfrage steht (null = keine).
  const [entfernenZiel, setEntfernenZiel] = useState<{ kennung: string; name: string } | null>(
    null,
  );
  const [entfernenBusy, setEntfernenBusy] = useState(false);

  useEffect(() => {
    let aktiv = true;
    // Die Allowlist ist der Beleg für Schritt 1. ⚠ Sie wird NICHT nach dem
    // Eintragen erneut geholt: `admitChargePoint` antwortet mit der ganzen
    // Konfiguration, und ein zweiter Abruf hinterher wäre ein Rennen um
    // dieselbe Wahrheit (die Antwort ist die frischere).
    api.chargingConfig(siteId).then(
      (c) => aktiv && setConfig(c),
      () => aktiv && setConfig(null),
    );
    return () => {
      aktiv = false;
    };
  }, [siteId]);

  useEffect(() => {
    let aktiv = true;
    const laden = () =>
      api.siteChargers(siteId).then(
        (c) => aktiv && setCharging(c),
        () => aktiv && setCharging(null),
      );
    laden();
    // ⚠ Hier wird AKTIV gewartet: der Kunde steht an der Säule und tippt die
    // Adresse ein. 10 s statt der üblichen 30 - der Assistent lebt nur, solange
    // er offen ist.
    const timer = window.setInterval(laden, 10000);
    return () => {
      aktiv = false;
      window.clearInterval(timer);
    };
  }, [siteId]);

  const vergeben = (config?.chargePoints ?? []).map((c) => c.chargePointId);
  const istEingetragen = !!kennung.trim() && vergeben.includes(kennung.trim());
  const mangel = kennungFehler(kennung, vergeben);
  const m = meldung(charging, kennung);
  const ziel = endpunkt(device, charging, kennung);
  const steps = schritte(istEingetragen, m.gemeldet);
  const zeilen = eingetrageneZeilen(config?.chargePoints, charging);

  function setzeName(v: string) {
    setName(v);
    if (!selbstGetippt) setKennung(kennungVorschlag(v));
  }

  async function eintragen() {
    setBusy(true);
    setFehler(null);
    try {
      const c = await api.admitChargePoint(siteId, {
        chargePointId: kennung.trim(),
        label: name.trim() || undefined,
      });
      setConfig(c);
      onChanged?.();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Die Kennung konnte nicht eingetragen werden.');
    } finally {
      setBusy(false);
    }
  }

  async function entfernen() {
    if (!entfernenZiel) return;
    setEntfernenBusy(true);
    setFehler(null);
    try {
      const c = await api.removeChargePoint(siteId, entfernenZiel.kennung);
      setConfig(c);
      setEntfernenZiel(null);
      onChanged?.();
    } catch (e) {
      setFehler(
        e instanceof ApiError ? e.message : 'Die Kennung konnte nicht entfernt werden.',
      );
      setEntfernenZiel(null);
    } finally {
      setEntfernenBusy(false);
    }
  }

  async function kopieren(text: string, was: string) {
    try {
      await navigator.clipboard?.writeText(text);
      setKopiert(was);
      window.setTimeout(() => setKopiert(null), 2000);
    } catch {
      // Kopieren kann der Browser verweigern (kein sicherer Kontext) - dann
      // steht die Adresse trotzdem da und lässt sich markieren. Kein Fehler.
    }
  }

  return (
    <section className="vp-anbinden" data-testid="ladesaeule-anbinden">
      {/* Der Satz, der die gewohnte Richtung umdreht - er steht ganz oben, weil
          „ich lege hier ein Gerät an" die falsche Erwartung wäre. */}
      <p className="vp-anbinden-note">{ANBINDEN_EINSTIEG}</p>

      <ol className="vp-anbinden-steps">
        {steps.map((s, i) => (
          <li key={s.id} className={s.erledigt ? 'is-done' : i === offen(steps) ? 'is-active' : ''}>
            <span className="vp-anbinden-step-n">{s.erledigt ? '✓' : i + 1}</span>
            {s.titel}
          </li>
        ))}
      </ol>

      <div className="vp-anbinden-step">
        <h3 className="vp-anbinden-h">1 · Kennung festlegen</h3>
        <p className="vp-anbinden-sub">{KENNUNG_HILFE}</p>
        <Input
          label="Name der Säule (optional)"
          value={name}
          placeholder="z. B. Hof Nord"
          hint="Nur für Ihre Anzeige - er darf sich vom Kennungs-Feld unterscheiden."
          onChange={(e: ChangeEvent<HTMLInputElement>) => setzeName(e.target.value)}
        />
        <Input
          label="Kennung"
          value={kennung}
          placeholder="z. B. saeule-hof-nord"
          /* ⚠ Der Mangel wird erst gezeigt, wenn wirklich etwas dasteht - ein
             leeres Feld als Fehler zu markieren, bevor jemand getippt hat, ist
             eine Ermahnung, keine Hilfe. */
          error={kennung.trim() && !istEingetragen ? mangel : null}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setSelbstGetippt(true);
            setKennung(e.target.value);
          }}
        />
        {istEingetragen ? (
          <p className="vp-anbinden-ok">
            <Icon name="check" /> Eingetragen — VoltPilot lässt diese Kennung ab jetzt herein.
          </p>
        ) : (
          <div className="vp-anbinden-actions">
            <Button size="sm" disabled={!!mangel || busy} onClick={() => void eintragen()}>
              {busy ? 'Wird eingetragen …' : 'Kennung eintragen'}
            </Button>
          </div>
        )}
        {fehler && (
          <p className="vp-anbinden-error" role="status">
            {fehler}
          </p>
        )}
        <p className="vp-anbinden-note">{ANBINDEN_ALLOWLIST}</p>
      </div>

      <div className="vp-anbinden-step">
        <h3 className="vp-anbinden-h">2 · Adresse in der Säule eintragen</h3>
        <p className="vp-anbinden-sub">{ziel.satz}</p>
        {ziel.url ? (
          <>
            <div className="vp-anbinden-url">
              <code>{ziel.url}</code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void kopieren(ziel.url as string, 'voll')}
              >
                {kopiert === 'voll' ? 'Kopiert' : 'Kopieren'}
              </Button>
            </div>
            <p className="vp-anbinden-note">{ENDPUNKT_ZWEI_FORMEN}</p>
            {ziel.basis && ziel.basis !== ziel.url && (
              <div className="vp-anbinden-url is-alt">
                <code>{ziel.basis}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void kopieren(ziel.basis as string, 'basis')}
                >
                  {kopiert === 'basis' ? 'Kopiert' : 'Kopieren'}
                </Button>
              </div>
            )}
          </>
        ) : null}
      </div>

      <div className="vp-anbinden-step">
        <h3 className="vp-anbinden-h">3 · Säule meldet sich</h3>
        <p className={`vp-anbinden-status is-${m.ton}`}>
          <Icon name={m.gemeldet ? 'check' : 'wifi'} /> {m.wort}
        </p>
        <p className="vp-anbinden-sub">{m.satz}</p>
        {istEingetragen && <p className="vp-anbinden-note">{abschluss(m.gemeldet)}</p>}
        {/* Wohin der Kunde jetzt schaut - erst, wenn es dort wirklich etwas
            zu sehen gibt (Konzept §8, Schritt 6). */}
        {cockpitHinweis(m.gemeldet) && (
          <p className="vp-anbinden-note">{cockpitHinweis(m.gemeldet)}</p>
        )}
      </div>

      <div className="vp-anbinden-step">
        <h3 className="vp-anbinden-h">Schon eingetragen</h3>
        {zeilen.length === 0 ? (
          <p className="vp-anbinden-sub">{KEINE_EINGETRAGEN}</p>
        ) : (
          <ul className="vp-anbinden-list">
            {zeilen.map((z) => (
              <li key={z.kennung}>
                <span className="vp-anbinden-name">{z.name}</span>
                <code>{z.kennung}</code>
                <span className={`vp-anbinden-zustand is-${z.ton}`}>{z.zustand}</span>
                {/* Die Rücknahme ist eine ausdrückliche Handlung mit Folgen -
                    deshalb der Haus-Dialog, nie ein Klick, der sofort wirkt. */}
                <button
                  type="button"
                  className="vp-anbinden-remove"
                  aria-label={`Ladesäule „${z.name}" entfernen`}
                  disabled={busy || entfernenBusy}
                  onClick={() => setEntfernenZiel({ kennung: z.kennung, name: z.name })}
                >
                  <Icon name="trash" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="vp-anbinden-note">{ENTFERNEN_HINWEIS}</p>
      </div>

      <ConfirmDialog
        open={!!entfernenZiel}
        title="Ladesäule entfernen"
        intro={entfernenZiel ? entfernenFrage(entfernenZiel.name) : ''}
        consequences={entfernenZiel ? entfernenFolgen(entfernenZiel.name) : []}
        confirmLabel="Kennung entfernen"
        tone="danger"
        busy={entfernenBusy}
        onConfirm={() => void entfernen()}
        onCancel={() => setEntfernenZiel(null)}
      />
    </section>
  );
}

/** Der erste noch offene Schritt - er trägt die Hervorhebung. */
function offen(steps: { erledigt: boolean }[]): number {
  const i = steps.findIndex((s) => !s.erledigt);
  return i < 0 ? steps.length - 1 : i;
}

/**
 * Derselbe Körper in einem Drawer - der Wirt der Ladevorgänge-Seite.
 */
export function LadesaeuleAnbindenDrawer({
  open,
  siteId,
  device,
  onClose,
  onChanged,
}: {
  open: boolean;
  siteId: string;
  device?: Device;
  onClose: () => void;
  onChanged?: () => void;
}) {
  if (!open) return null;
  return (
    <Drawer
      open
      onClose={onClose}
      title="Ladesäule anbinden"
      icon={
        <IconTile category="primary" size={40}>
          <Icon name="zap" size={20} />
        </IconTile>
      }
    >
      <LadesaeuleAnbinden siteId={siteId} device={device} onChanged={onChanged} />
    </Drawer>
  );
}
