import { useEffect, useRef } from 'react';

/**
 * Der Grund des Servers in einem Dialog der Seite „Geräte & Updates".
 *
 * Eine laufende Aktion sperrt ihren Knopf, und Chrome lässt dabei den Fokus
 * fallen. Der Fokus geht deshalb auf die Meldung im Dialog: so wird sie
 * vorgelesen, und Escape/Tab des Dialogs behalten die Tastatur.
 */
export function UpdateActionError({ error }: { error?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) ref.current?.focus(); }, [error]);
  return error ? <div ref={ref} tabIndex={-1} className="vp-alert vp-alert-warn" role="alert">{error}</div> : null;
}
