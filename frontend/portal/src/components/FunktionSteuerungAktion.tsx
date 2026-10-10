import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Recht } from './Recht';
import { ConfirmDialog } from './ConfirmDialog';

export type FunktionSteuerungAktionArt = 'anhalten' | 'fortsetzen';

function aufzaehlung(namen: readonly string[]): string {
  if (namen.length < 2) return namen[0] ?? 'Keine Anlage';
  return `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

/**
 * Der gemeinsame, rechtegeschützte Bestätigungsweg für Anlage und Standort.
 * Kein Klick schreibt unmittelbar: Der Dialog nennt zuerst jede betroffene
 * Anlage und die Folgen, erst sein Bestätigen ruft die gebaute Route auf.
 */
export function FunktionSteuerungAktion({
  art,
  umfang,
  standortId,
  betroffen,
  ruheHinweis,
  onBestaetigen,
}: {
  art: FunktionSteuerungAktionArt;
  umfang: 'anlage' | 'standort';
  standortId: string;
  betroffen: readonly string[];
  /** X7: ruhiger Zustandssatz, wenn diese Handlung die Ruhe an einer älteren Box setzt. */
  ruheHinweis?: string | null;
  onBestaetigen: () => Promise<void>;
}) {
  const [offen, setOffen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const label = umfang === 'standort' ? `Standort ${art}` : `Steuerung ${art}`;
  const namen = aufzaehlung(betroffen);
  const folgen = art === 'anhalten'
    ? [
        `Betroffen: ${namen}.`,
        'VoltPilot sendet ab sofort keine Sollwerte und keine Schaltbefehle mehr.',
        'Betriebsmodelle, Regeln und Freigaben bleiben erhalten, wirken aber bis zum Fortsetzen nicht.',
        'Einspeisegrenzen und Wächter bleiben aktiv. Die Steuerung bleibt ohne Enddatum angehalten.',
        ...(ruheHinweis ? [ruheHinweis] : []),
      ]
    : [
        `Betroffen: ${namen}.`,
        'VoltPilot prüft Box, Freigaben, Grenze, Hauptzähler und Betriebsweise erneut.',
        'Nur mit grüner Prüfliste beginnt die Steuerung mit dem nächsten Fahrplan.',
      ];

  return (
    <Recht standort={standortId} aktion="steuerung.anhalten_fortsetzen">
      <Button variant="outline" size="sm" onClick={() => { setFehler(null); setOffen(true); }}>
        {label}
      </Button>
      <ConfirmDialog
        open={offen}
        title={`${label}?`}
        intro={umfang === 'standort'
          ? 'Diese Änderung gilt für alle teilnehmenden Anlagen am Standort.'
          : `Diese Änderung gilt für ${namen}.`}
        consequences={folgen}
        confirmLabel={label}
        busy={busy}
        onCancel={() => { if (!busy) setOffen(false); }}
        onConfirm={() => {
          setBusy(true);
          setFehler(null);
          void onBestaetigen()
            .then(() => setOffen(false))
            .catch((e: unknown) => setFehler(e instanceof Error ? e.message : 'Die Steuerung konnte nicht geändert werden.'))
            .finally(() => setBusy(false));
        }}
        extra={fehler ? <p role="alert" className="vp-flowed-notice error">{fehler}</p> : undefined}
      />
    </Recht>
  );
}
