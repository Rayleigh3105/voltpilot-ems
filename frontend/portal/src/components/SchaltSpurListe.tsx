import { useCallback, useEffect, useState } from 'react';
import { consumersApi, type SchaltSpur } from '../consumers/consumersApi';
import { spurAnsicht } from '../consumers/schaltspurAnsicht';
import { LIVE_POLL_MS, SCHNELL_POLL_MS } from '../pollCadence';
import { useFreshnessPoll } from '../useFreshnessPoll';

/**
 * Technik & Diagnose › „Schaltspur" (nur Plattform-Administration, vp-schalten-3s): die jüngsten Handeingriffe
 * dieses Verbrauchers, je Abschnitt mit seiner Dauer. Solange der jüngste noch nicht bestätigt ist, fragt die Liste
 * im schnellen Takt nach - so füllt sie sich sichtbar, während man schaltet.
 */
export function SchaltSpurListe({ siteId, entityId }: { siteId: string; entityId: string }) {
  const [spuren, setSpuren] = useState<SchaltSpur[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  const laden = useCallback(() => {
    consumersApi.schaltspuren(siteId, entityId).then(
      (s) => { setSpuren(s); setFehler(null); },
      (e: unknown) => setFehler(e instanceof Error ? e.message : 'Die Schaltspur ließ sich nicht laden.'),
    );
  }, [siteId, entityId]);

  useEffect(() => { laden(); }, [laden]);
  // Nur ein frischer, offener Eingriff rechtfertigt den schnellen Takt - eine alte, nie bestätigte Spur nicht.
  const juengste = spuren?.[0] ?? null;
  const laeuft = juengste != null && juengste.ergebnis === 'offen'
    && Date.now() - new Date(juengste.apiEingang).getTime() < 10 * 60_000;
  useFreshnessPoll(laden, laeuft ? SCHNELL_POLL_MS : LIVE_POLL_MS);

  if (fehler) return <p className="vp-assist-error" role="alert">{fehler}</p>;
  if (!spuren) return <p className="vp-note" aria-busy="true">Lade die Schaltspur …</p>;
  if (spuren.length === 0) {
    return <p className="vp-note">Noch kein Handeingriff mit Schaltspur. Schalten Sie das Gerät von Hand - die Spur erscheint hier.</p>;
  }
  return (
    <div className="vp-schaltspur" data-testid="schaltspur">
      <p className="vp-note">
        Abschnitte der API in ihrer Uhr, die Schritte der Box in der Uhr der Box ab ihrem Empfang; die Portal-Zeiten misst
        der Browser, in dem geschaltet wurde.
      </p>
      {spuren.map((s) => {
        const a = spurAnsicht(s);
        return (
          <section key={s.id} className="vp-schaltspur-eintrag" data-ergebnis={s.ergebnis}>
            <p className="vp-geraet-sec-sub"><strong>{a.titel}</strong> · {a.ergebnis}</p>
            <dl className="vp-geraet-kv">
              {a.zeilen.map((z) => (
                <div key={z.label}>
                  <dt>{z.label}</dt>
                  <dd><span>{z.wert}</span></dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}
