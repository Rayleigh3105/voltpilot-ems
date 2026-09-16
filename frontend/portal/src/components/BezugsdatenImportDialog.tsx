import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  ApiError,
  api,
  type BezugsdatenImportErgebnis,
  type BezugsdatenVorlage,
  type BezugsdatenVorschau,
  type BezugsdatenZuordnung,
  type Bezugsgroesse,
} from '../api';
import { URTEIL_LABEL, trennzeichenText, vorschauAbleitung } from '../bezugsdatenVorschau';
import { VpPicker } from './VpPicker';
import './BezugsdatenImportDialog.css';

const SCHRITTE = ['Datei', 'Zuordnung', 'Vorschau', 'Übernahme'] as const;
const ROLLEN = [
  { value: 'keine', label: 'Nicht verwenden' },
  { value: 'periode', label: 'Periode oder Zeitpunkt' },
  { value: 'wert', label: 'Wert' },
  { value: 'einheit', label: 'Einheit' },
  { value: 'bezug', label: 'Bezugsgröße' },
  { value: 'bemerkung', label: 'Bemerkung' },
] as const;
type Rolle = typeof ROLLEN[number]['value'];

type DateiBild = { kopf: string[]; zeilen: string[][]; trennzeichen: string };

function felder(zeile: string, trennzeichen: string): string[] {
  const aus: string[] = []; let feld = ''; let zitat = false;
  for (let i = 0; i < zeile.length; i += 1) {
    const c = zeile[i];
    if (c === '"' && zitat && zeile[i + 1] === '"') { feld += '"'; i += 1; }
    else if (c === '"') zitat = !zitat;
    else if (c === trennzeichen && !zitat) { aus.push(feld); feld = ''; }
    else feld += c;
  }
  aus.push(feld); return aus;
}

async function dateiBild(datei: File): Promise<DateiBild> {
  const text = await datei.text();
  const roh = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((z) => z.length > 0).slice(0, 21);
  const kandidaten = [';', '\t', ','];
  const trennzeichen = kandidaten.sort((a, b) => roh.slice(0, 5).reduce((n, z) => n + (z.split(b).length - 1), 0) - roh.slice(0, 5).reduce((n, z) => n + (z.split(a).length - 1), 0))[0];
  const zeilen = roh.map((z) => felder(z, trennzeichen));
  return { kopf: zeilen[0] ?? [], zeilen: zeilen.slice(1), trennzeichen };
}

function rollenVorschlag(kopf: string[]): Rolle[] {
  const aus = kopf.map((name): Rolle => {
    const n = name.toLocaleLowerCase('de-DE');
    if (/periode|zeitraum|datum|monat|zeitpunkt|timestamp/.test(n)) return 'periode';
    if (/einheit|unit/.test(n)) return 'einheit';
    if (/bezug|artikel|prozess|kennzeichen|größe|groesse/.test(n)) return 'bezug';
    if (/wert|menge|betrag|stand/.test(n)) return 'wert';
    if (/bemerk|notiz|kommentar/.test(n)) return 'bemerkung';
    return 'keine';
  });
  if (!aus.includes('periode') && aus.length) aus[0] = 'periode';
  if (!aus.includes('wert') && aus.length) aus[Math.min(aus.length - 1, aus.length >= 4 ? 2 : 1)] = 'wert';
  return aus;
}

const fehlertext = (e: unknown): string => e instanceof ApiError ? e.message : 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.';

