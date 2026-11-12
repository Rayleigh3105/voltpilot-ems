import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input } from '../../../designsystem/components/forms/Input';
import { ApiError } from '../../api';
import { adminApi, type KundeLoeschbarkeit, type TenantOffboardingReport } from '../../admin/adminApi';
import { KUNDE_KEINE_DATEN_SATZ, kundeHatDatenSatz, kundeLoeschenFolgen } from '../../admin/kundeLoeschen';

/**
 * „Kunde endgültig löschen" (vp-kunde-sofort-loeschen-mit-daten): EIN Dialog für alle drei Einstiege
 * - das Kopf-Menü und die Vertrag-Karte der Kundenakte sowie das Zeilen-Menü der Kundenliste. Jeder
 * Kunde ist sofort löschbar, mit oder ohne Daten; der Befund vom Server (`GET …/loeschbarkeit`)
 * sagt nur noch ehrlich, WAS verloren geht (welche Daten, Weg Gesamtabzug) - nie, OB gelöscht werden
 * darf. Gelöscht wird erst nach dem ABTIPPEN des Kundennamens (Muster
 * `BoxEndgueltigLoeschenDialog`); die Folgenliste kommt aus den Server-Fakten (`folgen`).
 */
export function KundeLoeschenDialog({ open, tenantId, tenantName, onClose, onGeloescht }: {
  open: boolean;
  tenantId: string;
  tenantName: string;
  onClose: () => void;
  /** Nach dem Löschen: der Bericht des Servers - der Wirt zeigt ihn bzw. kehrt zur Kundenliste zurück. */
  onGeloescht: (report: TenantOffboardingReport) => void;
}) {
  const [befund, setBefund] = useState<KundeLoeschbarkeit | null>(null);
  const [ladefehler, setLadefehler] = useState(false);
  const [abschrift, setAbschrift] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBefund(null);
    setLadefehler(false);
    setAbschrift('');
    setFehler(null);
    let aktiv = true;
    adminApi.kundeLoeschbarkeit(tenantId)
      .then((b) => { if (aktiv) setBefund(b); })
      .catch(() => { if (aktiv) setLadefehler(true); });
    return () => { aktiv = false; };
  }, [open, tenantId]);

  async function bestaetigen() {
    if (busy || befund == null) return;
    if (abschrift.trim() !== tenantName) {
      setFehler('Der Name stimmt nicht überein - bitte genau abtippen.');
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      onGeloescht(await adminApi.deleteTenant(tenantId, tenantName));
    } catch (e) {
      setFehler(
        e instanceof ApiError && e.status === 502
          ? 'Die Benutzerverwaltung ist gerade nicht erreichbar - es wurde nichts gelöscht. Bitte versuchen Sie es später erneut.'
          : e instanceof ApiError
            ? `Löschen fehlgeschlagen: ${e.message}`
            : 'Löschen fehlgeschlagen. Es wurde nichts gelöscht.',
      );
      setBusy(false);
    }
  }

  const geladen = befund != null;
  const intro = ladefehler
    ? 'Die Datenauskunft ließ sich nicht laden - bitte erneut öffnen.'
    : !geladen
      ? 'Die Datenauskunft wird geladen …'
      : befund.daten.length === 0
        ? KUNDE_KEINE_DATEN_SATZ
        : kundeHatDatenSatz(befund);
  const folgen = geladen ? kundeLoeschenFolgen(tenantName, befund) : [];

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
      extra={geladen && (
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
