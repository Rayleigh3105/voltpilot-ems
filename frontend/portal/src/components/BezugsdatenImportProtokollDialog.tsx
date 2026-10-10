import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { ApiError, api, type BezugsdatenImportProtokollEintrag, type BezugsdatenRuecknahmeVorschau } from '../api';
import { IMPORT_STATUS, kannZuruecknehmen, ruecknahmeSaetze } from '../bezugsdatenImportProtokoll';
import { URTEIL_LABEL } from '../bezugsdatenVorschau';
import './BezugsdatenImportDialog.css';

const datum = (wert: string) => new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(wert));
const fehlerSatz = (e: unknown) => e instanceof ApiError ? e.message : 'Das Import-Protokoll konnte nicht geladen werden.';

export function BezugsdatenImportProtokollDialog({ startKennung, onClose }: { startKennung?: string | null; onClose: () => void }) {
  const [importe, setImporte] = useState<BezugsdatenImportProtokollEintrag[]>([]);
  const [detail, setDetail] = useState<BezugsdatenImportProtokollEintrag | null>(null);
  const [vorschau, setVorschau] = useState<BezugsdatenRuecknahmeVorschau | null>(null);
  const [begruendung, setBegruendung] = useState('');
  const [busy, setBusy] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const fehlerRef = useRef<HTMLParagraphElement>(null);

  const laden = async () => {
    setBusy(true); setFehler(null);
    try {
      const liste = await api.bezugsdatenImporte(); setImporte(liste.importe);
      if (startKennung) setDetail(await api.bezugsdatenImport(startKennung));
    } catch (e) { setFehler(fehlerSatz(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void laden(); }, []);
  useEffect(() => { if (fehler) requestAnimationFrame(() => fehlerRef.current?.focus()); }, [fehler]);

  const oeffnen = async (kennung: string) => {
    setBusy(true); setFehler(null); setVorschau(null); setBegruendung('');
    try { setDetail(await api.bezugsdatenImport(kennung)); }
    catch (e) { setFehler(fehlerSatz(e)); }
    finally { setBusy(false); }
  };
  const ruecknahmePruefen = async () => {
    if (!detail) return; setBusy(true); setFehler(null);
    try { setVorschau(await api.bezugsdatenRuecknahmeVorschau(detail.kennung)); }
    catch (e) { setFehler(fehlerSatz(e)); }
    finally { setBusy(false); }
  };
  const zuruecknehmen = async () => {
    if (!detail || !vorschau || begruendung.trim().length < 10) return;
    setBusy(true); setFehler(null);
    try { await api.bezugsdatenImportZuruecknehmen(detail.kennung, begruendung.trim()); setVorschau(null); setDetail(null); await laden(); }
    catch (e) { setFehler(fehlerSatz(e)); setBusy(false); }
  };

  const footer = vorschau ? <>
    <Button variant="ghost" disabled={busy} onClick={() => { setVorschau(null); setBegruendung(''); }}>Zurück</Button>
    <Button disabled={busy || begruendung.trim().length < 10} onClick={() => void zuruecknehmen()}>{busy ? 'Wird zurückgenommen …' : vorschau.vieraugen ? 'Rücknahme vorschlagen' : 'Import zurücknehmen'}</Button>
  </> : detail ? <>
    <Button variant="ghost" disabled={busy} onClick={() => setDetail(null)}>Zur Liste</Button>
    {kannZuruecknehmen(detail) && <Button disabled={busy} onClick={() => void ruecknahmePruefen()}>Import zurücknehmen</Button>}
  </> : <Button onClick={onClose}>Schließen</Button>;

  return <Modal open title={vorschau ? `${vorschau.kennung} zurücknehmen?` : detail ? detail.kennung : 'Import-Protokoll'} onClose={busy ? () => undefined : onClose} footer={<div className="vp-import-foot">{footer}</div>}>
    <div className="vp-import">
      {busy && !detail && <p role="status">Import-Protokoll wird geladen …</p>}
      {!busy && !detail && importe.length === 0 && <div className="vp-import-panel"><h3>Noch keine Importe</h3><p>Übernommene Dateien und ihre Befunde erscheinen hier.</p></div>}
      {!detail && importe.length > 0 && <ul className="vp-import-protokoll">{importe.map((i) => <li key={i.kennung}>
        <button type="button" onClick={() => void oeffnen(i.kennung)}><span><strong>{i.kennung}</strong><small>{i.datei_name}</small></span><span><strong>{IMPORT_STATUS[i.status] ?? i.status}</strong><small>{datum(i.erstellt_am)} · {i.aenderungen} Änderungen</small></span></button>
      </li>)}</ul>}
      {detail && !vorschau && <section className="vp-import-panel">
        <h3>{detail.datei_name}</h3><p>{IMPORT_STATUS[detail.status] ?? detail.status} · {datum(detail.erstellt_am)} · {detail.urheber.name}</p>
        <div className="vp-import-zaehler"><span><strong>{detail.zaehler.neu}</strong> neu</span><span><strong>{detail.zaehler.wiederholung}</strong> schon vorhanden</span><span><strong>{detail.zaehler.konflikt}</strong> Konflikte</span><span><strong>{detail.zaehler.abgelehnt}</strong> abgelehnt</span></div>
        <div className="vp-import-tabelle" tabIndex={0} role="region" aria-label="Zeilen und Befunde des Imports"><table><thead><tr><th>Zeile</th><th>Bezugsgröße</th><th>Zeitraum</th><th>Wert</th><th>Ergebnis und Befunde</th></tr></thead><tbody>{detail.zeilen.map((z) => <tr key={z.nr}><td>{z.nr}</td><td>{z.bezugsgroesse ?? '—'}</td><td>{z.periode_von ?? z.zeitpunkt ?? '—'}</td><td>{z.betrag === null ? '—' : `${z.betrag} ${z.einheit ?? ''}`}</td><td><strong>{URTEIL_LABEL[z.urteil] ?? z.urteil}</strong>{z.befunde.map((b) => <small key={b.befund}>{b.satz}</small>)}</td></tr>)}</tbody></table></div>
        {detail.begruendung && <p><strong>Begründung:</strong> {detail.begruendung}</p>}
      </section>}
      {vorschau && <section className="vp-import-panel">
        <h3>Folgen prüfen</h3><p><strong>{vorschau.aenderungen} {vorschau.aenderungen === 1 ? 'Wert wird' : 'Werte werden'} zurückgenommen.</strong> Es wird nichts gelöscht.</p>
        <ul className="vp-import-folgen">{ruecknahmeSaetze(vorschau).map((s) => <li key={s}>{s}</li>)}</ul>
        <p>Kennzahlen, die diese Werte verwenden, werden neu gebildet und können anschließend „keine Werte“ anzeigen.</p>
        {vorschau.vieraugen && <p className="vp-import-hinweis">Die Rücknahme wird zur Freigabe vorgeschlagen und wirkt erst nach der zweiten Prüfung.</p>}
        <Input label="Begründung" value={begruendung} onChange={(e) => setBegruendung(e.target.value)} hint="Mindestens 10 Zeichen" />
      </section>}
      {fehler && <p ref={fehlerRef} tabIndex={-1} role="alert" className="vp-import-fehler">{fehler}</p>}
    </div>
  </Modal>;
}
