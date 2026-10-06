import type { Energieeinsatz, Messbedarf, MessstelleRegisterZeile } from './api';
import { UEMS_GEPLANTE_MESSSTELLE } from './glossar';
import { KEIN_ORT, type MessstellenEbene } from './messstellen';
import { ortKopf, ortReihenfolge, type Hinweis } from './messstellenListe';
import { groesseText } from './uemsMessplanung';
import { datumText } from './uemsOrtsbaum';

/**
 * DIE GEPLANTEN MESSSTELLEN (Konzept Auswerten a1, Entscheid 9 „Messplanung nach Messen“): ein offener Messbedarf ist
 * eine Messstelle, die noch fehlt. Die Liste „Messstellen“ zeigt ihn an seinem Ort, nach dessen Messstellen - mit dem
 * Energieeinsatz, für den er erfasst wurde, und seiner Frist -, bis jemand die Messstelle einrichtet; dann steht dort die
 * Messstelle selbst. Eingelöste und verworfene Bedarfe zeigt Messen nicht, sie bleiben am Energieeinsatz lesbar.
 *
 * Rein und deterministisch - kein React, kein Netz. Die Bedarfe kommen von `GET /api/v1/unternehmen/messbedarf` (am
 * Standort mit `?standort=`), der Ort aus `ort_ziel` (Struktur seit AP-16 P1). Ein Bedarf aus der Fassung davor hat nur
 * ein Kurzzeichen als Wortlaut: kennt das Register den Ort, steht er dort; sonst unter „Kein Ort zugeordnet“ - er
 * verschwindet nie.
 */

export const GEPLANT = 'Geplant';
export const EINRICHTEN = 'Einrichten';
export const NOCH_NICHT_EINGERICHTET = 'Noch nicht eingerichtet';

/** Der Eintrag im Menü ⋯ der Liste („Messbedarf erfassen“) sagt, wozu er dient. */
export const ERFASSEN_HINWEIS = 'Eine Messstelle planen, die noch fehlt';
export const PLAN_FEHLER = 'Die geplanten Messstellen ließen sich gerade nicht laden.';

/** „1 geplant“ - an der Marke und im Kopf eines Orts. */
export const geplantZahl = (n: number): string => `${n} geplant`;

/** „1 geplante Messstelle“ · „2 geplante Messstellen“ - der Treffersatz, solange die Marke „geplant“ filtert. */
export const geplanteSatz = (n: number): string => `${n} ${n === 1 ? UEMS_GEPLANTE_MESSSTELLE : `${UEMS_GEPLANTE_MESSSTELLE}n`}`;

export interface GeplanteReihe {
  /** Die ID des Messbedarfs. */
  id: string;
  /** „MB-1“ */
  kennzeichen: string;
  /** Der Wortlaut des Bedarfs - er ist der Name, bis die Messstelle einen eigenen hat. */
  name: string;
  /**
   * Der Ort der Liste: derselbe Schlüssel wie die Gruppe der Messstellen dort (`ortKopf`); `ordnung` stellt einen Ort,
   * an dem bisher nur geplant ist, in die Reihenfolge des Ortsbaums (`ortReihenfolge`).
   */
  ort: { key: string; titel: string; standort: string | null; standortId: string | null; ordnung: string };
  /** Der Energieeinsatz, für den der Bedarf erfasst wurde („EE-8 Gebäudetechnik Halle 1“); `null`, wenn er nicht sichtbar ist. */
  einsatz: { id: string; text: string } | null;
  /** Die Frist („Frist 31.03.2027“) - überschritten, wenn sie vor dem Tag der Antwort liegt; ohne Frist `null`. */
  frist: { tag: string; text: string; ueberschritten: boolean } | null;
  /** Ab 760 px unter dem Namen: die Größe („Wirkenergie · Bezug“) und ein Ort, den das Register nicht kennt. */
  unter: string | null;
  bedarf: Messbedarf;
}

const nr = (kennzeichen: string) => Number(kennzeichen.replace(/^MB-/, '')) || 0;

/** Der Ort eines Bedarfs als Gruppe der Liste: aus `ort_ziel`, sonst das Kurzzeichen des Wortlauts im Register. */
function ortDes(
  b: Messbedarf,
  register: readonly MessstelleRegisterZeile[],
  ebene: MessstellenEbene,
): { ort: GeplanteReihe['ort']; unbekannt: string | null } {
  const z = b.ort_ziel;
  if (z) {
    const amStandort = z.art === 'standort';
    // Steht am Ort schon eine Messstelle, gilt ihr Platz; sonst nach dem Standort (dessen Kurzzeichen kennt das Register).
    const da = register.find((r) => r.ort.grund === 'verortet' && r.ort.id === z.id);
    const standortKz = register.find((r) => r.ort.standort_id !== null && r.ort.standort_id === z.standort_id)?.ort.standort ?? '~';
    return {
      ort: {
        key: z.id,
        titel: amStandort ? (z.standort_name ?? z.name ?? z.kurzzeichen) : (z.name ?? z.kurzzeichen),
        standort: ebene.art === 'unternehmen' && !amStandort ? z.standort_name : null,
        standortId: z.standort_id,
        ordnung: da ? ortReihenfolge(da) : amStandort ? `1/${z.kurzzeichen}` : `1/${standortKz}/${z.kurzzeichen}`,
      },
      unbekannt: null,
    };
  }
  const zeile = b.ort ? register.find((r) => r.ort.grund === 'verortet' && r.ort.kennzeichen === b.ort) : undefined;
  if (zeile) {
    const k = ortKopf(zeile, ebene);
    return {
      ort: { key: k.key, titel: k.titel, standort: k.standort, standortId: zeile.ort.standort_id, ordnung: ortReihenfolge(zeile) },
      unbekannt: null,
    };
  }
  return { ort: { key: 'ohne-ort', titel: KEIN_ORT, standort: null, standortId: null, ordnung: '3' }, unbekannt: b.ort };
}

