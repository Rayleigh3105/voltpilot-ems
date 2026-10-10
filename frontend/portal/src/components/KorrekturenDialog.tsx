import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type KorrekturDetail } from '../api';
import { STATUS, aktionsGrund, methodenName } from '../korrekturen';
import { useRollen } from '../rollen';
import { zeitText } from '../uemsEreignis';
import { KorrekturVorschau } from './KorrekturVorschau';
import { VpPicker } from './VpPicker';
import './Korrekturen.css';

export function KorrekturenDialog({ standort, zone, onClose, kennzeichen, onGespeichert }: {
  standort: string; zone: string; onClose: () => void; kennzeichen?: string; onGespeichert?: () => void;
}) {
  const rollen = useRollen();
  const [liste, setListe] = useState<KorrekturDetail[] | null>(null);
  const [detail, setDetail] = useState<KorrekturDetail | null>(null);
  const [filter, setFilter] = useState('alle');
  const [grund, setGrund] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [laden, setLaden] = useState(0);
  const eingabe = useRef<HTMLInputElement>(null), meldung = useRef<HTMLParagraphElement>(null);
  const sperre = useRef(false);
  useEffect(() => { if (fehler) meldung.current?.focus(); }, [fehler]);
  useEffect(() => {
    let da = true;
    api.korrekturen(standort).then(x => { if (da) { setListe(x); setFehler(null); } }, () => { if (da) setFehler('Die Korrekturen konnten nicht geladen werden. Bitte erneut versuchen.'); });
    return () => { da = false; };
  }, [standort, laden]);
  async function oeffnen(k: KorrekturDetail) {
    setBusy(true); setFehler(null); setHinweis(null);
    try { const neu = await api.korrektur(k.kennung); setDetail(neu); setGrund(neu.begruendung); }
    catch { setFehler('Die Korrektur konnte nicht geladen werden. Bitte die Liste neu laden.'); }
    finally { setBusy(false); }
  }
  async function entscheiden(aktion: 'freigeben' | 'ablehnen' | 'zuruecknehmen') {
    if (!detail || sperre.current) return;
    if (grund.trim().length < 10 || grund.trim().length > 500) { setFehler('Bitte den Grund mit 10 bis 500 Zeichen angeben.'); requestAnimationFrame(() => eingabe.current?.focus()); return; }
    sperre.current = true; setBusy(true); setFehler(null); setHinweis(null);
    try {
      if (aktion === 'freigeben') await api.korrekturFreigeben(detail.kennung, grund.trim());
      else if (aktion === 'ablehnen') await api.korrekturAblehnen(detail.kennung, grund.trim());
      else if (detail.ersatzwert_kennung) await api.ersatzwertZuruecknehmen(detail.ersatzwert_kennung, grund.trim());
      else await api.korrekturZuruecknehmen(detail.kennung, grund.trim());
      setDetail({ ...detail, status: aktion === 'freigeben' ? 'freigegeben' : aktion === 'ablehnen' ? 'abgelehnt' : 'zurueckgenommen',
        freigeben: { erlaubt: false, grund: 'status_passt_nicht' }, ablehnen: { erlaubt: false, grund: 'status_passt_nicht' }, zuruecknehmen: { erlaubt: false, grund: 'status_passt_nicht' } });
      onGespeichert?.();
      setHinweis(aktion === 'ablehnen' ? 'Ablehnung gespeichert. Die Werte bleiben unverändert.' : 'Entscheidung gespeichert. Die betroffenen Werte werden neu berechnet.');
      const neu = await api.korrektur(detail.kennung); setDetail(neu); setLaden(n => n + 1);
    } catch (e) { setFehler(e instanceof Error ? e.message : 'Die Entscheidung konnte nicht gespeichert werden. Bitte erneut versuchen.'); }
    finally { sperre.current = false; setBusy(false); }
  }
  const darfFrei = detail?.freigeben.erlaubt && rollen.darf('korrektur.freigeben', standort);
  const darfNein = detail?.ablehnen.erlaubt && rollen.darf('korrektur.freigeben', standort);
  const darfRueck = detail?.zuruecknehmen.erlaubt && rollen.darf('korrektur.zuruecknehmen', standort);
  const sichtbar = liste?.filter(k => (!kennzeichen || k.messstellen.some(m => m.kennzeichen === kennzeichen)) && (filter === 'alle' || k.status === filter));
  return <Modal open title={detail ? `Korrektur ${detail.kennung}` : 'Korrekturen am Standort'} onClose={() => { if (!busy) onClose(); }}
    footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Schließen</Button>
      {darfNein && <Button variant="outline" disabled={busy} onClick={() => void entscheiden('ablehnen')}>Ablehnen</Button>}
      {darfRueck && <Button disabled={busy} onClick={() => void entscheiden('zuruecknehmen')}>Widerruf speichern</Button>}
      {darfFrei && <Button disabled={busy} onClick={() => void entscheiden('freigeben')}>Freigeben</Button>}</>}>
    <div className="vp-korr">
      <p className="vp-korr-zone">Zeiten in {zone}</p>
      {fehler && <p ref={meldung} role="alert" tabIndex={-1}>{fehler} <Button variant="outline" disabled={busy} onClick={() => detail ? void oeffnen(detail) : setLaden(n => n + 1)}>Neu laden</Button></p>}
      {hinweis && <p role="status">{hinweis}</p>}
      {detail ? <>
        <Button variant="ghost" disabled={busy} onClick={() => { setDetail(null); setFehler(null); setHinweis(null); }}>Zur Liste</Button>
        <div className="vp-korr-kopf"><strong>{STATUS[detail.status] ?? detail.status}</strong><p>{detail.messstellen.map(m => `${m.kennzeichen} · ${m.name}`).join(', ')}</p>
          <p>{detail.methode ? methodenName(detail.methode) : 'Berichtigung der Messwerte'} · {zeitText(detail.von, zone)} bis {zeitText(detail.bis, zone)}</p>
          <p>Erstellt von {detail.ersteller.name} · {zeitText(detail.erstellt_am, zone)}</p><p>{detail.begruendung}</p>{detail.beleg && <p>Beleg: {detail.beleg}</p>}
          {detail.ersatzwert_kennung && <p>Ersatzwert {detail.ersatzwert_kennung}</p>}
        </div>

        {detail.status === 'vorschlag' && !darfFrei && <p className="vp-korr-folgen">{detail.freigeben.erlaubt ? rollen.grund : aktionsGrund(detail.freigeben)}</p>}
        {detail.status === 'freigegeben' && !darfRueck && <p>{detail.zuruecknehmen.erlaubt ? rollen.grund : aktionsGrund(detail.zuruecknehmen)}</p>}
        {darfRueck && <p>Ein Widerruf erzeugt eine weitere Version. Frühere Werte und die Begründung bleiben im Verlauf erhalten.</p>}
        <KorrekturVorschau perioden={detail.vorschau} auswirkungen={detail.auswirkungen} einheit={detail.einheit ?? ''} zone={zone} />
        {(darfFrei || darfNein || darfRueck) && <Input ref={eingabe} label={darfRueck ? 'Grund für den Widerruf' : 'Begründung der Entscheidung'} value={grund} maxLength={500} onChange={e => setGrund(e.target.value)} disabled={busy} hint="10 bis 500 Zeichen" />}
      </> : <>
        <VpPicker label="Zustand" value={filter} onChange={setFilter} options={[{ value: 'alle', label: 'Alle Korrekturen' }, ...Object.entries(STATUS).map(([value, label]) => ({ value, label }))]} />
        {!liste && !fehler && <p aria-busy="true">Korrekturen werden geladen …</p>}
        {sichtbar?.length === 0 && <p>Keine Korrekturen in dieser Auswahl.</p>}
        <ul className="vp-korr-liste">{sichtbar?.map(k => <li key={k.kennung}><button type="button" disabled={busy} onClick={() => void oeffnen(k)}>
          <strong>{k.kennung} · {STATUS[k.status] ?? k.status}</strong><span>{k.messstellen.map(m => `${m.kennzeichen} · ${m.name}`).join(', ')}</span>
          <span>{k.methode ? methodenName(k.methode) : 'Berichtigung der Messwerte'}</span><span>{zeitText(k.von, zone)} bis {zeitText(k.bis, zone)}</span>
          <span>{k.ersteller.name} · {zeitText(k.erstellt_am, zone)}</span>
        </button></li>)}</ul>
      </>}
    </div>
  </Modal>;
}
