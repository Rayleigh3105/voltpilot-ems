import { useEffect, useState } from 'react';
import { befundZeilen, messstelleVergleich, type BefundZeile } from '../uemsVergleichToleranz';
import './VergleichBefund.css';

/**
 * Die Befund-Zeile der Messstellen-Seite (UEMS AP-16 IP-17, G5, E10 = A): je Vergleichsquelle der letzte
 * volle Monat — „passt“, „bitte prüfen“ oder „nicht vergleichbar“. Nur Text, kein Bedienelement; der
 * Toleranz-Dialog kommt mit IP-18.
 *
 * ⚠ Ohne Vergleichsquelle mit Monatsmenge, bei einem Fehler oder solange nichts geladen ist, steht hier
 * NICHTS — Bestandskunden merken nichts (R11). ⚠ Keine Ursache, kein Ersatz: die Quelle-Karte zeigt die
 * Werte weiter unbewertet nebeneinander (AP-04 E3); dieser Satz nennt nur Abweichung und Toleranz.
 */
export function VergleichBefund({ kennzeichen }: { kennzeichen: string }) {
  const [zeilen, setZeilen] = useState<BefundZeile[]>([]);
  useEffect(() => {
    let aktiv = true;
    setZeilen([]);
    messstelleVergleich(kennzeichen).then(
      (v) => { if (aktiv) setZeilen(befundZeilen(v)); },
      () => { if (aktiv) setZeilen([]); },
    );
    return () => { aktiv = false; };
  }, [kennzeichen]);
  if (zeilen.length === 0) return null;
  return (
    <ul className="vp-vgl" data-testid="vergleich-befund" aria-label="Vergleich mit Vergleichsquellen">
      {zeilen.map((z) => (
        <li key={z.schluessel} className={`vp-vgl-zeile is-${z.zustand}`}>{z.satz}</li>
      ))}
    </ul>
  );
}
