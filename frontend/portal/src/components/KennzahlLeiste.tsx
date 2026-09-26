import type { KennzahlZelle } from '../kennzahl';
import './KennzahlLeiste.css';
import { SwapNumber } from './SwapNumber';

/**
 * DIE KENNZAHLEN-LEISTE — die eine Form, in der eine Zahl im Portal steht
 * (Portfolio Revision 2, Scout `vp-portfolio-konzept-r2` §5.4).
 *
 * Sie ist bewusst GETEILT angelegt: das Portfolio rendert damit seine
 * Flotten-Zellen, und die zwei Geld-Karten unter der Anlagen-Bühne werden in
 * S6 dieselben Zellen (r2 §8) — genau deshalb kennt dieses Bauteil weder
 * Flotte noch Anlage, sondern nur `KennzahlZelle[]`.
 *
 * **Render-only.** Jede Zahl, jedes Wort und jede Auslassung entsteht in einer
 * reinen Ableitung (`portfolioCockpit.leistenZellen` heute); hier wird
 * gezeichnet. Eine Zelle ohne Wert wird gar nicht erst gebaut — die
 * M0-Ehrlichkeit „kein Baustein ohne Wert".
 */
export function KennzahlLeiste({
  zellen,
  label,
}: {
  zellen: KennzahlZelle[];
  /** Der zugängliche Name der Leiste (sie ist eine Gruppe, keine Liste). */
  label: string;
}) {
  if (zellen.length === 0) return null;
  // ⚠ Die Spaltenzahl ist die Zahl der Zellen, die WIRKLICH etwas sagen — eine
  // feste Zahl im CSS liesse eine Flotte ohne Geld-Modus mit einer Lücke
  // rendern. Am Telefon übernimmt die Medienabfrage.
  const cols = Math.max(1, zellen.length);
  return (
    <section
      className="vp-leiste"
      role="group"
      aria-label={label}
      style={{ ['--vp-leiste-cols' as string]: String(cols) }}
    >
      {zellen.map((z, i) => (
        <div
          key={z.id}
          className={[
            'vp-leiste-zelle',
            z.lead ? 'is-lead' : '',
            // Eine ungerade LETZTE Zelle nimmt am Telefon die volle Breite.
            zellen.length % 2 === 1 && i === zellen.length - 1 ? 'is-voll' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="vp-leiste-label">{z.label}</span>
          <span className="vp-leiste-wert">
            {/* Bewegungs-Programm P3: Wertwechsel blendet durch, zaehlt nie. */}
            <SwapNumber value={z.wert} />
            {z.einheit && <span className="vp-leiste-einheit">{z.einheit}</span>}
          </span>
          {z.einordnung && <span className="vp-leiste-einordnung">{z.einordnung}</span>}
          {z.unterzeile && (
            <span className={`vp-leiste-sub${z.ton === 'warn' ? ' is-warn' : ''}`}>
              {z.unterzeile}
            </span>
          )}
        </div>
      ))}
    </section>
  );
}
