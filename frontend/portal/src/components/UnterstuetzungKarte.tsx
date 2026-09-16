import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import type { Unterstuetzung, UnterstuetzungAnfrage, UnterstuetzungHinweis } from '../api';
import { selbstauskunft, useRollen } from '../rollen';
import { enddatum, UMFANG, unterstuetzungApi, unterstuetzungFehler } from '../unterstuetzung';
import { UnterstuetzungBeenden, UnterstuetzungDialog } from './UnterstuetzungDialog';
import './Unterstuetzung.css';
export function UnterstuetzungKarte() {
  const rechte = useRollen(); const erlaubt = rechte.darf('unterstuetzung.verwalten', null);
  const [liste, setListe] = useState<Unterstuetzung[] | null>(null);
  const [anfragen, setAnfragen] = useState<UnterstuetzungAnfrage[]>([]);
  const [hinweise, setHinweise] = useState<UnterstuetzungHinweis[]>([]);
  const [fehler, setFehler] = useState('');
  const [dialog, setDialog] = useState<{ anfrage?: UnterstuetzungAnfrage; verlaengern?: Unterstuetzung }>();
  const [entzug, setEntzug] = useState<Unterstuetzung>();
  const laden = useCallback(async () => {
    if (!erlaubt) return;
    try { const [l, a, h] = await Promise.all([unterstuetzungApi.liste(), unterstuetzungApi.anfragen(), unterstuetzungApi.hinweise()]); if (selbstauskunft()?.kundenbereich?.id !== rechte.selbst?.kundenbereich?.id) return; setListe(l); setAnfragen(a); setHinweise(h); setFehler(''); }
    catch { setFehler('Die Unterstützung konnte nicht geladen werden.'); }
  }, [erlaubt, rechte.selbst?.kundenbereich?.id]);
  useEffect(() => { setListe(null); setAnfragen([]); setHinweise([]); void laden(); window.addEventListener('vp-unterstuetzung-geaendert', laden); return () => window.removeEventListener('vp-unterstuetzung-geaendert', laden); }, [laden]);
  if (!erlaubt) return null;
  async function ablehnen(id: string) { try { await unterstuetzungApi.ablehnen(id); await laden(); } catch (e) { setFehler(unterstuetzungFehler(e)); } }
  return <section className="vp-unterstuetzung" aria-label="Unterstützung"><h2>Unterstützung</h2><p>Befristeter Zugriff für Installateur oder VoltPilot-Support. Sie bestimmen Standorte, Umfang und Ende.</p>
    <Button onClick={e => { e.currentTarget.focus(); setDialog({}); }}>Unterstützung gewähren</Button>
    {fehler && <p role="alert">{fehler} <Button variant="ghost" onClick={() => void laden()}>Erneut versuchen</Button></p>}
    {liste?.length === 0 && anfragen.length === 0 && <p>Derzeit gibt es keine Unterstützung.</p>}
    {anfragen.map(a => <article className="vp-unterstuetzung-zeile" key={a.id}><h3>VoltPilot-Support fragt an</h3><p>{a.angefragt_von.name} · {UMFANG[a.umfang]} · bis {a.gueltig_bis.split('-').reverse().join('.')}</p>
      <p>{rechte.selbst?.standorte.filter(s => a.standorte.includes(s.id)).map(s => s.name).join(', ')}</p>{a.grund && <p>Grund: {a.grund}</p>}
      <div className="vp-unterstuetzung-aktionen"><Button onClick={e => { e.currentTarget.focus(); setDialog({ anfrage: a }); }}>Bestätigen oder ändern</Button><Button variant="ghost" onClick={() => void ablehnen(a.id)}>Ablehnen</Button></div></article>)}
    {liste?.map(u => <article key={u.id} className="vp-unterstuetzung-zeile"><h3>{u.art === 'notfall' ? 'Notfall-Zugriff · ' : ''}{u.unterstuetzer.name}</h3>
      <p>{u.banner ?? u.text ?? `Gültig bis ${enddatum(u)}`}</p>{u.grund && <p>Grund: {u.grund}</p>}
      {u.erinnerung && <p>Die Unterstützung endet in höchstens sieben Tagen.</p>}
      {u.zustand !== 'archiviert' && <div className="vp-unterstuetzung-aktionen">{u.art !== 'notfall' && <Button variant="outline" onClick={e => { e.currentTarget.focus(); setDialog({ verlaengern: u }); }}>Verlängern</Button>}
        <Button variant="ghost" onClick={e => { e.currentTarget.focus(); setEntzug(u); }}>Beenden</Button></div>}
    </article>)}
    {hinweise.filter(h => !h.gelesen_am && h.anlass !== 'anfrage').map(h => <article key={h.id} className="vp-unterstuetzung-zeile"><p>{h.text}</p>
      <p className="vp-note">{h.email_versandt_am ? 'Auch per E-Mail zugestellt.' : 'Dieser Hinweis wurde im Portal zugestellt.'}</p>
      <Button variant="ghost" onClick={() => void unterstuetzungApi.gelesen(h.id).then(laden).catch(e => setFehler(unterstuetzungFehler(e)))}>Als gelesen markieren</Button></article>)}
    {dialog && <UnterstuetzungDialog {...dialog} onClose={() => setDialog(undefined)} onSaved={() => void laden()} />}
    {entzug && <UnterstuetzungBeenden zugriff={entzug} onClose={() => setEntzug(undefined)} onSaved={() => void laden()} />}
  </section>;
}
