import { useEffect, useState } from 'react';

/**
 * Die Telefon-Grenze des Portals, an EINER Stelle.
 *
 * `<=720px` ist die Breite, ab der die Schale ihre Bottom-Bar zeigt und die
 * Flächen ihre Mobil-Fassung rendern (Mobil-Umbau, Konzept
 * `data/vp-mobile-views-x1`). Sie lag vorher als private Kopie in
 * `pages/AnlageTechnik.tsx` und als nackte Zahl in jeder Medienabfrage; zwei
 * Definitionen derselben Grenze laufen irgendwann auseinander, und dann
 * widersprechen sich zwei Flächen über dasselbe Gerät.
 *
 * **Warum eine Medienabfrage in JS und nicht nur CSS:** eine Mobil-Fassung,
 * die per `display:none` neben der Desktop-Fassung im DOM steht, verdoppelt
 * Überschriften und Beschriftungen für Vorlesesoftware und die Suche des
 * Browsers. Wo sich die STRUKTUR unterscheidet (eine Karte wird zum
 * Aufklapper, eine Reihenfolge dreht sich), wird deshalb hier verzweigt; wo
 * sich nur die GEOMETRIE unterscheidet, bleibt es bei CSS.
 *
 * **Ohne `matchMedia` (jsdom, Server-Rendern) ist das Ergebnis `false`** —
 * also die Desktop-Fassung. Das ist load-bearing: die bestehenden Tests
 * rendern damit unverändert die Bühne, eine Umgebung, die die Breite nicht
 * kennen kann, behauptet nie ein Telefon, und ein Test der Telefon-Fassung
 * stubbt `matchMedia` ausdrücklich.
 */
export const PHONE_MAX_PX = 720;

/** Dieselbe Grenze als Medienabfrage — wortgleich mit dem CSS-`@media`. */
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_PX}px)`;

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PHONE_QUERY).matches
    : false;
}

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(PHONE_QUERY);
    const onChange = () => setIsPhone(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isPhone;
}

/**
 * Die ZWEITE Breiten-Grenze des Portals: ab hier ist die Schale eine
 * Desktop-Schale (die Seitenleiste klappt unter 1024 px zu einer Schublade).
 *
 * Sie steht hier neben der Telefon-Grenze, weil zwei Definitionen derselben
 * Grenze irgendwann auseinanderlaufen - und dann widersprechen sich zwei
 * Flächen über dieselbe Fensterbreite.
 *
 * Gebraucht wird sie vom Struktur-Schaltbild der Anlagen-Zentrale: den Reiter
 * „Geräte | Schaltbild" gibt es ausdrücklich NUR auf dem Desktop; darunter IST
 * die Geräte-Liste die Struktur (M5-Lehre: Telefon = Liste, nie Mini-Canvas).
 *
 * **Ohne `matchMedia` (jsdom, Server-Rendern) ist das Ergebnis `true`** - also
 * die Desktop-Fassung, genau wie {@link useIsPhone} dort `false` liefert. Eine
 * Umgebung, die die Breite nicht kennen kann, behauptet nie ein schmales
 * Fenster; ein Test der schmalen Fassung stubbt `matchMedia` ausdrücklich.
 */
export const DESKTOP_MIN_PX = 1024;

/** Dieselbe Grenze als Medienabfrage — wortgleich mit dem CSS-`@media`. */
export const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_PX}px)`;

function desktopMatches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DESKTOP_QUERY).matches
    : true;
}

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(desktopMatches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setIsDesktop(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}
