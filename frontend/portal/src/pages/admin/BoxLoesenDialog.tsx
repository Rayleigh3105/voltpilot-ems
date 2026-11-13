import { useEffect, useState } from 'react';
import { VpPicker, type VpOption } from '../../components/VpPicker';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input } from '../../../designsystem/components/forms/Input';
import { ApiError } from '../../api';
import { adminApi, type BoxLoesenAnlass, type BoxLoesenBefund } from '../../admin/adminApi';
import { ausbaubar, ausbauenFolgen, befundSatz, nichtAusbaubarFolgen } from '../../boxAusbauen';

/**
 * „Vom Kunden lösen" (L1, Vertrag Abschnitt 3.5, B1-B4 = A): EIN Dialog für alle Einstiege -
 * Kopf-Karte und Menü der Geräteakte, seit dem Befund vp-kundenakte-fremde-personen (Punkt 7)
 * auch die Karte „Anlagen und Boxen" der Kundenakte. Der Befund kommt vom Server (nie vom Portal
 * behauptet); ist er nicht lösbar, bot der Dialog bisher nur den Grund und den Umweg - seit
 * vp-admin-box-ausbauen (Captain-Auftrag 11.11.2026) bietet er dem Plattform-Admin stattdessen
 * „Box ausbauen" an, wenn die Box deshalb nicht löschbar ist, weil sie schon Daten hat: EIN
 * Einstieg, zwei Ergebnisse. Bleibt sie auch dafür gesperrt (eine offene Zuständigkeit), zeigt der
 * Dialog weiter nur die ruhige Erklärung mit dem Weg dorthin - nie ein toter Knopf.
 */

const ANLASS_OPTIONEN: VpOption[] = [
  { value: 'falsche_kennung', label: 'Falsche Kennung verbunden' },
  { value: 'fremder_kunde', label: 'Box gehört einem anderen Kunden' },
  { value: 'doppelt_verbunden', label: 'Doppelt verbunden' },
  { value: 'anderer_anlass', label: 'Anderer Anlass …' },
];


