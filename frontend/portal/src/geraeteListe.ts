/**
 * Die GERÄTE-LISTE (Konzept `vp-adminview-konzept-k1` §4.4, Scheibe S2): eine
 * Zeile je Box in JEDEM Lebensabschnitt - gedruckt, meldet sich (wartet auf
 * Zuordnung), Werkstatt, beim Kunden. Sie ersetzt die Registrierung und die
 * Boxenliste von „Plattform › Software".
 *
 * Reine Ableitung: eine verbundene Box bekommt ihre Zeile unverändert aus
 * `geraeteUpdates.boxZeile` (dieselbe Wahrheit wie die Software-Seite - kein
 * zweites Urteil über denselben Fakt). Die anderen drei Lebensabschnitte
 * haben kein Fakten-Urteil (noch keine Box, die etwas melden könnte) und
 * bekommen nur einen einordnenden Satz.
 *
 * „Ausgebaut" fehlt bewusst: ohne ein Signal dafür (keine neue Schnittstelle
 * in dieser Scheibe) ließe sich die Stufe nicht von „noch nie verbunden"
 * unterscheiden, und eine erfundene Stufe wäre schlimmer als keine. Die Stufe
 * „verzögert" (E6) ist S7, nicht hier - der Chip fehlt deshalb ebenfalls.
 */
import type { AdminDeviceRow, PendingEnrollment } from './admin/adminApi';
import type { BoxArt, FleetRow } from './adminEdgeUpdates';
import { BOX_ART_LABELS, BOX_ART_UNBEKANNT } from './adminEdgeUpdates';
import { boxZeile, LINIEN, type BoxZeile } from './geraeteUpdates';
import { pendingRows } from './onboardingFunnel';
import type { WerkstattBox } from './werkstatt';

export type Lebensabschnitt = 'gedruckt' | 'wartet' | 'werkstatt' | 'verbunden';

/** Eine Zeile ohne eigene Box-Meldung (gedruckt/wartet/werkstatt) - kein Urteil, nur ein Satz. */
export interface RohZeile {
  lebensabschnitt: 'gedruckt' | 'wartet' | 'werkstatt';
  ref: string;
  name: string;
  hinweis: string;
  seit: string | null;
  suspect: boolean;
  suchtext: string;
}

export type GeraeteListeZeile =
  | { lebensabschnitt: 'verbunden'; zeile: BoxZeile }
  | RohZeile;

const key = (z: GeraeteListeZeile): string => (z.lebensabschnitt === 'verbunden' ? z.zeile.ref : z.ref);

/**
 * Alle Zeilen, aus dem, was die Seite ohnehin lädt (`/admin/edge-updates`,
 * `/admin/devices`, `/admin/enrollments/pending`, `/admin/werkstatt/boxen`).
 * Jede Referenz steht GENAU EINMAL - die Rangfolge löst eine Überschneidung
 * auf (verbunden vor wartet vor Werkstatt vor gedruckt).
 */
export function geraeteListeZeilen(args: {
  fleet: readonly FleetRow[];
  devices: readonly AdminDeviceRow[];
  pending: readonly PendingEnrollment[];
  werkstattBoxen: readonly WerkstattBox[];
}, now: Date): GeraeteListeZeile[] {
  const { fleet, devices, pending, werkstattBoxen } = args;
  const verbunden = new Set(fleet.map((r) => r.externalRef));
  const rows: GeraeteListeZeile[] = fleet.map((r) => ({ lebensabschnitt: 'verbunden', zeile: boxZeile(r, now) }));

  const wartend = new Set<string>();
  for (const p of pendingRows(pending.filter((p) => !verbunden.has(p.externalRef)), now)) {
    wartend.add(p.externalRef);
    rows.push({
      lebensabschnitt: 'wartet',
      ref: p.externalRef,
      name: p.externalRef,
      hinweis: p.hint,
      seit: p.csrUpdatedAt,
      suspect: p.suspect,
      suchtext: [p.externalRef, p.deviceInfo].filter(Boolean).join(' ').toLocaleLowerCase('de'),
    });
  }

  const werkstattRef = new Set<string>();
  for (const b of werkstattBoxen) {
    if (verbunden.has(b.edgeRef) || wartend.has(b.edgeRef)) continue;
    werkstattRef.add(b.edgeRef);
    const geraet = b.boxArt === 'edge-light' ? 'Mango' : 'Docker-Box';
    rows.push({
      lebensabschnitt: 'werkstatt',
      ref: b.edgeRef,
      name: `${geraet} · ${b.edgeRef}`,
      hinweis: b.abnahmen[0] ? 'Abgenommen, wartet auf Kopplung' : 'In Einrichtung',
      seit: b.angelegtAm,
      suspect: false,
      suchtext: [b.edgeRef, geraet, b.notiz].filter(Boolean).join(' ').toLocaleLowerCase('de'),
    });
  }

  for (const d of devices) {
    if (d.deviceId != null) continue; // schon als „verbunden" erfasst
    if (verbunden.has(d.externalRef) || wartend.has(d.externalRef) || werkstattRef.has(d.externalRef)) continue;
    rows.push({
      lebensabschnitt: 'gedruckt',
      ref: d.externalRef,
      name: d.label ?? d.externalRef,
      hinweis: 'Gedruckt, noch nicht verbunden',
      seit: d.provisionedAt,
      suspect: false,
      suchtext: [d.externalRef, d.label, d.note].filter(Boolean).join(' ').toLocaleLowerCase('de'),
    });
  }

  return rows.sort((a, b) => {
    const ra = RANG[a.lebensabschnitt];
    const rb = RANG[b.lebensabschnitt];
    if (ra !== rb) return ra - rb;
    if (a.lebensabschnitt === 'verbunden' && b.lebensabschnitt === 'verbunden') {
      if (a.zeile.brauchtDich !== b.zeile.brauchtDich) return a.zeile.brauchtDich ? -1 : 1;
      return a.zeile.name.localeCompare(b.zeile.name, 'de');
    }
    return key(a).localeCompare(key(b), 'de');
  });
}

