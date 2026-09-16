/** AP-10 IP-13: reine Anzeige und Dialogprüfung; die Fachregeln bleiben im Vertragszwilling. */
import {
  ApiError,
  type Netzanschluss,
  type NetzanschlussAnfrage,
  type NetzanschlussBindung,
  type StandortAnlage,
} from './api';
import { dez, dezText, type Dez } from './bezugsdaten';
import { bindung, felder, kennzeichen, kopfzeile, type Bindung } from './uemsNetzanschluss';
import { UEMS_NETZANSCHLUSS } from './glossar';
import { datumVon } from './picker/datum';
import { datumText } from './uemsOrtsbaum';

export const TITEL = 'Netzanschlüsse';
export const ANLEGEN = `${UEMS_NETZANSCHLUSS} anlegen`;
export const RECHT = 'netzanschluss.verwalten';
export const NICHT_ABRUFBAR = 'Die Netzanschlüsse konnten nicht geladen werden.';
export const HINWEIS_LEISTUNG = 'Die vereinbarte Leistung liegt über der Anschlussleistung.';
export const tagText = datumText;
export const giltAm = (b: { gueltig_ab: string | null; gueltig_bis: string | null }, am: string) =>
  (!b.gueltig_ab || b.gueltig_ab <= am) && (!b.gueltig_bis || am <= b.gueltig_bis);
export const anschlussDerAnlage = (liste: Netzanschluss[], anlage: string, am: string) =>
  liste.find((n) => giltAm(n, am) && n.anlagen.some((b) => b.anlage.id === anlage && giltAm(b, am))) ?? null;

/** EINE Formatierstelle für Liste und Bilanz: hier hängt das Paket „vereinbarte Werte“ ein. */
export function leistung(n: Netzanschluss): string {
  return kopfzeile(
    n.kennzeichen,
    n.vereinbart_kw === null ? null : dez(String(n.vereinbart_kw)),
    n.anschluss_kva === null ? null : dez(String(n.anschluss_kva)),
    null,
  ).text;
}
export const bindungsText = (b: NetzanschlussBindung) =>
  `${b.anlage.name ?? 'Anlage entfernt'} · ab ${datumText(b.gueltig_ab)}${b.gueltig_bis ? ` bis ${datumText(b.gueltig_bis)}` : ''}`;
export function bilanzKopf(liste: Netzanschluss[], anlage: string, am: string): string {
  const n = anschlussDerAnlage(liste, anlage, am);
  return anschlussText(n);
}
export function anschlussText(n: Netzanschluss | null): string {
  return n
    ? [`Netzanschluss ${n.kennzeichen}`, n.name, n.malo ? `MaLo ${n.malo}` : null, n.netzbetreiber, leistung(n)]
        .filter(Boolean)
        .join(' · ')
    : 'Netzanschluss: nicht angelegt';
}