export function BoxLoesenDialog({ open, boxRef, jetzt, onClose, onGeloescht, onAusgebaut }: {
  open: boolean;
  boxRef: string;
  jetzt: Date;
  onClose: () => void;
  /** „Vom Kunden lösen": die Box ist weg, als wäre sie nie gewesen - die Akte hat keine Referenz mehr. */
  onGeloescht: () => void;
  /**
   * „Box ausbauen": die Box bleibt (als ausgebaut) - die Akte zeigt dieselbe Referenz weiter, nur
   * mit neuem Zustand. Ohne diese Prop fällt der Einstieg auf {@link onGeloescht} zurück (beide
   * Ergebnisse führen dort zu einem einfachen Neuladen, z. B. in der Kundenakte).
   */
  onAusgebaut?: () => void;
}) {
  const [befund, setBefund] = useState<BoxLoesenBefund | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [anlass, setAnlass] = useState<BoxLoesenAnlass | null>(null);
  const [anlassText, setAnlassText] = useState('');
  const [abschrift, setAbschrift] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBefund(null);
    setLadeFehler(null);
    setAnlass(null);
    setAnlassText('');
    setAbschrift('');
    setFehler(null);
    let aktiv = true;
    adminApi.geraeteLoesenBefund(boxRef)
      .then((b) => { if (aktiv) setBefund(b); })
      .catch((e) => { if (aktiv) setLadeFehler(e instanceof ApiError ? e.message : 'Der Befund ließ sich nicht laden.'); });
    return () => { aktiv = false; };
  }, [open, boxRef]);

  const geladen = befund != null;
  const loesbar = befund?.loesbar === true;
  const kannAusbauen = geladen && !loesbar && ausbaubar(befund.gruende);

  async function loesenBestaetigen() {
    if (!anlass || busy) return;
    const text = anlass === 'anderer_anlass' ? anlassText.trim() : null;
    if (anlass === 'anderer_anlass' && text === '') {
      setFehler('Bitte beschreiben Sie den Anlass.');
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      await adminApi.geraeteLoesen(boxRef, anlass, text);
      onGeloescht();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Lösen ist gerade nicht möglich.');
    } finally {
      setBusy(false);
    }
  }

  async function ausbauenBestaetigen() {
    if (!anlass || busy) return;
    const text = anlass === 'anderer_anlass' ? anlassText.trim() : null;
    if (anlass === 'anderer_anlass' && text === '') {
      setFehler('Bitte beschreiben Sie den Anlass.');
      return;
    }
    if (abschrift.trim() !== boxRef) {
      setFehler('Die Kennung stimmt nicht überein - bitte genau abtippen.');
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      await adminApi.geraeteAusbauen(boxRef, anlass, text);
      (onAusgebaut ?? onGeloescht)();
    } catch (e) {
      // box_hat_zustaendigkeiten (BoxKonflikt) trägt den Satz in `satz`, nicht in `message` (wie
      // jeder andere benannte 409 am Box-Lebenszyklus) - derselbe Weg dorthin wie bei den Gründen
      // oben, falls die Zuständigkeit erst zwischen Befund und Bestätigen entstand.
      const koerper = e instanceof ApiError && e.body && typeof e.body === 'object' ? e.body as { satz?: unknown } : null;
      setFehler(typeof koerper?.satz === 'string' ? koerper.satz
        : e instanceof ApiError ? e.message : 'Ausbauen ist gerade nicht möglich.');
    } finally {
      setBusy(false);
    }
  }

  const intro = ladeFehler ?? (!geladen ? 'Befund wird geladen …' : befundSatz(befund, jetzt));
  const title = loesbar || !geladen ? 'Vom Kunden lösen' : kannAusbauen ? 'Box ausbauen' : 'Vom Kunden lösen';
  const folgen = !geladen
    ? []
    : loesbar
      ? [`„${boxRef}" wird wieder frei - der richtige Besitzer kann sie verbinden.`,
          befund.fakten.anmeldung.schluesselAbgeholtAm
            ? 'Die Box verliert sofort ihren Zugang zum Server.'
            : 'War es die einzige Box der Anlage, kommt der Kunde wieder in die Einrichtung.']
      : kannAusbauen
        ? ausbauenFolgen(boxRef)
        : nichtAusbaubarFolgen(befund.gruende);
  const confirmLabel = !geladen
    ? 'Bitte warten …'
    : loesbar
      ? (busy ? 'Wird gelöst …' : 'Vom Kunden lösen')
      : kannAusbauen
        ? (busy ? 'Wird ausgebaut …' : 'Box ausbauen')
        : 'Verstanden';
  const aktion = loesbar ? loesenBestaetigen : kannAusbauen ? ausbauenBestaetigen : onClose;

  return (
    <ConfirmDialog
      open={open}
      title={title}
      intro={intro}
      consequences={folgen}
      confirmLabel={confirmLabel}
      tone={!geladen || loesbar || kannAusbauen ? 'danger' : 'neutral'}
      busy={busy || !geladen}
      onConfirm={!geladen ? () => {} : aktion}
      onCancel={onClose}
      extra={(loesbar || kannAusbauen) && (
        <div className="vp-loesen-anlass">
          <VpPicker label="Anlass" ariaLabel="Anlass" value={anlass} onChange={(v) => setAnlass(v as BoxLoesenAnlass)}
            options={ANLASS_OPTIONEN} placeholder="Bitte wählen …" />
          {anlass === 'anderer_anlass' && (
            <Input value={anlassText} onChange={(e) => setAnlassText(e.target.value)}
              placeholder="Anlass beschreiben" aria-label="Anlass beschreiben" />
          )}
          {kannAusbauen && (
            <>
              <Input value={abschrift} onChange={(e) => setAbschrift(e.target.value)}
                placeholder={boxRef} aria-label="Zum Bestätigen die Kennung abtippen"
                autoComplete="off" spellCheck={false} />
              <p className="vp-muted vp-text-sm" style={{ margin: '4px 0 0' }}>
                Ausbauen ist endgültig - zum Bestätigen die Kennung <span className="vp-mono">{boxRef}</span> abtippen.
              </p>
            </>
          )}
          {fehler && <p className="vp-feld-fehler" role="alert" style={{ marginBottom: 0 }}>{fehler}</p>}
        </div>
      )}
    />
  );
}