const RANG: Record<Lebensabschnitt, number> = { verbunden: 0, wartet: 1, werkstatt: 2, gedruckt: 3 };

// ── Filter ──────────────────────────────────────────────────────────────────

export type ListeChip =
  | 'braucht' | 'offline' | 'lauf' | 'aelter'
  | 'gedruckt' | 'ohne_kunde' | 'werkstatt';

export interface ListeFilter {
  chip: ListeChip | null;
  linie: BoxArt | 'alle' | 'unbekannt';
  suche: string;
}

export const LEERER_LISTE_FILTER: ListeFilter = { chip: null, linie: 'alle', suche: '' };

const chipPasst = (z: GeraeteListeZeile, chip: ListeChip): boolean => {
  switch (chip) {
    case 'braucht': return z.lebensabschnitt === 'verbunden' && z.zeile.brauchtDich;
    case 'offline': return z.lebensabschnitt === 'verbunden' && z.zeile.offline;
    case 'lauf': return z.lebensabschnitt === 'verbunden' && z.zeile.laeuftUpdate;
    case 'aelter': return z.lebensabschnitt === 'verbunden' && z.zeile.aelter;
    case 'gedruckt': return z.lebensabschnitt === 'gedruckt';
    case 'werkstatt': return z.lebensabschnitt === 'werkstatt';
    case 'ohne_kunde': return z.lebensabschnitt === 'gedruckt' || z.lebensabschnitt === 'wartet';
    default: return false;
  }
};

const linieVon = (z: GeraeteListeZeile): BoxArt | null => (z.lebensabschnitt === 'verbunden' ? z.zeile.linie : null);
const suchtextVon = (z: GeraeteListeZeile): string => (z.lebensabschnitt === 'verbunden' ? z.zeile.suchtext : z.suchtext);

export interface ListeChipZahl { chip: ListeChip; label: string; n: number }

/** Die Zähl-Chips der Filterleiste, nur mit Zahl > 0 (ein leerer Chip wäre eine Sackgasse). */
export function listeChipZahlen(zeilen: GeraeteListeZeile[]): ListeChipZahl[] {
  const LABEL: Record<ListeChip, string> = {
    braucht: 'Braucht dich', offline: 'Offline', lauf: 'Update läuft', aelter: 'Älter',
    gedruckt: 'Gedruckt', ohne_kunde: 'Ohne Kunde', werkstatt: 'Werkstatt',
  };
  return (Object.keys(LABEL) as ListeChip[])
    .map((chip) => ({ chip, label: LABEL[chip], n: zeilen.filter((z) => chipPasst(z, chip)).length }))
    .filter((c) => c.n > 0);
}

export function geraeteListeLinien(zeilen: GeraeteListeZeile[]): { wert: BoxArt | 'alle' | 'unbekannt'; label: string; n: number }[] {
  const verbunden = zeilen.filter((z) => z.lebensabschnitt === 'verbunden');
  const out: { wert: BoxArt | 'alle' | 'unbekannt'; label: string; n: number }[] = [
    { wert: 'alle', label: 'Alle', n: zeilen.length },
    ...LINIEN.map((l) => ({ wert: l, label: BOX_ART_LABELS[l], n: verbunden.filter((z) => linieVon(z) === l).length })),
  ];
  const unbekannt = zeilen.length - verbunden.filter((z) => linieVon(z) != null).length;
  if (unbekannt > 0) out.push({ wert: 'unbekannt', label: BOX_ART_UNBEKANNT, n: unbekannt });
  return out;
}

export function filterGeraeteListe(zeilen: GeraeteListeZeile[], f: ListeFilter): GeraeteListeZeile[] {
  const q = f.suche.trim().toLocaleLowerCase('de');
  return zeilen.filter((z) =>
    (f.linie === 'alle' || (f.linie === 'unbekannt' ? linieVon(z) == null : linieVon(z) === f.linie))
    && (f.chip == null || chipPasst(z, f.chip))
    && (!q || suchtextVon(z).includes(q)));
}
