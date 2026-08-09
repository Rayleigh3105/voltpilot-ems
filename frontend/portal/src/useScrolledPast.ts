import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * „Ist dieses Element nach OBEN aus dem Bild gescrollt?" — der Auslöser der
 * Sticky-Kopfzahl (Mobil-Umbau Stufe 2): der geschrumpfte Kopf erscheint erst,
 * wenn die Geld-Karte selbst nicht mehr zu sehen ist.
 *
 * `IntersectionObserver` statt eines Scroll-Handlers (kein Layout-Thrashing,
 * das `useScrollSpy`-Muster der Einstellungs-Seite). **Ohne Observer (jsdom)
 * bleibt das Ergebnis `false`** — dann erscheint nie ein Kopf, den niemand
 * ausgelöst hat.
 *
 * **Load-bearing: die Anbindung ist ein CALLBACK-Ref, kein `useRef` + Effekt.**
 * Das beobachtete Element erscheint erst, wenn die Übersichts-Zeile geladen
 * ist — ein Effekt, der nur an `enabled` hängt, liefe zu diesem Zeitpunkt gegen
 * `ref.current === null` und würde nie wieder laufen (im Browser genau so
 * aufgefallen: der Kopf blieb beim Scrollen aus).
 */
export function useScrolledPast<T extends HTMLElement>(
  enabled: boolean,
): [(node: T | null) => void, boolean] {
  const [past, setPast] = useState(false);
  const nodeRef = useRef<T | null>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);

  const observe = useCallback(() => {
    ioRef.current?.disconnect();
    ioRef.current = null;
    const el = nodeRef.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') {
      setPast(false);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        // Nur NACH OBEN hinausgescrollt zählt: unterhalb des Bildes (noch nicht
        // erreicht) ist der Kopf keine Erinnerung, sondern eine Vorwegnahme.
        setPast(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      },
      { threshold: 0 },
    );
    io.observe(el);
    ioRef.current = io;
  }, [enabled]);

  const ref = useCallback(
    (node: T | null) => {
      nodeRef.current = node;
      observe();
    },
    [observe],
  );

  useEffect(() => {
    observe();
    return () => ioRef.current?.disconnect();
  }, [observe]);

  return [ref, past];
}
