import { useEffect, useState } from 'react';

/**
 * Ein Zähler, der bei jedem AUFWACHEN des Tabs hochzählt — gedacht als
 * Abhängigkeit eines Lade-Effekts, der beim Aufwachen sofort neu holen soll.
 *
 * Das WARUM: Browser drosseln oder frieren die Takte eines verdeckten Tabs ein
 * (Chrome friert Hintergrund-Tabs nach wenigen Minuten ganz ein, auf dem Handy
 * ohnehin), und eine bfcache-Rückkehr baut GAR NICHTS neu auf. Ein Effekt, der
 * seine Daten nur über `setInterval` frisch hält, zeigt dem zurückkehrenden
 * Kunden deshalb erst den Stand von vorhin und aktualisiert ihn Sekunden
 * später — genau das „beim Öffnen zuerst die alte Ansicht" der Kundenmeldung.
 *
 * `useFreshnessPoll` löst dasselbe für Flächen, die einen eigenen Takt haben;
 * dieser Zähler ist die Variante für Effekte, die ihre Daten schon beim
 * Betreten holen und nur einen zusätzlichen Auslöser brauchen: `wake` in die
 * Abhängigkeitsliste, fertig — die Bedingungen und Abbruch-Wächter des
 * Effekts bleiben unangetastet.
 *
 * Beide Auslöser sind nötig: `visibilitychange` deckt den Tab-Wechsel ab,
 * `pageshow` mit `persisted` die eingefrorene Rückkehr aus dem bfcache (auf
 * iOS der verlässlichere der beiden).
 */
export function useWake(): number {
  const [wake, setWake] = useState(0);
  useEffect(() => {
    const bump = () => setWake((n) => n + 1);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') bump();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) bump();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);
  return wake;
}
