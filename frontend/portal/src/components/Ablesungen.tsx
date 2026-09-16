import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type Ablesung, type AblesungAntwort } from '../api';
import { useRollen } from '../rollen';
import { betrag, periodenText, zeitText, wirksameAblesungen } from '../werteEingabe';
import { AblesungDialog } from './AblesungDialog';
import '../pages/BezugsgroessenPage.css';
import './WerteEingabe.css';
export function Ablesungen({ kennzeichen, einheit, zone, archiviert = false }: { kennzeichen: string; einheit: string; zone: string; archiviert?: boolean }) {
  const [alle, setAlle] = useState<Ablesung[] | null>(null), [neu, setNeu] = useState(0);
  const [fehler, setFehler] = useState(false), [antwort, setAntwort] = useState<AblesungAntwort | null>(null);
  const [dialog, setDialog] = useState<{ alt: Ablesung | null } | null>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  const { darf } = useRollen();
  const erlaubt = !archiviert && darf('ablesung.erfassen');
  useEffect(() => { let aktiv = true; setFehler(false); api.ablesungen(kennzeichen).then(a => { if (aktiv) setAlle(a); }, () => { if (aktiv) setFehler(true); }); return () => { aktiv = false; }; }, [kennzeichen, neu]);
  const schliessen = () => { setDialog(null); requestAnimationFrame(() => ausloeser.current?.focus()); };
  return <section className="vp-wert-liste" aria-label="Ablesungen"><h2>Ablesungen</h2><p>Zeitzone: {zone}</p>
    {fehler ? <><p role="alert">Die Ablesungen konnten nicht geladen werden.</p><Button variant="outline" onClick={() => setNeu(n => n + 1)}>Erneut versuchen</Button></> : !alle ? <p role="status">Ablesungen werden geladen …</p> : <>
      {antwort && <div role="status"><p>{antwort.urteil === 'vorschlag' ? 'Vorschlag gesendet — bis zur Freigabe gilt der bisherige Stand.' : antwort.urteil === 'wiederholung' ? 'Diese Ablesung ist bereits gespeichert.' : 'Ablesung gespeichert.'} {antwort.korrektur}</p>
        {antwort.ablesezeitraum && <p>{antwort.ablesezeitraum.kennzeichen} · {betrag(antwort.ablesezeitraum.menge)} {einheit} · {antwort.ablesezeitraum.zustand}</p>}</div>}
      {alle.length === 0 && <p>Noch keine Ablesungen. Tragen Sie den ersten Zählerstand ein.</p>}
      {wirksameAblesungen(alle).map(a => <div className="vp-wert-zeile" key={a.zeitpunkt}>
        <strong>{zeitText(a.zeitpunkt, zone)} · {betrag(a.stand)} {einheit}</strong>
        <p>{a.monat ? `Gilt für ${periodenText(a.monat.slice(0, 7), 'monat')}` : 'Keinem Monat zugeordnet'} · Fassung {a.fassung}</p>
        <details><summary>Fassungen ansehen</summary>{alle.filter(f => f.zeitpunkt === a.zeitpunkt).map(f => <div className="vp-wert-fassung" key={f.fassung}><strong>Fassung {f.fassung} · {betrag(f.stand)} {einheit}</strong><p>{f.woher === 'import' ? 'Importiert' : 'Eingegeben'} · {f.urheber.name} · {zeitText(f.eingetragen_am, zone)}</p><p>{f.monat ? `Gilt für ${periodenText(f.monat.slice(0, 7), 'monat')}` : 'Keinem Monat zugeordnet'}{f.korrektur ? ` · ${f.korrektur}` : ''}</p></div>)}</details>
        {erlaubt && <Button variant="ghost" onClick={e => { ausloeser.current = e.currentTarget; setDialog({ alt: a }); }}>Berichtigen</Button>}
      </div>)}
      {erlaubt && <Button variant="outline" onClick={e => { ausloeser.current = e.currentTarget; setDialog({ alt: null }); }}>Ablesung eintragen</Button>}
    </>}
    {dialog && alle && erlaubt && <AblesungDialog kennzeichen={kennzeichen} einheit={einheit} zone={zone} alle={alle} alt={dialog.alt} onClose={schliessen} onSaved={a => { setAntwort(a); setNeu(n => n + 1); schliessen(); }} />}
  </section>;
}
