import { useEffect, useId, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import {
  aktiv,
  CHIPS,
  ERGEBNISSE,
  HERKUENFTE,
  STROEME,
  umschalten,
  ZEITRAUM_LABEL,
  type BefehlFilter,
  type BefehlZeitraum,
} from '../befehleFilter';

/**
 * Die FILTER-LEISTE des Befehls-Verlaufs (Geräteseiten Revision B §6,
 * Captain-Punkt 4): Zeitraum · Befehlsart · Herkunft · Ergebnis · Freitext.
 *
 * <b>Sie entscheidet nichts.</b> Jedes Wort, jede Beschriftung und jeder Satz
 * kommt aus der reinen `src/befehleFilter.ts` - hier wird nur gerendert und
 * gemeldet, was jemand angefasst hat.
 *
 * <b>Telefon:</b> unter 720px wird die Leiste ein Sheet („Filter · 2 aktiv"),
 * die drei Schnell-Chips bleiben SICHTBAR - sie sind die drei Fragen der
 * Support-Fälle und dürfen nie hinter einem Knopf verschwinden.
 */
export function BefehleFilterLeiste({
  filter,
  onChange,
  hinweis,
  treffer,
}: {
  filter: BefehlFilter;
  onChange: (f: BefehlFilter) => void;
  /** Der Satz unter dem Suchfeld: WORIN gesucht wird. */
  hinweis: string;
  /** Der Treffer-Satz („14 von 212 Zeilen"), oder null bei älterem Backend. */
  treffer: string | null;
}) {
  const [offen, setOffen] = useState(false);
  const id = useId();
  const n = aktiv(filter);

  // Das Sheet schliesst mit Escape - ein Vollbild ohne Ausweg ist eine Falle.
  useEffect(() => {
    if (!offen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOffen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [offen]);

  const setze = (patch: Partial<BefehlFilter>) => onChange({ ...filter, ...patch });

  return (
    <div className="vp-bf">
      <div className="vp-bf-chips">
        {CHIPS.map((c) => {
          const an = Object.entries(c.patch).every(([k, v]) =>
            Array.isArray(v)
              ? v.every((x) => (filter[k as keyof BefehlFilter] as string[]).includes(x))
              : true,
          );
          return (
            <button
              key={c.id}
              type="button"
              className={`vp-bf-chip${an ? ' is-an' : ''}`}
              aria-pressed={an}
              onClick={() =>
                // Ein zweiter Klick NIMMT den Chip zurück - ein Filter, den man
                // nur setzen kann, ist eine Sackgasse.
                onChange(
                  an
                    ? { ...filter, ...leerenWie(c.patch) }
                    : { ...filter, ...c.patch },
                )
              }
            >
              {c.label}
            </button>
          );
        })}
        <button
          type="button"
          className={`vp-bf-more${n > 0 ? ' is-an' : ''}`}
          aria-expanded={offen}
          onClick={() => setOffen((v) => !v)}
        >
          <Icon name="settings" size={14} />
          {n > 0 ? `Filter · ${n} aktiv` : 'Filter'}
        </button>
        {n > 0 && (
          <button type="button" className="vp-bf-clear" onClick={() => onChange(zurueck(filter))}>
            Zurücksetzen
          </button>
        )}
      </div>

      {offen && (
        <>
          <div
            className="vp-bf-backdrop"
            role="presentation"
            onClick={() => setOffen(false)}
          />
          <div className="vp-bf-panel" role="group" aria-label="Filter">
            <div className="vp-bf-panel-head">
              <span>Filter</span>
              <button type="button" aria-label="Filter schliessen" onClick={() => setOffen(false)}>
                <Icon name="x" size={16} />
              </button>
            </div>

            <VpPicker
              className="vp-bf-field"
              label="Zeitraum"
              name="befehle-zeitraum"
              options={(Object.keys(ZEITRAUM_LABEL) as BefehlZeitraum[]).map((z) => ({
                value: z,
                label: ZEITRAUM_LABEL[z],
              }))}
              value={filter.zeitraum}
              onChange={(v) => setze({ zeitraum: v as BefehlZeitraum })}
            />
            {filter.zeitraum === 'eigen' && (
              <div className="vp-bf-range">
                <VpDatePicker
                  className="vp-bf-field"
                  label="Von"
                  name="befehle-von"
                  value={filter.von}
                  onChange={(v) => setze({ von: v || null })}
                />
                <VpDatePicker
                  className="vp-bf-field"
                  label="Bis"
                  name="befehle-bis"
                  value={filter.bis}
                  onChange={(v) => setze({ bis: v || null })}
                />
                {/* Die Aufbewahrung IST die Grenze - sie steht hier, damit sie
                    niemand erst als Server-Ablehnung erfährt. */}
                <p className="vp-note">Der Verlauf wird 90 Tage aufbewahrt.</p>
              </div>
            )}

            <Gruppe
              titel="Befehlsart"
              werte={STROEME}
              gewaehlt={filter.stroeme}
              onToggle={(v) => setze({ stroeme: umschalten(filter.stroeme, v) })}
            />
            <Gruppe
              titel="Herkunft"
              werte={HERKUENFTE}
              gewaehlt={filter.herkunft}
              onToggle={(v) => setze({ herkunft: umschalten(filter.herkunft, v) })}
            />
            <Gruppe
              titel="Ergebnis"
              werte={ERGEBNISSE}
              gewaehlt={filter.ergebnis}
              onToggle={(v) => setze({ ergebnis: umschalten(filter.ergebnis, v) })}
            />
          </div>
        </>
      )}

      <div className="vp-bf-search">
        <label className="vp-bf-searchbox" htmlFor={`${id}-q`}>
          <Icon name="search" size={15} />
          <input
            id={`${id}-q`}
            type="search"
            placeholder="Suchen (z. B. Adresse, Grund, Gerät)"
            value={filter.q}
            onChange={(e) => setze({ q: e.target.value })}
          />
        </label>
        <p className="vp-note">{hinweis}</p>
      </div>

      {treffer && <p className="vp-bf-treffer">{treffer}</p>}
    </div>
  );
}

/** Eine Mehrfach-Auswahl als Kästchen-Liste. */
function Gruppe({
  titel,
  werte,
  gewaehlt,
  onToggle,
}: {
  titel: string;
  werte: { wert: string; label: string }[];
  gewaehlt: string[];
  onToggle: (wert: string) => void;
}) {
  return (
    <fieldset className="vp-bf-group">
      <legend>{titel}</legend>
      {werte.map((w) => (
        <label key={w.wert}>
          <input
            type="checkbox"
            name={`${titel}-${w.wert}`}
            checked={gewaehlt.includes(w.wert)}
            onChange={() => onToggle(w.wert)}
          />
          {w.label}
        </label>
      ))}
    </fieldset>
  );
}

/** Die Gegen-Bewegung eines Schnell-Chips: genau seine Felder leeren. */
function leerenWie(patch: Partial<BefehlFilter>): Partial<BefehlFilter> {
  const out: Partial<BefehlFilter> = {};
  Object.keys(patch).forEach((k) => {
    (out as Record<string, unknown>)[k] = [];
  });
  return out;
}

/** „Zurücksetzen": alles ausser dem gewählten Gerät/der Komponente. */
function zurueck(f: BefehlFilter): BefehlFilter {
  return { ...f, zeitraum: 'heute', von: null, bis: null, stroeme: [], herkunft: [], ergebnis: [], q: '' };
}
