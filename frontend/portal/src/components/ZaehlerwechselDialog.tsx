import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type EinstellungFassung, type UemsDatenquelle, type UemsGeraet, type ZaehlerwechselVorgang } from '../api';
import { useRollen } from '../rollen';
import { useBerichteFolgen } from '../useBerichteFolgen';
import { zeitText } from '../uemsEreignis';
import { VORGABE_ZEITZONE } from '../uemsZustand';
import { ableseEinheit, standText, wechselAbzeichen, wechselBerichtsfolge, wechselEingabe, wechselFolgen, wechselPruefen,
  type WechselEingabe, type WechselZiel } from '../zaehlerwechsel';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import { VpTimePicker } from './VpTimePicker';
import './ZaehlerwechselDialog.css';
import { WechselzeitpunktDialog } from './WechselzeitpunktDialog';

interface Kontext {
  geraet: UemsGeraet; zone: string; vorgabe: boolean; standort: string | null;
  einheit: string | null; einstellungen: EinstellungFassung[]; datenquellen: UemsDatenquelle[]; messstellen: string[];
}
/** Beide Einstiege benutzen genau EINEN Schreibaufruf. Keine nachgelagerten Einstellungs-Schreibwege. */
export function ZaehlerwechselDialog({ ziel, jetzt, onClose, onGewechselt, onBerichtigt }: {
  ziel: WechselZiel; jetzt?: string; onBerichtigt?: () => void; onClose: () => void; onGewechselt: (v: ZaehlerwechselVorgang) => void;
}) {
  const uhr = useMemo(() => jetzt ?? new Date().toISOString(), [jetzt]);
  const rollen = useRollen();
  const [geplant, setGeplant] = useState<{ alt: UemsGeraet; zone: string; standort: string | null } | null>(null);
  const [kontext, setKontext] = useState<Kontext | null>(null);
  const [eingabe, setEingabe] = useState<WechselEingabe | null>(null);
  const [schritt, setSchritt] = useState<1 | 2>(1);
  const [fehler, setFehler] = useState<string | null>(null);
  const [beruehrt, setBeruehrt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ergebnis, setErgebnis] = useState<ZaehlerwechselVorgang | null>(null);
  const formular = useRef<HTMLFormElement>(null);
  const sperre = useRef(false);
  const fehlerRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (fehler) fehlerRef.current?.focus(); }, [fehler]);
  const zielId = ziel.art === 'messstelle' ? ziel.geraetId : ziel.geraet.id;

  useEffect(() => {
    let aktiv = true;
    void (async () => {
      try {
        const [liste, standorte, quellen] = await Promise.all([
          api.uemsGeraete(ziel.anlageId), api.standorte(), api.datenquellen(ziel.anlageId),
        ]);
        const geraet = liste.geraete.find(g => g.id === zielId);
        const standort = standorte.standorte.find(s => s.anlagen.some(a => a.id === ziel.anlageId));
        const zone = standort?.zeitzone ?? VORGABE_ZEITZONE;
        const alt = liste.geraete.find(g => g.kennzeichen === geraet?.kennzeichen
          && g.ausgebaut_am && Date.parse(g.ausgebaut_am) > Date.parse(uhr)
          && liste.geraete.some(n => n.id !== g.id && n.kennzeichen === g.kennzeichen && n.eingebaut_am === g.ausgebaut_am));
        if (alt) { if (aktiv) setGeplant({ alt, zone, standort: standort?.id ?? null }); return; }
        if (!geraet || geraet.ausgebaut_am || geraet.geraeteart === 'controller' || geraet.teile?.length) {
          throw new Error('Dieses Gerät kann hier nicht als Zähler ausgetauscht werden.');
        }
        const [einstellungen, ...kanaele] = await Promise.all([
          api.geraetEinstellungen(geraet.id),
          ...geraet.komponenten.filter(k => !k.gueltig_bis).map(k => api.komponenteMesskanaele(ziel.anlageId, k.entity_id)),
        ]);
        if (!aktiv) return;
        const werte = kanaele.flatMap(k => k.messkanaele);
        setKontext({ geraet, zone, vorgabe: !standort, standort: standort?.id ?? null,
          einheit: ableseEinheit(werte), einstellungen: einstellungen.historie,
          datenquellen: quellen.datenquellen.filter(q => !q.archiviert_am),
          messstellen: [...new Set(werte.flatMap(k => (k.speist ?? []).map(s => s.messstelle)))],
        });
        setEingabe(wechselEingabe(uhr, zone));
      } catch (e) { if (aktiv) setFehler(e instanceof Error ? e.message : 'Die Angaben zum Zähler konnten nicht geladen werden.'); }
    })();
    return () => { aktiv = false; };
  }, [ziel.anlageId, zielId, uhr]);

  const pruefung = eingabe && kontext ? wechselPruefen(eingabe, kontext.zone, kontext.einheit) : null;
  const body = pruefung?.body;
  const abzeichen = body?.zeitpunkt ? wechselAbzeichen(body.zeitpunkt, uhr) : null;
  const rueckwirkend = abzeichen?.startsWith('rückwirkend') === true;
  const berichte = useBerichteFolgen(ziel.art === 'messstelle' ? ziel.id : '',
    ziel.art === 'messstelle' && rueckwirkend ? eingabe?.datum ?? null : null, 'zuordnung_rueckwirkend', 'aendern');
  const berichtstage = body?.zeitpunkt && rueckwirkend ? wechselBerichtsfolge(body.zeitpunkt, uhr, kontext?.zone ?? VORGABE_ZEITZONE) : null;
  const darf = kontext && rollen.darf('messstelle.quelle', kontext.standort)
    && (ziel.art === 'messstelle' || rollen.darf('geraet.einrichten', kontext.standort))
    && (!abzeichen?.startsWith('rückwirkend') || rollen.darf('aenderung.rueckwirkend', kontext.standort));
  const setzen = <K extends keyof WechselEingabe>(feld: K, wert: WechselEingabe[K]) => {
    setEingabe(e => e && ({ ...e, [feld]: wert })); setFehler(null);
  };
  const fokusFehler = () => requestAnimationFrame(() => formular.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
  const weiter = () => {
    setBeruehrt(true);
    if (!body) { fokusFehler(); return; }
    if (darf) { setSchritt(2); setFehler(null); }
  };
  const speichern = async () => {
    if (!body || !darf || sperre.current) return;
    sperre.current = true; setBusy(true); setFehler(null);
    try {
      const v = ziel.art === 'messstelle' ? await api.messstelleZaehlerwechsel(ziel.id, body)
        : await api.geraetAustauschen(ziel.geraet.id, body);
      setErgebnis(v); onGewechselt(v);
    } catch (e) { setFehler(e instanceof Error ? e.message : 'Der Zählerwechsel konnte nicht eingetragen werden.'); }
    finally { sperre.current = false; setBusy(false); }
  };
  const e = eingabe, k = kontext;
  const feldFehler = (feld: keyof WechselEingabe) => beruehrt ? pruefung?.fehler[feld] : undefined;
  const felder = (feld: keyof WechselEingabe) => ({ value: String(e?.[feld] ?? ''),
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setzen(feld, event.target.value),
    error: feldFehler(feld), 'aria-invalid': !!feldFehler(feld) });
  const gueltigeEinstellungen = k?.einstellungen.filter(f => body?.zeitpunkt && Date.parse(f.gueltig_ab) <= Date.parse(body.zeitpunkt)
    && (!f.gueltig_bis || Date.parse(body.zeitpunkt) < Date.parse(f.gueltig_bis))) ?? [];

  if (geplant) return <WechselzeitpunktDialog geraet={geplant.alt} zone={geplant.zone} jetzt={uhr}
    darf={rollen.darf('messstelle.quelle', geplant.standort)} onClose={onClose} onBerichtigt={onBerichtigt} />;

  return <Modal open onClose={() => { if (!busy) onClose(); }} title={ergebnis ? 'Zählerwechsel eingetragen' : 'Zähler wechseln'}
    footer={ergebnis ? <Button onClick={onClose}>Schließen</Button> : <>
      <Button variant="ghost" disabled={busy} onClick={schritt === 2 ? () => setSchritt(1) : onClose}>{schritt === 2 ? 'Zurück' : 'Abbrechen'}</Button>
      {k && e && <Button disabled={busy || !darf} onClick={schritt === 1 ? weiter : () => void speichern()}>
        {busy ? 'Wird eingetragen …' : schritt === 1 ? 'Folgen prüfen' : 'Zählerwechsel eintragen'}
      </Button>}
    </>}>
    <div className="vp-zw">
      {k && <p className="vp-zw-kopf">{ziel.art === 'messstelle' ? `${ziel.kennzeichen} · ` : ''}{k.geraet.einbau_kennzeichen} · Zeitzone: {k.zone}{k.vorgabe ? ' (Vorgabe)' : ''}</p>}
      {fehler && <p ref={fehlerRef} className="vp-zw-fehler" role="alert" tabIndex={-1}>{fehler}</p>}
      {!k && !fehler && <p role="status">Angaben zum Zähler werden geladen …</p>}
      {ergebnis && k ? <section className="vp-zw-folgen" aria-label="Gespeicherte Folgen" role="status">
        {wechselFolgen(ergebnis, k.zone).map(s => <p key={s}>{s}</p>)}
        {berichtstage && <p>{berichtstage}</p>}
        {berichte && <p>{berichte.titel}: {berichte.text}.</p>}
      </section> : e && k && <>
        <p className="vp-zw-schritt">Schritt {schritt} von 2 · {schritt === 1 ? 'Zählerwechsel erfassen' : 'Angaben und Folgen prüfen'}</p>
        {schritt === 1 ? <form ref={formular} onSubmit={event => { event.preventDefault(); weiter(); }} noValidate>
          <fieldset disabled={busy}><legend>Zeitpunkt</legend><div className="vp-zw-raster">
            <VpDatePicker label="Datum" value={e.datum} onChange={v => setzen('datum', v ?? '')} error={feldFehler('datum')} />
            <VpTimePicker label="Uhrzeit" value={e.uhrzeit} onChange={v => setzen('uhrzeit', v ?? '')} />
          </div>{abzeichen && <p className="vp-zw-marke">{abzeichen}</p>}</fieldset>
          <fieldset><legend>Neues Gerät</legend>
            <label className="vp-zw-check"><input type="checkbox" checked={e.gleichesModell} onChange={ev => setzen('gleichesModell', ev.target.checked)} />Gleiches Modell wie bisher</label>
            {e.gleichesModell && (k.geraet.hersteller || k.geraet.typ) && <p>{[k.geraet.hersteller, k.geraet.typ].filter(Boolean).join(' · ')}</p>}
            {!e.gleichesModell && <div className="vp-zw-raster"><Input label="Hersteller" {...felder('hersteller')} /><Input label="Typ" {...felder('typ')} /></div>}
            <div className="vp-zw-raster"><Input label="Kennzeichen des neuen Zählers (optional)" hint="Wird sonst automatisch vergeben." {...felder('kennzeichen')} />
              <Input label="Seriennummer (optional)" {...felder('seriennummer')} /></div>
          </fieldset>
          <fieldset><legend>Verbindung</legend>
            <label className="vp-zw-check"><input type="checkbox" checked={e.gleicheVerbindung} onChange={ev => setzen('gleicheVerbindung', ev.target.checked)} />Gleiche Datenquelle und Geräte-ID</label>
            {!e.gleicheVerbindung && <div className="vp-zw-raster">
              <VpPicker label="Datenquelle" value={e.datenquelle} onChange={v => setzen('datenquelle', v ?? '')}
                options={[{ value: '', label: 'Bisherige Datenquelle' }, ...k.datenquellen.map(q => ({ value: q.id, label: `${q.kennzeichen} · ${q.name ?? q.adresse}` }))]} />
              <Input label="Geräte-ID (optional)" inputMode="numeric" hint="Leer übernimmt die bisherige Geräte-ID." {...felder('geraeteId')} />
            </div>}
          </fieldset>
          <fieldset><legend>Ablesestände (optional)</legend>
            {k.einheit ? <div className="vp-zw-raster"><Input label={`Endstand bisheriger Zähler (${k.einheit})`} inputMode="decimal" {...felder('endstand')} />
              <Input label={`Anfangsstand neuer Zähler (${k.einheit})`} inputMode="decimal" {...felder('anfangsstand')} /></div>
              : <p>Die Ablesestände lassen sich keinem einzelnen Zählwerk zuordnen. Sie können den Wechsel ohne Ablesestände eintragen.</p>}
          </fieldset>
          <fieldset><legend>Einstellungen</legend>
            <label className="vp-zw-check"><input type="checkbox" checked={e.uebernehmen} onChange={ev => setzen('uebernehmen', ev.target.checked)} />Bisherige Einstellungen übernehmen</label>
            {gueltigeEinstellungen.map(f => <p key={f.id}>{f.art_kundenwort}: {f.wert_text} · {f.anwendung_text}</p>)}
            <p>Neue Einstellungen können Sie nach dem Wechsel am Gerät eintragen.</p>
          </fieldset>
          <Input label="Begründung (optional)" {...felder('grund')} />
        </form> : body && <section className="vp-zw-folgen" aria-label="Folgen des Zählerwechsels">
          <h3>Das wird eingetragen</h3>
          <p>{k.geraet.einbau_kennzeichen} → {e.kennzeichen || 'neuer Zähler mit automatisch vergebenem Kennzeichen'} · {zeitText(body.zeitpunkt!, k.zone)}</p>
          {abzeichen && <p className="vp-zw-marke">{abzeichen}</p>}
          <p>Seriennummer: {e.seriennummer || 'nicht erfasst'}</p>
          <p>{e.gleichesModell ? 'Gleiches Modell wie bisher.' : `${e.hersteller} · ${e.typ}`}</p>
          <p>{e.gleicheVerbindung ? 'Datenquelle und Geräte-ID bleiben.' : `Datenquelle: ${k.datenquellen.find(q => q.id === e.datenquelle)?.kennzeichen ?? 'bisherige'} · Geräte-ID: ${e.geraeteId || 'bisherige'}`}</p>
          <p>Endstand: {standText(body.endstand_vorgaenger ?? null) ?? 'nicht erfasst'} · Anfangsstand: {standText(body.anfangsstand ?? null) ?? 'nicht erfasst'}</p>
          <p>{e.uebernehmen ? 'Bisherige Einstellungen übernehmen.' : 'Keine Einstellungen übernehmen.'}</p>
          <h3>Was bleibt</h3>
          <p>Die Messstellen behalten Kennzeichen, Namen und Zuordnungen. Gespeicherte Werte bleiben unverändert. Eine Lücke bis zu den ersten Werten des neuen Zählers bleibt sichtbar.</p>
          {berichtstage && <p>{berichtstage}</p>}
          {berichte && <p>{berichte.titel}: {berichte.text}.</p>}
          {k.messstellen.length > 0 && <p>Derzeit liest aus diesem Gerät: {k.messstellen.join(' · ')}.</p>}
          <p>Nach dem Eintrag sehen Sie die bestätigten Quellen und Zeitpunkte.</p>
        </section>}
        {!darf && <p role="note">{rollen.grund}</p>}
      </>}
    </div>
  </Modal>;
}
