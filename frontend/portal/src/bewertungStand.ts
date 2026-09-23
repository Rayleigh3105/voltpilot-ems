import type { Bericht, BerichtDetail, BerichtEntwurf, BerichtStandKurz, Selbstauskunft } from './api';
import { revisionBanner, type RevisionBanner } from './berichtDialoge';
import { gueltigerStand } from './berichtSeite';
import { BEWERTUNG_VORLAGE, bewertungFristBaustein, tagText } from './bewertungFrist';
import { iso } from './bezugsPeriode';
import { UEMS_BEWERTUNG_SAETZE, UEMS_BERICHTSSTAND, UEMS_DATENSTAND, UEMS_ENTWURF } from './glossar';
import { uhr } from './uemsErgebnis';

/**
 * UEMS AP-16 IP-25 (§5.5, S1/S4/S5, R7/R10/R15): der Bewertungsstand auf der Seite „Bewertung“ — rein.
 *
 * Die Bewertung ist ein Bericht der Vorlage `energetische_bewertung` (E5 = A); Stände, Anstöße, Entwurf und Frist kommen
 * fertig aus den Bericht-Routen (`GET /api/v1/berichte`, `…/{kennung}`, `…/entwurf`). Hier wird nur gewählt und in Sätze
 * gesetzt — nichts gerechnet, nichts geprüft, was die Route nicht schon gesagt hat. Das Recht aller Handlungen an dieser
 * Vorlage ist `bewertung.abrufen` (`BerichtRechte.kennung` mit Vorlage, Rechte-Matrix AP-16 §6.1).
 */

export const BEWERTUNG_RECHT = 'bewertung.abrufen';

export const STAND_TITEL = 'Bewertungsstand';
export const STAENDE_TITEL = 'Stände';
export const ANLEGEN_KNOPF = 'Bewertung anlegen';
export const KEINE_BEWERTUNG =
  'Noch keine Bewertung. Legen Sie eine an — der Entwurf entsteht aus Umfang, Einsätzen, Rangliste, Einstufungen, Messplanung und Messmitteln.';
export const KEIN_STAND = `Noch kein ${UEMS_BERICHTSSTAND} — der ${UEMS_ENTWURF} ist noch nicht freigegeben.`;
export const ENTWURF_LADEFEHLER = `Der ${UEMS_ENTWURF} konnte nicht geladen werden.`;
export const LADEFEHLER = 'Der Bewertungsstand konnte nicht geladen werden.';
export const DATEI_FEHLER = 'Die Datei konnte nicht abgerufen werden.';
export const ERSETZT = 'ersetzt';
export const GUELTIG = 'gültig';

/** Darf die Person die Bewertung sehen, anlegen, freigeben und abrufen? Nur aus `/me` (`unternehmen_rechte`). */
export const darfBewertung = (s: Pick<Selbstauskunft, 'unternehmen_rechte'> | null | undefined): boolean =>
  !!s && s.unternehmen_rechte.includes(BEWERTUNG_RECHT);

/**
 * Die Bewertung der Seite: nicht archiviert; zuerst die gültige (mit Frist, nicht abgelöst), sonst die jüngst angelegte.
 * Ohne sie `null` — Bestandskunden merken nichts (R11).
 */
export const bewertungWaehlen = (berichte: readonly Bericht[] | null): Bericht | null => {
  const offen = (berichte ?? []).filter((b) => b.vorlage === BEWERTUNG_VORLAGE && b.archiviert_am === null);
  const gueltig = offen.find((b) => b.ueberpruefung != null && b.ueberpruefung.abgeloest_durch == null);
  if (gueltig) return gueltig;
  return [...offen].sort((a, b) => b.angelegt_am.localeCompare(a.angelegt_am))[0] ?? null;
};

/** „10.11.2026 08:55“ in der Zone der Bewertung. */
export const zeitpunkt = (zeit: string, zone: string): string => {
  const t = Date.parse(zeit);
  return `${tagText(iso(t, zone).slice(0, 10))} ${uhr(t, zone)}`;
};

/** Ein Kalendertag in der Zone der Bewertung: „17.11.2026“. */
const tag = (zeit: string, zone: string): string => tagText(iso(Date.parse(zeit), zone).slice(0, 10));

/** Prüfsumme gekürzt wie im Messmittel-Satz (§5.7): „3b1f…9a2e“. */
export const pruefsummeKurz = (p: string): string => (p.length <= 9 ? p : `${p.slice(0, 4)}…${p.slice(-4)}`);

/** Das Jahr der Bewertung (§5.7 „Bewertung 2026“): das Jahr des letzten Monats ihrer Datengrundlage. */
export const bewertungJahr = (b: Pick<Bericht, 'zeitraum'>): number => Number(b.zeitraum.split('/').pop()!.slice(0, 4));

/** Der Anlass eines Stands (R7): der Anstoß, den er erledigt hat — „Korrektur K-2026-0007 …“ wie die Route ihn sagt. */
const anlassVon = (detail: BerichtDetail, s: BerichtStandKurz): string | null =>
  s.anlass_anstoss_id === null ? null : detail.anstoesse.find((a) => a.id === s.anlass_anstoss_id)?.anlass_text ?? null;

