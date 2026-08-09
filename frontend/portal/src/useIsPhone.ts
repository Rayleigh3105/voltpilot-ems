import { useEffect, useState } from 'react';

/**
 * Die EINE Telefon-Grenze des Portals (`<= 720px`) als Hook.
 *
 * Sie war schon zweimal im Code (als private Kopie in `pages/AnlageTechnik.tsx`
 * und als Zahl in jeder Medienabfrage); seit dem Mobil-Umbau Stufe 2 gibt es
 * Flächen, die am Telefon eine ANDERE Komposition rendern statt derselben in
 * anderem CSS — dafür braucht es die Grenze in JS, und zwar genau einmal.
 *
 * **Ohne `matchMedia` (jsdom, SSR) ist das Ergebnis `false`** — also die
 * Desktop-Fassung. Das ist load-bearing: die bestehenden Tests rendern damit
 * unverändert die Bühne, und eine Umgebung, die die Breite nicht kennen kann,
 * behauptet nie ein Telefon.
 */
export const PHONE_MAX_PX = 720;

const QUERY = `(max-width: ${PHONE_MAX_PX}px)`;

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY).matches
    : false;
}

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(QUERY);
    const onChange = () => setIsPhone(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isPhone;
}
