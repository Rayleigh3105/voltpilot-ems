import { Recht } from './Recht';
import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { api, ApiError, type Site } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { fmtNum } from '../format';
import {
  aktivierenFolgen,
  GRENZE_FEHLT,
  grenzeFehler,
  type ChargingConfig,
} from '../ladepunkte';
import {
  NICHT_GEMELDET,
  NUR_HINTERLEGT,
  OHNE_MELDUNG,
  ohneMeldung,
  RAHMEN_KARTE_INTRO,
  RAHMEN_KARTE_TITEL,
  rahmenZeilen,
} from '../ladeparkRahmen';
import { showTechnicalLayer } from '../rollen';
import type { LadeparkRahmen } from '../verbraucherZone';
import './LadeparkKapsel.css';

/**
 * Der LADEPARK-RAHMEN (Verbrauchsmanagement v1 / P5, E10) — die Nachfolgerin
 * der alten Ladepark-Kapsel.
 *
 * ⚠ Was hier ERSATZLOS entfallen ist, ist die eigentliche Aussage dieser Runde:
 * die zwei Radio-Gruppen der Kapsel (Quellen-Wahl und Speicher-Vorrang) haben
 * neue, bessere Wohnorte bekommen — die QUELLE ist seit P2/P5 der
 * Anlagen-Standard bzw. die Steuerart je Säule (sie kann seither auch je
 * Ladepunkt abweichen, was ein anlagenweiter Radio nie ausdrücken konnte), und
 * der VORRANG ist seit P4 die Rangliste (die zusätzlich den Speicher UND die
 * übrigen Verbraucher einordnet). Sie hier stehen zu lassen wären zwei
 * Bedienelemente für dieselbe Tatsache — genau die Doppeldeutigkeit, gegen die
 * das Programm gebaut ist.
 *
 * Was BLEIBT: die Anschlussgrenze (die EINE Zahl, die dem Kunden gehört) und —
 * neu — die übrigen Rahmen-Werte, die er bis hierher im Portal nicht einmal
 * LESEN konnte.
 */
export function LadeparkRahmenKarte({
  site,
  rahmen,
  onSaved,
}: {
  site: Site;
  /** Das IST der Box (aus `GET /verbraucher`); null = sie hat nichts gemeldet. */
  rahmen: LadeparkRahmen | null;
  onSaved?: () => void;
}) {
  const [config, setConfig] = useState<ChargingConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.chargingConfig(site.id).then(
      (c) => {
        if (!active) return;
        setConfig(c);
        setDraft(c.gridLimitKw == null ? '' : String(c.gridLimitKw));
      },
      () => active && setConfig(null),
    );
    return () => {
      active = false;
    };
  }, [site.id]);

  const limit = config?.gridLimitKw ?? null;
  const inputError = draft.trim() === '' ? null : grenzeFehler(draft);
  const parsed = Number(draft.replace(',', '.').trim());
  const zeilen = rahmenZeilen(rahmen, config?.frame ?? null);
  const stumm = ohneMeldung(rahmen);

  async function save(gridLimitKw: number) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.saveChargingConfig(site.id, { gridLimitKw });
      setConfig(next);
      setDraft(next.gridLimitKw == null ? '' : String(next.gridLimitKw));
      onSaved?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
      setDialog(false);
    }
  }

  return (
    <section className="vp-ladepark" aria-label={RAHMEN_KARTE_TITEL}>
      <Card padding="lg" radius="lg">
        <div className="vp-ladepark-row">
          <div>
            <h4>{RAHMEN_KARTE_TITEL}</h4>
            <p className="vp-ladepark-managed">{RAHMEN_KARTE_INTRO}</p>
          </div>
        </div>

        {/* Die EINE Zahl, die dem Kunden gehört. */}
        <div className="vp-ladepark-row">
          <div>
            <h4>Anschlussgrenze</h4>
            <p className="vp-ladepark-managed">
              {limit == null ? GRENZE_FEHLT : `${fmtNum(limit, 'kW')} am Netzverknüpfungspunkt.`}
            </p>
          </div>
          <Recht aktion="grenze.eintragen"><div className="vp-ladepark-edit">
            <label htmlFor="vp-grenze">kW</label>
            <input
              id="vp-grenze"
              inputMode="decimal"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-invalid={inputError ? true : undefined}
            />
            <Button
              variant="outline"
              disabled={busy || draft.trim() === '' || inputError != null}
              onClick={() => setDialog(true)}
            >
              Übernehmen
            </Button>
          </div></Recht>
        </div>
        {inputError && <p className="vp-ladepark-error">{inputError}</p>}
        {error && <p className="vp-ladepark-error">{error}</p>}

        {/* Der Rest: LESEN. Jede Zeile sagt, WOHER ihre Zahl kommt. */}
        {stumm && <p className="vp-ladepark-hint">{OHNE_MELDUNG}</p>}
        <ul className="vp-ladepark-rahmen">
          {zeilen.map((z) => (
            <li key={z.key}>
              <span className="vp-ladepark-rahmen-label">{z.label}</span>
              <span className="vp-ladepark-rahmen-wert">
                {z.wert ?? <i className="vp-ladepark-rahmen-leer">{NICHT_GEMELDET}</i>}
              </span>
              {z.hinweis && <small className="vp-ladepark-hint">{z.hinweis}</small>}
            </li>
          ))}
        </ul>

        {showTechnicalLayer() && (
          <RahmenEditor
            site={site}
            frame={config?.frame ?? null}
            onSaved={(next) => {
              setConfig(next);
              onSaved?.();
            }}
          />
        )}
      </Card>

      <ConfirmDialog
        open={dialog}
        title="Anschlussgrenze übernehmen"
        intro={`VoltPilot rechnet ab sofort mit ${fmtNum(parsed, 'kW')} als Grenze Ihres Netzanschlusses.`}
        consequences={aktivierenFolgen(Number.isFinite(parsed) ? parsed : null)}
        confirmLabel="Übernehmen"
        busy={busy}
        onConfirm={() => void save(parsed)}
        onCancel={() => setDialog(false)}
      />
    </section>
  );
}

