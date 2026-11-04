import { Badge } from '../../../designsystem/components/core/Badge';
import {
  boxVerbindung,
  type BoxErreichbarkeit,
  type BoxVerbindung,
  type VerbindungZaehlung,
} from '../../adminFleet';

/**
 * Die Online-Bausteine der Geräte-Reiter („Updates" und „Registrierung"):
 * Zählung, Schnellfilter und Zelle je Box. Beide Reiter rechnen nach DERSELBEN
 * Regel (`boxVerbindung`) und zeigen denselben Wortlaut wie die
 * Plattform-Übersicht - hier steht nur die Darstellung, nie eine zweite Regel.
 */

export type OnlineFilter = 'alle' | BoxErreichbarkeit;

export const ONLINE_FILTER: { id: OnlineFilter; label: string }[] = [
  { id: 'alle', label: 'Alle' },
  { id: 'online', label: 'Online' },
  { id: 'offline', label: 'Offline' },
  { id: 'nie', label: 'Nie gemeldet' },
];

/**
 * Online-Status je Box (Schlüssel = Geräte-Id) gegen den Abrufzeitpunkt des
 * Inventars - nie gegen eine Uhr über einem stehenden Schnappschuss. Wer nicht
 * in `boxen` steht, hat KEINEN Status (unbekannt ist nicht online).
 */
export function verbindungJeBox(
  boxen: Iterable<{ key: string; lastSeenAt: string | null | undefined }>,
  fetchedAt: number,
): Map<string, BoxVerbindung> {
  const now = new Date(fetchedAt);
  const map = new Map<string, BoxVerbindung>();
  for (const b of boxen) map.set(b.key, boxVerbindung(b.lastSeenAt, now));
  return map;
}

/** „4 online · 1 offline · 1 nie gemeldet", bei stehendem Takt mit Stand. */
export function OnlineZaehlung({ zaehlung, fetchedAt, refreshFailed }: {
  zaehlung: VerbindungZaehlung;
  fetchedAt: number;
  refreshFailed: boolean;
}) {
  return (
    <p className="vp-online-zaehlung" data-testid="online-zaehlung">
      <strong>{zaehlung.text}</strong>
      {refreshFailed && (
        <span className="vp-muted">
          {' '}· Stand {new Date(fetchedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })} Uhr,
          die Aktualisierung schlägt gerade fehl
        </span>
      )}
    </p>
  );
}

/** Schnellfilter Alle/Online/Offline/Nie gemeldet mit Anzahl je Knopf. */
export function OnlineFilterLeiste({ filter, onFilter, alle, zaehlung }: {
  filter: OnlineFilter;
  onFilter: (f: OnlineFilter) => void;
  /** Anzahl hinter „Alle" - alle Zeilen der Liste, nicht nur Boxen mit Status. */
  alle: number;
  zaehlung: VerbindungZaehlung;
}) {
  return (
    <div className="vp-box-filters" role="group" aria-label="Boxen nach Online-Status filtern">
      {ONLINE_FILTER.map((f) => (
        <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => onFilter(f.id)}>
          {f.label}<span>{f.id === 'alle' ? alle : zaehlung[f.id]}</span>
        </button>
      ))}
    </div>
  );
}

/** Inhalt der Spalte „Online-Status"; ohne Status ein ruhiger Strich. */
export function OnlineStatusZelle({ verbindung }: { verbindung: BoxVerbindung | null | undefined }) {
  if (!verbindung) return <span className="vp-muted">–</span>;
  return (
    <span className="vp-cell-main">
      <span><Badge variant={verbindung.tone} dot>{verbindung.text}</Badge></span>
      <span className="vp-cell-sub">
        Letzte Meldung: {verbindung.zustand === 'nie' ? 'noch nie' : verbindung.lastSeenText}
      </span>
    </span>
  );
}
