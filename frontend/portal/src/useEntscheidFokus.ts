import { useEffect } from 'react';
import { entscheidAus, ohneEntscheid, type Entscheid } from './entscheid';
import { replaceCurrentNavigation } from './navigationBlocker';
import './entscheidBlick.css';

/** So lange darf die Zielseite laden, bis ihr Entscheid erscheint; danach bleibt die Seite einfach oben. */
const WARTEN_MS = 8000;
/** So lange trägt der Entscheid die Markierung, die den Blick hinführt. */
const MARKIERT_MS = 2400;
/** So lange ohne Umbau des Baums gilt die Zielseite als ruhig … */
const RUHE_MS = 350;
/** … und länger als so lange nach dem ersten Fund wird nicht gewartet. */
const RUHE_HOECHSTENS_MS = 2500;
export const ENTSCHEID_MARKE = 'vp-entscheid-blick';

/** Das Ziel eines Entscheids: das Element mit `data-entscheid`, bei mehreren Gegenständen das mit dem Kennzeichen. */
export function entscheidZiel(wurzel: ParentNode, e: Entscheid): HTMLElement | null {
  const alle = [...wurzel.querySelectorAll<HTMLElement>('[data-entscheid]')].filter((el) => el.dataset.entscheid === e.art);
  if (e.kennzeichen) {
    const genau = alle.find((el) => el.dataset.entscheidKennzeichen === e.kennzeichen);
    if (genau) return genau;
    // Trägt die Seite gar kein Kennzeichen (eine Kennzahl hat genau eine Bezugsbasis), gilt der eine Entscheid.
    if (alle.some((el) => el.dataset.entscheidKennzeichen)) return null;
  }
  return alle[0] ?? null;
}

const FOKUSSIERBAR = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Der Knopf des Schritts, wo der Entscheid mehrere Knöpfe trägt (etwa „Entwurf vergleichen“ vor „Anstoß verwerfen“). */
const SCHRITT = '[data-entscheid-schritt]:not([disabled])';

/**
 * Den Blick zum Entscheid führen: hinscrollen, den Knopf des Schritts (`data-entscheid-schritt`, sonst den ersten Knopf)
 * fokussieren und kurz markieren; ohne Knopf, etwa ohne das Recht dazu, trägt der Entscheid selbst Fokus und Markierung.
 */
export function zumEntscheid(el: HTMLElement): void {
  const ruhig = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const knopf = el.querySelector<HTMLElement>(SCHRITT) ?? (el.matches(FOKUSSIERBAR) ? el : el.querySelector<HTMLElement>(FOKUSSIERBAR));
  const blick = knopf ?? el;
  if (!knopf && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  // Gescrollt wird zum Knopf: ein hoher Entscheid (zehn Anstöße über „Entwurf vergleichen“) zeigte sonst seine Mitte.
  blick.scrollIntoView?.({ block: 'center', behavior: ruhig ? 'auto' : 'smooth' });
  blick.focus({ preventScroll: true });
  blick.classList.add(ENTSCHEID_MARKE);
  window.setTimeout(() => blick.classList.remove(ENTSCHEID_MARKE), MARKIERT_MS);
}

/**
 * Ein Schritt der Wiedervorlage öffnet das Objekt mit offenem Entscheid (`?entscheid=…`, `entscheid.ts`). Dieser Haken
 * wartet, bis die Zielseite ihren Entscheid (`data-entscheid`) zeigt, führt den Blick dorthin und nimmt den Parameter
 * wieder aus der Adresse (ohne Verlaufseintrag), damit ein Neuladen nicht noch einmal springt. Er hängt EINMAL an der
 * Schale und folgt jedem Seitenwechsel über `hashchange`. Erscheint der Entscheid nicht (etwa ohne das Recht dafür),
 * bleibt die Seite oben stehen.
 */
export function useEntscheidFokus(): void {
  useEffect(() => {
    let aufraeumen: (() => void) | null = null;
    const pruefe = () => {
      aufraeumen?.();
      aufraeumen = null;
      const entscheid = entscheidAus(window.location.hash);
      if (!entscheid) return;
      let bild = 0;
      let ruhe = 0;
      let bisSpaetestens = 0;
      const fertig = () => {
        aufraeumen?.();
        aufraeumen = null;
        const hash = window.location.hash;
        const ohne = ohneEntscheid(hash);
        if (ohne !== hash) replaceCurrentNavigation(ohne);
      };
      // Erst wenn die Seite ruhig ist, wird gescrollt: lädt über dem Ziel noch ein Abschnitt nach, rutschte es sonst
      // wieder aus dem Bild. Ruhig heißt RUHE_MS ohne Umbau, spätestens nach RUHE_HOECHSTENS_MS ab dem ersten Fund.
      const ankommen = () => {
        ruhe = 0;
        const el = entscheidZiel(document, entscheid);
        if (!el) return;
        fertig();
        zumEntscheid(el);
      };
      const suche = () => {
        bild = 0;
        if (!entscheidZiel(document, entscheid)) return;
        const jetzt = Date.now();
        if (!bisSpaetestens) bisSpaetestens = jetzt + RUHE_HOECHSTENS_MS;
        window.clearTimeout(ruhe);
        ruhe = window.setTimeout(ankommen, Math.max(0, Math.min(RUHE_MS, bisSpaetestens - jetzt)));
      };
      // Die Zielseite lädt nach: gesucht wird nach jedem Umbau des Baums, höchstens einmal je Bild.
      const beobachter = new MutationObserver(() => {
        if (!bild) bild = window.requestAnimationFrame(suche);
      });
      beobachter.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-entscheid'] });
      const frist = window.setTimeout(fertig, WARTEN_MS);
      aufraeumen = () => {
        beobachter.disconnect();
        window.clearTimeout(frist);
        window.clearTimeout(ruhe);
        if (bild) window.cancelAnimationFrame(bild);
      };
      suche();
    };
    pruefe();
    window.addEventListener('hashchange', pruefe);
    return () => {
      window.removeEventListener('hashchange', pruefe);
      aufraeumen?.();
    };
  }, []);
}
