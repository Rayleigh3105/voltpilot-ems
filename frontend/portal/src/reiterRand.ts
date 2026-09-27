import { useCallback, useRef } from 'react';

/**
 * Welche Kante einer waagerecht scrollenden Reiterleiste noch Reiter verbirgt.
 *
 * Rein, damit die Regel ohne Browser prüfbar ist: `''` = alles sichtbar.
 */
export function reiterRand(scrollLeft: number, clientWidth: number, scrollWidth: number): '' | 'links' | 'rechts' | 'beide' {
  const links = scrollLeft > 1;
  const rechts = scrollLeft + clientWidth < scrollWidth - 1;
  return links && rechts ? 'beide' : links ? 'links' : rechts ? 'rechts' : '';
}

/**
 * Reiterleisten scrollen waagerecht, ihr Balken ist ausgeblendet (`BereichTabs.css`) — ohne Hinweis wüsste
 * niemand, dass rechts noch „Vergleich mit Bezugsbasis“ oder „Managementbewertung“ liegt. Die Leiste trägt
 * deshalb `data-rand="links|rechts|beide"` (das CSS blendet an dieser Kante weich aus), und der gewählte
 * Reiter rückt beim Erscheinen und bei jedem Wechsel in die Mitte — auch wenn ihn ein anderer Weg wählt
 * (Leiste unten, Rücksprung).
 *
 * Als Ref-Callback: `<div ref={useReiterRand()} className="vp-bereich-tabs">`.
 */
export function useReiterRand<T extends HTMLElement>(): (el: T | null) => void {
  const aufraeumen = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    aufraeumen.current?.();
    aufraeumen.current = null;
    if (!el) return;
    const messe = () => {
      const rand = reiterRand(el.scrollLeft, el.clientWidth, el.scrollWidth);
      if (rand) el.dataset.rand = rand;
      else delete el.dataset.rand;
    };
    const mittig = () => {
      const aktiv = el.querySelector<HTMLElement>('[aria-selected="true"]');
      if (aktiv && el.scrollWidth > el.clientWidth) {
        const links = aktiv.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
        el.scrollLeft = Math.max(0, links - (el.clientWidth - aktiv.offsetWidth) / 2);
      }
      messe();
    };
    mittig();
    el.addEventListener('scroll', messe, { passive: true });
    const beobachter = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(messe);
    beobachter?.observe(el);
    const wechsel = typeof MutationObserver === 'undefined' ? null : new MutationObserver(mittig);
    wechsel?.observe(el, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
    aufraeumen.current = () => {
      el.removeEventListener('scroll', messe);
      beobachter?.disconnect();
      wechsel?.disconnect();
    };
  }, []);
}
