import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Switch } from '../../designsystem/components/forms/Switch';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type GeraetRolle, type Messstelle } from '../api';
import { fmtNum } from '../format';
import { ROLLEN } from '../uemsRollen';
import {
  SUMMENWERT, SCHRITTE, MAX_NAME, MAX_TERME, abgeleiteteGroesse, alsAnfrage,
  entwurfFehler, frischeVon, leererEntwurf, nameVorschlag,
  punkt, rechenzeile, schluessel, schritt1Fertig, termAus, unvollstaendigSatz,
  vorschau, wertText, type Entwurf, type Schritt,
} from '../gesamtwert';
import {
  ankerAus, anhakbar, leseGrund, mitSitzungswert, sperrArt, sperrGrund, sperrKurz,
  standText, suchePasst, unterzeile, vorauswahl, zeileAus, zuQuellwert,
  type RegisterZeile, type Sitzungswert,
} from '../summenwertQuellen';
import { ConfirmDialog } from './ConfirmDialog';
import './Gesamtwert.css';
import './SummenwertAssistent.css';

type Rolle = keyof typeof ROLLEN;
type Geraet = { deviceId: string; entityId: string; name: string };
type Zeile = RegisterZeile & { deviceId: string; geraetName: string };
export interface SummenwertEinstieg {
  siteId: string;
  deviceId?: string;
  entityId?: string;
  geraetName?: string;
  /** Kompatibilität mit dem früheren Geräte-Einstieg. Rollen werden frisch gelesen. */
  bestehend?: GeraetRolle | null;
  onGespeichert?: (messstelle: Messstelle) => void;
}

/** Stabile Öffnen-Funktion für Karten und Anlagen-Einstieg. Fertig bleibt bis zum Schließen. */
export function useSummenwertAssistent() {
  const [einstieg, setEinstieg] = useState<SummenwertEinstieg | null>(null);
  return {
    oeffneSummenwertAssistent: (neu: SummenwertEinstieg) => setEinstieg(neu),
    assistent: einstieg && <SummenwertAssistent {...einstieg} open onClose={() => setEinstieg(null)} />,
  };
}