export interface Entwurf {
  kennzeichen: string;
  name: string;
  malo: string;
  netzbetreiber: string;
  anschluss_kva: string;
  vereinbart_kw: string;
  messung: 'RLM' | 'SLP';
}
export type Feld = keyof Entwurf;
export const neuerEntwurf = (vorschlag: string): Entwurf => ({
  kennzeichen: vorschlag,
  name: '',
  malo: '',
  netzbetreiber: '',
  anschluss_kva: '',
  vereinbart_kw: '',
  messung: 'RLM',
});
/** Deutsche Eingabe, ohne stilles Runden oder Teillesen. */
const betrag = (s: string): Dez | null => {
  const text = s.trim();
  if (!text) return null;
  if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/.test(text)) throw new Error('Ungültige Zahl');
  return dez(text.replace(/\./g, '').replace(',', '.'));
};
export function pruefen(e: Entwurf, standort: string): Partial<Record<Feld, string>> {
  const f: Partial<Record<Feld, string>> = {};
  if (!kennzeichen(e.kennzeichen.trim() || null, [], 1).gueltig)
    f.kennzeichen = 'Bitte ein gültiges Kennzeichen eingeben.';
  let kva: Dez | null = null,
    kw: Dez | null = null;
  try {
    kva = betrag(e.anschluss_kva);
  } catch {
    f.anschluss_kva = 'Bitte eine positive Zahl eingeben.';
  }
  try {
    kw = betrag(e.vereinbart_kw);
  } catch {
    f.vereinbart_kw = 'Bitte eine positive Zahl eingeben.';
  }
  const u = felder({
    ...e,
    name: e.name.trim(),
    standort,
    malo: e.malo.trim() || null,
    anschluss_kva: kva,
    vereinbart_kw: kw,
  });
  if (u.feld)
    f[u.feld as Feld] =
      u.feld === 'malo'
        ? 'Die Marktlokation braucht elf Ziffern.'
        : u.feld === 'name'
          ? 'Bitte einen Namen eingeben.'
          : 'Bitte eine gültige Angabe eingeben.';
  return f;
}
export function anfrage(e: Entwurf): NetzanschlussAnfrage {
  const kva = betrag(e.anschluss_kva),
    kw = betrag(e.vereinbart_kw);
  return {
    ...e,
    kennzeichen: e.kennzeichen.trim() || null,
    name: e.name.trim(),
    malo: e.malo.trim() || null,
    netzbetreiber: e.netzbetreiber.trim() || null,
    anschluss_kva: kva === null ? null : dezText(kva),
    vereinbart_kw: kw === null ? null : dezText(kw),
    gueltig_ab: null,
    gueltig_bis: null,
  };
}
const bindungen = (liste: Netzanschluss[]): Bindung[] =>
  liste.flatMap((n) =>
    n.anlagen.map((b) => ({
      netzanschluss: n.id,
      anlage: b.anlage.id,
      gueltig_ab: b.gueltig_ab,
      gueltig_bis: b.gueltig_bis,
    })),
  );
export function bindungPruefen(liste: Netzanschluss[], ziel: Netzanschluss, anlage: string, am: string, heute: string) {
  if (!anlage) return { feld: 'anlage', text: 'Bitte eine Anlage wählen.' };
  if (!datumVon(am, 'tag')) return { feld: 'ab', text: 'Bitte einen gültigen Tag wählen.' };
  if (!giltAm(ziel, am)) return { feld: 'ab', text: 'Der Netzanschluss besteht an diesem Tag nicht.' };
  const u = bindung(
    bindungen(liste),
    { netzanschluss: ziel.id, anlage, gueltig_ab: am, gueltig_bis: ziel.gueltig_bis },
    heute,
  );
  if (u.fehler)
    return {
      feld: 'ab',
      text:
        u.fehler === 'anschluss_belegt'
          ? 'Der Netzanschluss ist in diesem Zeitraum an eine andere Anlage gebunden.'
          : 'Für diese Anlage besteht ab diesem Tag bereits eine Bindung.',
    };
  return {
    feld: null,
    text: u.beendet
      ? `Die bisherige Bindung endet am ${datumText(u.beendet.gueltig_bis!)}.`
      : 'Ab diesem Tag gilt die neue Bindung.',
  };
}
export function anlagenOptionen(anlagen: StandortAnlage[], liste: Netzanschluss[], heute: string) {
  return anlagen.map((a) => {
    const n = anschlussDerAnlage(liste, a.id, heute);
    const b = n?.anlagen.find((b) => b.anlage.id === a.id && giltAm(b, heute));
    return {
      value: a.id,
      label: a.name,
      sub: n && b ? `Gebunden an ${n.kennzeichen} seit ${datumText(b.gueltig_ab)}` : 'Noch nicht gebunden',
    };
  });
}
export function fehlerSatz(e: unknown): string {
  if (e instanceof ApiError && typeof (e.body as { message?: unknown })?.message === 'string')
    return (e.body as { message: string }).message;
  return 'Die Änderung konnte nicht gespeichert werden. Bitte erneut versuchen.';
}
