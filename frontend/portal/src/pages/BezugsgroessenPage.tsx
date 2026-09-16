import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api } from '../api';
import { useRollen } from '../rollen';
import { heuteIn } from '../kennzahlKarte';
import { VORGABE_ZEITZONE } from '../uemsOrtsbaum';
import { VpPicker } from '../components/VpPicker';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BezugsgroesseAnlegenDialog } from '../components/BezugsgroesseAnlegenDialog';
import * as B from '../bezugsgroesseListe';
import './BezugsgroessenPage.css';

async function laden(): Promise<{ liste: B.Liste; daten: B.OrtsDaten; orte: B.Ort[] }> {
  const [liste, unternehmen, standorte, prozesse, kostenstellen, register] = await Promise.all([
    api.bezugsgroessen(), api.unternehmen(), api.standorte(), api.prozesse(), api.kostenstellen(), api.messstellenRegister(),
  ]);
  const baeume = await Promise.all(standorte.standorte.map(s => api.standortOrte(s.id)));
  const daten = { unternehmen, standorte: standorte.standorte, baeume, prozesse: prozesse.prozesse, kostenstellen: kostenstellen.kostenstellen, messstellen: register.register };
  return { liste, daten, orte: B.geltungsOrte(daten, heuteIn(unternehmen.zeitzone ?? VORGABE_ZEITZONE, Date.now())) };
}

