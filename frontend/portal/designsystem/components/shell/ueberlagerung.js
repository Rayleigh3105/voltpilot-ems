import React from 'react';
import { fokussierbareElemente } from './fokus';

/**
 * **Der EINE Stapel der Überlagerungen** - Seiten-Scroll-Sperre, Fokus hinein und zurück und Escape für die oberste
 * Fläche, gemeinsam für `Modal` und `BottomSheet` (Review Nachweisen r1, Q-1 und Q-2).
 *
 * ## ⚠ WARUM EIN ZÄHLER STATT „VORHER MERKEN“
 *
 * Überlagerungen folgen aufeinander: das Blatt einer Gruppe schließt und öffnet im selben Render das Blatt eines Teils,
 * ein Blatt öffnet ein Modal. Merkt sich jede Fläche beim Öffnen `body.style.overflow` als „vorher“, merkt sich die
 * neue das `hidden` der alten, die gerade noch ausblendet - danach gibt die alte `''` zurück und beim Schließen setzt
 * die neue `hidden`: die Seite scrollt bis zum Neuladen nicht mehr (am Handy reproduziert). Deshalb EIN Zähler für
 * das ganze Haus; der Wert der Seite kommt erst nach der letzten Fläche zurück.
 *
 * ## ⚠ WARUM EIN STAPEL
 *
 * Escape gehört der obersten Fläche, nicht jeder, durch die der Tastendruck im React-Baum blubbert (ein Erklär-Blatt
 * im Blatt eines Teils schloss sonst beide samt Eingaben). Der Fokus geht beim Schließen an das Element zurück, das
 * ihn beim Öffnen hatte; lag es in einer Fläche, die inzwischen selbst gegangen ist, erbt die obere deren Auslöser.
 */

let sperren = 0;
let seitenOverflow = '';
const stapel = [];

/**
 * Sperrt den Seiten-Scroll, bis die zurückgegebene Freigabe läuft. Gezählt: erst die letzte Freigabe stellt den Wert
 * der Seite wieder her. Auch für Flächen außerhalb des Stapels (Rückfragen, Assistenten), damit es nur einen Zähler
 * gibt.
 */
export function sperreSeitenScroll() {
  if (sperren === 0) seitenOverflow = document.body.style.overflow;
  sperren += 1;
  document.body.style.overflow = 'hidden';
  let frei = false;
  return () => {
    if (frei) return;
    frei = true;
    sperren = Math.max(0, sperren - 1);
    if (sperren === 0) {
      document.body.style.overflow = seitenOverflow;
      seitenOverflow = '';
    }
  };
}

/**
 * Die Fokusfalle einer Fläche: Tab und Shift-Tab bleiben in `panel`. Der Tastendruck endet hier - sonst fängt ihn die
 * Falle einer äußeren Fläche, durch die er im React-Baum blubbert, und der Fokus spränge hinaus.
 */
export function fokusFalle(event, panel) {
  if (event.key !== 'Tab') return;
  const elemente = fokussierbareElemente(panel);
  if (elemente.length === 0) return;
  const aktuell = document.activeElement;
  const index = aktuell ? elemente.indexOf(aktuell) : -1;
  const ziel = event.shiftKey
    ? elemente[(index <= 0 ? elemente.length : index) - 1]
    : elemente[(index + 1) % elemente.length];
  event.preventDefault();
  event.stopPropagation();
  ziel?.focus();
}

/**
 * Hält eine Überlagerung im Stapel, solange sie `sichtbar` ist (auch während sie ausblendet): Scroll-Sperre, Fokus in
 * `panelRef`, Escape ruft `onClose` nur, solange sie oben liegt, und beim Gehen kommt der Fokus zurück.
 *
 * `onClose` wird über eine Referenz gelesen: ein Aufrufer, der bei jedem Tastendruck neu rendert, reißt den Effekt
 * sonst ab - Fokus weg, Sperre neu.
 */
export function useUeberlagerung(sichtbar, panelRef, onClose) {
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useEffect(() => {
    if (!sichtbar) return undefined;
    const panel = panelRef.current;
    const eintrag = { panel, fokusVorher: document.activeElement };
    const freigeben = sperreSeitenScroll();
    stapel.push(eintrag);
    panel?.focus();
    const escape = (e) => {
      if (e.key !== 'Escape' || stapel.at(-1) !== eintrag) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeRef.current();
    };
    // Bubble-Phase am Dokument: was in der Fläche Escape selbst verbraucht (ein offener Picker), kommt zuerst.
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      const oben = stapel.at(-1) === eintrag;
      const index = stapel.lastIndexOf(eintrag);
      if (index >= 0) stapel.splice(index, 1);
      // Eine Fläche darüber, die aus dieser geöffnet wurde, gibt den Fokus später an deren Auslöser zurück.
      for (const darueber of index >= 0 ? stapel.slice(index) : []) {
        if (panel && darueber.fokusVorher && panel.contains(darueber.fokusVorher)) darueber.fokusVorher = eintrag.fokusVorher;
      }
      freigeben();
      if (!oben) return;
      const ziel = eintrag.fokusVorher;
      if (ziel?.isConnected && typeof ziel.focus === 'function') ziel.focus();
      else stapel.at(-1)?.panel?.focus();
    };
    // `panelRef` ist stabil; `onClose` liegt bewusst in `closeRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sichtbar]);
}