/** EIN Assistent, optional mit Geräte-Vorauswahl; alle Quellen bleiben in derselben Anlage. */
export function SummenwertAssistent({ open, siteId, deviceId, entityId, geraetName, onClose, onGespeichert }: SummenwertEinstieg & { open: boolean; onClose: () => void }) {
  const [schritt, setSchritt] = useState<Schritt>(1);
  const [entwurf, setEntwurf] = useState<Entwurf>(leererEntwurf);
  const [zeilen, setZeilen] = useState<Zeile[] | null>(null);
  const [geraete, setGeraete] = useState<Geraet[]>([]);
  const [query, setQuery] = useState('');
  const [rolle, setRolle] = useState<Rolle>('keine');
  const [faktoren, setFaktoren] = useState(false);
  const [sitzung, setSitzung] = useState<Record<string, Sitzungswert>>({});
  const [lesend, setLesend] = useState<Set<string>>(new Set());
  const gelesen = useRef(new Set<string>());
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<Messstelle | null>(null);
  const [ersetzt, setErsetzt] = useState<string[] | null>(null);
  const [bestaetigt, setBestaetigt] = useState<string[]>([]);

  useEffect(() => {
    const lauf = ++generation.current;
    if (!open) return;
    setSchritt(1); setEntwurf(leererEntwurf()); setZeilen(null); setQuery('');
    setRolle('keine'); setFaktoren(false); setSitzung({}); setLesend(new Set());
    setFehler(null); setErgebnis(null); setErsetzt(null); setBestaetigt([]); gelesen.current.clear();
    void (async () => {
      try {
        const res = await api.summenwertQuellen(siteId);
        const gs: Geraet[] = res.filter((g) => g.deviceId).map((g) => ({ deviceId: g.deviceId!, entityId: g.entityId, name: g.name }));
        const fehlend = res.filter((g) => !g.deviceId);
        if (fehlend.length && lauf === generation.current) setFehler(`Keine lesende Box zugeordnet: ${fehlend.map((g) => g.name).join(', ')}.`);
        const zs = (await Promise.all(gs.map(async (g) => {
          const out: Zeile[] = [];
          let offset = 0;
          for (;;) {
            const katalog = await api.measurementCatalog(g.deviceId, new URLSearchParams({ entityId: g.entityId, availableOnly: 'true', offset: String(offset), limit: '250' }));
            out.push(...katalog.points.map((p) => ({ ...zeileAus(p, g.entityId), deviceId: g.deviceId, geraetName: g.name })));
            offset += katalog.points.length;
            if (!katalog.points.length || offset >= katalog.total) break;
          }
          return out;
        }))).flat();
        if (lauf !== generation.current) return;
        setGeraete(gs); setZeilen(zs);
        const vorab = entityId ? vorauswahl(zs.filter((z) => z.entityId === entityId && z.beobachtet)) : [];
        const terme = vorab.slice(0, MAX_TERME).map((z) => termAus(zuQuellwert(z, geraetName ?? null)));
        setEntwurf({ ...leererEntwurf(), terme, name: terme.length ? nameVorschlag(terme) : '' });
      } catch {
        if (lauf === generation.current) { setZeilen([]); setFehler('Die Register konnten nicht geladen werden. Bitte öffnen Sie den Assistenten erneut.'); }
      }
    })();
    return () => { generation.current++; };
  }, [open, siteId, deviceId, entityId, geraetName]);

  // Laufende Frische wird auch dann geprüft, wenn der Kunde einen Schritt länger offen lässt.
  const [jetzt, setJetzt] = useState(Date.now);
  useEffect(() => { if (!open) return; const t = setInterval(() => setJetzt(Date.now()), 1000); return () => clearInterval(t); }, [open]);
  const alle = (zeilen ?? []).map((z) => ({ ...z, ...mitSitzungswert(z, sitzung[schluessel({ entityId: z.entityId, channel: z.pointKey })]) }));
  const aktuelleTerme = entwurf.terme.map((t) => {
    const z = alle.find((z) => z.entityId === t.quelle.entityId && z.pointKey === t.quelle.channel);
    const q = z ? zuQuellwert(z, z.geraetName) : t.quelle;
    return { ...t, quelle: { ...q, wert: frischeVon(q.stand, q.wert, jetzt) === 'frisch' ? q.wert : null } };
  });
  const summe = vorschau(aktuelleTerme);
  const anker = ankerAus(entwurf.terme.map((t) => t.quelle));
  const keys = new Set(entwurf.terme.map((t) => schluessel(t.quelle)));
  const groesse = abgeleiteteGroesse(entwurf.terme);
  const stand = aktuelleTerme.map((t) => t.quelle.stand).filter((s): s is string => !!s).sort().slice(-1)[0] ?? null;
  const formFehler = entwurfFehler(entwurf);
  const unbeobachtet = alle.filter((z) => !z.beobachtet && keys.has(schluessel({ entityId: z.entityId, channel: z.pointKey })));
  const rolleErlaubt = (r: Rolle) => r === 'keine' || (groesse?.groesse === 'Wirkleistung' && groesse.wertart === 'Momentanwert'
    && groesse.richtung === (r === 'pv' ? 'Erzeugung' : r === 'consumer' ? 'Bezug' : 'richtungslos'));

  async function einmalLesen(z: Zeile) {
    const key = schluessel({ entityId: z.entityId, channel: z.pointKey });
    if (z.beobachtet || gelesen.current.has(key)) return;
    gelesen.current.add(key);
    const lauf = generation.current;
    setLesend((s) => new Set(s).add(key));
    let wert: Sitzungswert;
    try { wert = await api.measurementLesen(z.deviceId, z.entityId, z.pointKey); }
    catch { wert = { wert: null, einheit: z.einheit, gelesen_am: null, grund: 'box_offline' }; }
    if (lauf !== generation.current) return;
    setSitzung((s) => ({ ...s, [key]: wert }));
    setLesend((s) => { const n = new Set(s); n.delete(key); return n; });
    setJetzt(Date.now());
  }

  function toggle(z: Zeile, erzeugung = false) {
    const key = schluessel({ entityId: z.entityId, channel: z.pointKey });
    if (!keys.has(key)) void einmalLesen(z);
    setEntwurf((e) => ({ ...e, terme: keys.has(key) ? e.terme.filter((t) => schluessel(t.quelle) !== key)
      : [...e.terme, { ...termAus(zuQuellwert(z, z.geraetName)), ...(erzeugung ? { giltAlsErzeugung: true } : {}) }] }));
  }

  async function speichern(ersetzen = false) {
    if (busy || formFehler || !rolleErlaubt(rolle)) return;
    setBusy(true); setFehler(null); setErsetzt(null);
    try {
      if (rolle !== 'keine' && !ersetzen) {
        const zugeordnet = rolle === 'grid'
          ? await api.rollenWert(siteId, rolle).then((r) => r.zuordnung_vorhanden ? r.geraete.map((b) => b.name) : [])
          : (await Promise.all([...new Set(entwurf.terme.map((t) => t.quelle.entityId))].map((id) => api.geraetRolle(siteId, id, rolle)))).flatMap((r) => r.zugeordnet ? [r.zugeordnet.name ?? 'Bisheriger Wert'] : []);
        if (zugeordnet.length) { setErsetzt(zugeordnet); return; }
      }
      // Auswahl erst beim Speichern beobachten. Die Revision gilt je Box, nicht je Komponente.
      for (const z of unbeobachtet) {
        const st = await api.measurementSelection(z.deviceId, z.entityId);
        await api.changeMeasurementSelection(z.deviceId, z.pointKey, {
          expectedRevision: st.desiredRevision, idempotencyKey: crypto.randomUUID(), enabled: true,
          cadenceS: z.standardKadenzS ?? undefined,
        }, z.entityId);
        setZeilen((zs) => zs?.map((q) => q.entityId === z.entityId && q.pointKey === z.pointKey ? { ...q, beobachtet: true } : q) ?? null);
      }
      const neu = await api.berechneteMessstelleAnlegen({ ...alsAnfrage(entwurf),
        ...(rolle === 'keine' ? {} : { rolle: { entity_id: entwurf.terme[0].quelle.entityId, role: rolle, ersetzen } }),
      });
      setErgebnis(neu); setSchritt(5); onGespeichert?.(neu);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Das Speichern ist gerade nicht gelungen.');
    } finally { setBusy(false); }
  }

  function weiter() {
    if (schritt === 1 && !schritt1Fertig(entwurf.terme)) { setFehler('Wählen Sie mindestens ein passendes Register.'); return; }
    if (schritt === 2 && entwurf.terme.some((t) => !Number.isFinite(t.faktor) || t.faktor === 0)) { setFehler('Ein Faktor muss eine Zahl ungleich 0 sein.'); return; }
    if (schritt === 3 && formFehler) { setFehler(formFehler); return; }
    setFehler(null);
    if (schritt === 2 && !entwurf.name) setEntwurf((e) => ({ ...e, name: nameVorschlag(e.terme) }));
    setSchritt((s) => (s + 1) as Schritt);
  }

  function register(z: Zeile) {
    const key = schluessel({ entityId: z.entityId, channel: z.pointKey });
    const art = sperrArt(z, anker), an = keys.has(key);
    const kann = an || (anhakbar(z, anker) && keys.size < MAX_TERME);
    const gelesenWert = sitzung[key];
    return <div key={key} className={`vp-sw-row${art !== 'summierbar' ? ' locked' : ''}`}>
      <button type="button" className={`vp-sw-chk ${an ? 'on' : 'off'}`} aria-pressed={an}
        aria-label={`${z.name} ${an ? 'entfernen' : z.richtungslos ? 'einmal lesen' : 'mitzählen'}`} disabled={!kann}
        title={sperrGrund(art) ?? undefined} onClick={() => z.richtungslos && !an ? void einmalLesen(z) : toggle(z)}>
        {an && <Icon name="check" size={12} />}
      </button>
      <div className="vp-sw-mid">
        <div className="vp-sw-nm"><span className={`vp-sw-dot ${punkt(frischeVon(z.stand, z.wert, jetzt))}`} />{z.name}</div>
        <div className="vp-sw-subrow">{unterzeile(z, anker)}</div>
        <div className="vp-sw-live">{lesend.has(key) ? 'Wird einmal gelesen …' : gelesenWert?.grund ? `— · ${leseGrund(gelesenWert.grund)}`
          : <>{wertText(z.wert, z.einheit ?? '')} · {standText(z.stand, !!gelesenWert)}</>}</div>
        {!z.beobachtet && art === 'summierbar' && <div className="vp-sw-subrow">Beim Speichern beobachten · ≈ {fmtNum(z.jahresBytes / 1e9, '', 1)} GB/Jahr</div>}
        {z.richtungslos && <div className="vp-sw-suggest">
          <span>{z.genPort ? 'Am Gen-Port hängt ein Mikrowechselrichter?' : `Zählt „${z.name}“ als Erzeugung?`}</span>
          <Switch checked={an} disabled={!kann} onChange={() => toggle(z, true)} label={an ? 'Zählt mit' : 'Aus'} />
        </div>}
        {art !== 'summierbar' && <div className="vp-sw-warn">{sperrKurz(art)} · {sperrGrund(art)}</div>}
      </div>
    </div>;
  }
  function gruppe(g: Geraet) {
    const zs = alle.filter((z) => z.entityId === g.entityId && suchePasst(z, query));
    return <section className="vp-sw-group" key={g.entityId}><h3 className="vp-sw-group-h">{g.name}</h3>
      {zs.filter((z) => z.beobachtet).map(register)}
      <details open={!!query}><summary>Alle Register des Geräts · {zs.filter((z) => !z.beobachtet).length} weitere</summary>{zs.filter((z) => !z.beobachtet).map(register)}</details>
      {!zs.length && <p className="vp-sw-hint">Keine passenden Register.</p>}
    </section>;
  }
  const folgen = {
    keine: 'Der Wert bleibt unter Verlauf › Messwerte sichtbar. Die Anlagen-Übersicht bleibt unverändert.',
    pv: 'Ersetzt in der Anlagen-Übersicht die PV-Zahl der beteiligten Geräte.',
    consumer: 'Ersetzt in der Anlagen-Übersicht die Verbrauchszahl der beteiligten Geräte. Prüfen Sie, ob alle Verbraucher erfasst sind; ein Teilverbrauch bildet nicht den Verbrauch der ganzen Anlage ab.',
    grid: 'Wird der Netzwert dieser Anlage. Bezug zählt positiv, Abgabe negativ. Es gibt höchstens einen maßgeblichen Netzwert je Anlage.',
  };
  return <Modal open={open} onClose={busy ? () => undefined : onClose} title={`${SUMMENWERT}${geraetName ? ` · ${geraetName}` : ' anlegen'}`}
    footer={<div className="vp-sw-foot">
      {schritt === 5 ? <Button onClick={onClose}>Fertig</Button> : <>
        <Button variant="ghost" disabled={busy} onClick={schritt === 1 ? onClose : () => { setFehler(null); setSchritt((s) => (s - 1) as Schritt); }}>{schritt === 1 ? 'Abbrechen' : 'Zurück'}</Button>
        {schritt < 4 ? <Button onClick={weiter} disabled={zeilen === null || (schritt === 1 && (!schritt1Fertig(entwurf.terme) || lesend.size > 0))}>Weiter</Button>
          : <Button disabled={busy || !!formFehler || !rolleErlaubt(rolle)} onClick={() => void speichern()}>{busy ? 'Speichern …' : 'Speichern'}</Button>}
      </>}
    </div>}>
    <div className="vp-sw vp-gw">
      <ol className="vp-steps" aria-label="Schritte">{SCHRITTE.map((label, i) => <li key={label} className={`vp-step vp-step-${i + 1 === schritt ? 'active' : i + 1 < schritt ? 'done' : 'todo'}`} aria-current={i + 1 === schritt ? 'step' : undefined}><span className="vp-step-num">{i + 1}</span><span className="vp-step-label">{label}</span></li>)}</ol>
      <p className="vp-gw-eyebrow">Schritt {schritt} von 5</p>
      {schritt === 1 && <>
        <h3 className="vp-sw-h">Welche Register gehören zusammen?</h3>
        <p className="vp-sw-sub">Wählen Sie Register dieser Anlage. Noch nicht beobachtete Register werden beim Antippen einmal gelesen.</p>
        <input className="vp-sw-search-in" type="search" aria-label="Register durchsuchen" placeholder="Register durchsuchen …" value={query} onChange={(e) => setQuery(e.target.value)} />
        {zeilen === null ? <p>Register werden geladen …</p> : geraete.length === 0 ? <p>Diese Anlage meldet noch keine Geräte mit Registern.</p> : <>
          {geraete.filter((g) => !entityId || g.entityId === entityId).map(gruppe)}
          {entityId && geraete.some((g) => g.entityId !== entityId) && <details open={!!query}><summary>Weitere Geräte dieser Anlage</summary>{geraete.filter((g) => g.entityId !== entityId).map(gruppe)}</details>}
        </>}
      </>}
      {schritt === 2 && <>
        <h3 className="vp-sw-h">Wie zählen wir sie?</h3>
        <p className="vp-sw-sub">Standard ist „plus“. Vorzeichen und Faktor gelten für jeden Eingang.</p>
        <div className="vp-gw-terms">{entwurf.terme.map((t, i) => <div className="vp-gw-term" key={schluessel(t.quelle)}>
          <span className="vp-gw-term-name">{t.quelle.name}<small>{t.quelle.geraet}</small></span>
          <span className="vp-gw-seg" role="group" aria-label={`Vorzeichen für ${t.quelle.name}`}>{(['+', '-'] as const).map((v) => <button key={v} type="button" aria-pressed={t.vorzeichen === v} className={t.vorzeichen === v ? 'on' : ''} onClick={() => setEntwurf((e) => ({ ...e, terme: e.terme.map((x, n) => n === i ? { ...x, vorzeichen: v } : x) }))}>{v === '-' ? '−' : '+'}</button>)}</span>
          {faktoren && <label className="vp-gw-factor">Faktor<input type="number" inputMode="decimal" step="any" aria-label={`Faktor für ${t.quelle.name}`} value={Number.isNaN(t.faktor) ? '' : t.faktor} onChange={(ev) => { const f = ev.target.value === '' ? NaN : Number(ev.target.value); setEntwurf((e) => ({ ...e, terme: e.terme.map((x, n) => n === i ? { ...x, faktor: f } : x) })); }} /></label>}
        </div>)}</div>
        <button type="button" className="vp-gw-fine" onClick={() => setFaktoren((f) => !f)}>Feineinstellung {faktoren ? 'ausblenden' : '(Faktor) anzeigen'}</button>
        {faktoren && <p className="vp-sw-warn">Ein Faktor verändert den gemessenen Wert. Ändern Sie ihn nur, wenn Sie die Umrechnung kennen.</p>}
      </>}
      {schritt === 3 && <><h3 className="vp-sw-h">Wie soll der Wert heißen?</h3><label>Name<input autoFocus className="vp-sw-name-in" aria-label={`Name des ${SUMMENWERT}s`} maxLength={MAX_NAME} value={entwurf.name} onChange={(e) => setEntwurf((s) => ({ ...s, name: e.target.value }))} /></label><p className="vp-sw-sub">Der Vorschlag ist frei änderbar.</p></>}
      {schritt === 4 && <><h3 className="vp-sw-h">Diesen Wert verwenden als …</h3><div className="vp-sw-role-options" role="group" aria-label="Rolle">{(Object.keys(ROLLEN) as Rolle[]).map((r) => <button key={r} type="button" className={`vp-sw-role-option ${rolle === r ? 'on' : ''}`} aria-pressed={rolle === r} disabled={!rolleErlaubt(r)} onClick={() => setRolle(r)}>{ROLLEN[r]}</button>)}</div>
        <p>{folgen[rolle]}</p>{rolle !== 'keine' && <p>Die Zuordnung wirkt ab jetzt und steht im Änderungsprotokoll der Anlage. Der Wert hängt an jedem gelesenen Gerät und zählt in der Anlagen-Summe einmal.</p>}
        <p className="vp-sw-sub">Rollen benötigen Wirkleistung als Momentanwert: Erzeugung für PV-Produktion, Bezug für Verbrauch, richtungslos für Netz.</p>
      </>}
      {schritt < 5 && <div aria-live="polite"><div className="vp-sw-sumline"><span>{SUMMENWERT}</span><strong>{summe.unvollstaendig ? 'unvollständig' : wertText(summe.wert, summe.einheit)}</strong></div><p className="vp-sw-sub">{standText(stand)}</p><p className="vp-sw-sub">{rechenzeile(aktuelleTerme)}</p>{summe.unvollstaendig && entwurf.terme.length > 0 && <p className="vp-sw-warn">{unvollstaendigSatz(summe.fehlende)}</p>}
        {unbeobachtet.length > 0 && <p className="vp-sw-sub">Beim Speichern werden {unbeobachtet.length} weitere Register beobachtet · ≈ {fmtNum(unbeobachtet.reduce((s, z) => s + z.jahresBytes, 0) / 1e9, '', 1)} GB/Jahr.</p>}
      </div>}
      {schritt === 5 && <section className="vp-sw-done"><Icon name="check" size={30} /><h3>„{ergebnis?.name}“ ist angelegt</h3><p>{rolle === 'keine' ? 'ohne Rolle' : ROLLEN[rolle]}</p><p>{folgen[rolle]}</p><p>{summe.unvollstaendig ? 'unvollständig' : wertText(summe.wert, summe.einheit)} · {standText(stand)}</p>{bestaetigt.length > 0 && <p>Abgelöst: {bestaetigt.join(', ')}. Die bisherigen Werte bleiben bestehen.</p>}</section>}
      {fehler && <p role="alert" className="vp-sw-error">{fehler}</p>}
    </div>
    <ConfirmDialog open={ersetzt !== null} title="Zuordnung ersetzen?" intro={`Bisher verwendet: ${ersetzt?.join(', ')}. Stattdessen „${entwurf.name}“ verwenden?`} consequences={['Die bisherigen Werte bleiben bestehen.', 'Die neue Zuordnung gilt ab jetzt. Jeder Summenwert zählt einmal.']} confirmLabel="Ersetzen" onCancel={() => setErsetzt(null)} onConfirm={() => { setBestaetigt(ersetzt ?? []); void speichern(true); }} />
  </Modal>;
}
