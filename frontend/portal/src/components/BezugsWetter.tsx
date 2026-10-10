import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type Bezugsgroesse, type Wetterbezug } from '../api';
import { useRollen } from '../rollen';
import { fehlerSatz } from '../bezugsgroesseListe';
import { heuteIn } from '../kennzahlKarte';
import { zahl } from '../zahl';
import { ConfirmDialog } from './ConfirmDialog';
import { VpDatePicker } from './VpDatePicker';
import * as W from '../wetterBezug';

const satzAus = (e: unknown) => e instanceof ApiError && e.body && typeof e.body === 'object' && 'message' in e.body ? String(e.body.message) : fehlerSatz(e);
const gestern = (zone: string) => { const d = new Date(`${heuteIn(zone, Date.now())}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

/**
 * AP-17 IP-12c: der Abschnitt „Wetter“ an einer Gradtagzahl — binden an das Wetter-Archiv (kein sofortiger Abruf, der
 * Läufer holt täglich), Zustand mit letztem Abruf und „x von y Tagen“, lösen (die Werte bleiben). Ohne Koordinaten
 * am Standort steht der Satz aus §5.8 statt des Knopfs.
 */
export function BezugsWetter({ bezug, standort, zone, onChanged }: { bezug: Bezugsgroesse; standort: string | null | undefined; zone: string; onChanged?: () => void }) {
  const { darf } = useRollen();
  const erlaubt = !bezug.archiviert_am && standort !== undefined && darf('bezugsgroesse.verwalten', standort);
  const [offen, setOffen] = useState(false), [neu, setNeu] = useState(0);
  const [sicht, setSicht] = useState<Wetterbezug | null>(null);
  const [ladefehler, setLadefehler] = useState(false);
  const [dialog, setDialog] = useState<'binden' | 'loesen' | null>(null);
  const [busy, setBusy] = useState(false), [fehler, setFehler] = useState<string | null>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  const ueberschrift = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!offen) return;
    let aktiv = true; setLadefehler(false);
    api.wetterbezug(bezug.id).then(x => { if (aktiv) setSicht(x); }, () => { if (aktiv) setLadefehler(true); });
    return () => { aktiv = false; };
  }, [offen, neu, bezug.id]);
  const schliessen = () => { setDialog(null); setFehler(null); requestAnimationFrame(() => (ausloeser.current?.isConnected ? ausloeser.current : ueberschrift.current)?.focus()); };
  const loesen = async () => {
    if (!erlaubt || busy) return;
    setBusy(true); setFehler(null);
    try { await api.wetterLoesen(bezug.id); setNeu(n => n + 1); onChanged?.(); schliessen(); }
    catch (e) { setFehler(satzAus(e)); }
    finally { setBusy(false); }
  };
  const b = sicht?.bindung ?? null;
  return <details className="vp-wert-liste" data-testid="bezugsgroesse-wetter" onToggle={e => setOffen(e.currentTarget.open)}><summary ref={ueberschrift}>{W.WETTER}</summary>
    {ladefehler ? <><p role="alert">Der Wetterbezug konnte nicht geladen werden.</p><Button variant="outline" onClick={() => setNeu(n => n + 1)}>Erneut versuchen</Button></> : !sicht ? <p>Wetter wird geladen …</p> : <>
      {b ? <div className="vp-wert-zeile">
        <p><strong>{W.bindungText(b)}</strong></p>
        <p data-testid="wetter-zustand">{W.zustandSatz(b)}</p>
        <p>{W.KENNZEICHEN_SATZ}</p>
        {erlaubt && <Button variant="outline" onClick={e => { ausloeser.current = e.currentTarget; setDialog('loesen'); }}>{W.WETTER_LOESEN}</Button>}
      </div> : !sicht.moeglich ? <p>{W.NUR_GRADTAGZAHL}</p> : !sicht.koordinaten ? <p data-testid="wetter-koordinaten-fehlen">{sicht.satz}</p> : <>
        <p>Es wird kein Wetter bezogen.</p>
        {erlaubt && <Button variant="outline" onClick={e => { ausloeser.current = e.currentTarget; setDialog('binden'); }}>{W.WETTER_BEZIEHEN}</Button>}
      </>}
    </>}
    {dialog === 'binden' && erlaubt && <BindenDialog bezug={bezug} zone={zone} onClose={schliessen} onSaved={() => { setNeu(n => n + 1); onChanged?.(); schliessen(); }} />}
    {dialog === 'loesen' && erlaubt && <ConfirmDialog open title="Wetterbezug lösen?" intro={`„${bezug.name}“ bezieht danach kein Wetter mehr.`} consequences={W.LOESEN_FOLGEN} confirmLabel={W.WETTER_LOESEN} busy={busy} onConfirm={() => void loesen()} onCancel={() => { if (!busy) schliessen(); }} extra={fehler ? <p role="alert">{fehler}</p> : undefined} />}
  </details>;
}

function BindenDialog({ bezug, zone, onClose, onSaved }: { bezug: Bezugsgroesse; zone: string; onClose: () => void; onSaved: () => void }) {
  const monat = bezug.periode_art === 'monat';
  const bis = gestern(zone);
  const [von, setVon] = useState(() => monat ? `${bis.slice(0, 7)}-01` : bis);
  const [raum, setRaum] = useState('20'), [grenze, setGrenze] = useState('15');
  const [fehler, setFehler] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const speichern = async () => {
    if (busy) return;
    const r = zahl(raum), g = zahl(grenze);
    const tag = monat ? `${von.slice(0, 7)}-01` : von;
    const falsch = !tag || tag > bis ? 'Der Bezug beginnt spätestens mit dem gestrigen Tag.'
      : r === null || g === null || r <= g ? 'Die Raumtemperatur muss über der Heizgrenze liegen.' : null;
    if (falsch) { setFehler(falsch); requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[role="alert"]')?.focus()); return; }
    setBusy(true); setFehler(null);
    try { await api.wetterBinden(bezug.id, { von: tag, raumtemperatur: r!, heizgrenze: g! }); onSaved(); }
    catch (e) { setFehler(satzAus(e)); requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[role="alert"]')?.focus()); }
    finally { setBusy(false); }
  };
  return <Modal open title={W.WETTER_BEZIEHEN} onClose={() => { if (!busy) onClose(); }} footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Abbrechen</Button><Button type="submit" form="wetterbezug-form" disabled={busy}>{busy ? 'Wird gespeichert …' : W.WETTER_BEZIEHEN}</Button></>}>
    <form id="wetterbezug-form" className="vp-bz-form" ref={form} noValidate onSubmit={e => { e.preventDefault(); void speichern(); }}>
      <p>{bezug.kennzeichen} · {bezug.name}</p>
      <p>VoltPilot bezieht das Tagesmittel der Außentemperatur über die Koordinaten des Standorts, nur Tage bis gestern. Der erste Abruf folgt beim nächsten täglichen Lauf.</p>
      <VpDatePicker label={monat ? 'Ab Monat' : 'Ab Tag'} art={monat ? 'monat' : 'tag'} value={monat ? von.slice(0, 7) : von} max={monat ? bis.slice(0, 7) : bis} onChange={v => setVon(monat ? `${v}-01` : v)} disabled={busy} />
      <div className="vp-bz-felder"><Input label="Raumtemperatur (°C)" value={raum} onChange={e => setRaum(e.target.value)} inputMode="decimal" disabled={busy} /><Input label="Heizgrenze (°C)" value={grenze} onChange={e => setGrenze(e.target.value)} inputMode="decimal" disabled={busy} /></div>
      <p>Unterhalb der Heizgrenze zählt Raumtemperatur minus Tagesmittel. Ein fehlender Tag bleibt eine Lücke, nie 0.</p>
      {fehler && <p role="alert" tabIndex={-1}>{fehler}</p>}
    </form>
  </Modal>;
}