export function BezugsdatenImportDialog({ bezugsgroessen, onClose }: { bezugsgroessen: Bezugsgroesse[]; onClose: () => void }) {
  const [schritt, setSchritt] = useState(1);
  const [datei, setDatei] = useState<File | null>(null);
  const [bild, setBild] = useState<DateiBild | null>(null);
  const [rollen, setRollen] = useState<Rolle[]>([]);
  const [festerBezug, setFesterBezug] = useState('');
  const [bezugTabelle, setBezugTabelle] = useState<Record<string, string>>({});
  const [vorlagen, setVorlagen] = useState<BezugsdatenVorlage[]>([]);
  const [vorlageId, setVorlageId] = useState<string | null>(null);
  const [vorlageName, setVorlageName] = useState('');
  const [vorschau, setVorschau] = useState<BezugsdatenVorschau | null>(null);
  const [ergebnis, setErgebnis] = useState<BezugsdatenImportErgebnis | null>(null);
  const [teilBestaetigt, setTeilBestaetigt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const fehlerRef = useRef<HTMLParagraphElement>(null);
  const inhaltRef = useRef<HTMLDivElement>(null);
  const ziele = bezugsgroessen.filter((b) => !b.archiviert_am && b.wertart !== 'stammdatum');

  useEffect(() => { api.bezugsdatenVorlagen().then((x) => setVorlagen(x.vorlagen), () => setVorlagen([])); }, []);
  useEffect(() => { if (fehler) requestAnimationFrame(() => fehlerRef.current?.focus()); }, [fehler]);
  useEffect(() => { requestAnimationFrame(() => inhaltRef.current?.closest('.dbody')?.scrollTo({ top: 0 })); }, [schritt]);

  const bezugSpalte = rollen.indexOf('bezug');
  const bezugTexte = useMemo(() => bezugSpalte < 0 || !bild ? [] : [...new Set(bild.zeilen.map((z) => z[bezugSpalte]?.trim()).filter(Boolean))], [bezugSpalte, bild]);
  const zuordnung = useMemo<BezugsdatenZuordnung>(() => {
    const spalte = (r: Rolle) => { const i = rollen.indexOf(r); return i < 0 ? null : i + 1; };
    const fest = ziele.find((b) => b.kennzeichen === festerBezug) ?? null;
    return {
      csv: null,
      spalten: { periode: spalte('periode'), bis: null, wert: spalte('wert'), einheit: spalte('einheit'), bezug: spalte('bezug'), bemerkung: spalte('bemerkung') },
      deutung: fest?.wertart === 'stand' ? 'zeitpunkt' : 'periode', zahlformat: 'auto', einheit: null,
      bezugsgroesse: bezugSpalte < 0 ? festerBezug || null : null, bezug_tabelle: bezugSpalte < 0 ? {} : bezugTabelle, synonyme: {},
    };
  }, [rollen, ziele, festerBezug, bezugSpalte, bezugTabelle]);
  const modell = vorschau ? vorschauAbleitung(vorschau) : null;
  const zuordnungFertig = zuordnung.spalten.periode !== null && zuordnung.spalten.wert !== null
    && (bezugSpalte < 0 ? !!festerBezug : bezugTexte.length > 0 && bezugTexte.every((x) => !!bezugTabelle[x]));

  const dateiWaehlen = async (neu: File | null) => {
    setDatei(neu); setVorschau(null); setErgebnis(null); setFehler(null); setVorlageId(null);
    if (!neu) { setBild(null); setRollen([]); return; }
    try {
      const b = await dateiBild(neu); setBild(b); setRollen(rollenVorschlag(b.kopf));
      setFesterBezug(ziele[0]?.kennzeichen ?? ''); setBezugTabelle({});
    } catch (e) { setFehler(fehlertext(e)); }
  };
  const rolleSetzen = (index: number, rolle: Rolle) => {
    setVorlageId(null); setVorschau(null);
    setRollen((alt) => alt.map((r, i) => i === index ? rolle : rolle !== 'keine' && r === rolle ? 'keine' : r));
  };
  const vorlageWaehlen = (id: string | null) => {
    setVorschau(null); setVorlageId(id || null);
    const v = vorlagen.find((x) => x.vorlage_id === id);
    if (!v) return;
    const rollenNeu: Rolle[] = (bild?.kopf ?? []).map(() => 'keine');
    for (const r of ['periode', 'wert', 'einheit', 'bezug', 'bemerkung'] as const) {
      const i = v.zuordnung.spalten[r]; if (i) rollenNeu[i - 1] = r;
    }
    setRollen(rollenNeu); setFesterBezug(v.zuordnung.bezugsgroesse ?? ''); setBezugTabelle(v.zuordnung.bezug_tabelle ?? {});
  };
  const vorschauen = async () => {
    if (!datei || (!vorlageId && !zuordnungFertig)) return;
    setBusy(true); setFehler(null);
    try { setVorschau(await api.bezugsdatenVorschau(datei, vorlageId ? null : zuordnung, vorlageId)); setSchritt(3); }
    catch (e) { setFehler(fehlertext(e)); }
    finally { setBusy(false); }
  };
  const vorlageSpeichern = async () => {
    if (!vorlageName.trim() || !zuordnungFertig) return;
    setBusy(true); setFehler(null);
    try {
      const v = await api.bezugsdatenVorlageSpeichern({ name: vorlageName.trim(), zuordnung });
      setVorlagen((alt) => [...alt, v]); setVorlageId(v.vorlage_id); setVorlageName('');
    } catch (e) { setFehler(fehlertext(e)); }
    finally { setBusy(false); }
  };
  const importieren = async () => {
    if (!datei || !vorschau || !modell || (modell.teiluebernahme && !teilBestaetigt)) return;
    setBusy(true); setFehler(null);
    try {
      setErgebnis(await api.bezugsdatenImportieren(datei, vorlageId ? null : zuordnung, vorlageId, {
        vorschau: vorschau.vorschau.kennung, entscheidungen: {}, begruendung: null,
        teiluebernahme: modell.bestaetigung,
      }));
    } catch (e) { setFehler(fehlertext(e)); }
    finally { setBusy(false); }
  };

  const footer = ergebnis ? <Button onClick={onClose}>Fertig</Button> : <>
    <Button variant="ghost" disabled={busy} onClick={schritt === 1 ? onClose : () => { setFehler(null); setSchritt((s) => s - 1); }}>{schritt === 1 ? 'Abbrechen' : 'Zurück'}</Button>
    {schritt === 1 && <Button disabled={!datei || !bild} onClick={() => setSchritt(2)}>Weiter zur Zuordnung</Button>}
    {schritt === 2 && <Button disabled={busy || (!vorlageId && !zuordnungFertig)} onClick={() => void vorschauen()}>{busy ? 'Vorschau wird erstellt …' : 'Vorschau erstellen'}</Button>}
    {schritt === 3 && modell && <Button disabled={!vorschau?.import.uebernahme_moeglich || vorschau.import.zaehler.konflikt > 0} onClick={() => setSchritt(4)}>{modell.knopf}</Button>}
    {schritt === 4 && modell && <Button disabled={busy || (modell.teiluebernahme && !teilBestaetigt)} onClick={() => void importieren()}>{busy ? 'Wird übernommen …' : modell.knopf}</Button>}
  </>;

  return <Modal open title="Werte aus Datei übernehmen" onClose={busy ? () => undefined : onClose} footer={<div className="vp-import-foot">{footer}</div>}>
    <div className="vp-import" ref={inhaltRef}>
      <ol className="vp-steps" aria-label="Schritte">{SCHRITTE.map((label, i) => <li key={label} className={`vp-step vp-step-${i + 1 === schritt ? 'active' : i + 1 < schritt ? 'done' : 'todo'}`} aria-current={i + 1 === schritt ? 'step' : undefined}><span className="vp-step-num">{i + 1}</span><span className="vp-step-label">{label}</span></li>)}</ol>
      <p className="vp-import-kicker">Schritt {schritt} von 4</p>
      {schritt === 1 && <section className="vp-import-panel">
        <h3>Datei auswählen</h3><p>Wählen Sie eine CSV-Datei mit höchstens 5 MB. Die Datei wird erst nach Ihrer Bestätigung übernommen.</p>
        <Input type="file" label="CSV-Datei" accept=".csv,text/csv,text/plain" onChange={(e) => void dateiWaehlen(e.target.files?.[0] ?? null)} />
        {datei && <div className="vp-import-datei"><strong>{datei.name}</strong><span>{Math.max(1, Math.ceil(datei.size / 1024)).toLocaleString('de-DE')} KB · {bild?.kopf.length ?? 0} Spalten erkannt</span></div>}
      </section>}
      {schritt === 2 && bild && <section className="vp-import-panel">
        <h3>Spalten zuordnen</h3>
        <VpPicker label="Gespeicherte Vorlage" value={vorlageId ?? 'keine'} options={[{ value: 'keine', label: 'Ohne Vorlage' }, ...vorlagen.map((v) => ({ value: v.vorlage_id, label: `${v.name} · Fassung ${v.fassung}` }))]} onChange={(id) => vorlageWaehlen(id === 'keine' ? null : id)} />
        <div className="vp-import-spalten">{bild.kopf.map((name, i) => <div className="vp-import-spalte" key={`${name}-${i}`}><strong>{name || `Spalte ${i + 1}`}</strong><small>{bild?.zeilen[0]?.[i] || 'Keine Vorschau'}</small><VpPicker label={`Rolle für ${name || `Spalte ${i + 1}`}`} value={rollen[i] ?? 'keine'} options={[...ROLLEN]} onChange={(r) => rolleSetzen(i, (r ?? 'keine') as Rolle)} /></div>)}</div>
        {bezugSpalte < 0 ? <VpPicker label="Bezugsgröße für alle Zeilen" value={festerBezug} placeholder="Bezugsgröße wählen …" search="immer" options={ziele.map((b) => ({ value: b.kennzeichen, label: `${b.kennzeichen} · ${b.name}` }))} onChange={(x) => { setVorlageId(null); setFesterBezug(x ?? ''); }} /> : <div className="vp-import-bezuege"><h4>Texte Bezugsgrößen zuordnen</h4>{bezugTexte.map((text) => <VpPicker key={text} label={text} value={bezugTabelle[text] ?? ''} placeholder="Bezugsgröße wählen …" search="immer" options={ziele.map((b) => ({ value: b.kennzeichen, label: `${b.kennzeichen} · ${b.name}` }))} onChange={(x) => { setVorlageId(null); setBezugTabelle((alt) => ({ ...alt, [text]: x ?? '' })); }} />)}</div>}
        <div className="vp-import-vorlage"><Input label="Name der neuen Vorlage" value={vorlageName} onChange={(e) => setVorlageName(e.target.value)} placeholder="z. B. ERP-Export Spritzguss" /><Button variant="outline" disabled={busy || !vorlageName.trim() || !zuordnungFertig} onClick={() => void vorlageSpeichern()}>Vorlage speichern</Button></div>
      </section>}
      {schritt === 3 && vorschau && modell && <section className="vp-import-panel">
        <h3>Vorschau prüfen</h3>
        <dl className="vp-import-erkennung"><div><dt>Kodierung</dt><dd>{vorschau.datei.kodierung?.toUpperCase() ?? 'Nicht erkannt'}</dd></div><div><dt>Trennzeichen</dt><dd>{trennzeichenText(vorschau.datei.trennzeichen)}</dd></div><div><dt>Kopfzeile</dt><dd>{vorschau.datei.kopfzeile ? 'Ja' : 'Nein'}</dd></div><div><dt>Datei</dt><dd>{vorschau.datei.name}</dd></div></dl>
        <div className="vp-import-zaehler"><span><strong>{vorschau.import.zaehler.neu}</strong> neu</span><span><strong>{vorschau.import.zaehler.wiederholung}</strong> schon vorhanden</span><span><strong>{vorschau.import.zaehler.abgelehnt}</strong> abgelehnt</span><span><strong>{vorschau.import.zaehler.mit_hinweis}</strong> mit Hinweis</span></div>
        {vorschau.import.zaehler.konflikt > 0 && <p role="alert">{vorschau.import.zaehler.konflikt} abweichende Werte brauchen vor der Übernahme eine Entscheidung. Sie können in diesem Schritt noch nicht übernommen werden.</p>}
        {modell.befunde.map((b) => <p className={b.hinweis ? 'vp-import-hinweis' : 'vp-import-fehler'} key={b.befund}>{b.satz}</p>)}
        <div className="vp-import-tabelle" tabIndex={0} role="region" aria-label="Vorschau der Datenzeilen"><table><thead><tr><th>Zeile</th>{(vorschau.datei.kopf ?? bild?.kopf ?? []).map((x, i) => <th key={`${x}-${i}`}>{x || `Spalte ${i + 1}`}</th>)}<th>Ergebnis</th></tr></thead><tbody>{vorschau.zeilen.map((z) => <tr key={z.nr}><td>{z.nr}</td>{z.felder.map((x, i) => <td key={i}>{x}</td>)}<td><strong>{URTEIL_LABEL[z.urteil] ?? z.urteil}</strong>{z.befunde.map((b) => <small key={b.befund}>{b.satz}</small>)}</td></tr>)}</tbody></table></div>
      </section>}
      {schritt === 4 && modell && <section className="vp-import-panel">
        {ergebnis ? <div className="vp-import-fertig" role="status"><h3>{ergebnis.kennung} ist übernommen</h3><p>{ergebnis.aenderungen} {ergebnis.aenderungen === 1 ? 'Wert wurde' : 'Werte wurden'} gespeichert.</p>{ergebnis.vorschlaege > 0 && <p>{ergebnis.vorschlaege} Berichtigungen warten auf Freigabe.</p>}</div> : <>
          <h3>Übernahme bestätigen</h3><p><strong>{modell.uebernehmen} von {modell.zeilen} Zeilen</strong> werden übernommen. Die Vorschau selbst hat noch nichts gespeichert.</p>
          {modell.teiluebernahme && <label className="vp-import-check"><input type="checkbox" checked={teilBestaetigt} onChange={(e) => setTeilBestaetigt(e.target.checked)} /><span>Ich bestätige: {modell.bestaetigung}.</span></label>}
          {modell.nichtUebernehmen > 0 && <p className="vp-import-hinweis">{modell.nichtUebernehmen} {modell.nichtUebernehmen === 1 ? 'Zeile wird' : 'Zeilen werden'} nicht übernommen. Die Befunde bleiben beim Import nachvollziehbar.</p>}
        </>}
      </section>}
      {fehler && <p ref={fehlerRef} role="alert" tabIndex={-1} className="vp-import-fehler">{fehler}</p>}
    </div>
  </Modal>;
}
