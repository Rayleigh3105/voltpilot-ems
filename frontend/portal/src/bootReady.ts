import { createContext, useContext, useEffect } from 'react';

/**
 * DER ERSTE-BILD-MELDER des Shell-Boot-Covers.
 *
 * Beim ersten Start hält der VoltPilot-Marken-Lader (`VpLoaderScreen`) über der
 * montierenden App, BIS die Startseite ihr erstes ECHTES Bild hat - EIN einziger
 * Übergang Lader → Inhalt, keine Kette Lader → Skelett → Inhalt (Captain-Entscheid
 * Feedback-1 Punkt 6). Die Startseite (Cockpit/Flotte/Portfolio) meldet über
 * diesen Kontext, sobald ihre erste Datenladung steht; die Schale blendet dann
 * den Lader aus. Sicherheitsgrenze in `App.tsx` (~3 s), damit der Lader nie
 * endlos steht.
 *
 * Der Vorgabewert ist ein No-op: eine Startseite, die ausserhalb der Schale
 * gerendert wird (Tests, isolierte Harnesse), meldet ins Leere - kein Fehler.
 */
export const ReportFirstPaint = createContext<() => void>(() => {});

/**
 * Meldet dem Boot-Cover das erste echte Bild dieser Startseite, sobald `ready`
 * wahr wird (Datenladung steht bzw. ein terminaler Zustand ist erreicht).
 * Nach dem ersten Start ist die Meldung ein No-op (die Schale hat den Lader
 * längst ausgeblendet).
 */
export function useReportFirstPaint(ready: boolean): void {
  const report = useContext(ReportFirstPaint);
  useEffect(() => {
    if (ready) report();
  }, [ready, report]);
}
