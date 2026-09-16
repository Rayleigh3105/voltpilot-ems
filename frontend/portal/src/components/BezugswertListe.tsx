import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type Bezugsgroesse, type BezugsgroesseWert } from '../api';
import { useRollen } from '../rollen';
import { schluesselVon } from '../bezugsPeriode';
import { betrag, periodenText, zeitText } from '../werteEingabe';
import { BezugswertDialog } from './BezugswertDialog';
import './WerteEingabe.css';
export function BezugswertListe({ bezug, standort, zone }: { bezug: Bezugsgroesse; standort: string | null | undefined; zone: string }) {
  const [offen, setOffen] = useState(false), [neu, setNeu] = useState(0);
  const [werte, setWerte] = useState<BezugsgroesseWert[] | null>(null);
  const [fehler, setFehler] = useState(false), [meldung, setMeldung] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ alt: BezugsgroesseWert | null } | null>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  const { darf } = useRollen();
  const erlaubt = standort !== undefined && darf('bezugsgroesse.eingeben', standort) && !bezug.archiviert_am;
  useEffect(() => { if (!offen) return; let aktiv = true; setFehler(false);
    api.bezugsgroesseWerte(bezug.id, { fassungen: 'alle' }).then(a => { if (aktiv) setWerte(a.werte); }, () => { if (aktiv) setFehler(true); });
    return () => { aktiv = false; };
  }, [offen, neu, bezug.id]);
  const schliessen = () => { setDialog(null); requestAnimationFrame(() => ausloeser.current?.focus()); };
  return <details className="vp-wert-liste" onToggle={e => setOffen(e.currentTarget.open)}><summary>Werte und Fassungen</summary>
    {fehler ? <><p role="alert">Die Werte konnten nicht geladen werden.</p><Button variant="outline" onClick={() => setNeu(n => n + 1)}>Erneut versuchen</Button></> : !werte ? <p role="status">Werte werden geladen …</p> : <>
      {meldung && <p role="status">{meldung}</p>}
      {werte.length === 0 && <p>— keine Werte</p>}
      {werte.map(w => <div className="vp-wert-zeile" key={w.periode_von ?? w.zeitpunkt}>
        <strong>{w.periode_von ? periodenText(schluesselVon(w.periode_von, bezug.periode_art!), bezug.periode_art!) : w.zeitpunkt}</strong>
        <p>{betrag(w.wirksamer_betrag)}{w.wirksamer_betrag !== null ? ` ${bezug.einheit} · Fassung ${w.wirksame_fassung}` : ''}</p>
        {w.vorschlag && <p>Vorschlag von {w.vorschlag.urheber.name}: {betrag(w.vorschlag.betrag)} {bezug.einheit}. Bis zur Freigabe gilt der bisherige Wert. {w.vorschlag.begruendung}</p>}
        <details><summary>Fassungen ansehen ({w.fassungen.length})</summary>{w.fassungen.map(f => <div className="vp-wert-fassung" key={f.fassung}>
          <strong>Fassung {f.fassung} · {betrag(f.betrag)} {bezug.einheit}</strong>
          <p>{f.herkunft.art === 'eingabe' ? 'Eingegeben' : f.herkunft.art === 'import' ? 'Importiert' : 'Messkanal'} · {f.urheber.name} · {zeitText(f.eingetragen_am, w.zeitzone)}</p>
          {f.herkunft.import_kennung && <p>{f.herkunft.import_kennung} · Zeile {f.herkunft.import_zeile} · {f.herkunft.geliefert_text} {f.herkunft.geliefert_einheit}</p>}
          {f.begruendung && <p>{f.begruendung}</p>}{f.freigeber && <p>Freigegeben von {f.freigeber.name}</p>}
        </div>)}</details>
        {erlaubt && !w.vorschlag && !w.stand_offen && <Button variant="ghost" onClick={e => { ausloeser.current = e.currentTarget; setDialog({ alt: w }); }}>Berichtigen</Button>}
      </div>)}
      {erlaubt && <Button variant="outline" onClick={e => { ausloeser.current = e.currentTarget; setDialog({ alt: null }); }}>Wert eingeben</Button>}
    </>}
    {dialog && werte && standort !== undefined && erlaubt && <BezugswertDialog bezug={bezug} werte={werte} alt={dialog.alt} standort={standort} zone={zone} onClose={schliessen} onSaved={a => { setMeldung([a.satz, ...a.hinweise.map(h => h.satz)].join(' ')); setWerte(ws => [...(ws ?? []).filter(w => w.periode_von !== a.wert.periode_von), a.wert]); schliessen(); }} />}
  </details>;
}
