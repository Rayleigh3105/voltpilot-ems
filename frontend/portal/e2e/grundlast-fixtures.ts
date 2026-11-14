/**
 * Gestellte Antworten der Route `GET /api/v1/sites/{id}/grundlast` für die Bühnen (Bedienkonzept Privatkunde §5):
 * dieselbe Form wie der Server (`GrundlastDto`), die Zahlen fiktiv in der Größenordnung des Labors (220–640 W).
 * Fälle über `?grundlast=`: `voll` (Vorgabe), `luecke` (zwei Nächte ohne Messwerte), `wenig` (erst zwei Nächte
 * gemessen), `stufe` (im Monat ab dem 17. eine Stufe), `nie` (Hausverbrauch nie gemessen: weder Karte noch Kachel).
 */
import type { Grundlast, GrundlastZeitraum } from '../src/api';

export type GrundlastFall = 'voll' | 'luecke' | 'wenig' | 'stufe' | 'nie';

export interface GrundlastBuehne {
  /** „Heute“ der Bühne (JJJJ-MM-TT): Nächte danach sind offen. */
  heute: string;
  /** Die typische Nacht der Anlage in Watt. */
  basisW: number;
  /** Unterzähler an der Wurzel mit ihrem Anteil an der Nacht (der Rest ist „übriger Haushalt“). */
  teile?: { entityId: string; label: string; anteil: number }[];
  fall?: GrundlastFall;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const datum = (s: string) => {
  const [j, m, t] = s.split('-').map(Number);
  return new Date(j, m - 1, t);
};
const plus = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function fenster(z: GrundlastZeitraum, at: Date, heute: Date): [Date, Date] {
  switch (z) {
    case 'tag':
      return [at, plus(at, 1)];
    case 'woche': {
      const mo = plus(at, -((at.getDay() + 6) % 7));
      return [mo, plus(mo, 7)];
    }
    case 'monat':
      return [new Date(at.getFullYear(), at.getMonth(), 1), new Date(at.getFullYear(), at.getMonth() + 1, 1)];
    case 'jahr':
      return [new Date(at.getFullYear(), 0, 1), new Date(at.getFullYear() + 1, 0, 1)];
    default:
      return [plus(heute, -13), plus(heute, 1)];
  }
}

const median = (w: number[]) => {
  const s = [...w].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? null : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Der Wert einer Nacht: die Basis mit leiser, fester Schwankung (und der Stufe ab dem 17.). */
function nachtW(b: GrundlastBuehne, d: Date): number {
  const wackel = [0, 10, -10, 5, -5, 15, -15][d.getDate() % 7];
  const winter = [1.15, 1.12, 1.08, 1.02, 0.98, 0.95, 0.9, 0.93, 0.97, 1.04, 1.12, 1.16][d.getMonth()];
  const stufe = b.fall === 'stufe' && d.getDate() >= 17 ? 60 : 0;
  return Math.round(b.basisW * winter + wackel + stufe);
}

export function grundlastAntwort(b: GrundlastBuehne, z: GrundlastZeitraum, atIso?: string): Grundlast {
  const fall = b.fall ?? 'voll';
  const heute = datum(b.heute);
  const at = atIso ? datum(atIso) : heute;
  const [von, bis] = fenster(z, at, heute);
  const messbeginn = fall === 'wenig' ? plus(heute, -1) : new Date(2020, 0, 1);
  // Bei `luecke` fehlen die dritte und vierte Nacht des Zeitraums (in der Kachel zwei der letzten Nächte).
  const lueckeAb = z === 'aktuell' ? plus(heute, -9) : plus(von, 2);

  const nacht = (d: Date) => {
    if (d > heute) return { datum: iso(d), status: 'offen' as const, w: null };
    if (d < messbeginn) return { datum: iso(d), status: 'vorher' as const, w: null };
    if (fall === 'luecke' && (iso(d) === iso(lueckeAb) || iso(d) === iso(plus(lueckeAb, 1))))
      return { datum: iso(d), status: 'luecke' as const, w: null };
    return { datum: iso(d), status: 'gewertet' as const, w: nachtW(b, d) };
  };
  const naechte = [];
  for (let d = von; d < bis; d = plus(d, 1)) naechte.push(nacht(d));
  const gew = naechte.filter((n) => n.status === 'gewertet').map((n) => n.w as number);
  const mindestens = z === 'tag' ? 1 : 3;
  const typischRoh = gew.length >= mindestens ? median(gew) : null;
  const typischW = typischRoh == null ? null : Math.round(typischRoh);

  const vor = (() => {
    if (fall === 'wenig') return null;
    const [vv, vb] =
      z === 'aktuell'
        ? [new Date(von.getFullYear(), von.getMonth() - 1, von.getDate()), new Date(bis.getFullYear(), bis.getMonth() - 1, bis.getDate())]
        : z === 'tag'
          ? [plus(von, -1), von]
          : z === 'woche'
            ? [plus(von, -7), von]
            : z === 'monat'
              ? [new Date(von.getFullYear(), von.getMonth() - 1, 1), von]
              : [new Date(von.getFullYear() - 1, 0, 1), von];
    const w: number[] = [];
    for (let d = vv; d < vb; d = plus(d, 1)) w.push(nachtW({ ...b, fall: 'voll' }, d) - 40);
    const m = median(w);
    return m == null ? null : Math.round(m);
  })();

  const monate =
    z === 'jahr'
      ? Array.from({ length: 12 }, (_, i) => {
        const ns = naechte.filter((n) => datum(n.datum).getMonth() === i);
        const g = ns.filter((n) => n.status === 'gewertet').map((n) => n.w as number);
        const m = g.length >= 7 ? median(g) : null;
        return { monat: `${von.getFullYear()}-${String(i + 1).padStart(2, '0')}`, w: m == null ? null : Math.round(m), gewertet: g.length };
      })
      : [];

  const teile =
    typischW == null || !b.teile
      ? []
      : b.teile.map((t) => ({ entityId: t.entityId, label: t.label, typLabel: 'Unterzähler', unterzaehler: true, w: Math.round(typischW * t.anteil) }));
  const rest = teile.length === 0 || typischW == null ? null : { w: Math.max(0, typischW - teile.reduce((s, t) => s + t.w, 0)), grund: null };

  return {
    z,
    von: iso(von),
    bis: iso(plus(bis, -1)),
    hausverbrauchGemessen: fall !== 'nie',
    typischW,
    gewertet: gew.length,
    mindestens,
    luecken: naechte.filter((n) => n.status === 'luecke').length,
    naechte: z === 'jahr' ? [] : naechte,
    monate,
    kwhAmTag: typischW == null ? null : Math.round(typischW * 24) / 1000,
    anteil: typischW == null ? null : Math.min(0.9, (typischW * 24) / 1000 / 29.4),
    vorperiodeW: vor,
    stufe: fall === 'stufe' && z === 'monat' && gew.length >= 20
      ? { seit: iso(new Date(von.getFullYear(), von.getMonth(), 17)), vorherW: Math.round(median(gew.slice(0, 16)) ?? 0), nachherW: Math.round(median(gew.slice(16)) ?? 0) }
      : null,
    teile,
    rest,
  };
}
