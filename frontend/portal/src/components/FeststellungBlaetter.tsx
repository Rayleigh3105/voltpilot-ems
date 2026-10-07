import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type FeststellungErgebnis, type FeststellungMitVerlauf } from '../api';
import * as A from '../auditFeststellung';
import * as E from '../energiemanagementPortal';
import { useRollen } from '../rollen';
import { GrenzSatz } from './GrenzSatz';
import { ablehnung, usePersonen } from './InternesAuditDialoge';
import { ErklaerKnopf } from './nachweisen/ErklaerKnopf';
import type { Erklaerung } from './nachweisen/erklaerung';
import { NwBlatt } from './nachweisen/NwBlatt';
import { AntwortKarten, HinweisZeile, PruefZeilen } from './nachweisen/NwSchritte';
import { NwTextfeld } from './nachweisen/NwTextfeld';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

const ERKLAERUNG_ZWEI_PERSONEN: Erklaerung = {
  frage: 'Wer darf bestätigen?',
  klartext: 'Bei Ihnen gilt: eine zweite Person bestätigt jede Wirksamkeit. Wer beantragt oder verantwortlich ist, bestätigt nicht selbst.',
  fachwort: 'Vier-Augen-Prinzip',
};

/**
 * „Wirksamkeit prüfen“ als Blatt (Konzept Nachweisen n1 Runde 2, §6.6/§6.10, Mock WI): eine Frage mit zwei Antwort-Karten
 * („Ja, wirksam“ · „Noch nicht wirksam“), „Woran sehen Sie das?“ als Satz und wer geprüft hat - vorbelegt mit der Person
 * des eigenen Kontos und dem Tag der Route, „Ändern“ öffnet beides. Mit Vier-Augen wird der Stand beantragt (FS6); die
 * Route entscheidet und lehnt mit ihrem Satz ab. Höchstens 35 Wörter des Systems.
 */
export function WirksamkeitBlatt({
  id,
  vieraugen,
  heute,
  onClose,
  onFertig,
}: {
  id: string;
  vieraugen: boolean;
  /** Der Tag der Route (`lage.abruf`) - eine Uhr. */
  heute: string;
  onClose: () => void;
  onFertig: (f: FeststellungMitVerlauf) => void;
}) {
  const rollen = useRollen();
  const { personen, optionen } = usePersonen();
  const [ergebnis, setErgebnis] = useState<Extract<FeststellungErgebnis, 'wirksam' | 'nicht_wirksam'> | null>('wirksam');
  const [begruendung, setBegruendung] = useState('');
  const [entschiedenVon, setEntschiedenVon] = useState('');
  const [am, setAm] = useState(heute);
  const [aendern, setAendern] = useState(false);
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Vorbelegt: die Person des eigenen Kontos; ohne sie öffnet „Geprüft von“ gleich zum Wählen.
  useEffect(() => {
    if (!personen || entschiedenVon) return;
    const ich = personen.find((p) => p.konto?.sub && p.konto.sub === rollen.selbst?.kennung);
    if (ich) setEntschiedenVon(ich.id);
    else setAendern(true);
  }, [personen, entschiedenVon, rollen.selbst?.kennung]);

  const name = personen?.find((p) => p.id === entschiedenVon)?.name ?? '';
  async function festhalten() {
    const r = A.standKoerper({ ergebnis: ergebnis ?? '', begruendung, entschiedenVon, am });
    if ('fehler' in r) {
      setFehler(r.fehler ?? {});
      if (r.fehler?.entschiedenVon) setAendern(true);
      return;
    }
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onFertig(await api.energiemanagementFeststellungStand(id, vieraugen ? 'wirksamkeit/beantragen' : 'wirksamkeit', r.koerper!));
    } catch (err) {
      setSatz(ablehnung(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <NwBlatt
      open
      titel={A.KNOPF_WIRKSAMKEIT}
      onClose={onClose}
      testId="wirksamkeit-blatt"
      fuss={
        <div className="vp-nw-blatt-fuss">
          <Button onClick={() => void festhalten()} disabled={busy} data-testid="wirksamkeit-festhalten">
            {vieraugen ? 'Beantragen' : 'Festhalten'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
        </div>
      }
    >
      <div className="vp-nw-schritt-inhalt">
        <AntwortKarten
          frage="Behoben, und bleibt es so?"
          optionen={[
            { wert: 'wirksam', titel: 'Ja, wirksam' },
            { wert: 'nicht_wirksam', titel: 'Noch nicht wirksam' },
          ]}
          wert={ergebnis}
          onWahl={setErgebnis}
          testid="wirksamkeit-ergebnis"
        />
        <NwTextfeld
          label="Woran sehen Sie das?"
          wert={begruendung}
          onWert={setBegruendung}
          mehrzeilig
          platzhalter="ein Satz"
          hoechstens={500}
          fehler={fehler.begruendung}
          testid="wirksamkeit-begruendung"
        />
        {aendern ? (
          <>
            <VpPicker
              label="Geprüft von"
              options={optionen}
              value={entschiedenVon || null}
              onChange={setEntschiedenVon}
              placeholder="Person wählen"
              loading={personen === null}
              error={fehler.entschiedenVon ?? null}
            />
            <VpDatePicker label="Am" value={am || null} onChange={setAm} max={heute} />
          </>
        ) : (
          <PruefZeilen zeilen={[{ etikett: 'Geprüft von', wert: `${name} · ${E.tagText(am)}`, onAendern: () => setAendern(true) }]} />
        )}
        {vieraugen && (
          <HinweisZeile icon="users" titel="Zwei Personen prüfen" knopf={<ErklaerKnopf erklaerung={ERKLAERUNG_ZWEI_PERSONEN} klein />} />
        )}
        {satz && (
          <p className="vp-nw-feld-fehler" role="alert" data-testid="energiemanagement-ablehnung">
            {satz}
          </p>
        )}
        {/* Grenz- und Verantwortungs-Satz: einmal am Fuß des Bereichs, unter dem das Blatt liegt (K7/D5). */}
        <GrenzSatz verantwortung />
      </div>
    </NwBlatt>
  );
}
