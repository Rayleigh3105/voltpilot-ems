import { useEffect, useState } from 'react';
import { VpPicker, type VpOption } from '../../components/VpPicker';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input } from '../../../designsystem/components/forms/Input';
import { ApiError } from '../../api';
import { adminApi, type BoxLoesenAnlass, type BoxLoesenBefund } from '../../admin/adminApi';
import { fmtRelative } from '../../format';

/**
 * „Vom Kunden lösen" (L1, Vertrag Abschnitt 3.5, B1-B4 = A): EIN Dialog für alle Einstiege -
 * Kopf-Karte und Menü der Geräteakte, seit dem Befund vp-kundenakte-fremde-personen (Punkt 7)
 * auch die Karte „Anlagen und Boxen" der Kundenakte. Der Befund kommt vom Server (nie vom Portal
 * behauptet); ist er nicht lösbar, zeigt der Dialog nur den Grund und den Weg stattdessen - kein
 * Formular, kein destruktiver Knopf.
 */

const ANLASS_OPTIONEN: VpOption[] = [
  { value: 'falsche_kennung', label: 'Falsche Kennung verbunden' },
  { value: 'fremder_kunde', label: 'Box gehört einem anderen Kunden' },
  { value: 'doppelt_verbunden', label: 'Doppelt verbunden' },
  { value: 'anderer_anlass', label: 'Anderer Anlass …' },
];

const GRUND_SATZ: Record<string, (f: BoxLoesenBefund['fakten'], jetzt: Date) => string> = {
  verbund: () => 'ist nicht mehr verbunden',
  herzschlag: (f, jetzt) => `Herzschlag ${fmtRelative(f.herzschlagAm, jetzt)}`,
  messwerte: (f, jetzt) => `Messwerte seit ${fmtRelative(f.messwertAm, jetzt)}`,
  meldungen: (f, jetzt) => `Software-Meldung ${fmtRelative(f.meldungAm, jetzt)}`,
  zustaendigkeit: () => 'liest noch eine Datenquelle',
  angemeldet: () => 'hat ihren Schlüssel schon abgeholt',
};

function befundSatz(befund: BoxLoesenBefund, jetzt: Date): string {
  if (befund.loesbar) {
    const schluessel = befund.fakten.anmeldung.schluesselAbgeholtAm;
    return `Hat sich nie gemeldet · Herzschlag nie · Messwerte keine · Anmeldung ${schluessel ? 'abgeholt, wird entzogen' : 'nie'}.`;
  }
  const teile = befund.gruende.map((g) => GRUND_SATZ[g]?.(befund.fakten, jetzt) ?? g);
  return `Hat Daten gespeichert · ${teile.join(' · ')}.`;
}

export function BoxLoesenDialog({ open, boxRef, jetzt, onClose, onGeloescht }: {
  open: boolean;
  boxRef: string;
  jetzt: Date;
  onClose: () => void;
  onGeloescht: () => void;
}) {
  const [befund, setBefund] = useState<BoxLoesenBefund | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [anlass, setAnlass] = useState<BoxLoesenAnlass | null>(null);
  const [anlassText, setAnlassText] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBefund(null);
    setLadeFehler(null);
    setAnlass(null);
    setAnlassText('');
    setFehler(null);
    let aktiv = true;
    adminApi.geraeteLoesenBefund(boxRef)
      .then((b) => { if (aktiv) setBefund(b); })
      .catch((e) => { if (aktiv) setLadeFehler(e instanceof ApiError ? e.message : 'Der Befund ließ sich nicht laden.'); });
    return () => { aktiv = false; };
  }, [open, boxRef]);

  async function bestaetigen() {
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

  const geladen = befund != null;
  const loesbar = befund?.loesbar === true;
  const intro = ladeFehler ?? (!geladen ? 'Befund wird geladen …' : befundSatz(befund, jetzt));
  const folgen = loesbar
    ? [`„${boxRef}" wird wieder frei - der richtige Besitzer kann sie verbinden.`,
        befund!.fakten.anmeldung.schluesselAbgeholtAm
          ? 'Die Box verliert sofort ihren Zugang zum Server.'
          : 'War es die einzige Box der Anlage, kommt der Kunde wieder in die Einrichtung.']
    : ['Der Kunde entfernt die Box selbst (Anlage › Box › ⋯ › Gerät entfernen) - die Daten bleiben.',
        'Gehören die Daten zu einer fremden Anlage, ist das ein Fall für die Unterstützung.'];

  return (
    <ConfirmDialog
      open={open}
      title="Vom Kunden lösen"
      intro={intro}
      consequences={folgen}
      confirmLabel={!geladen ? 'Bitte warten …' : loesbar ? (busy ? 'Wird gelöst …' : 'Vom Kunden lösen') : 'Verstanden'}
      tone={loesbar ? 'danger' : 'neutral'}
      busy={busy || !geladen}
      onConfirm={!geladen ? () => {} : loesbar ? bestaetigen : onClose}
      onCancel={onClose}
      extra={loesbar && (
        <div className="vp-loesen-anlass">
          <VpPicker label="Anlass" ariaLabel="Anlass" value={anlass} onChange={(v) => setAnlass(v as BoxLoesenAnlass)}
            options={ANLASS_OPTIONEN} placeholder="Bitte wählen …" />
          {anlass === 'anderer_anlass' && (
            <Input value={anlassText} onChange={(e) => setAnlassText(e.target.value)}
              placeholder="Anlass beschreiben" aria-label="Anlass beschreiben" />
          )}
          {fehler && <p className="vp-feld-fehler" role="alert" style={{ marginBottom: 0 }}>{fehler}</p>}
        </div>
      )}
    />
  );
}
