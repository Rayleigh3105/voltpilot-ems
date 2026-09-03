import { type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import './Aufklapper.css';

/**
 * V8 · DER Aufklapper des Bereichs „Verlauf" — EINE Form für alle sechs Reiter
 * (Konzept `data/vp-verlauf-sprache-konzept-v5` §3.2 V8, Paket P2b).
 *
 * Titel 16/600, Chevron rechts, 48 px Trefferfläche über die volle Breite,
 * Inhalt darunter in Textgröße. Bewegt wird ausschließlich der Chevron
 * (`--vp-c-motion`); die HÖHE springt ohne Übergang, damit ein aufklappender
 * Abschnitt den Scrollweg nicht unter dem Daumen wegzieht.
 *
 * **Warum nativ `<details>`/`<summary>` und kein `<button>` + `{open && …}`:**
 * die Tastatur (Enter UND Leertaste), der Fokus, die Aufklapp-Ansage der
 * Screenreader und das Suchen-im-Browser über zugeklapptem Text kommen dann vom
 * Browser statt aus unserem Code. Der Inhalt bleibt dabei im DOM, also findet
 * ihn auch zugeklappt die Suche des Browsers — wer schwere Inhalte hängt
 * (ECharts misst in einer zugeklappten `details` 0 px Breite), reicht sie
 * bewusst erst beim Öffnen herein. `aria-expanded` steht zusätzlich am
 * `summary` — auf dessen implizitem
 * Knopf-Rang ist es erlaubt und macht den Zustand für ältere Hilfsmittel und
 * für die Tests ablesbar.
 *
 * **Kontrolliert ODER frei:** mit `open` + `onToggle` gehört der Zustand dem
 * Aufrufer (so hängen mehrere Abschnitte an EINER Zustandsquelle); ohne `open`
 * verwaltet ihn der Browser selbst.
 *
 * ⚠ **Im kontrollierten Fall wird der Klick abgefangen (`preventDefault`) —
 * das ist Pflicht, nicht Geschmack.** Sonst schreiben zwei Stellen dasselbe
 * Attribut: React setzt `open` aus dem Zustand, und danach dreht die native
 * Aktivierung des `summary` es ein zweites Mal um — der Aufklapper bliebe
 * stehen. Der TASTATUR nimmt das nichts: Enter und Leertaste erzeugen auf einem
 * `summary` erst einen Klick, unser Zustandswechsel läuft also schon; abbestellt
 * wird nur das Aufklappen DES BROWSERS, das wir selbst übernehmen.
 */
export function Aufklapper({
  titel,
  sub,
  open,
  onToggle,
  children,
  className,
  id,
}: {
  /** Die Zeile, 16/600 — sie sagt, WAS dahinter liegt. */
  titel: ReactNode;
  /** Ruhige Beistellung rechts (am Telefon eine eigene Zeile darunter). */
  sub?: ReactNode;
  /** Gesetzt = kontrolliert. Weggelassen = der Browser führt den Zustand. */
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const kontrolliert = open !== undefined;

  const beiKlick = (e: ReactMouseEvent<HTMLElement>) => {
    if (!kontrolliert) return;
    e.preventDefault();
    onToggle?.();
  };

  return (
    <details
      id={id}
      className={className ? `vp-c-aufk ${className}` : 'vp-c-aufk'}
      {...(kontrolliert ? { open } : {})}
    >
      <summary
        className="vp-c-aufk-sum"
        aria-expanded={kontrolliert ? open : undefined}
        onClick={beiKlick}
      >
        <span className="vp-c-aufk-titel">{titel}</span>
        {sub != null && sub !== '' ? <span className="vp-c-aufk-sub">{sub}</span> : null}
        <span className="vp-c-aufk-chev" aria-hidden="true" />
      </summary>
      <div className="vp-c-aufk-body">{children}</div>
    </details>
  );
}
