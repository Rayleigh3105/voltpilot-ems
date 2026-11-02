/**
 * „Werkstatt freigeben“ (WI-4 A, nur platform-admin): welche Fassungen der
 * Werkstatt-Dienst aufspielt und bis wann. Die Freigabe gilt für jede Mango,
 * die in der Zeit eingesteckt wird; die Obergrenze ist nur ein Schutz. Die
 * API prüft alles noch einmal und nennt jeden Grund (422).
 */
import { useState, type FormEvent } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Input } from '../../../designsystem/components/forms/Input';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import { OPENWRT_ABBILD, OPENWRT_FASSUNG, OPENWRT_QUELLE } from '../../werkstatt';
import type { WerkstattFreigabe } from '../../werkstattBank';

/** Der Block `edge_light` aus `freigabe-edge-light.json` einer Fassung (Lauf „Edge-Light-Fassung“). */
export function edgeLightAusBlock(text: string): WerkstattFreigabe['edgeLight'] | null {
  try {
    const roh = JSON.parse(text);
    const b = roh && typeof roh === 'object' && 'edge_light' in roh ? roh.edge_light : roh;
    if (b && typeof b.fassung === 'string' && typeof b.quelle === 'string'
      && typeof b.programm_sha256 === 'string' && typeof b.skripte_sha256 === 'string') {
      return { fassung: b.fassung, quelle: b.quelle, programmSha256: b.programm_sha256, skripteSha256: b.skripte_sha256 };
    }
    return null;
  } catch {
    return null;
  }
}

export function WerkstattFreigabeDialog({ onClose, onErteilt }: { onClose: () => void; onErteilt: (f: WerkstattFreigabe) => void }) {
  const [tage, setTage] = useState('30');
  const [obergrenze, setObergrenze] = useState('20');
  const [owFassung, setOwFassung] = useState(OPENWRT_FASSUNG);
  const [owDatei, setOwDatei] = useState(OPENWRT_ABBILD);
  const [owSha, setOwSha] = useState('');
  const [owQuelle, setOwQuelle] = useState(OPENWRT_QUELLE);
  const [block, setBlock] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function absenden(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    const edge = edgeLightAusBlock(block);
    if (!edge) {
      setFehler('Den Block „edge_light“ aus freigabe-edge-light.json der Fassung einfügen (fassung, quelle, programm_sha256, skripte_sha256).');
      document.getElementById('ws-freigabe-block')?.focus();
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      const f = await adminApi.werkstattFreigeben({
        boxArt: 'mango', tage: Number(tage), obergrenze: Number(obergrenze),
        openwrt: { fassung: owFassung.trim(), datei: owDatei.trim(), sha256: owSha.trim().toLowerCase(), quelle: owQuelle.trim() },
        edgeLight: edge,
      });
      onErteilt(f);
    } catch (err) {
      setFehler(err instanceof ApiError ? err.message : 'Die Freigabe ließ sich nicht anlegen. Bitte erneut versuchen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title="Werkstatt freigeben"
      onClose={() => { if (!busy) onClose(); }}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>Abbrechen</Button>
          <Button type="submit" form="ws-freigabe" disabled={busy} data-testid="ws-freigabe-absenden">
            {busy ? 'Wird freigegeben …' : 'Freigeben'}
          </Button>
        </>
      }
    >
      <form id="ws-freigabe" className="vp-ws-freigabe-form" onSubmit={(e) => void absenden(e)} noValidate>
        <p className="vp-muted" style={{ marginTop: 0 }}>
          Für jede Mango, die du in der Zeit einsteckst, eine nach der anderen. Je Box-Art läuft höchstens eine Freigabe.
        </p>
        <div className="vp-ws-reihe2">
          <Input label="Tage ab jetzt" inputMode="numeric" value={tage} onChange={(e) => setTage(e.target.value)} hint="1 bis 92" />
          <Input label="Obergrenze Boxen" inputMode="numeric" value={obergrenze} onChange={(e) => setObergrenze(e.target.value)} hint="1 bis 200, nur ein Schutz" />
        </div>
        <fieldset className="vp-ws-feldgruppe">
          <legend>OpenWrt-Abbild</legend>
          <Input label="Fassung" value={owFassung} onChange={(e) => setOwFassung(e.target.value)} />
          <Input label="Datei (sysupgrade)" value={owDatei} onChange={(e) => setOwDatei(e.target.value)} />
          <Input label="sha256" value={owSha} onChange={(e) => setOwSha(e.target.value)} hint="aus sha256sums der Fassung, 64 Zeichen" data-testid="ws-freigabe-sha" />
          <Input label="Quelle (https)" value={owQuelle} onChange={(e) => setOwQuelle(e.target.value)} />
        </fieldset>
        <label className="vp-ws-feld" htmlFor="ws-freigabe-block">
          <span>Edge Light: Block aus freigabe-edge-light.json</span>
          <textarea
            id="ws-freigabe-block"
            rows={6}
            value={block}
            onChange={(e) => setBlock(e.target.value)}
            placeholder='{"fassung":"edge-light-2026.11.1","quelle":"https://…","programm_sha256":"…","skripte_sha256":"…"}'
            data-testid="ws-freigabe-block"
          />
        </label>
        {fehler && <p className="vp-alert vp-alert-err" role="alert" data-testid="ws-freigabe-fehler">{fehler}</p>}
      </form>
    </Modal>
  );
}
