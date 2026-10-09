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
 *
 * ## ⚠ WARUM DER AUSLÖSER NICHT EINFACH `document.activeElement` IST
 *
 * Safari (macOS und iOS) fokussiert einen angetippten Knopf oder Link nicht: beim Öffnen steht der Fokus auf `body`
 * oder auf der Fläche darunter, und die Rückkehr liefe ins Leere. Deshalb merkt sich das Haus EINMAL hier, welches
 * klick-fokussierbare Element der Zeiger zuletzt getroffen hat (`fokusAusloeser`) - aber nur, wenn der Browser es nicht
 * selbst fokussiert hat. Hat er es (Chromium), gilt wie immer `document.activeElement`. Wer aus einem Menü öffnet,
 * dessen Eintrag mit dem Menü verschwindet, nennt den Auslöser ausdrücklich: `merkeAusloeser(knopf)`.
 */

let sperren = 0;
let seitenOverflow = '';
const stapel = [];

// Was ein Klick fokussiert - also auch `tabindex="-1"`, anders als die Tab-Liste in `fokus.js`.
const KLICK_FOKUS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]';
let zeigerZiel = null;
let genannt = null;

function vomZeiger(event) {
  genannt = null;
  const ziel = event.target instanceof Element ? event.target.closest(KLICK_FOKUS) : null;
  // Beim `click` hat ein Browser, der Angeklicktes fokussiert, das längst getan: dann braucht es kein Gedächtnis.
  zeigerZiel = ziel && document.activeElement !== ziel ? ziel : null;
}

// Eine Taste seit dem Zeiger: was danach aufgeht, hat er nicht ausgelöst.
function vonDerTastatur() {
  genannt = null;
  zeigerZiel = null;
}

if (typeof document !== 'undefined') {
  // Capture-Phase: vor jedem Handler, der die Fläche öffnet oder das Ereignis anhält.
  document.addEventListener('pointerdown', vomZeiger, true);
  document.addEventListener('click', vomZeiger, true);
  document.addEventListener('keydown', vonDerTastatur, true);
}

/**
 * Nennt den Auslöser der nächsten Überlagerung ausdrücklich - für Einstiege, deren angeklicktes Element gleich
 * verschwindet (ein Menüeintrag: zurück geht es an den Menüknopf). Gilt für genau eine Fläche und nur bis zur nächsten
 * Eingabe.
 */
export function merkeAusloeser(element) {
  genannt = element ?? null;
}

/**
 * Das Element, an das der Fokus nach dem Schließen zurückgeht - beim ÖFFNEN zu lesen, nie beim Schließen zu suchen.
 * Reihenfolge: der ausdrücklich genannte Auslöser, sonst das vom Zeiger getroffene Element, wenn der Fokus es nicht
 * selbst trägt (er steht auf `body` oder auf einer Fläche um das Element herum), sonst `document.activeElement`.
 */
export function fokusAusloeser() {
  const aktiv = document.activeElement;
  const ausdruecklich = genannt;
  genannt = null;
  if (ausdruecklich?.isConnected) return ausdruecklich;
  if (zeigerZiel?.isConnected && (!aktiv || aktiv.contains(zeigerZiel))) return zeigerZiel;
  return aktiv;
}

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
    const eintrag = { panel, fokusVorher: fokusAusloeser() };
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