/**
 * Die geplanten Messstellen: je OFFENER Bedarf eine Reihe, nach Kennzeichen. `heute` ist der Tag der Antwort des
 * Registers (`JJJJ-MM-TT`, die Uhr des Servers) - an ihm gemessen ist eine Frist überschritten.
 */
export function geplanteAus(
  bedarfe: readonly Messbedarf[],
  i: { register: readonly MessstelleRegisterZeile[]; einsaetze: readonly Energieeinsatz[]; ebene: MessstellenEbene; heute: string },
): GeplanteReihe[] {
  return bedarfe
    .filter((b) => b.zustand === 'offen')
    .sort((a, b) => nr(a.kennzeichen) - nr(b.kennzeichen))
    .map((b) => {
      const { ort, unbekannt } = ortDes(b, i.register, i.ebene);
      const e = i.einsaetze.find((x) => x.id === b.energieeinsatz_id);
      const ueberschritten = b.frist !== null && b.frist < i.heute;
      return {
        id: b.id,
        kennzeichen: b.kennzeichen,
        name: b.wortlaut,
        ort,
        einsatz: e ? { id: e.id, text: `${e.kennzeichen} ${e.name}` } : null,
        frist: b.frist
          ? { tag: b.frist, text: `Frist ${datumText(b.frist)}${ueberschritten ? ' überschritten' : ''}`, ueberschritten }
          : null,
        unter: [groesseText(b), unbekannt ? `Ort „${unbekannt}“` : null].filter(Boolean).join(' · ') || null,
        bedarf: b,
      };
    });
}

/**
 * Die Hinweiskarte, wenn eine Frist überschritten ist - wie eine überfällige Ablesung: „Lüftung … (MB-1) ist noch nicht
 * eingerichtet“, darunter „Frist seit 31.03.2027 überschritten · Halle 1“; sie filtert auf die Marke „geplant“. Eine
 * Frist, die noch läuft, ist kein Handlungsbedarf der Liste (die Wiedervorlage nennt sie).
 */
export function geplantHinweis(geplante: readonly GeplanteReihe[]): Hinweis | null {
  const ueber = geplante.filter((g) => g.frist?.ueberschritten);
  if (ueber.length === 0) return null;
  const frueheste = ueber.map((g) => g.frist!.tag).sort()[0];
  const orte = [...new Set(ueber.map((g) => g.ort.titel))];
  const ortText = orte.length <= 1 ? (orte[0] ?? '') : `${orte.slice(0, -1).join(', ')} und ${orte[orte.length - 1]}`;
  return {
    titel:
      ueber.length === 1
        ? `${ueber[0].name} (${ueber[0].kennzeichen}) ist noch nicht eingerichtet`
        : `${geplanteSatz(ueber.length)} sind noch nicht eingerichtet`,
    satz: [`Frist seit ${datumText(frueheste)} überschritten`, ortText].filter(Boolean).join(' · '),
    ton: 'warn',
    marke: 'geplant',
    schritt: 'Ansehen',
  };
}

/** Nach „Einrichten“: „Messbedarf MB-1 ist eingelöst - MS-24 Halle 1 Allgemein steht jetzt in der Liste.“ */
export function eingeloestSatz(b: Messbedarf): string {
  const m = b.messstelle ? `${b.messstelle.kennzeichen}${b.messstelle.name ? ` ${b.messstelle.name}` : ''}` : 'die Messstelle';
  return `Messbedarf ${b.kennzeichen} ist eingelöst - ${m} steht jetzt in der Liste.`;
}

/**
 * Lehnt der Server das Einlösen ab, ist die Messstelle schon eingerichtet (der Dialog speichert Schritt für Schritt):
 * der Satz der Ablehnung und, was jetzt gilt - „Die Messstelle MS-24 ist trotzdem eingerichtet und steht in der Liste;
 * MB-1 bleibt geplant.“
 */
export const einloesenAbgelehntSatz = (satz: string, messstelle: string, bedarf: string): string =>
  `${satz} Die Messstelle ${messstelle} ist trotzdem eingerichtet und steht in der Liste; ${bedarf} bleibt geplant.`;

/**
 * Nach „Messbedarf erfassen“: steht er in dieser Liste (am Unternehmen immer, am Standort mit einem Ort dort), sagt der
 * Satz das; sonst, wo er zu finden ist - ein Bedarf ohne Ort hängt an keinem Standort.
 */
export function erfasstSatz(b: Messbedarf, ebene: MessstellenEbene): string {
  const hier = ebene.art === 'unternehmen' || b.ort_ziel?.standort_id === ebene.id;
  return hier
    ? `Messbedarf ${b.kennzeichen} ist erfasst und steht als ${UEMS_GEPLANTE_MESSSTELLE} in der Liste.`
    : `Messbedarf ${b.kennzeichen} ist erfasst; er hat keinen Ort an diesem Standort und steht in der Liste des Unternehmens.`;
}
