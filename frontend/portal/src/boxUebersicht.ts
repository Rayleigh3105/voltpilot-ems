import {
  deviceLiveStatus,
  type Device,
  type EdgeVersion,
  type UemsDatenquelle,
} from './api';
import { fmtRelative } from './format';
import { faehigkeiten, fehlerklasse, type TabellenEintrag } from './uemsDatenquelle';

const ANFRAGEN_GRENZE = 30;
const MESSWERTE_GRENZE = 600;

/** Runtime copy of the reviewed capability table; its vector test pins names and order. */
export const BOX_FAEHIGKEITEN: TabellenEintrag[] = [
  { code: 'data_sources', name: 'Rückmeldung je Datenquelle', ab_release: null },
  { code: 'assignment_effective_at', name: 'Zuständigkeit ab Zeitpunkt', ab_release: null },
];

export interface BoxQuelleZeile {
  id: string;
  kennzeichen: string;
  name: string;
  zustand: string;
  fehlerklasse: string | null;
  seit: string | null;
  budget: string;
  ton: 'ok' | 'warn' | 'off';
}

export interface BoxUebersichtKarte {
  id: string;
  siteId: string;
  ref: string;
  name: string;
  verbindung: string;
  verbindungDetail: string | null;
  verbindungTon: 'ok' | 'warn' | 'off';
  rolle: string;
  quellen: BoxQuelleZeile[];
  quellenSatz: string;
  budgetSumme: string | null;
  software: string;
  faehigkeiten: string;
  updateNoetig: boolean;
}

const zahl = (wert: number) => wert.toLocaleString('de-DE', { maximumFractionDigits: 1 });

function zeitpunkt(iso: string | null | undefined): string | null {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function budgetAnteil(q: UemsDatenquelle): string {
  const r = q.rueckmeldung;
  const anfragen = r?.anfragen_pro_minute;
  const messwerte = r?.messwerte_pro_minute;
  if (anfragen == null && messwerte == null) return 'Budget-Anteil nicht gemeldet';
  const anteil = Math.max(
    anfragen == null ? 0 : anfragen / ANFRAGEN_GRENZE,
    messwerte == null ? 0 : messwerte / MESSWERTE_GRENZE,
  ) * 100;
  const teile = [
    anfragen == null ? null : `${zahl(anfragen)} von ${ANFRAGEN_GRENZE} Anfragen/min`,
    messwerte == null ? null : `${zahl(messwerte)} von ${MESSWERTE_GRENZE} Messwerten/min`,
  ].filter((s): s is string => s !== null);
  return `Budget-Anteil ${zahl(anteil)} % · ${teile.join(' · ')}`;
}

export function quellZeile(q: UemsDatenquelle): BoxQuelleZeile {
  const r = q.rueckmeldung;
  const name = q.name?.trim() || q.kennzeichen;
  if (!r || r.zustand === 'meldet_noch_nicht_je_quelle') {
    return {
      id: q.id, kennzeichen: q.kennzeichen, name,
      zustand: 'Box meldet noch nicht je Quelle', fehlerklasse: null, seit: null,
      budget: budgetAnteil(q), ton: 'off',
    };
  }
  if (r.zustand === 'liefert') {
    return {
      id: q.id, kennzeichen: q.kennzeichen, name,
      zustand: 'Liefert Daten', fehlerklasse: null,
      seit: r.gelesen_am ? `Zuletzt gelesen ${zeitpunkt(r.gelesen_am)}` : null,
      budget: budgetAnteil(q), ton: 'ok',
    };
  }
  const klasse = r.fehlerklasse ? fehlerklasse(r.fehlerklasse, 'box') : null;
  return {
    id: q.id, kennzeichen: q.kennzeichen, name,
    zustand: 'Liefert keine Daten',
    fehlerklasse: klasse?.name ?? null,
    seit: r.seit ? `Seit ${zeitpunkt(r.seit)}` : null,
    budget: budgetAnteil(q), ton: 'warn',
  };
}

function faehigkeitenText(edge: EdgeVersion | undefined): { text: string; update: boolean } {
  const stand = edge?.coreVersion?.trim() || null;
  const f = faehigkeiten(
    { version: stand, release: null, supports: null },
    BOX_FAEHIGKEITEN,
    [],
  );
  return { text: f.text, update: f.faehigkeiten.some((x) => x.status === 'fehlt') };
}

export function boxUebersicht(
  devices: readonly Device[],
  versionen: readonly EdgeVersion[],
  quellen: readonly UemsDatenquelle[],
  anlagenNamen: ReadonlyMap<string, string>,
  jetzt = new Date(),
): BoxUebersichtKarte[] {
  const version = new Map(versionen.map((v) => [v.deviceId, v]));
  return devices.map((d): BoxUebersichtKarte => {
    const qs = quellen.filter((q) => q.zustaendige_box?.id === d.id).map(quellZeile);
    const status = deviceLiveStatus(d, jetzt);
    const f = faehigkeitenText(version.get(d.id));
    const anlage = anlagenNamen.get(d.siteId) ?? 'diese Anlage';
    const summe = qs.length === 0 ? null : quellen
      .filter((q) => q.zustaendige_box?.id === d.id)
      .reduce((n, q) => n + (q.rueckmeldung?.anfragen_pro_minute ?? 0), 0);
    return {
      id: d.id,
      siteId: d.siteId,
      ref: d.externalRef,
      name: d.name?.trim() || d.externalRef,
      verbindung: status === 'online' ? 'Verbunden' : status === 'stale' ? 'Meldet sich nicht' : 'Wartet auf erste Meldung',
      verbindungDetail: d.lastSeenAt ? `Letzte Meldung ${fmtRelative(d.lastSeenAt, jetzt)}` : null,
      verbindungTon: status === 'online' ? 'ok' : status === 'stale' ? 'warn' : 'off',
      rolle: d.fuehrtAnlage === true ? `Führt ${anlage}` : `Führt ${anlage} nicht`,
      quellen: qs,
      quellenSatz: qs.length === 0 ? 'Liest noch keine Datenquelle' : `Liest ${qs.length} ${qs.length === 1 ? 'Datenquelle' : 'Datenquellen'}`,
      budgetSumme: summe && summe > 0 ? `Zusammen ${zahl(summe)} von ${ANFRAGEN_GRENZE} Anfragen/min` : null,
      software: version.get(d.id)?.coreVersion ? `Software ${version.get(d.id)!.coreVersion}` : 'Software-Stand unbekannt',
      faehigkeiten: f.text,
      updateNoetig: f.update,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
