import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type ControllerwechselVorschau, type UemsGeraet, type ZaehlerwechselVorgang } from '../api';
import { controllerAuftrag, controllerFolgen } from '../controllerwechsel';
import { lesen, ortszeit, type ZeitpunktEingabe } from '../picker/zeitpunkt';
import { useRollen } from '../rollen';
import { zeitText } from '../uemsEreignis';
import { VORGABE_ZEITZONE } from '../uemsZustand';
import { wechselAbzeichen, wechselFolgen } from '../zaehlerwechsel';
import { VpZeitpunktPicker } from './VpZeitpunktPicker';
import './ZaehlerwechselDialog.css';

export function ControllerwechselDialog({ geraet, anlageId, jetzt, onClose, onGewechselt }: {
  geraet: UemsGeraet; anlageId: string; jetzt?: string; onClose: () => void; onGewechselt: (v: ZaehlerwechselVorgang) => void;
}) {
  const [uhr] = useState(() => jetzt ?? new Date().toISOString());
  const rollen = useRollen();
  const [ort, setOrt] = useState<{ id: string | null; zone: string } | null>(null);
  const [zeit, setZeit] = useState<ZeitpunktEingabe | null>(null);
  const [vorschau, setVorschau] = useState<ControllerwechselVorschau | null>(null);
  const [uebernommen, setUebernommen] = useState<string[]>([]);
  const [staende, setStaende] = useState<Record<string, string>>({});
  const [typ, setTyp] = useState(geraet.typ ?? '');
  const [seriennummer, setSeriennummer] = useState('');
  const [bestaetigung, setBestaetigung] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<ZaehlerwechselVorgang | null>(null);
  const sperre = useRef(false), fehlerRef = useRef<HTMLParagraphElement>(null);
  const bereichRef = useRef<HTMLDivElement>(null), schrittRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const koerper = bereichRef.current?.closest<HTMLElement>('.dbody');
    if (koerper) koerper.scrollTop = 0;
    if (bestaetigung) schrittRef.current?.focus({ preventScroll: true });
  }, [bestaetigung, ergebnis]);
  useEffect(() => { if (fehler) fehlerRef.current?.focus(); }, [fehler]);
  useEffect(() => {
    let aktiv = true;
    void api.standorte().then(liste => {
      if (!aktiv) return;
      const standort = liste.standorte.find(s => s.anlagen.some(a => a.id === anlageId));
      const zone = standort?.zeitzone ?? VORGABE_ZEITZONE;
      setOrt({ id: standort?.id ?? null, zone }); setZeit(ortszeit(uhr, zone));
    }).catch(e => { if (aktiv) setFehler(e.message); });
    return () => { aktiv = false; };
  }, [anlageId, uhr]);
  const zeitpunkt = ort && zeit ? lesen(zeit, ort.zone).wert : null;
  useEffect(() => {
    let aktiv = true;
    setVorschau(null); setBestaetigung(false);
    if (zeitpunkt) void api.controllerwechselVorschau(geraet.id, zeitpunkt).then(v => {
      if (aktiv) { setVorschau(v); setUebernommen(v.karten.map(k => k.id)); setStaende({}); setFehler(null); }
    }).catch(e => { if (aktiv) setFehler(e.message); });
    return () => { aktiv = false; };
  }, [geraet.id, zeitpunkt]);
  const auftrag = vorschau ? controllerAuftrag(vorschau, uebernommen, staende, typ, seriennummer) : null;
  const abzeichen = zeitpunkt ? wechselAbzeichen(zeitpunkt, uhr) : null;
  const darf = ort && rollen.darf('geraet.einrichten', ort.id) && rollen.darf('messstelle.quelle', ort.id)
    && (!abzeichen?.startsWith('rückwirkend') || rollen.darf('aenderung.rueckwirkend', ort.id));
  const weiter = () => {
    if (!auftrag?.body) { setFehler(auftrag?.fehler ?? 'Bitte wählen Sie einen gültigen Zeitpunkt.'); return; }
    setFehler(null); setBestaetigung(true);
  };
  const speichern = async () => {
    if (!auftrag?.body || !darf || sperre.current) return;
    sperre.current = true; setBusy(true); setFehler(null);
    try { const v = await api.geraetAustauschen(geraet.id, auftrag.body); setErgebnis(v); onGewechselt(v); }
    catch (e) { setFehler(e instanceof Error ? e.message : 'Der Controllerwechsel konnte nicht eingetragen werden.'); setBestaetigung(false); }
    finally { sperre.current = false; setBusy(false); }
  };
  return <Modal open title={ergebnis ? 'Controllerwechsel eingetragen' : 'Controller austauschen'} onClose={() => { if (!busy) onClose(); }}
    footer={ergebnis ? <Button onClick={onClose}>Schließen</Button> : <>
      <Button variant="ghost" disabled={busy} onClick={bestaetigung ? () => setBestaetigung(false) : onClose}>{bestaetigung ? 'Zurück' : 'Abbrechen'}</Button>
      <Button disabled={busy || !vorschau || !darf} onClick={bestaetigung ? () => void speichern() : weiter}>{busy ? 'Wird eingetragen …' : bestaetigung ? 'Controllerwechsel eintragen' : 'Folgen prüfen'}</Button>
    </>}>
    <div className="vp-zw" ref={bereichRef}>
      <p>{geraet.kennzeichen} · {geraet.einbau_kennzeichen}</p>
      {fehler && <p ref={fehlerRef} role="alert" tabIndex={-1} className="vp-zw-fehler">{fehler}</p>}
      {fehler && zeitpunkt && !ergebnis && <Button variant="outline" disabled={busy} onClick={() => {
        setBusy(true);
        void api.controllerwechselVorschau(geraet.id, zeitpunkt).then(v => {
          setVorschau(v); setBestaetigung(false);
          setUebernommen(ids => v.karten.filter(k => ids.includes(k.id) || !vorschau?.karten.some(alt => alt.id === k.id)).map(k => k.id));
          setStaende(alt => Object.fromEntries(Object.entries(alt).filter(([id]) => v.folgen.some(f => f.bindung === id))));
          setFehler(null);
        }).catch(e => setFehler(e.message)).finally(() => setBusy(false));
      }}>Folgen erneut laden</Button>}
      {ergebnis && ort ? <section aria-label="Gespeicherte Folgen" role="status" className="vp-zw-folgen">
        {wechselFolgen(ergebnis, ort.zone, 'Controller').map(s => <p key={s}>{s}</p>)}
      </section> : <>
        <p className="vp-zw-schritt" ref={schrittRef} tabIndex={-1}>Schritt {bestaetigung ? '2 von 2 · Folgen bestätigen' : '1 von 2 · Controller und Karten'}</p>
        {!bestaetigung && ort && zeit && <>
          <VpZeitpunktPicker value={zeit} zone={ort.zone} onChange={setZeit} disabled={busy} />
          {!ort.id && <p>Die Zeitzone ist eine Vorgabe, da kein Standort zugeordnet ist.</p>}
          <div className="vp-zw-raster"><Input label="Typ des neuen Controllers" value={typ} onChange={e => setTyp(e.target.value)} />
            <Input label="Seriennummer (optional)" value={seriennummer} onChange={e => setSeriennummer(e.target.value)} /></div>
          {vorschau?.karten.map(karte => <fieldset key={karte.id}><legend>{karte.bezeichnung ?? `Karte im Steckplatz ${karte.steckplatz ?? 'unbekannt'}`}</legend>
            <label className="vp-zw-check"><input type="checkbox" checked={uebernommen.includes(karte.id)} onChange={e => setUebernommen(ids => e.target.checked ? [...ids, karte.id] : ids.filter(id => id !== karte.id))} />Karte übernommen</label>
            {!uebernommen.includes(karte.id) && <p>Karte ebenfalls neu · Seriennummer noch nicht erfasst.</p>}
            {vorschau.folgen.filter(f => f.karte === karte.id && f.rolle === 'fuehrend' && f.zaehlerstand).map(f =>
              <Input key={f.bindung} label={`Endstand ${f.kennzeichen} (${f.einheit ?? 'Einheit nicht erfasst'}, optional)`} inputMode="decimal"
                value={staende[f.bindung] ?? ''} onChange={e => setStaende(s => ({ ...s, [f.bindung]: e.target.value }))} />)}
          </fieldset>)}
        </>}
        {!vorschau && !fehler && <p role="status">Betroffene Messstellen werden geladen …</p>}
        {bestaetigung && vorschau && ort && <section className="vp-zw-folgen" aria-label="Folgen des Controllerwechsels">
          <h3>Alle betroffenen Messstellen</h3>
          <p>{geraet.einbau_kennzeichen} → neuer Controller · {zeitText(vorschau.zeitpunkt, ort.zone)}</p>
          {abzeichen && <p>{abzeichen}</p>}<p>{typ} · Seriennummer: {seriennummer || 'nicht erfasst'}</p>
          <ul>{controllerFolgen(vorschau).map((text, i) => <li key={vorschau.folgen[i].bindung}>{text}</li>)}</ul>
          {vorschau.karten.map(k => <p key={k.id}>{k.bezeichnung ?? 'Energiekarte'}: {uebernommen.includes(k.id) ? 'übernommen' : 'ebenfalls neu'}</p>)}
          {vorschau.folgen.filter(f => f.zaehlerstand && f.rolle === 'fuehrend').map(f => <p key={f.bindung}>{f.kennzeichen} · Endstand: {staende[f.bindung] || 'nicht erfasst'} {staende[f.bindung] ? f.einheit : ''}</p>)}
          <p>Alle Komponenten wechseln gemeinsam auf den neuen Controller. Alle genannten Quellen enden und beginnen zum selben Zeitpunkt. Bisherige Einstellungen werden übernommen.</p>
          <p>Messstellen, Kennzeichen und Zuordnungen bleiben. Gespeicherte Werte bleiben unverändert; fehlende Werte werden nicht aufgefüllt. Die Zählerstände nach dem Wechsel bleiben unbekannt, bis sie abgelesen oder geliefert werden.</p>
        </section>}
        {ort && !darf && <p role="note">{rollen.grund}</p>}
      </>}
    </div>
  </Modal>;
}
