import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Input } from '../../../designsystem/components/forms/Input';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { request, type Unterstuetzung, type UnterstuetzungAnfrage } from '../../api';
import { fleetApi } from '../../admin/fleetApi';
import { isPlatformAdmin } from '../../auth';
import { VpPicker } from '../../components/VpPicker';
import { VpDatePicker } from '../../components/VpDatePicker';
import { UnterstuetzungFolgen } from '../../components/UnterstuetzungDialog';
import { heute, hoechstesEnde, pruefeUnterstuetzung, UMFANG, unterstuetzungFehler, vorgabeEnde } from '../../unterstuetzung';

/** Unterstützung und Notfall-Zugriff gelten je Standort - ein Satz, keine Technik. */
const UNTERSTUETZUNG_OHNE_STANDORT = 'Unterstützung gilt je Standort, und dieser Kunde hat noch keinen. '
  + '„Wie der Kunde es sieht“ geht trotzdem.';

export function UnterstuetzungAdmin({ tenantId, name }: { tenantId: string; name: string }) {
  const [modus, setModus] = useState<'anfrage' | 'notfall'>();
  // `null` = (noch) nicht bekannt: nicht geladen, Abruf gescheitert oder die Flotte nennt die Standorte nicht.
  const [orte, setOrte] = useState<{ id: string; name: string }[] | null>(null);
  const [auswahl, setAuswahl] = useState<string[]>([]); const [umfang, setUmfang] = useState('ansehen');
  const [bis, setBis] = useState(vorgabeEnde); const [grund, setGrund] = useState('');
  const [busy, setBusy] = useState(false); const [fehler, setFehler] = useState(''); const [erfolg, setErfolg] = useState('');
  const form = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLElement | null>(null);
  // Schon mit dem Mandanten-Dialog geladen (und beim Öffnen eines Formulars frisch): ohne Standort sagt der Kasten es vorher.
  useEffect(() => { if (isPlatformAdmin()) void fleetApi.fleet().then(f => setOrte(f.unterstuetzungStandorte ? f.unterstuetzungStandorte.filter(s => s.tenantId === tenantId) : null)).catch(() => { setOrte(null); if (modus) setFehler('Standorte konnten nicht geladen werden.'); }); }, [modus, tenantId]);
  if (!isPlatformAdmin()) return null;
  const schliessen = () => { if (!busy) { setModus(undefined); requestAnimationFrame(() => trigger.current?.focus()); } };
  async function speichern() {
    if (busy || !modus) return;
    const problem = modus === 'notfall' ? (!auswahl.length ? 'Wählen Sie mindestens einen Standort.' : !grund.trim() ? 'Bitte geben Sie einen Grund für den Notfall-Zugriff an.' : null) : pruefeUnterstuetzung(auswahl, bis);
    if (problem) { setFehler(problem); form.current?.querySelector<HTMLElement>(!auswahl.length ? '[role="combobox"]' : modus === 'notfall' ? 'input' : '[aria-haspopup="dialog"]')?.focus(); return; }
    setBusy(true); setFehler('');
    try {
      const antwort = await request<Unterstuetzung | UnterstuetzungAnfrage>(`/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/unterstuetzung/${modus}`, { method: 'POST', body: JSON.stringify({ standorte: auswahl, umfang, grund: grund.trim() || null, ...(modus === 'anfrage' ? { gueltig_bis: bis } : {}) }) });
      setErfolg(modus === 'notfall' ? ('banner' in antwort ? antwort.banner ?? 'Notfall-Zugriff gewährt.' : '') : 'Anfrage gesendet. Zugriff entsteht erst nach Bestätigung durch den Kundenadministrator.');
      setModus(undefined); requestAnimationFrame(() => trigger.current?.focus());
      window.dispatchEvent(new Event('vp-unterstuetzung-geaendert'));
    } catch (e) { setFehler(unterstuetzungFehler(e)); } finally { setBusy(false); }
  }
  return <>
    <Card padding="lg" radius="lg" className="vp-mandant-karte vp-unterstuetzung">
      <div className="vp-section-head">
        <h2><Icon name="help-circle" size={18} /> Unterstützung</h2>
        {/* Admin-Durchgang F10: ohne Standort führten beide Knöpfe in Dialoge ohne Auswahl. */}
        {orte?.length !== 0 && <span className="actions">
          {(['anfrage', 'notfall'] as const).map(m => <Button key={m} variant="outline" size="sm" onClick={e => { e.currentTarget.focus(); trigger.current = e.currentTarget; setFehler(''); setGrund(''); setAuswahl([]); setUmfang(m === 'notfall' ? 'einrichten_und_bedienen' : 'ansehen'); setModus(m); }}>{m === 'anfrage' ? 'Unterstützung anfragen' : 'Notfall-Zugriff'}</Button>)}
        </span>}
      </div>
      {orte?.length === 0 && <p className="vp-unterstuetzung-ohne-standort" role="note">{UNTERSTUETZUNG_OHNE_STANDORT}</p>}
      {erfolg && <p role="status">{erfolg}</p>}
    </Card>
    <Modal open={!!modus} onClose={schliessen} title={modus === 'notfall' ? 'Notfall-Zugriff' : 'Unterstützung anfragen'} footer={<><Button variant="ghost" disabled={busy} onClick={schliessen}>Abbrechen</Button><Button disabled={busy} onClick={() => void speichern()}>{modus === 'notfall' ? 'Notfall-Zugriff gewähren' : 'Anfrage senden'}</Button></>}>
      <div className="vp-unterstuetzung-form" ref={form}><p>{name}</p>
        <VpPicker label="Standorte" values={auswahl} onChangeMany={setAuswahl} options={(orte ?? []).map(s => ({ value: s.id, label: s.name }))} />
        <VpPicker label="Umfang" value={umfang} onChange={setUmfang} options={Object.entries(UMFANG).map(([value, label]) => ({ value, label }))} />
        {modus === 'notfall' ? <p>Der Zugriff gilt genau 24 Stunden und kann nicht verlängert werden. Alle Kundenadministratoren erhalten einen Hinweis im Portal; eine E-Mail wird nur bei eingerichtetem E-Mail-Versand zugestellt.</p>
          : <VpDatePicker label="Gültig bis einschließlich" value={bis} onChange={setBis} min={heute()} max={hoechstesEnde()} />}
        <Input label={modus === 'notfall' ? 'Grund (Pflicht)' : 'Grund (optional)'} required={modus === 'notfall'} value={grund} onChange={e => setGrund(e.target.value)} />
        <UnterstuetzungFolgen />{fehler && <p role="alert">{fehler}</p>}
      </div>
    </Modal>
  </>;
}
