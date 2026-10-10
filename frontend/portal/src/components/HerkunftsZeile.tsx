import type { Stueck } from '../uemsOberflaechen';
import './HerkunftsZeile.css';

/**
 * UEMS AP-13 IP-11 (D1/D2) — EINE Herkunfts-Zeile, deren Kennzeichen Sprünge sind.
 *
 * Die Zeile bleibt der Satz, den ihre Fläche schon gesprochen hat; sie bekommt keine zweite Form,
 * sondern Kanten: wo `Stueck.sprung` steht, trägt das Kennzeichen seinen Hash MIT Periode und Version
 * (ein Sprung, der beides verliert, führt zu einer ANDEREN Zahl als der angeklickten). Ein Objekt ohne
 * Seite — Bezugsgröße, Ereignis, Box — bleibt Text (D3); dort steht `sprung: null`, und hier kein `<a>`.
 */
export function HerkunftsZeile({ stuecke, className }: { stuecke: readonly Stueck[]; className?: string }) {
  return (
    <>
      {stuecke.map((s, i) =>
        s.sprung ? (
          <a key={i} className={className ?? 'vp-herkunft-sprung'} href={s.sprung.hash}>
            {s.text}
          </a>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