/** Eigene Unternehmenswelt nach Firstmate-Entscheid 001 (AP-09 IP-9), keine Standortseite. */
export function BezugsgroessenPage() {
  const [stand, setStand] = useState<Awaited<ReturnType<typeof laden>> | null>(null);
  const [ladefehler, setLadefehler] = useState(false);
  const [neu, setNeu] = useState(0);
  const [filter, setFilter] = useState({ standort: null as string | null, prozess: null as string | null, archiviert: false });
  const [anlegen, setAnlegen] = useState(false);
  const [archiv, setArchiv] = useState<B.Zeile | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [erfolg, setErfolg] = useState<string | null>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  const kopf = useRef<HTMLHeadingElement>(null);
  const { darf } = useRollen();
  const verwalten = (standort: string | null) => darf('bezugsgroesse.verwalten', standort);
  useEffect(() => {
    let aktiv = true;
    setLadefehler(false);
    laden().then(x => { if (aktiv) setStand(x); }, () => { if (aktiv) setLadefehler(true); });
    return () => { aktiv = false; };
  }, [neu]);
  const schliessen = () => { setAnlegen(false); setArchiv(null); setFehler(null); requestAnimationFrame(() => (ausloeser.current?.isConnected ? ausloeser.current : kopf.current)?.focus()); };
  const archivieren = async () => {
    if (!archiv?.original || archiv.standort === undefined || !verwalten(archiv.standort) || busy) return;
    setBusy(true); setFehler(null);
    try {
      const b = await api.bezugsgroesseArchivieren(archiv.original.id);
      setStand(s => s ? { ...s, liste: { ...s.liste, bezugsgroessen: s.liste.bezugsgroessen.map(x => x.id === b.id ? b : x) } } : s);
      setErfolg(`${b.name} ist archiviert.`); schliessen();
    } catch (e) { setFehler(B.fehlerSatz(e)); }
    finally { setBusy(false); }
  };
  const alle = stand ? B.zeilen(stand.liste, stand.orte) : [];
  const zeilen = B.filtern(alle, filter);
  return <section className="vp-bz" aria-label={B.TITEL}>
    <header className="vp-bz-kopf">
      <div><h1 tabIndex={-1} ref={kopf}>{B.TITEL}</h1><p>Die Grundlage für Kennzahlen je Kilogramm, Stunde oder Quadratmeter.</p></div>
      {stand && stand.orte.some(o => o.waehlbar && verwalten(o.standort)) && <Button onClick={e => { ausloeser.current = e.currentTarget; setAnlegen(true); setErfolg(null); }}><Icon name="plus" size={16} />{B.ANLEGEN}</Button>}
    </header>
    {erfolg && <p role="status" className="vp-bz-erfolg">{erfolg}</p>}
    {ladefehler ? <div role="alert"><p>Die Bezugsgrößen konnten nicht geladen werden.</p><Button variant="outline" onClick={() => setNeu(n => n + 1)}>Erneut versuchen</Button></div> : !stand ? <p role="status">Bezugsgrößen werden geladen …</p> : <>
      <div className="vp-bz-filter">
        <VpPicker label="Standort" value={filter.standort ?? 'alle'} options={[{ value: 'alle', label: 'Alle Standorte' }, ...stand.daten.standorte.filter(s => s.zustand !== 'archiviert').map(s => ({ value: s.id, label: s.name }))]} onChange={s => setFilter(f => ({ ...f, standort: s === 'alle' ? null : s, prozess: null }))} />
        <VpPicker label="Prozess" value={filter.prozess ?? 'alle'} options={[{ value: 'alle', label: 'Alle Prozesse' }, ...stand.daten.prozesse.map(p => ({ value: p.id, label: p.name, sub: p.kennzeichen }))]} onChange={p => setFilter(f => ({ ...f, prozess: p === 'alle' ? null : p, standort: null }))} />
        <VpPicker label="Anzeige" value={filter.archiviert ? 'archiviert' : 'aktiv'} options={[{ value: 'aktiv', label: 'Aktiv' }, { value: 'archiviert', label: 'Archiviert' }]} onChange={v => setFilter(f => ({ ...f, archiviert: v === 'archiviert' }))} />
      </div>
      {filter.standort && <p className="vp-bz-hinweis">Bezugsgrößen des Unternehmens, der Prozesse und Kostenstellen sehen Sie unter „Alle Standorte“.</p>}
      {zeilen.length === 0 ? <div className="vp-bz-leer"><Icon name="layers" size={28} /><h2>{alle.length === 0 ? B.LEER : filter.archiviert ? 'Keine archivierten Bezugsgrößen' : 'Keine Bezugsgrößen für diese Auswahl'}</h2><p>{alle.length === 0 ? B.LEER_SATZ : 'Ändern Sie die Auswahl, um weitere Bezugsgrößen zu sehen.'}</p></div> : <ul className="vp-bz-liste">
        {zeilen.map(z => <li className="vp-bz-karte" key={z.key} data-testid="bezugsgroesse-karte">
          <div className="vp-bz-kennung"><span>{z.kennzeichen ?? 'Bezugsfläche'}</span><span className="vp-bz-status">{z.status}</span></div>
          <h2>{z.name}</h2><p className="vp-bz-einheit">{z.einheit}</p><p>{z.geltung}</p>
          {z.flaeche && <p className="vp-bz-hinweis">Flächen werden in der Ortsstruktur gepflegt.</p>}
          {z.flaeche && z.standort && <a className="vp-bz-weg" href={`#/standort/${encodeURIComponent(z.standort)}/gebaeude`}>Gebäude und Bereiche ansehen<Icon name="chevron-right" size={16} /></a>}
          {z.original && !z.archiviert && z.standort !== undefined && verwalten(z.standort) && <Button variant="ghost" onClick={e => { ausloeser.current = e.currentTarget; setArchiv(z); setErfolg(null); }}>Archivieren</Button>}
        </li>)}
      </ul>}
    </>}
    {anlegen && stand && <BezugsgroesseAnlegenDialog orte={stand.orte} onClose={schliessen} onGespeichert={b => { setStand(s => s ? { ...s, liste: { ...s.liste, bezugsgroessen: [...s.liste.bezugsgroessen, b] } } : s); setFilter({ standort: null, prozess: null, archiviert: false }); setErfolg(`${b.kennzeichen} · ${b.name} ist angelegt.`); schliessen(); }} />}
    {archiv && archiv.standort !== undefined && verwalten(archiv.standort) && <ConfirmDialog open title="Bezugsgröße archivieren?" intro={`„${archiv.name}“ wird archiviert.`} consequences={B.ARCHIV_FOLGEN} confirmLabel="Archivieren" busy={busy} onConfirm={() => void archivieren()} onCancel={() => { if (!busy) schliessen(); }} extra={fehler ? <p role="alert">{fehler}</p> : undefined} />}
  </section>;
}
