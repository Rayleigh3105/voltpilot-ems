import { useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Bezugsgroesse } from '../api';
import { useRollen } from '../rollen';
import { VpPicker } from './VpPicker';
import * as B from '../bezugsgroesseListe';

export function BezugsgroesseAnlegenDialog({ orte, onClose, onGespeichert }: { orte: B.Ort[]; onClose: () => void; onGespeichert: (b: Bezugsgroesse) => void }) {
  const [entwurf, setEntwurf] = useState(B.neuerEntwurf);
  const [fehler, setFehler] = useState<Partial<Record<B.Feld, string>>>({});
  const [meldung, setMeldung] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const { darf } = useRollen();
  const verwalten = (standort: string | null) => darf('bezugsgroesse.verwalten', standort);
  const ort = orte.find(o => o.key === entwurf.ort);
  const kannSpeichern = ort ? verwalten(ort.standort) : orte.some(o => verwalten(o.standort));
  const setze = (patch: Partial<B.Entwurf>) => { setEntwurf(e => ({ ...e, ...patch })); setMeldung(null); };
  const fokussiere = (feld: B.Feld) => requestAnimationFrame(() => form.current?.querySelector<HTMLElement>(`#bz-${feld}`)?.focus());
  const speichern = async () => {
    if (busy) return;
    const f = B.pruefen(entwurf, orte, verwalten);
    setFehler(f);
    const erstes = Object.keys(f)[0] as B.Feld | undefined;
    if (erstes) { fokussiere(erstes); return; }
    if (!ort || !kannSpeichern) return;
    setBusy(true); setMeldung(null);
    try { onGespeichert(await api.bezugsgroesseAnlegen(B.anfrage(entwurf, ort))); }
    catch (e) { setMeldung(B.fehlerSatz(e)); requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[role="alert"]')?.focus()); }
    finally { setBusy(false); }
  };
  return <Modal open title={B.ANLEGEN} onClose={() => { if (!busy) onClose(); }} footer={<>
    <Button variant="outline" disabled={busy} onClick={onClose}>Abbrechen</Button>
    {kannSpeichern && <Button type="submit" form="bz-anlegen" disabled={busy}>{busy ? 'Wird gespeichert …' : 'Speichern'}</Button>}
  </>}>
    <form id="bz-anlegen" ref={form} className="vp-bz-form" onSubmit={e => { e.preventDefault(); void speichern(); }} noValidate>
      <VpPicker label="Art" value={entwurf.art} options={B.anlegeArten()} disabled={busy} onChange={art => { if (art) { setEntwurf(e => B.artWechsel(e, art, orte)); setFehler({}); } }} />
      <Input id="bz-name" label="Name" value={entwurf.name} disabled={busy} error={fehler.name} onChange={e => setze({ name: e.target.value })} autoFocus />
      <Input id="bz-kennzeichen" label="Kennzeichen" value={entwurf.kennzeichen} disabled={busy} error={fehler.kennzeichen} placeholder="Wird automatisch vergeben" hint="Leer lassen für das nächste freie Kennzeichen." onChange={e => setze({ kennzeichen: e.target.value })} />
      <div className="vp-bz-felder">
        <VpPicker id="bz-einheit" label="Einheit" value={entwurf.einheit} options={B.einheiten(entwurf.art).map(value => ({ value, label: value }))} disabled={busy} error={fehler.einheit} onChange={einheit => setze({ einheit: einheit ?? '' })} />
        {B.perioden(entwurf.art).length > 0 && <VpPicker id="bz-periode" label="Periode" value={entwurf.periode} options={B.perioden(entwurf.art).map(value => ({ value, label: B.PERIODE[value as keyof typeof B.PERIODE] }))} disabled={busy} error={fehler.periode} onChange={periode => setze({ periode })} />}
      </div>
      {B.ARTEN[entwurf.art].wertart === 'stammdatum' && <p>Die Anzahl gilt ab einem Tag bis zur nächsten Änderung.</p>}
      <VpPicker id="bz-ort" label="Geltungsbereich" value={entwurf.ort} options={B.ortOptionen(entwurf.art, orte, verwalten)} search="immer" disabled={busy} placeholder="Geltungsbereich wählen …" error={fehler.ort} onChange={ort => setze({ ort })} />
      <p className="vp-bz-hinweis">Bezugsflächen werden aus den Gebäuden und Bereichen übernommen.</p>
      {meldung && <p role="alert" tabIndex={-1}>{meldung}</p>}
    </form>
  </Modal>;
}
