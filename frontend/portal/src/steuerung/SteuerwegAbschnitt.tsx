/**
 * „Wie Ihre Regeln und Steuerarten laufen“ im Reiter „Regeln“ (Steuerlogik Stufe 6, Zusammenführen): der Schalter der
 * Anlage zwischen dem bisherigen und dem neuen Weg, je Regel und je Gerät mit Steuerart oder Heizstab-Regler, wo es
 * läuft und - solange der neue Weg nur mitrechnet - der Vergleich der Box. Die Wörter und Schritte kommen aus
 * `steuerweg.ts`; stellen darf den Schalter, wer eine Logik bearbeiten darf (`darf` der Antwort). „Übernehmen“ ist
 * der ausdrückliche Schritt und fragt nach; „Zurück“ wirkt sofort, ohne Rückfrage.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SteuerwegAntwort } from '../api';
import { api } from '../apiVoll';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LIST_POLL_MS } from '../pollCadence';
import { abschnittTitel, geraetZeile, regelZeile, sichtbar, uebernehmenFolgen, wegAnsicht, type Schritt } from './steuerweg';

export function SteuerwegAbschnitt({ siteId, schluessel }: { siteId: string; schluessel: string }) {
  const [antwort, setAntwort] = useState<SteuerwegAntwort | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [fragt, setFragt] = useState(false);

  const lade = useCallback(async () => {
    try {
      setAntwort(await api.steuerweg(siteId));
    } catch {
      // Ohne Antwort bleibt der Abschnitt weg; die Regeln selbst stehen darüber.
    }
  }, [siteId]);

  // Neu laden, wenn sich die eingeschalteten Regeln ändern (`schluessel`), und während der neue Weg mitrechnet
  // oder schaltet im Takt der Listen - der Vergleich kommt mit dem Herzschlag der Box.
  useEffect(() => { void lade(); }, [lade, schluessel]);
  const laeuft = antwort != null && (antwort.stand.modus !== 'alt' || antwort.stand.geraeteModus !== 'alt');
  useEffect(() => {
    if (!laeuft) return undefined;
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void lade(); }, LIST_POLL_MS);
    return () => window.clearInterval(t);
  }, [laeuft, lade]);

  const schritt = async (s: Schritt) => {
    setBusy(true);
    setFehler(null);
    try {
      setAntwort(await api.steuerwegSchritt(siteId, s));
      setFragt(false);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Das hat nicht geklappt. Bitte später erneut versuchen.');
    } finally {
      setBusy(false);
    }
  };

  if (!antwort || !sichtbar(antwort)) return null;
  const w = wegAnsicht(antwort);
  const titel = abschnittTitel(antwort);
  const { regeln, geraete } = antwort.stand;
  const beide = regeln.length > 0 && geraete.length > 0;
  return (
    <section aria-label={titel} className="links stw-abschnitt" style={{ display: 'grid', gap: 8 }}>
      <div className="grp-h"><h3>{titel}</h3><span className={`pill ${w.pille.klasse}`}><i />{w.pille.wort}</span></div>
      <article className="card stw-karte">
        <p className="stw-satz">{w.satz}</p>
        {regeln.length > 0 ? (
          <>
            {beide ? <h4 className="stw-gruppe">Regeln</h4> : null}
            <ul className="stw-regeln">
              {regeln.map((r) => {
                const z = regelZeile(r);
                return (
                  <li key={z.flowId} data-regel={z.flowId}>
                    <span className="stw-kopf"><b>{z.name}</b><span className={`pill ${z.pille.klasse}`}><i />{z.pille.wort}</span></span>
                    {z.satz ? <small>{z.satz}</small> : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        {geraete.length > 0 ? (
          <>
            {beide ? <h4 className="stw-gruppe">Steuerarten</h4> : null}
            <ul className="stw-regeln">
              {geraete.map((g) => {
                const z = geraetZeile(g);
                return (
                  <li key={`${g.art}:${z.entityId}`} data-geraet={z.entityId} data-art={g.art}>
                    <span className="stw-kopf">
                      <span className="stw-name"><b>{z.name}</b><span className="stw-art">{z.art}</span></span>
                      <span className={`pill ${z.pille.klasse}`}><i />{z.pille.wort}</span>
                    </span>
                    {z.satz ? <small>{z.satz}</small> : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        {w.hinweis ? <p className="leise">{w.hinweis}</p> : null}
        {fehler ? <p className="stw-fehler" role="alert">{fehler}</p> : null}
        {w.knoepfe.length > 0 ? (
          <div className="stw-knoepfe">
            {w.knoepfe.map((k) => (
              <button
                key={k.schritt}
                type="button"
                className={k.art === 'primaer' ? 'btn' : 'btn sek'}
                disabled={busy}
                onClick={() => { if (k.schritt === 'uebernehmen') setFragt(true); else void schritt(k.schritt); }}
              >
                {k.wort}
              </button>
            ))}
          </div>
        ) : null}
      </article>
      <ConfirmDialog
        open={fragt}
        title="Neuen Weg übernehmen?"
        intro="Ab jetzt rechnet die Box selbst, was mitläuft, und schaltet danach."
        consequences={uebernehmenFolgen(antwort)}
        confirmLabel="Übernehmen"
        busy={busy}
        onConfirm={() => { void schritt('uebernehmen'); }}
        onCancel={() => setFragt(false)}
      />
    </section>
  );
}
