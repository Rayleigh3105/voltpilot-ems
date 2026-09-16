import { kanalRegelText } from '../bezugsKanal';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type Bezugsgroesse, type BezugsKanalAuswahl, type BezugsKanalbindung } from '../api';
import { useRollen } from '../rollen';
import { fehlerSatz } from '../bezugsgroesseListe';
import { zeitText } from '../werteEingabe';
import { lesen, ortszeit } from '../picker/zeitpunkt';
import { zahl } from '../zahl';
import { VpPicker } from './VpPicker';
import { VpZeitpunktPicker } from './VpZeitpunktPicker';

export const BINDUNGS_HINWEIS = 'Im gebundenen Zeitraum sind Eingabe und Import nicht möglich. Werte erscheinen nach Periodenende.';
export function bindungsRegel(b: BezugsKanalbindung) {
  return b.wertart === 'gauge' ? kanalRegelText(`Gradtage G${b.raumtemperatur}/${b.heizgrenze}`) : b.wertart === 'state' ? `Zeit im Zustand „${b.zustand}“` : 'Zähler-Differenz';
}
export function BezugsKanalbindung({ bezug, standort, zone, onChanged }: { onChanged?: () => void; bezug: Bezugsgroesse; standort: string | null | undefined; zone: string }) {
  const { darf } = useRollen();
  const erlaubt = !bezug.archiviert_am && standort !== undefined && darf('bezugsgroesse.verwalten', standort);
  const [offen, setOffen] = useState(false), [neu, setNeu] = useState(0);
  const [bindungen, setBindungen] = useState<BezugsKanalbindung[] | null>(null);
  const [ladefehler, setLadefehler] = useState(false);
  const [dialog, setDialog] = useState<{ ende: BezugsKanalbindung | null } | null>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  const ueberschrift = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!offen) return;
    let aktiv = true; setLadefehler(false);
    api.kanalbindungen(bezug.id).then(x => { if (aktiv) setBindungen(x); }, () => { if (aktiv) setLadefehler(true); });
    return () => { aktiv = false; };
  }, [offen, neu, bezug.id]);
  const schliessen = () => { setDialog(null); requestAnimationFrame(() => (ausloeser.current?.isConnected ? ausloeser.current : ueberschrift.current)?.focus()); };
  return <details className="vp-wert-liste" onToggle={e => setOffen(e.currentTarget.open)}><summary ref={ueberschrift}>Messkanal</summary>
    {ladefehler ? <><p role="alert">Die Kanalbindungen konnten nicht geladen werden.</p><Button variant="outline" onClick={() => setNeu(n => n + 1)}>Erneut versuchen</Button></> : !bindungen ? <p>Messkanäle werden geladen …</p> : <>
      {bindungen.length === 0 && <p>Es ist kein Messkanal gebunden.</p>}
      {bindungen.map(b => <div key={b.id} className="vp-wert-zeile"><p><strong>{bindungsRegel(b)}</strong> · {b.kanal}</p><p>Ab {zeitText(b.von, zone)}{b.bis ? ` bis ${zeitText(b.bis, zone)} (Ende ausschließlich)` : ''}</p>
        {erlaubt && !b.bis && <Button variant="outline" onClick={e => { ausloeser.current = e.currentTarget; setDialog({ ende: b }); }}>Bindung beenden</Button>}
      </div>)}
      {bindungen.length > 0 && <p>{BINDUNGS_HINWEIS}</p>}
      {erlaubt && !bindungen.some(b => !b.bis) && <Button variant="outline" onClick={e => { ausloeser.current = e.currentTarget; setDialog({ ende: null }); }}>Messkanal binden</Button>}
    </>}
    {dialog && erlaubt && <BindungsDialog bezug={bezug} zone={zone} ende={dialog.ende} erlaubt={erlaubt} onClose={schliessen} onSaved={() => { setNeu(n => n + 1); onChanged?.(); schliessen(); }} />}
  </details>;
}
function BindungsDialog({ bezug, zone, ende, erlaubt, onClose, onSaved }: { bezug: Bezugsgroesse; zone: string; ende: BezugsKanalbindung | null; erlaubt: boolean; onClose: () => void; onSaved: () => void }) {
  const [kanaele, setKanaele] = useState<BezugsKanalAuswahl[] | null>(null);
  const [kanal, setKanal] = useState<string | null>(null), [zustand, setZustand] = useState<string | null>(null);
  const [raum, setRaum] = useState('20'), [grenze, setGrenze] = useState('15');
  const [zeit, setZeit] = useState(() => ortszeit(Date.now(), zone));
  const [fehler, setFehler] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (ende) return; let aktiv = true;
    api.bezugsKanaele(bezug.id).then(x => { if (aktiv) setKanaele(x); }, () => { if (aktiv) setFehler('Die Messkanäle konnten nicht geladen werden. Bitte öffnen Sie den Dialog erneut.'); });
    return () => { aktiv = false; };
  }, [bezug.id, ende]);
  const gewaehlt = kanaele?.find(k => `${k.entity_id}/${k.kanal}` === kanal);
  const speichern = async () => {
    if (!erlaubt || busy) return;
    const t = lesen(zeit, zone), r = zahl(raum), g = zahl(grenze);
    const falsch = !t.wert ? t.fehler : !ende && !gewaehlt ? 'Bitte wählen Sie einen Messkanal.'
      : !ende && !gewaehlt?.liefert ? 'Dieser Kanal liefert zurzeit keine Daten.'
      : !ende && gewaehlt?.erste_messung && Date.parse(t.wert!) < Date.parse(gewaehlt.erste_messung) ? 'Die Bindung beginnt frühestens mit dem ersten gespeicherten Messwert.'
      : gewaehlt?.wertart === 'state' && !zustand ? 'Bitte wählen Sie den Zustand.'
      : gewaehlt?.wertart === 'gauge' && (r === null || g === null || r <= g) ? 'Die Raumtemperatur muss über der Heizgrenze liegen.' : null;
    if (falsch) { setFehler(falsch); requestAnimationFrame(() => form.current?.querySelector<HTMLElement>(!gewaehlt && !ende ? '[role="combobox"]' : '[role="alert"]')?.focus()); return; }
    setBusy(true); setFehler(null);
    try {
      if (ende) await api.kanalBeenden(bezug.id, ende.id, t.wert!);
      else await api.kanalBinden(bezug.id, { entity_id: gewaehlt!.entity_id, kanal: gewaehlt!.kanal, von: t.wert!, ...(gewaehlt!.wertart === 'state' ? { zustand: zustand! } : {}), ...(gewaehlt!.wertart === 'gauge' ? { raumtemperatur: r!, heizgrenze: g! } : {}) });
      onSaved();
    } catch (e) { setFehler(e instanceof ApiError && e.body && typeof e.body === 'object' && 'message' in e.body ? String(e.body.message) : fehlerSatz(e)); requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[role="alert"]')?.focus()); }
    finally { setBusy(false); }
  };
  return <Modal open title={ende ? 'Bindung beenden' : 'Messkanal binden'} onClose={() => { if (!busy) onClose(); }} footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Abbrechen</Button><Button type="submit" form="kanalbindung-form" disabled={busy}>{busy ? 'Wird gespeichert …' : ende ? 'Bindung beenden' : 'Binden'}</Button></>}>
    <form id="kanalbindung-form" className="vp-bz-form" ref={form} noValidate onSubmit={e => { e.preventDefault(); void speichern(); }}>
      <p>{bezug.kennzeichen} · {bezug.name}</p>
      {!ende && <VpPicker label="Messkanal" value={kanal} placeholder="Messkanal wählen …" disabled={busy || !kanaele} options={(kanaele ?? []).map(k => ({ value: `${k.entity_id}/${k.kanal}`, label: `${k.komponente} · ${k.name || k.kanal}`, sub: `${k.wertart === 'gauge' ? 'Temperatur' : k.wertart === 'state' ? 'Zustand' : 'Zähler'}${k.liefert ? '' : ' · liefert keine Daten'}` }))} onChange={v => { setKanal(v); setZustand(null); setFehler(null); }} />}
      {!ende && kanaele?.length === 0 && <p>Es gibt noch keinen passenden Messkanal. Richten Sie einen Kanal mit passender Wertart und Einheit am Gerät ein.</p>}
      {gewaehlt?.erste_messung && <p>Erster Messwert: {zeitText(gewaehlt.erste_messung, zone)}</p>}
      {gewaehlt && !gewaehlt.liefert && <p>Dieser Kanal liefert zurzeit keine Daten. Die Bindung ist erst möglich, wenn wieder Messwerte eintreffen.</p>}
      {gewaehlt?.wertart === 'state' && <VpPicker label="Zustand" value={zustand} options={gewaehlt.zustaende.map(s => ({ value: s, label: s }))} onChange={setZustand} disabled={busy} placeholder="Zustand wählen …" />}
      {gewaehlt?.wertart === 'gauge' && <><p>Wählen Sie die gemessene Außentemperatur des Standorts. Vorhersage-Wetter ist keine Messung.</p><div className="vp-bz-felder"><Input label="Raumtemperatur (°C)" value={raum} onChange={e => setRaum(e.target.value)} inputMode="decimal" disabled={busy} /><Input label="Heizgrenze (°C)" value={grenze} onChange={e => setGrenze(e.target.value)} inputMode="decimal" disabled={busy} /></div><p>Unterhalb der Heizgrenze zählt Raumtemperatur minus Tagesmittel. Fehlende Tagesmittel bleiben als Lücke sichtbar.</p></>}
      <p><strong>{ende ? 'Gültig bis (Ende ausschließlich)' : 'Gültig ab'}</strong></p><VpZeitpunktPicker value={zeit} zone={zone} onChange={setZeit} disabled={busy} />
      <p>{BINDUNGS_HINWEIS}</p>{fehler && <p role="alert" tabIndex={-1}>{fehler}</p>}
    </form>
  </Modal>;
}
