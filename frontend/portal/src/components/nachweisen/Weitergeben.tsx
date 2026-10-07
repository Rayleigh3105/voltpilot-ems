import { useState } from 'react';
import { NwSymbol, type NwSymbolName } from './NwSymbol';
import { TEILEN_SATZ, teilen, type TeilenUmgebung } from './teilen';
import './NwZeilen.css';

/** Ein Knopf zum Lesen oder Weitergeben: PDF, CSV, Speichern, Einsicht geben - ohne Unterzeile (Runde 2). */
export type WeitergebenKnopf = {
  symbol: NwSymbolName;
  text: string;
  onClick: () => void;
  /** Läuft gerade (Abruf eines PDF): der Knopf ist gesperrt. */
  laeuft?: boolean;
  testId?: string;
};

/**
 * Weitergeben (Konzept n1, `.weitergeben`): ruhige Knöpfe unter der Status-Zeile jedes Stands. „Teilen“ ist eingebaut:
 * über das Teilen-Menü des Telefons, sonst „Link kopieren“; danach eine leise Zeile („Link kopiert“). Geteilt wird der Link
 * in den Kundenbereich, nie die Datei: wer ihn öffnet, braucht Zugang.
 */
export function Weitergeben({
  knoepfe,
  teilenLink,
  umgebung,
  testId,
}: {
  knoepfe: WeitergebenKnopf[];
  /** Was „Teilen“ teilt; ohne Angabe kein Teilen-Knopf. */
  teilenLink?: { titel: string; url: string } | null;
  /** Im Test: die Teilen-Umgebung des Browsers. */
  umgebung?: TeilenUmgebung;
  testId?: string;
}) {
  const [satz, setSatz] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  async function teile() {
    if (!teilenLink) return;
    setLaeuft(true);
    setSatz(null);
    try {
      setSatz(TEILEN_SATZ[await teilen(teilenLink, umgebung)]);
    } finally {
      setLaeuft(false);
    }
  }
  const alle: WeitergebenKnopf[] = [...knoepfe];
  if (teilenLink) {
    // Teilen steht an zweiter Stelle (nach PDF), wie im Konzept: „PDF · Teilen · CSV“.
    alle.splice(Math.min(1, alle.length), 0, { symbol: 'teilen', text: 'Teilen', onClick: () => void teile(), laeuft, testId: 'weitergeben-teilen' });
  }
  return (
    <div className="vp-nw-wg-rahmen" data-testid={testId}>
      <div className="vp-nw-wg">
        {alle.map((k) => (
          <button key={k.text} type="button" className="vp-nw-wg-k" onClick={k.onClick} disabled={k.laeuft} aria-busy={k.laeuft || undefined} data-testid={k.testId}>
            <NwSymbol name={k.symbol} size={16} />
            <span>{k.text}</span>
          </button>
        ))}
      </div>
      {satz && (
        <p className="vp-nw-wg-satz" role="status" data-testid="weitergeben-satz">
          {satz}
        </p>
      )}
    </div>
  );
}
