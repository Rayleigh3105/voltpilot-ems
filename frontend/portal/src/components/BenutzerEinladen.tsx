import { useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { benutzerApi, benutzerFehler, KUNDENROLLEN, rechteVorschau, unternehmensrolle, type BenutzerAnlage, type BenutzerEintrag, type BenutzerZuweisung } from '../benutzer';
import { ROLLE_KUNDENWORT, type Rolle } from '../rechte';
import { useRollen } from '../rollen';
import { heute } from '../bewertung';
import { ApiError } from '../api';
import { BenutzerAnlegenDialog } from './BenutzerAnlegenDialog';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

/** Die Rollen-Beschreibung im Rollen-Wähler — je zuweisbare Rolle ein Satz (`copy.test.ts` hält sie vollständig). */
export const ROLLE_BESCHREIBUNG: Record<string, string> = {
  kundenadministrator: 'Verwaltet Benutzer, Daten und Steuerung im ganzen Unternehmen.',
  energiemanager: 'Pflegt Daten an allen Standorten; bedient keine Steuerung und verwaltet keine Benutzer.',
  bearbeiter: 'Pflegt Daten an ausgewählten Standorten; bedient keine Steuerung.',
  bedienberechtigt: 'Bedient die Steuerung an ausgewählten Standorten; pflegt keine Messdaten und erteilt keine Freigaben.',
  leser: 'Sieht Daten an ausgewählten Standorten; ändert nichts.',
  einsicht: 'Sieht das Energiemanagement des ganzen Unternehmens und kann nichts ändern — für Leitung und Prüfende, auch befristet.',
};
/** AP-19 IP-13: befristen lässt sich allein „Einsicht“, und nur als weitere Rolle (`POST /api/v1/zugriff`). */
export const EINSICHT_BEFRISTEN_HINWEIS = 'Befristen lässt sich „Einsicht“, wenn Sie sie über „Weitere Rolle zuweisen“ hinzufügen.';
export function RechteVorschau({ rolle, standorte }: { rolle: Rolle; standorte: string[] }) {
  const v = rechteVorschau(rolle, standorte);
  if (!unternehmensrolle(rolle) && !standorte.length) return <p>Wählen Sie mindestens einen Standort.</p>;
  return <div className="vp-benutzer-folgen" aria-label="Folgen der Rolle">
    {[true, false].map(erlaubt => {
      const eintraege = v.filter(x => x.erlaubt === erlaubt);
      return <section key={String(erlaubt)}><strong>{erlaubt ? 'Darf' : 'Darf nicht'}</strong>
        <ul>{eintraege.slice(0, 3).map(x => <li key={x.text}>{x.text}</li>)}</ul>
        {eintraege.length > 3 && <details><summary>Weitere Rechte anzeigen · {eintraege.length - 3}</summary>
          <ul>{eintraege.slice(3).map(x => <li key={x.text}>{x.text}</li>)}</ul></details>}
        {eintraege.length === 0 && <p>Keine Einschränkung in diesem Geltungsbereich.</p>}
      </section>;
    })}
  </div>;
}

/** N2 → vorhandene N3-Hülle. Die einmalige Passwortausgabe bleibt im IP-14-Dialog. */
export function BenutzerEinladen({ onClose, onCreated, bearbeiten }: {
  onClose: () => void; onCreated: () => void; bearbeiten?: { konto: BenutzerEintrag; zuweisung?: BenutzerZuweisung };
}) {
  const { selbst } = useRollen();
  const standorte = selbst?.standorte ?? [];
  const z = bearbeiten?.zuweisung;
  const [anlage, setAnlage] = useState<BenutzerAnlage>({ username: '', email: '', vorname: '', nachname: '',
    rolle: z?.rolle ?? 'leser', standorte: z?.standort_id ? [z.standort_id] : standorte.length === 1 ? [standorte[0].id] : [] });
  const [schritt, setSchritt] = useState(1);
  const [fehler, setFehler] = useState('');
  const [busy, setBusy] = useState(false);
  const [einsichtBis, setEinsichtBis] = useState('');
  const [einsichtGrund, setEinsichtGrund] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const standortFeld = useRef<HTMLDivElement>(null);
  const ausloeser = useRef(document.activeElement as HTMLElement | null);
  const uw = unternehmensrolle(anlage.rolle);
  const daten = { ...anlage, standorte: uw ? [] : anlage.standorte };
  const schliessen = () => { onClose(); requestAnimationFrame(() => ausloeser.current?.focus()); };
  const pruefen = () => {
    if (!uw && !anlage.standorte.length) {
      setFehler('Wählen Sie mindestens einen Standort.');
      standortFeld.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
      return false;
    }
    setFehler(''); return true;
  };
  const auswahl = <>
    {!uw && <div ref={standortFeld}><VpPicker label="Standorte" values={anlage.standorte}
      options={standorte.map(s => ({ value: s.id, label: s.name }))}
      onChangeMany={ids => { setFehler(''); setAnlage(a => ({ ...a, standorte: ids })); }} error={fehler || undefined} />
      {standorte.length > 1 && <Button variant="ghost" onClick={() => { setFehler(''); setAnlage(a => ({ ...a, standorte: standorte.map(s => s.id) })); }}>Alle aktuellen Standorte</Button>}
      <p className="vp-note">Neue Standorte müssen später ausdrücklich zugewiesen werden.</p></div>}
    <RechteVorschau rolle={anlage.rolle as Rolle} standorte={daten.standorte} />
  </>;
  // „Weitere Rolle zuweisen“ mit „Einsicht“: letzter Tag und Grund wahlfrei; gesetzt geht die Zuweisung über
  // `POST /api/v1/zugriff`, sonst bleibt es beim bisherigen Wechsel (AP-19 IP-13, RE3).
  const einsichtWeitere = !!bearbeiten && !z && anlage.rolle === 'einsicht';
  const befristet = einsichtWeitere && (!!einsichtBis || !!einsichtGrund.trim());
  async function speichern() {
    if (!bearbeiten || !pruefen() || busy) return;
    if (befristet && einsichtBis && einsichtBis < heute()) { setFehler('Bitte wählen Sie als letzten Tag heute oder einen späteren Tag.'); return; }
    setBusy(true);
    try {
      if (befristet) await benutzerApi.einsichtZuweisen(bearbeiten.konto.sub, einsichtBis || null, einsichtGrund.trim() || null);
      else await benutzerApi.wechseln(bearbeiten.konto.sub, z ? [z.id] : [], anlage.rolle, daten.standorte);
      onCreated(); schliessen();
    }
    catch (e) {
      setFehler(befristet && e instanceof ApiError && e.status === 400
        ? 'Bitte wählen Sie als letzten Tag heute oder einen späteren Tag.'
        : benutzerFehler(e, 'Die Änderung konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.'));
    }
    finally { setBusy(false); }
  }
  return <>
    {schritt === 1 && <Modal open onClose={() => { if (!busy) schliessen(); }} title={bearbeiten ? 'Rolle und Standorte ändern' : 'Benutzer anlegen · Schritt 1 von 2'}
      footer={<><Button variant="ghost" disabled={busy} onClick={schliessen}>Abbrechen</Button><Button disabled={busy} onClick={() => {
        if (bearbeiten) { void speichern(); return; }
        const ungueltig = form.current?.querySelector<HTMLInputElement>('input:invalid');
        if (!anlage.username.trim() || ungueltig) {
          setFehler(!anlage.username.trim() || ungueltig?.type !== 'email'
            ? 'Bitte geben Sie einen Benutzernamen ein.' : 'Bitte geben Sie eine gültige E-Mail-Adresse ein.');
          (anlage.username.trim() ? ungueltig : form.current?.querySelector<HTMLInputElement>('input'))?.focus();
          return;
        }
        setFehler(''); setSchritt(2);
      }}>{bearbeiten ? 'Speichern' : 'Weiter'}</Button></>}>
      <form ref={form} onSubmit={e => e.preventDefault()} className="vp-benutzer-form">
        {bearbeiten ? <p>{bearbeiten.konto.anzeigename}</p> : <>
          <Input label="Benutzername" required value={anlage.username} onChange={e => setAnlage(a => ({ ...a, username: e.target.value }))} />
          <Input label="E-Mail" type="email" required value={anlage.email} onChange={e => setAnlage(a => ({ ...a, email: e.target.value }))} />
          <div className="vp-benutzer-zwei"><Input label="Vorname" value={anlage.vorname} onChange={e => setAnlage(a => ({ ...a, vorname: e.target.value }))} />
            <Input label="Nachname" value={anlage.nachname} onChange={e => setAnlage(a => ({ ...a, nachname: e.target.value }))} /></div>
        </>}
        <VpPicker label="Rolle" value={anlage.rolle} options={KUNDENROLLEN.map(r => ({ ...r, sub: ROLLE_BESCHREIBUNG[r.value] }))}
          onChange={rolle => setAnlage(a => ({ ...a, rolle }))} />
        <p>{ROLLE_BESCHREIBUNG[anlage.rolle]}</p>
        {einsichtWeitere && <div className="vp-benutzer-zwei">
          <VpDatePicker label="Gültig bis einschließlich (wahlfrei)" value={einsichtBis || null} min={heute()} onChange={v => { setFehler(''); setEinsichtBis(v ?? ''); }} />
          <Input label="Grund (wahlfrei)" value={einsichtGrund} onChange={e => setEinsichtGrund(e.target.value)} placeholder="etwa Internes Audit, Nachweise lesen" />
        </div>}
        {anlage.rolle === 'einsicht' && !einsichtWeitere && <p className="vp-note">{EINSICHT_BEFRISTEN_HINWEIS}</p>}
        {bearbeiten && <><p>Die Änderung gilt sofort. Andere Rollen und Standorte bleiben erhalten.</p>{auswahl}</>}
        {fehler && <p role="alert">{fehler}</p>}
      </form>
    </Modal>}
    {!bearbeiten && schritt === 2 && <BenutzerAnlegenDialog open={schritt === 2} onClose={() => setSchritt(1)} anlage={daten}
      rollenname={ROLLE_KUNDENWORT[anlage.rolle as Rolle]} standortnamen={standorte.filter(s => daten.standorte.includes(s.id)).map(s => s.name)}
      pruefen={pruefen} onCreated={() => { onCreated(); schliessen(); }}>
      <p className="vp-note">Schritt 2 von 2 · Zugriff und Startpasswort</p>{auswahl}
    </BenutzerAnlegenDialog>}
  </>;
}
