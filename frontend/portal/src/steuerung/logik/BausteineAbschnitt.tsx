/**
 * Die Bausteine im Reiter „Regeln“, direkt unter „Neue Regel“ (Steuerlogik Stufe 5, Bericht 6.7, E4 = A): je
 * Baustein ein Satz mit den Werten, die der Logik-Dienst für diese Anlage vorschlägt. Nur Bausteine, deren Geräte und
 * Fühler die Anlage hat; nur für wer eine Logik speichern darf. Von VoltPilot für alle, vom Fachbetrieb für seine
 * Kunden (mit seinem Namen).
 */
import { useCallback, useEffect, useState } from 'react';
import type { BausteinKopf, BausteinListe } from '../../api';
import { api } from '../../apiVoll';
import { Ic } from '../Ic';
import { BausteinBlatt } from './BausteinBlatt';
import { satzZeile, symbol, zeigbar } from './baustein';

export function BausteineAbschnitt({ siteId }: { siteId: string }) {
  const [liste, setListe] = useState<BausteinListe | null>(null);
  const [offen, setOffen] = useState<BausteinKopf | null>(null);
  const lade = useCallback(() => {
    let ab = false;
    api.bausteinListe(siteId).then((l) => { if (!ab) setListe(l); }).catch(() => { if (!ab) setListe(null); });
    return () => { ab = true; };
  }, [siteId]);
  useEffect(() => lade(), [lade]);

  if (!liste?.darfEinsetzen) return null;
  const zeigen = zeigbar(liste.bausteine);
  if (!zeigen.length) return null;
  return (
    <section aria-label="Bausteine" className="voll">
      <div className="grp-h"><h3>Bausteine</h3><span>Satz wählen, Lücken füllen</span></div>
      <div className="vorl bs-liste">
        {zeigen.map((b) => (
          <button type="button" className="vk bs-karte" key={b.id} disabled={!b.lesbar}
            onClick={(e) => { e.currentTarget.focus(); setOffen(b); }}>
            <span className="ico" style={{ background: 'var(--pv-soft)', color: 'var(--pv)' }}><Ic n={symbol(b)} s={19} /></span>
            <b>{b.name ?? 'Baustein'}</b>
            <small>{b.lesbar ? satzZeile(b.satz, b.luecken) : b.message}</small>
            {b.herkunft === 'fachbetrieb' ? <span className="bs-von">{b.eigen ? 'Ihr Baustein' : b.von}</span> : null}
          </button>
        ))}
      </div>
      {offen ? (
        <BausteinBlatt siteId={siteId} kopf={offen} onClose={() => setOffen(null)}
          onEntfernt={() => { setOffen(null); lade(); }} />
      ) : null}
    </section>
  );
}
