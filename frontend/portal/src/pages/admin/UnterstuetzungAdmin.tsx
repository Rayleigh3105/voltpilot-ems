import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Input } from '../../../designsystem/components/forms/Input';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { request, type Unterstuetzung, type UnterstuetzungAnfrage } from '../../api';
import { fleetApi } from '../../admin/fleetApi';
import { isPlatformAdmin } from '../../auth';
import { VpPicker } from '../../components/VpPicker';
import { VpDatePicker } from '../../components/VpDatePicker';
import { UnterstuetzungFolgen } from '../../components/UnterstuetzungDialog';
import { heute, hoechstesEnde, pruefeUnterstuetzung, UMFANG, unterstuetzungFehler, vorgabeEnde } from '../../unterstuetzung';

export function UnterstuetzungAdmin({ tenantId, name }: { tenantId: string; name: string }) {
  const [modus, setModus] = useState<'anfrage' | 'notfall'>();
  const [orte, setOrte] = useState<{ id: string; name: string }[]>([]);
  const [auswahl, setAuswahl] = useState<string[]>([]); const [umfang, setUmfang] = useState('ansehen');
  const [bis, setBis] = useState(vorgabeEnde); const [grund, setGrund] = useState('');
  const [busy, setBusy] = useState(false); const [fehler, setFehler] = useState(''); const [erfolg, setErfolg] = useState('');
  const form = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => { if (modus) void fleetApi.fleet().then(f => setOrte((f.unterstuetzungStandorte ?? []).filter(s => s.tenantId === tenantId))).catch(() => setFehler('Standorte konnten nicht geladen werden.')); }, [modus, tenantId]);
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
  return <section className="vp-unterstuetzung"><h3>Unterstützung</h3><div className="vp-unterstuetzung-aktionen">
    {(['anfrage', 'notfall'] as const).map(m => <Button key={m} variant="outline" onClick={e => { e.currentTarget.focus(); trigger.current = e.currentTarget; setFehler(''); setGrund(''); setAuswahl([]); setUmfang(m === 'notfall' ? 'einrichten_und_bedienen' : 'ansehen'); setModus(m); }}>{m === 'anfrage' ? 'Unterstützung anfragen' : 'Notfall-Zugriff'}</Button>)}
    </div>{erfolg && <p role="status">{erfolg}</p>}
    <Modal open={!!modus} onClose={schliessen} title={modus === 'notfall' ? 'Notfall-Zugriff' : 'Unterstützung anfragen'} footer={<><Button variant="ghost" disabled={busy} onClick={schliessen}>Abbrechen</Button><Button disabled={busy} onClick={() => void speichern()}>{modus === 'notfall' ? 'Notfall-Zugriff gewähren' : 'Anfrage senden'}</Button></>}>
      <div className="vp-unterstuetzung-form" ref={form}><p>{name}</p>
        <VpPicker label="Standorte" values={auswahl} onChangeMany={setAuswahl} options={orte.map(s => ({ value: s.id, label: s.name }))} />
        <VpPicker label="Umfang" value={umfang} onChange={setUmfang} options={Object.entries(UMFANG).map(([value, label]) => ({ value, label }))} />
        {modus === 'notfall' ? <p>Der Zugriff gilt genau 24 Stunden und kann nicht verlängert werden. Alle Kundenadministratoren erhalten einen Hinweis im Portal; eine E-Mail wird nur bei eingerichtetem E-Mail-Versand zugestellt.</p>
          : <VpDatePicker label="Gültig bis einschließlich" value={bis} onChange={setBis} min={heute()} max={hoechstesEnde()} />}
        <Input label={modus === 'notfall' ? 'Grund (Pflicht)' : 'Grund (optional)'} required={modus === 'notfall'} value={grund} onChange={e => setGrund(e.target.value)} />
        <UnterstuetzungFolgen />{fehler && <p role="alert">{fehler}</p>}
      </div>
    </Modal>
  </section>;
}