export interface StandZeile {
  nr: number;
  titel: string;
  /** „freigegeben am 17.11.2026 09:30 · Ines Kaltenbach“ */
  freigabe: string;
  /** „Prüfsumme 3b1f…9a2e“ */
  pruefsumme: string;
  pruefsummeVoll: string;
  /** „ersetzt durch Nr. 2“ oder „gültig“. */
  zustand: string;
  gueltig: boolean;
  /** R7 — „Anlass: Korrektur K-2026-0007 …“; ohne Anstoß `null`. */
  anlass: string | null;
  /** §5.4 — `bericht-BR-2026-0003-nr1.pdf`. */
  dateien: Array<{ format: 'pdf' | 'csv'; text: string; datei: string }>;
}

/** Die Stände, jüngster zuerst (S1: Nr., freigegeben am, Freigeber, Prüfsumme, ersetzt durch). */
export const standZeilen = (detail: BerichtDetail, mitDateien: boolean): StandZeile[] => {
  const zone = detail.bericht.zeitzone;
  return [...detail.staende]
    .sort((a, b) => b.nr - a.nr)
    .map((s) => {
      const anlass = anlassVon(detail, s);
      return {
        nr: s.nr,
        titel: `Stand Nr. ${s.nr}`,
        freigabe: `freigegeben am ${zeitpunkt(s.freigegeben_am, zone)} · ${s.freigegeben_von.name}`,
        pruefsumme: `Prüfsumme ${pruefsummeKurz(s.pruefsumme)}`,
        pruefsummeVoll: s.pruefsumme,
        zustand: s.ersetzt_durch_nr === null ? GUELTIG : `${ERSETZT} durch Nr. ${s.ersetzt_durch_nr}`,
        gueltig: s.ersetzt_durch_nr === null,
        anlass: anlass === null ? null : `Anlass: ${anlass}`,
        dateien: mitDateien
          ? (['pdf', 'csv'] as const).map((format) => ({
              format,
              text: format.toUpperCase(),
              datei: `bericht-${detail.bericht.kennung}-nr${s.nr}.${format}`,
            }))
          : [],
      };
    });
};

/**
 * §5.7 „Stand“: „Bewertung 2026 · Stand Nr. 2 vom 17.11.2026 (ersetzt Nr. 1 vom 09.11.2026 — Anlass: Korrektur
 * K-2026-0007).“ — ohne Vorgänger „Bewertung 2026 · Stand Nr. 1 vom 09.11.2026.“; ohne Stand `null`.
 */
export const standSatz = (detail: BerichtDetail): string | null => {
  const g = gueltigerStand(detail.staende);
  if (!g) return null;
  const zone = detail.bericht.zeitzone;
  const jahr = bewertungJahr(detail.bericht);
  const vorher = detail.staende.find((s) => s.ersetzt_durch_nr === g.nr) ?? null;
  const anlass = anlassVon(detail, g);
  return vorher && anlass
    ? UEMS_BEWERTUNG_SAETZE.stand(jahr, g.nr, tag(g.freigegeben_am, zone), vorher.nr, tag(vorher.freigegeben_am, zone), anlass)
    : UEMS_BEWERTUNG_SAETZE.standErster(jahr, g.nr, tag(g.freigegeben_am, zone));
};

/** Der Entwurf mit Datenstand (§5.5 Schritt 1): „Entwurf · Datenstand 20.11.2026 09:00 · Datengrundlage …“. */
export const entwurfZeile = (b: Pick<Bericht, 'zeitzone' | 'zeitraum_text'>, e: Pick<BerichtEntwurf, 'datenstand'>): string =>
  `${UEMS_ENTWURF} · ${UEMS_DATENSTAND} ${zeitpunkt(e.datenstand, b.zeitzone)} · Datengrundlage ${b.zeitraum_text}`;

/** Die Frist-Kopfzeile (S5, R10) — derselbe Satz wie der Übersichts-Baustein; ohne gültigen Stand `null`. */
export const fristKopf = (b: Bericht | null): { satz: string; faellig: boolean; hinweis: string | null } | null => {
  const f = b ? bewertungFristBaustein([b]) : null;
  return f ? { satz: f.satz, faellig: f.faellig, hinweis: f.hinweis } : null;
};

/** Der Revision-Vermerk (§5.5 Schritt 3, R7): „Revision nötig — <Anlass>“, nur für offene Anstöße am gültigen Stand. */
export const revisionVermerk = (detail: BerichtDetail): RevisionBanner | null => revisionBanner(detail);

/**
 * R15 — nach einer Kriterien-Änderung, wenn es einen freigegebenen Bewertungsstand gibt: „Bewertungsstand Nr. 2 bekommt
 * einen Anstoß — …“. Die Naht (Pfad 2) setzt ihn, der Satz sagt nur, was kommt; ohne Stand `null`.
 */
export const kriterienAnstoss = (berichte: readonly Bericht[] | null): string | null => {
  const b = bewertungWaehlen(berichte);
  return b && b.neueste_nr !== null ? UEMS_BEWERTUNG_SAETZE.kriterienAnstoss(b.neueste_nr) : null;
};