const FELDER = [
  { key: 'maxHouseLoadKw', label: 'Höchste Gebäudelast (kW)' },
  { key: 'marginPct', label: 'Sicherheitsabstand (%)' },
  { key: 'minPowerKw', label: 'Mindestleistung je Fahrzeug (kW)' },
  { key: 'rotationMinutes', label: 'Wechsel bei knapper Leistung (Min.)' },
] as const;

/**
 * Der Betreiber-Editor (Plattform-Admin). Er schreibt das SOLL; was die Box
 * daraufhin rechnet, sagt die Leseliste darüber.
 *
 * ⚠ Ein LEER gelassenes Feld ist „nichts sagen" (der gespeicherte Wert bleibt),
 * NICHT „auf 0 setzen" — deshalb wird ein leeres Feld gar nicht erst gesendet.
 * Zurücknehmen ist eine eigene Handlung („Zurücknehmen" je Feld), damit ein
 * versehentlich geleertes Feld nie eine gepflegte Zahl löscht.
 */
function RahmenEditor({
  site,
  frame,
  onSaved,
}: {
  site: Site;
  frame: ChargingConfig['frame'];
  onSaved: (next: ChargingConfig) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft({
      maxHouseLoadKw: frame?.maxHouseLoadKw == null ? '' : String(frame.maxHouseLoadKw),
      marginPct: frame?.marginPct == null ? '' : String(frame.marginPct),
      minPowerKw: frame?.minPowerKw == null ? '' : String(frame.minPowerKw),
      rotationMinutes: frame?.rotationMinutes == null ? '' : String(frame.rotationMinutes),
    });
  }, [frame]);

  async function speichern() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, number | null> = {};
      for (const f of FELDER) {
        const raw = (draft[f.key] ?? '').replace(',', '.').trim();
        if (raw === '') continue; // ⚠ nichts sagen ≠ löschen
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          setError(`„${f.label}" ist keine Zahl.`);
          setBusy(false);
          return;
        }
        body[f.key] = n;
      }
      onSaved(await api.saveChargingFrame(site.id, body));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-ladepark-row vp-ladepark-admin">
      <div>
        <h4>Rahmen einrichten (VoltPilot)</h4>
        <p className="vp-ladepark-managed">
          Leer lassen heißt „nichts sagen" — Ihre Box behält dann ihre eigene Zahl.
        </p>
        <div className="vp-ladepark-grid">
          {FELDER.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                inputMode="decimal"
                value={draft[f.key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <Button variant="outline" disabled={busy} onClick={() => void speichern()}>
          Rahmen speichern
        </Button>
        {error && <p className="vp-ladepark-error">{error}</p>}
        <p className="vp-ladepark-hint">{NUR_HINTERLEGT}</p>
      </div>
    </div>
  );
}
