import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type ErsatzwertEingabe, type ErsatzwertLuecke, type ErsatzwertVorschau, type KorrekturDetail, type MessstelleQuellenListe } from '../api';
import { datumZeit, ersatzAnfrage, formAus, lueckenZeitraum, methoden, methodenName, periodenZahl, type ErsatzForm } from '../korrekturen';
import { useRollen } from '../rollen';
import { zeitText } from '../uemsEreignis';
import { KorrekturVorschau } from './KorrekturVorschau';
import { VpDatePicker } from './VpDatePicker';
import { VpTimePicker } from './VpTimePicker';
import { VpPicker } from './VpPicker';
import './Korrekturen.css';

export function ErsatzwertDialog({ kennzeichen, name, standort, quellen, einheit, von, bis, zone, ereignis, onClose, onGespeichert }: {
  kennzeichen: string; name: string; standort: string; quellen: MessstelleQuellenListe; einheit: string;
  von: string; bis: string; zone: string; ereignis?: string; onClose: () => void; onGespeichert?: () => void;
}) {
  const rollen = useRollen();
  const fuehrend = quellen.quellen.filter(q => q.rolle === 'fuehrend' && q.groesse === quellen.groessen[0]?.groesse
    && Date.parse(q.gueltig_ab) < Date.parse(bis) && (!q.gueltig_bis || Date.parse(q.gueltig_bis) > Date.parse(von)));
  const [quelleId, setQuelleId] = useState(fuehrend[0]?.id ?? '');
  const quelle = fuehrend.find(q => q.id === quelleId);
  const vergleich = quellen.quellen.filter(q => q.rolle === 'vergleich' && q.groesse === quelle?.groesse);
  const [luecken, setLuecken] = useState<ErsatzwertLuecke[] | null>(null);
  const [luecke, setLuecke] = useState<ErsatzwertLuecke | null>(null);
  const [form, setForm] = useState(() => formAus(von, bis, zone));
  const [vorschau, setVorschau] = useState<{ wert: ErsatzwertVorschau; eingabe: ErsatzwertEingabe } | null>(null);
  const [ergebnis, setErgebnis] = useState<KorrekturDetail | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [feldFehler, setFeldFehler] = useState<keyof ErsatzForm | null>(null);
  const [busy, setBusy] = useState(false), [versuch, setVersuch] = useState(0);
  const formular = useRef<HTMLFormElement>(null), meldung = useRef<HTMLParagraphElement>(null), sperre = useRef(false);
  const erlaubt = rollen.darf('ersatzwert.erfassen', standort);
  useEffect(() => { if (fehler && !feldFehler) meldung.current?.focus(); }, [fehler, feldFehler]);
  function waehleLuecke(l: ErsatzwertLuecke | null) {
    setLuecke(l); setFehler(null); setFeldFehler(null); setVorschau(null);
    const zeiten = l ? lueckenZeitraum(l) : { von, bis };
    const f = formAus(zeiten.von, zeiten.bis ?? bis, zone);
    f.methode = methoden(l, vergleich.length > 0)[0];
    if (l && l.art !== 'data_gap') { const t = datumZeit(l.von, zone); f.zeitTag = t.datum; f.zeitZeit = t.zeit; }
    setForm(alt => ({ ...f, grund: alt.grund, beleg: alt.beleg }));
  }
  useEffect(() => {
    if (!quelleId) return;
    let da = true; setLuecken(null); setFehler(null);
    api.ersatzwertLuecken(kennzeichen, quelleId, von, bis).then(l => {
      if (!da) return; setLuecken(l);
      const gew = ereignis ? l.find(x => x.id === ereignis) : null;
      waehleLuecke(gew ?? null);
      if (ereignis && !gew) setFehler('Das Ereignis ist für diese Quelle nicht mehr verfügbar. Bitte prüfen Sie Quelle und Zeitraum.');
    }, () => { if (da) setFehler('Die Lücken konnten nicht geladen werden. Bitte erneut versuchen.'); });
    return () => { da = false; };
    // Die Wahl wird ausschließlich mit dem abgeschlossenen Lückenabruf vorbelegt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kennzeichen, quelleId, von, bis, versuch]);
  function setzen(k: keyof ErsatzForm, v: string) { setForm(f => ({ ...f, [k]: v })); setVorschau(null); setFehler(null); setFeldFehler(null); }
  async function pruefen() {
    if (!quelle || sperre.current || !erlaubt || !luecken) return;
    const e = ersatzAnfrage(form, quelle, luecke, zone, einheit, vergleich);
    if ('fehler' in e) {
      setFehler(e.fehler); setFeldFehler(e.feld);
      requestAnimationFrame(() => formular.current?.querySelector<HTMLElement>(`[data-feld="${e.feld}"] input:not([type="hidden"]), [data-feld="${e.feld}"] button`)?.focus()); return;
    }
    sperre.current = true; setBusy(true); setFehler(null); setFeldFehler(null);
    try { setVorschau({ wert: await api.ersatzwertVorschau(kennzeichen, e.eingabe), eingabe: e.eingabe }); }
    catch (e) { setFehler(e instanceof Error ? e.message : 'Die Vorschau konnte nicht berechnet werden.'); }
    finally { setBusy(false); sperre.current = false; }
  }
  async function speichern() {
    if (!vorschau || sperre.current || !erlaubt) return;
    sperre.current = true; setBusy(true); setFehler(null);
    try { setErgebnis(await api.ersatzwertErfassen(kennzeichen, vorschau.eingabe)); onGespeichert?.(); }
    catch (e) { setFehler(e instanceof Error ? e.message : 'Der Ersatzwert konnte nicht gespeichert werden.'); }
    finally { setBusy(false); sperre.current = false; }
  }
  const date = (label: string, tag: keyof ErsatzForm, zeit: keyof ErsatzForm, disabled = false, step = 15) => <fieldset><legend>{label}</legend><div className="vp-korr-raster">
    <div data-feld={tag}><VpDatePicker label={`${label}: Datum`} value={form[tag]} onChange={v => setzen(tag, v)} disabled={busy || disabled} /></div>
    <div data-feld={zeit}><VpTimePicker label={`${label}: Uhrzeit`} value={form[zeit]} onChange={v => setzen(zeit, v)} step={step} disabled={busy || disabled} /></div>
  </div></fieldset>;
  const input = (label: string, key: keyof ErsatzForm, numeric = false) => <div data-feld={key}><Input label={label} value={form[key]} onChange={e => setzen(key, e.target.value)} disabled={busy} inputMode={numeric ? 'decimal' : undefined} maxLength={numeric ? 30 : 500} error={feldFehler === key ? fehler : undefined} /></div>;
  const verteilen = luecke?.zuwachs != null;
  return <Modal open title={ergebnis ? 'Ersatzwert gespeichert' : vorschau ? 'Ersatzwert prüfen' : 'Ersatzwert eintragen'} onClose={() => { if (!busy) onClose(); }}
    footer={ergebnis ? <Button onClick={onClose}>Schließen</Button> : <>
      <Button variant="outline" disabled={busy} onClick={() => vorschau ? setVorschau(null) : onClose()}>{vorschau ? 'Eingaben ändern' : 'Abbrechen'}</Button>
      {erlaubt && (vorschau ? <Button disabled={busy} onClick={() => void speichern()}>{vorschau.wert.freigabe_noetig ? 'Vorschlag speichern' : 'Ersatzwert speichern'}</Button>
        : <Button type="submit" form="vp-ersatzwert" disabled={busy || !quelle || luecken === null}>Vorschau berechnen</Button>)}
    </>}>
    <div className="vp-korr"><p><strong>{kennzeichen} · {name}</strong></p><p className="vp-korr-zone">Zeiten in {zone}</p>
      {fehler && <p ref={meldung} role="alert" tabIndex={-1}>{fehler}{!luecken && <Button variant="outline" onClick={() => setVersuch(n => n + 1)}>Erneut laden</Button>}</p>}
      {!erlaubt && <p>{rollen.grund}</p>}
      {ergebnis ? <div role="status"><p>{ergebnis.kennung} · {ergebnis.ersatzwert_kennung}</p><p>{ergebnis.status === 'vorschlag'
        ? 'Der Vorschlag wartet auf Freigabe. Die bisherigen Werte bleiben unverändert.'
        : 'Der Ersatzwert ist freigegeben. Die betroffenen Werte werden neu berechnet.'}</p><p>Sie finden den Vorgang unter „Korrekturen“.</p></div>
      : vorschau ? <>
        <p>{methodenName(form.methode)} · {zeitText(vorschau.eingabe.von, zone)} bis {zeitText(vorschau.eingabe.bis, zone)}</p>
        {verteilen && <p>Gemessener Zuwachs: {periodenZahl(luecke.zuwachs, einheit)}. Die Verteilung ändert diese Summe nicht.</p>}
        <p>{vorschau.wert.vieraugen ? 'Wird erst nach Freigabe durch eine zweite Person wirksam.' : vorschau.wert.freigabe_noetig ? 'Der nachgetragene Stand wartet auf Freigabe, weil der Zeitraum bereits endgültig ist.' : 'Beim Speichern wird der Ersatzwert freigegeben.'}</p>
        <KorrekturVorschau perioden={vorschau.wert.perioden} auswirkungen={vorschau.wert.auswirkungen} einheit={einheit} zone={zone} />
        <p>Begründung: {form.grund}</p>{form.beleg && <p>Beleg: {form.beleg}</p>}
      </> : <form id="vp-ersatzwert" ref={formular} onSubmit={e => { e.preventDefault(); void pruefen(); }} noValidate>
        {!quelle && <p>Im gewählten Zeitraum ist keine führende Quelle zugeordnet. Bitte einen Zeitraum mit Quelle wählen.</p>}
        <VpPicker label="Quelle" value={quelleId} options={fuehrend.map(q => ({ value: q.id, label: q.komponente_name ?? q.geraet.geraet ?? 'Messgerät', sub: q.kanal_name ?? q.groesse }))} onChange={setQuelleId} disabled={busy} />
        <VpPicker label="Lücke oder Zählerbruch" value={luecke?.id ?? 'zeitraum'} loading={luecken === null} disabled={busy} onChange={id => waehleLuecke(luecken?.find(l => l.id === id) ?? null)}
          options={[{ value: 'zeitraum', label: 'Anderer Zeitraum ohne gemessenen Zuwachs' }, ...(luecken ?? []).map(l => ({ value: l.id,
            label: `${l.art === 'data_gap' ? 'Lücke' : l.art === 'counter_reset' ? 'Zählerrücksetzung' : 'Zählerwechsel'} · ${zeitText(l.von, zone)}`,
            sub: l.zuwachs == null ? 'Kein gemessener Zuwachs' : `Gemessener Zuwachs: ${periodenZahl(l.zuwachs, l.einheit ?? einheit)}` }))]} />
        {date('Beginn', 'vonTag', 'vonZeit', verteilen)}{date('Ende', 'bisTag', 'bisZeit', verteilen)}
        {verteilen && <p>Gemessener Zuwachs: {periodenZahl(luecke.zuwachs, einheit)}. Er wird über die ganze Lücke verteilt.</p>}
        <div data-feld="methode"><VpPicker label="Methode" value={form.methode} onChange={v => setzen('methode', v)} disabled={busy}
          options={methoden(luecke, vergleich.length > 0).map(m => ({ value: m, label: methodenName(m) }))} /></div>
        {['profil_vorperiode', 'vorperiode_uebernehmen'].includes(form.methode) && date('Vorperiode ab', 'vorTag', 'vorZeit')}
        {['profil_vergleichsquelle', 'vergleichsquelle_uebernehmen'].includes(form.methode) && <div data-feld="vergleich"><VpPicker label="Vergleichsquelle" value={form.vergleich} onChange={v => setzen('vergleich', v)} disabled={busy}
          options={vergleich.map(q => ({ value: q.id, label: q.komponente_name ?? q.geraet.geraet ?? 'Messgerät', sub: q.kanal_name ?? q.groesse }))} /></div>}
        {form.methode === 'wert_eingeben' && <>{input(`Menge (${einheit})`, 'betrag', true)}<p>Eine belegte Menge für höchstens einen Kalendermonat. Daraus wird kein Viertelstundenprofil erfunden.</p></>}
        {form.methode === 'ablesestand_nachtragen' && <>{date('Ablesung', 'zeitTag', 'zeitZeit', false, 1)}{input(`Endstand (${einheit})`, 'endstand', true)}{input(`Anfangsstand (${einheit})`, 'anfangsstand', true)}</>}
        {input('Begründung', 'grund')}{input(form.methode === 'wert_eingeben' ? 'Beleg (Pflicht)' : 'Beleg (optional)', 'beleg')}
        <p>Begründung und Beleg: jeweils 10 bis 500 Zeichen. Die Vorschau speichert noch nichts.</p>
      </form>}
    </div>
  </Modal>;
}
