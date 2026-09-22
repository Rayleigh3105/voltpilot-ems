import type { Bericht } from './api';
import { UEMS_BEWERTUNG_SAETZE } from './glossar';

/**
 * UEMS AP-16 IP-24 (S5/S6, §5.5 Schritt 4): der Übersichts-Baustein „Energetische Bewertung“ am Unternehmen — rein.
 * Frist, Fälligkeit, Zahlen und Verantwortliche kommen fertig aus `GET /api/v1/berichte` (`ueberpruefung`, beim Abruf
 * abgeleitet); hier wird nur die gültige Bewertung gewählt und in Sätze aus `glossar.ts` gesetzt — nichts gerechnet.
 */

export const BEWERTUNG_VORLAGE = 'energetische_bewertung';

export interface BewertungFristBild {
  kennung: string;
  /** „Energetische Bewertung: Stand Nr. 2 vom 17.11.2026 · Überprüfung fällig seit 1 Tag.“ */
  satz: string;
  faellig: boolean;
  /** „6 wesentliche Energieeinsätze · 1 offener Messbedarf“ */
  zahlen: string;
  /** S6 — nur wenn fällig: die Verantwortlichen der wesentlichen Einsätze. */
  hinweis: string | null;
  ohneVerantwortliche: string | null;
}

/** `2026-11-17` → `17.11.2026` (ein Kalendertag, keine Zeitzone). */
export const tagText = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/**
 * Die gültige Bewertung: Vorlage `energetische_bewertung`, mit freigegebenem Stand, nicht abgelöst (der Server kennzeichnet
 * jede ältere mit `abgeloest_durch`). Ohne sie gibt es keinen Baustein (`null`) — Bestandskunden merken nichts (R11).
 */
export function bewertungFristBaustein(berichte: readonly Bericht[] | null): BewertungFristBild | null {
  const b = (berichte ?? []).find(
    (x) => x.vorlage === BEWERTUNG_VORLAGE && x.ueberpruefung != null && x.ueberpruefung.abgeloest_durch == null,
  );
  const u = b?.ueberpruefung;
  if (!b || !u) return null;
  const vom = tagText(u.stand_vom);
  const satz = !u.ueberpruefung_faellig
    ? UEMS_BEWERTUNG_SAETZE.fristAm(u.stand_nr, vom, tagText(u.faellig_am ?? u.stand_vom))
    : u.faellig_seit_tagen === 0
      ? UEMS_BEWERTUNG_SAETZE.fristHeute(u.stand_nr, vom)
      : UEMS_BEWERTUNG_SAETZE.frist(u.stand_nr, vom, u.faellig_seit_tagen ?? 0);
  const namen = u.verantwortliche.map((v) => `${v.name} (${v.einsaetze.join(', ')})`).join(' · ');
  return {
    kennung: b.kennung,
    satz,
    faellig: u.ueberpruefung_faellig,
    zahlen: UEMS_BEWERTUNG_SAETZE.fristZahlen(u.wesentliche_einsaetze, u.offene_bedarfe),
    hinweis: u.ueberpruefung_faellig && namen ? UEMS_BEWERTUNG_SAETZE.fristHinweis(namen) : null,
    ohneVerantwortliche:
      u.ueberpruefung_faellig && u.ohne_verantwortliche.length > 0
        ? UEMS_BEWERTUNG_SAETZE.fristOhneVerantwortliche(u.ohne_verantwortliche.join(', '))
        : null,
  };
}
