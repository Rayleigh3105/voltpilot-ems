import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input } from '../../../designsystem/components/forms/Input';
import { ApiError } from '../../api';
import { adminApi, type KundeLoeschbarkeit, type KundeLoeschlauf, type TenantOffboardingReport } from '../../admin/adminApi';
import {
  KUNDE_KEINE_DATEN_SATZ,
  KUNDE_WIRD_GELOESCHT_SATZ,
  kundeHatDatenSatz,
  kundeLoeschenFolgen,
  kundeLoeschlaufAbwarten,
  kundeLoeschlaufLesen,
} from '../../admin/kundeLoeschen';

/**
 * „Kunde endgültig löschen" (vp-kunde-sofort-loeschen-mit-daten): EIN Dialog für alle drei Einstiege
 * - das Kopf-Menü und die Vertrag-Karte der Kundenakte sowie das Zeilen-Menü der Kundenliste. Jeder
 * Kunde ist sofort löschbar, mit oder ohne Daten; der Befund vom Server (`GET …/loeschbarkeit`)
 * sagt nur noch ehrlich, WAS verloren geht (welche Daten, Weg Gesamtabzug) - nie, OB gelöscht werden
 * darf. Gelöscht wird erst nach dem ABTIPPEN des Kundennamens (Muster
 * `BoxEndgueltigLoeschenDialog`); die Folgenliste kommt aus den Server-Fakten (`folgen`).
 *
 * <p>Seit vp-kunde-loeschen-504 läuft der Löschzug serverseitig als Auftrag: das Bestätigen startet
 * ihn (202), der Dialog zeigt „Wird gelöscht …" und fragt den Stand ab, bis der Lauf fertig oder
 * mit ehrlichem Satz gescheitert ist - unabhängig davon, ob ein einzelner Request unter der
 * 60-s-Grenze des Ingress bleibt. Läuft beim Öffnen schon ein Zug (zweiter Tab, neu geöffnet),
 * zeigt der Dialog sofort diesen Lauf; ein zweites Bestätigen startet nie einen zweiten Zug.
 */
export function KundeLoeschenDialog({ open, tenantId, tenantName, onClose, onGeloescht }: {
  open: boolean;
  tenantId: string;
  tenantName: string;
  onClose: () => void;
  /**
   * Nach dem Löschen: der Bericht des Servers - der Wirt zeigt ihn bzw. kehrt zur Kundenliste
   * zurück. `null`, wenn der Bericht verloren ging (Absturz nach dem Commit): gelöscht ist gelöscht.
   */
  onGeloescht: (report: TenantOffboardingReport | null) => void;
}) {
  const [befund, setBefund] = useState<KundeLoeschbarkeit | null>(null);
  const [ladefehler, setLadefehler] = useState(false);
  const [abschrift, setAbschrift] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const offenRef = useRef(false);

  useEffect(() => {
    offenRef.current = open;
    if (!open) return;
    setBefund(null);
    setLadefehler(false);
    setAbschrift('');
    setFehler(null);
    setBusy(false);
    let aktiv = true;
    adminApi.kundeLoeschbarkeit(tenantId)
      .then((b) => { if (aktiv) setBefund(b); })
      .catch(() => { if (aktiv) setLadefehler(true); });
    // Läuft schon ein Zug (zweiter Tab, Dialog neu geöffnet)? Dann sofort seinen Stand zeigen.
    void kundeLoeschlaufLesen(tenantId).then((lauf) => {
      if (aktiv && lauf?.stand === 'laeuft') void abwarten(lauf);
    });
    return () => { aktiv = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenantId]);

  async function abwarten(lauf: KundeLoeschlauf) {
    setBusy(true);
    setFehler(null);
    try {
      const ende = await kundeLoeschlaufAbwarten(tenantId, lauf, () => offenRef.current);
      if (!offenRef.current) return;
      if (ende.stand === 'fertig') {
        onGeloescht(ende.bericht);
        return;
      }
      if (ende.stand === 'gescheitert') {
        setFehler(ende.fehler ?? 'Löschen fehlgeschlagen. Es wurde nichts gelöscht.');
      }
    } catch {
      if (offenRef.current) {
        setFehler('Der Stand des Löschzugs ist gerade nicht abrufbar - er läuft auf dem Server weiter. '
          + 'Bitte den Dialog erneut öffnen.');
      }
    } finally {
      if (offenRef.current) setBusy(false);
    }
  }

  async function bestaetigen() {
    if (busy || befund == null) return;
    if (abschrift.trim() !== tenantName) {
      setFehler('Der Name stimmt nicht überein - bitte genau abtippen.');
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      // Startet den Lauf (202) - oder bekommt den schon laufenden zurück (kein zweiter Zug).
      await abwarten(await adminApi.deleteTenant(tenantId, tenantName));
    } catch (e) {
      setFehler(e instanceof ApiError
        ? `Löschen fehlgeschlagen: ${e.message}`
        : 'Löschen fehlgeschlagen. Es wurde nichts gelöscht.');
      setBusy(false);
    }
  }

  const geladen = befund != null;
  const intro = busy
    ? KUNDE_WIRD_GELOESCHT_SATZ
    : ladefehler
      ? 'Die Datenauskunft ließ sich nicht laden - bitte erneut öffnen.'
      : !geladen
        ? 'Die Datenauskunft wird geladen …'
        : befund.daten.length === 0
          ? KUNDE_KEINE_DATEN_SATZ
          : kundeHatDatenSatz(befund);
  const folgen = geladen && !busy ? kundeLoeschenFolgen(tenantName, befund) : [];

  return (
    <ConfirmDialog
      open={open}
      title="Kunde endgültig löschen"
      intro={intro}
      consequences={folgen}
      confirmLabel={busy ? 'Wird gelöscht …' : 'Kunde endgültig löschen'}
      tone="danger"
      busy={busy || (!geladen && !ladefehler)}
      onConfirm={!geladen ? onClose : bestaetigen}
      onCancel={onClose}
      extra={geladen && !busy && (
        <div className="vp-endgueltig-abschrift">
          <Input value={abschrift} onChange={(e) => setAbschrift(e.target.value)}
            placeholder={tenantName} aria-label="Zum Bestätigen den Kundennamen abtippen"
            autoComplete="off" spellCheck={false} />
          <p className="vp-muted vp-text-sm" style={{ margin: '4px 0 0' }}>
            Zum Bestätigen den Namen <b>{tenantName}</b> abtippen.
          </p>
          {fehler && <p className="vp-feld-fehler" role="alert" style={{ marginBottom: 0 }}>{fehler}</p>}
        </div>
      )}
    />
  );
}
