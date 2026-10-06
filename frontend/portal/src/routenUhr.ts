/**
 * Eine Uhr für „Ziele und Maßnahmen“ (Konzept Verbessern v1, Befund 2): „heute“ in den Dialogen ist der Tag der Route
 * (`abruf`), nie die Uhr des Browsers — die Route prüft Termine, frühesten und spätesten Tag mit ihrer Uhr und lehnt
 * sonst ab (in der Demo laufen beide Uhren um Jahre auseinander). Jede Antwort der Verbessern-Routen trägt `abruf`;
 * die Seiten merken ihn sich hier (`merkeAbruf`), die Dialoge lesen ihn (`routenHeute`). Ein Einstieg ohne eigene
 * Antwort (Kennzahl, Energieeinsatz, Feststellung, Audit, Managementbewertung) holt ihn einmal über
 * `GET /api/v1/verbesserung/uebersicht` (`useRoutenHeute`). Erst ohne jede Antwort gilt der Kalendertag in Berlin.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { heute } from './bewertung';

const TAG = /^\d{4}-\d{2}-\d{2}$/;
let gemerkt: string | null = null;
let laden: Promise<void> | null = null;

/** Merkt sich den Tag der Route aus einer Antwort (`abruf`, auch `frist.abruf`). */
export function merkeAbruf(abruf: string | null | undefined): void {
  if (abruf && TAG.test(abruf)) gemerkt = abruf;
}

/** „heute“ für Vorgaben und Grenzen der Dialoge: der zuletzt gemerkte Tag der Route, sonst Berlin. */
export function routenHeute(): string {
  return gemerkt ?? heute();
}

/** Holt den Tag der Route, falls noch keine Antwort ihn geliefert hat; `null`, solange er lädt. */
export function useRoutenHeute(): string | null {
  const [tag, setTag] = useState<string | null>(gemerkt);
  useEffect(() => {
    if (gemerkt) {
      setTag(gemerkt);
      return;
    }
    let aktiv = true;
    laden ??= api.verbesserungUebersicht().then(
      (u) => merkeAbruf(u.abruf),
      () => undefined,
    );
    laden.then(() => {
      laden = null;
      if (aktiv) setTag(routenHeute());
    });
    return () => {
      aktiv = false;
    };
  }, []);
  return tag;
}

/** Nur für Tests: vergisst den gemerkten Tag. */
export function vergissAbruf(): void {
  gemerkt = null;
  laden = null;
}

/**
 * Konzept Nachweisen n1, Befund 3: dieselbe Uhr für Nachweisen. Manche Routen nennen einen Augenblick statt eines Tags
 * (`abruf` der Berichte, `stichtag` von Verzeichnis und Wiedervorlage); ihr Tag ist der Kalendertag in der Zone des
 * Unternehmens - nie der UTC-Tag. `null` ohne lesbaren Augenblick.
 */
export function tagDesAugenblicks(zeitpunkt: string | null | undefined, zone = 'Europe/Berlin'): string | null {
  const ms = Date.parse(zeitpunkt ?? '');
  return Number.isNaN(ms) ? null : new Date(ms).toLocaleDateString('sv-SE', { timeZone: zone });
}

/** Merkt sich den Tag eines Augenblicks der Route (siehe {@link tagDesAugenblicks}). */
export function merkeAugenblick(zeitpunkt: string | null | undefined, zone = 'Europe/Berlin'): void {
  merkeAbruf(tagDesAugenblicks(zeitpunkt, zone));
}
