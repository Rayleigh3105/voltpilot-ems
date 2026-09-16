import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import { benutzerApi, benutzerFehler, type BenutzerEintrag, type BenutzerZuweisung, type ZugriffProtokoll } from '../benutzer';
import { useRollen } from '../rollen';
import { datumZeit, ROLLE_KUNDENWORT } from '../rechte';
import { BenutzerEinladen } from '../components/BenutzerEinladen';
import { StartpasswortNeuVergeben } from '../components/StartpasswortNeuVergeben';
import { VpDatePicker } from '../components/VpDatePicker';
import { iso, mitternacht, tagPlus } from '../bezugsPeriode';
import { VORGABE_ZEITZONE } from '../uemsZustand';
import './BenutzerPage.css';

const vorgang: Record<string, string> = { zuweisen: 'Zugriff gewährt', entziehen: 'Zugriff beendet', sperren: 'Benutzer gesperrt', entfernen: 'Benutzer entfernt', erste_anmeldung: 'Erste Anmeldung', startpasswort_neu: 'Startpasswort neu vergeben', gewaehren: 'Unterstützung gewährt', verlaengern: 'Unterstützung verlängert', beenden: 'Unterstützung beendet', ablaufen: 'Unterstützung abgelaufen', anfragen: 'Anfrage zur Unterstützung', notfall: 'Notfall-Zugriff' };
const tag = (zeit: number) => iso(zeit, VORGABE_ZEITZONE).slice(0, 10);
export function BenutzerPage() {
  const rechte = useRollen();
  const schreiben = rechte.darf('benutzer.verwalten', null);
  const [liste, setListe] = useState<BenutzerEintrag[] | null>(null);
  const [fehler, setFehler] = useState('');
  const [revision, setRevision] = useState(0);
  const [anlegen, setAnlegen] = useState(false);
  const [bearbeiten, setBearbeiten] = useState<{ konto: BenutzerEintrag; zuweisung?: BenutzerZuweisung }>();
  const [entzug, setEntzug] = useState<{ konto: BenutzerEintrag; entfernen: boolean; zuweisung?: BenutzerZuweisung }>();
  const [busy, setBusy] = useState(false);
  const [protokoll, setProtokoll] = useState(false);
  const [eintraege, setEintraege] = useState<ZugriffProtokoll[] | null>(null);
  const [von, setVon] = useState(() => tagPlus(tag(Date.now()), -30));
  const [bis, setBis] = useState(() => tag(Date.now()));
  const kopf = useRef<HTMLHeadingElement>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let aktiv = true;
    setListe(null); setFehler('');
    if (rechte.benutzerLesen) benutzerApi.liste().then(x => { if (aktiv) setListe(x); }, e => { if (aktiv) setFehler(benutzerFehler(e, 'Die Benutzer konnten nicht geladen werden. Bitte versuchen Sie es erneut.')); });
    return () => { aktiv = false; };
  }, [revision, rechte.benutzerLesen, rechte.selbst?.kundenbereich?.id]);
  useEffect(() => {
    let aktiv = true;
    setEintraege(null);
    if (protokoll && schreiben) {
      if (!von || !bis || von > bis || Date.parse(bis) - Date.parse(von) > 365 * 86400000) {
        setFehler('Bitte wählen Sie einen Zeitraum von höchstens einem Jahr.');
      } else {
        setFehler('');
        benutzerApi.protokoll(new Date(mitternacht(von, VORGABE_ZEITZONE)).toISOString(),
          new Date(mitternacht(tagPlus(bis, 1), VORGABE_ZEITZONE)).toISOString())
          .then(x => { if (aktiv) setEintraege(x); }, e => { if (aktiv) setFehler(benutzerFehler(e, 'Das Zugriffsprotokoll konnte nicht geladen werden. Bitte versuchen Sie es erneut.')); });
      }
    }
    return () => { aktiv = false; };
  }, [protokoll, schreiben, von, bis, revision]);
  if (!rechte.benutzerLesen) return <p role="alert">Diese Seite gibt es für Sie nicht.</p>;
  const zurueck = () => { setEntzug(undefined); setFehler(''); requestAnimationFrame(() => (ausloeser.current?.isConnected ? ausloeser.current : kopf.current)?.focus()); };
  async function beenden() {
    if (!entzug || busy || !schreiben) return;
    setBusy(true); setFehler('');
    try { await (entzug.zuweisung ? benutzerApi.entziehen(entzug.zuweisung.id) : entzug.entfernen ? benutzerApi.entfernen(entzug.konto.sub) : benutzerApi.sperren(entzug.konto.sub)); zurueck(); setRevision(x => x + 1); }
    catch (e) { setFehler(benutzerFehler(e, 'Der Zugriff konnte nicht beendet werden. Bitte versuchen Sie es erneut.')); }
    finally { setBusy(false); }
  }
  return <section className="vp-benutzer" aria-label="Benutzerverwaltung">
    <p className="vp-note">Unternehmen › Einstellungen</p>
    <header className="vp-benutzer-kopf"><div><h1 ref={kopf} tabIndex={-1}>Benutzer</h1><p>Wer in Ihrem Unternehmen sehen, pflegen und bedienen darf.</p></div>
      {schreiben && <Button onClick={e => { e.currentTarget.focus(); setAnlegen(true); }}>Benutzer anlegen</Button>}
    </header>
    {!schreiben && <p className="vp-note">Sie lesen die Benutzerliste. Änderungen übernimmt Ihr Kundenadministrator.</p>}
    {schreiben && <div className="vp-benutzer-aktionen"><Button variant={protokoll ? 'outline' : 'primary'} onClick={() => setProtokoll(false)}>Benutzerliste</Button>
      <Button variant={protokoll ? 'primary' : 'outline'} onClick={() => setProtokoll(true)}>Zugriffsprotokoll</Button></div>}
    {fehler && !entzug && <p role="alert" className="vp-alert vp-alert-err">{fehler}</p>}
    {!protokoll && <>
      {!liste && !fehler && <p role="status">Benutzer werden geladen…</p>}
      {liste?.length === 1 && schreiben && <p className="vp-benutzer-leer">Bisher arbeiten Sie allein. Legen Sie Kolleginnen und Kollegen an und bestimmen Sie, was sie sehen und bedienen dürfen.</p>}
      {liste?.map(konto => <article key={konto.sub} className="vp-benutzer-karte">
        <div><h2>{konto.anzeigename}{konto.sub === rechte.selbst?.kennung ? ' · Sie' : ''}</h2><p>{konto.email}</p><span className="vp-benutzer-chip">{konto.zustand === 'angelegt' ? 'Angelegt · erste Anmeldung ausstehend' : konto.zustand === 'gesperrt' ? 'Gesperrt' : 'Aktiv'}</span></div>
        <div className="vp-benutzer-zuweisungen">{konto.zuweisungen.length === 0 && <p>Derzeit kein Zugriff zugewiesen.</p>}
          {konto.zuweisungen.map(z => <div key={z.id} className="vp-benutzer-zuweisung">
            <span className="vp-benutzer-chip">{ROLLE_KUNDENWORT[z.rolle]}</span>
            <p>{z.standort_id ? (z.standort_name ? `Gilt für ${z.standort_name}.` : 'Der zugewiesene Standort ist nicht verfügbar.') : 'Gilt für alle Standorte des Unternehmens, auch künftige.'}</p>
            {Date.parse(z.gueltig_ab) > Date.now() && <p className="vp-note">Eingerichtet · gültig ab {datumZeit(z.gueltig_ab)}</p>}
            {z.gueltig_bis && <p className="vp-note">Gültig bis einschließlich {new Date(z.gueltig_bis).toLocaleDateString('de-DE')}</p>}
            {schreiben && konto.sub !== rechte.selbst?.kennung && konto.zustand !== 'gesperrt' && <div className="vp-benutzer-aktionen">
              <Button variant="ghost" size="sm" onClick={e => { e.currentTarget.focus(); setBearbeiten({ konto, zuweisung: z }); }}>Rolle und Standorte ändern</Button>
              <Button variant="ghost" size="sm" onClick={e => { e.currentTarget.focus(); ausloeser.current = e.currentTarget; setEntzug({ konto, entfernen: false, zuweisung: z }); }}>Zugriff beenden</Button>
            </div>}
          </div>)}
        </div>
        {schreiben && konto.sub !== rechte.selbst?.kennung && <div className="vp-benutzer-aktionen">
          {konto.zustand !== 'gesperrt' && <><Button variant="outline" size="sm" onClick={e => { e.currentTarget.focus(); setBearbeiten({ konto }); }}>Weitere Rolle zuweisen</Button>
            <StartpasswortNeuVergeben sub={konto.sub} name={konto.anzeigename} />
            <Button variant="outline" size="sm" onClick={e => { e.currentTarget.focus(); ausloeser.current = e.currentTarget; setEntzug({ konto, entfernen: false }); }}>Sperren</Button></>}
          <Button variant="ghost" size="sm" onClick={e => { e.currentTarget.focus(); ausloeser.current = e.currentTarget; setEntzug({ konto, entfernen: true }); }}>Entfernen</Button>
        </div>}
      </article>)}
    </>}
    {protokoll && <section aria-label="Zugriffsprotokoll"><h2>Zugriffsprotokoll</h2>
      <p className="vp-note">Zeiten in {VORGABE_ZEITZONE} (Zeitzone des Unternehmens).</p>
      <div className="vp-benutzer-zwei"><VpDatePicker label="Von" value={von} onChange={setVon} /><VpDatePicker label="Bis einschließlich" value={bis} onChange={setBis} /></div>
      <p className="vp-note">Wählen Sie höchstens ein Jahr.</p>
      {eintraege?.length === 0 && <p>In diesem Zeitraum gibt es keine Einträge.</p>}
      {eintraege && eintraege.length > 1000 && <p role="status">Es gibt weitere Einträge. Wählen Sie einen kürzeren Zeitraum.</p>}
      <div className="vp-benutzer-protokoll">{eintraege?.slice(0, 1000).map(e => <article className="vp-benutzer-karte" key={e.id}>
        <time dateTime={e.zeit}>{datumZeit(e.zeit, VORGABE_ZEITZONE)}</time><h3>{e.betroffener}</h3><p>{vorgang[e.aktion] ?? 'Zugriff geändert'}{e.rolle ? ` · ${ROLLE_KUNDENWORT[e.rolle]}` : ''}</p>
        <p>{e.standort ?? 'Unternehmen'} · von {e.urheber}</p>{e.grund && <p>{e.grund}</p>}
      </article>)}</div>
    </section>}
    {schreiben && (anlegen || bearbeiten) && <BenutzerEinladen bearbeiten={bearbeiten} onClose={() => { setAnlegen(false); setBearbeiten(undefined); }} onCreated={() => setRevision(x => x + 1)} />}
    <Modal open={!!entzug && schreiben} onClose={() => { if (!busy) zurueck(); }} title={entzug?.zuweisung ? 'Zugriff beenden' : entzug?.entfernen ? 'Benutzer entfernen' : 'Benutzer sperren'}
      footer={<><Button variant="ghost" disabled={busy} onClick={zurueck}>Abbrechen</Button><Button disabled={busy} onClick={() => void beenden()}>{entzug?.zuweisung ? 'Zugriff beenden' : entzug?.entfernen ? 'Entfernen' : 'Sperren'}</Button></>}>
      {entzug?.zuweisung ? <><p><strong>{entzug.konto.anzeigename}</strong> verliert diese Zuweisung sofort: {ROLLE_KUNDENWORT[entzug.zuweisung.rolle]} · {entzug.zuweisung.standort_name ?? 'Unternehmen'}.</p><p>Andere Zuweisungen bleiben erhalten.</p></>
        : <p><strong>{entzug?.konto.anzeigename}</strong> verliert den Zugriff sofort. Auch künftige Zuweisungen enden.</p>}
      <p>Gesetzte Handeingriffe bleiben bis zu ihrem Ablauf oder bis eine berechtigte Person sie beendet. Der Vorgang wird protokolliert.</p>
      {fehler && <p role="alert">{fehler}</p>}
    </Modal>
  </section>;
}
