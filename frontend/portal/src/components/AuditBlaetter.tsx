import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type InternesAuditMitVerlauf, type InternesAuditprogramm } from '../api';
import * as A from '../auditFeststellung';
import { planVorschlag, unabhaengigSatz, wannOptionen, type UnabhaengigWahl } from '../auditPlanen';
import * as E from '../energiemanagementPortal';
import { useRollen } from '../rollen';
import { GrenzSatz } from './GrenzSatz';
import { ablehnung, useKonten, usePersonen } from './InternesAuditDialoge';
import { NwBlatt } from './nachweisen/NwBlatt';
import { AntwortKarten, PruefZeilen, SchrittAnzeige, WahlChips } from './nachweisen/NwSchritte';
import { NwTextfeld } from './nachweisen/NwTextfeld';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

type Schritt = 1 | 2 | 3;

/**
 * „Internes Audit 2030 planen“ als geführtes Blatt (Konzept Nachweisen n1 Runde 2, §6.10, Mocks AU1/AU2): drei Schritte,
 * eine Frage je Schritt - was und wann (spätestens die Frist der Route, IA4), wer prüft und warum unabhängig (Antwort-
 * Karten statt Wortlaut-Feld), zuletzt Prüfen in Zeilen. Titel, „woran“ und Verantwortlich sind vorbelegt (das nächste
 * Jahr, „woran“ des letzten Audits, das eigene Konto) und im Prüfen änderbar. Die Route prüft alles (IA1).
 */
export function AuditPlanenBlatt({
  programm,
  onClose,
  onGeplant,
}: {
  programm: InternesAuditprogramm;
  onClose: () => void;
  onGeplant: (a: InternesAuditMitVerlauf) => void;
}) {
  const rollen = useRollen();
  const { personen, optionen } = usePersonen();
  const konten = useKonten();
  const vorschlag = planVorschlag(programm);
  const [schritt, setSchritt] = useState<Schritt>(1);
  const [e, setE] = useState<A.AuditEntwurf>({ ...A.LEERES_AUDIT, titel: vorschlag.titel, woran: vorschlag.woran, termin: vorschlag.termin ?? '' });
  const [wann, setWann] = useState<string | null>(vorschlag.termin ? 'frist' : 'anders');
  const [unab, setUnab] = useState<UnabhaengigWahl | null>(null);
  const [eigen, setEigen] = useState('');
  const [aendern, setAendern] = useState<'titel' | 'woran' | 'verantwortlich' | null>(null);
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setze = (t: Partial<A.AuditEntwurf>) => setE((alt) => ({ ...alt, ...t }));
  const optWann = wannOptionen(programm);

  // Verantwortlich ist ein Konto: vorbelegt das eigene, wenn es eines im Kundenbereich ist.
  useEffect(() => {
    if (e.verantwortlich || !konten) return;
    const ich = konten.find((k) => k.value === rollen.selbst?.kennung);
    if (ich) setze({ verantwortlich: ich.value });
  }, [konten, e.verantwortlich, rollen.selbst?.kennung]);

  const namen = (personen ?? []).filter((p) => e.auditorIds.includes(p.id)).map((p) => p.name);
  const unabhaengigkeit = unab ? unabhaengigSatz(unab, namen, eigen) : '';

  function weiter() {
    const f: E.Feldfehler = {};
    if (schritt === 1) {
      if (!e.was.trim()) f.was = 'Bitte nennen Sie, was geprüft wird.';
      if (!e.termin) f.termin = 'Bitte wählen Sie den Tag.';
    }
    if (schritt === 2) {
      if (!e.auditorIds.length) f.auditorIds = 'Bitte wählen Sie, wer prüft.';
      if (!unabhaengigkeit.trim()) f.unabhaengigkeit = 'Bitte sagen Sie, warum die Person unabhängig prüft.';
    }
    setFehler(f);
    if (!Object.keys(f).length) setSchritt((s) => (s < 3 ? ((s + 1) as Schritt) : s));
  }

  async function planen() {
    const r = A.auditKoerper({ ...e, unabhaengigkeit });
    if ('fehler' in r) {
      setFehler(r.fehler);
      if (r.fehler.was || r.fehler.termin) setSchritt(1);
      else if (r.fehler.auditorIds || r.fehler.unabhaengigkeit) setSchritt(2);
      else if (r.fehler.woran) setAendern('woran');
      else if (r.fehler.verantwortlich) setAendern('verantwortlich');
      else if (r.fehler.titel) setAendern('titel');
      return;
    }
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onGeplant(await api.energiemanagementAuditPlanen(r.koerper));
    } catch (err) {
      setSatz(ablehnung(err));
    } finally {
      setBusy(false);
    }
  }

  const titel = schritt === 1 ? `${e.titel || 'Internes Audit'} planen` : schritt === 2 ? 'Wer prüft?' : 'Prüfen';
  const fuss = (
    <div className="vp-nw-blatt-fuss">
      {schritt < 3 ? (
        <Button onClick={weiter} data-testid="audit-planen-weiter">
          Weiter
        </Button>
      ) : (
        <Button onClick={() => void planen()} disabled={busy} data-testid="audit-planen-senden">
          {A.KNOPF_AUDIT_PLANEN}
        </Button>
      )}
      <Button variant="ghost" onClick={schritt === 1 ? onClose : () => setSchritt((s) => (s - 1) as Schritt)}>
        {schritt === 1 ? 'Abbrechen' : 'Zurück'}
      </Button>
    </div>
  );

  return (
    <NwBlatt open titel={titel} onClose={onClose} fuss={fuss} testId="audit-planen-blatt">
      <div className="vp-nw-schritt-inhalt">
        <SchrittAnzeige nr={schritt} von={3} />
        {schritt === 1 && (
          <>
            <NwTextfeld label="Was prüfen Sie?" wert={e.was} onWert={(was) => setze({ was })} mehrzeilig fehler={fehler.was} testid="audit-planen-was" />
            {optWann.length > 0 && (
              <WahlChips frage="Wann?" optionen={optWann} wert={wann} onWahl={(w) => {
                setWann(w);
                const o = optWann.find((x) => x.wert === w);
                setze({ termin: o?.tag ?? '' });
              }} testid="audit-planen-wann" fehler={wann !== 'anders' ? fehler.termin : null} />
            )}
            {wann === 'anders' && (
              <VpDatePicker label={optWann.length ? 'Tag' : 'Wann?'} value={e.termin || null} onChange={(termin) => setze({ termin })} error={fehler.termin ?? null} />
            )}
            {vorschlag.spaetestens && <p className="vp-nw-leise">{`spätestens ${E.tagText(vorschlag.spaetestens)}`}</p>}
          </>
        )}
        {schritt === 2 && (
          <>
            <VpPicker
              label="Wer prüft?"
              options={optionen}
              values={e.auditorIds}
              onChangeMany={(auditorIds) => setze({ auditorIds })}
              placeholder="Person wählen"
              loading={personen === null}
              error={fehler.auditorIds ?? null}
            />
            <AntwortKarten
              frage="Warum unabhängig?"
              optionen={[
                { wert: 'team', titel: 'Nicht im Energieteam' },
                { wert: 'aussen', titel: 'Von außen' },
                { wert: 'eigen', titel: 'In eigenen Worten' },
              ]}
              wert={unab}
              onWahl={setUnab}
              testid="audit-planen-unabhaengig"
            />
            {unab === 'eigen' && <NwTextfeld label="Ihre Worte" wert={eigen} onWert={setEigen} mehrzeilig />}
            {fehler.unabhaengigkeit && <p className="vp-nw-feld-fehler" role="alert">{fehler.unabhaengigkeit}</p>}
          </>
        )}
        {schritt === 3 && (
          <>
            <PruefZeilen
              testid="audit-planen-pruefen"
              zeilen={[
                { etikett: 'Audit', wert: e.titel, onAendern: () => setAendern('titel') },
                { etikett: 'Was', wert: e.was, onAendern: () => setSchritt(1) },
                { etikett: 'Wann', wert: E.tagText(e.termin), onAendern: () => setSchritt(1) },
                { etikett: 'Wer prüft', wert: namen.join(', '), onAendern: () => setSchritt(2) },
                { etikett: 'Woran', wert: e.woran || '-', onAendern: () => setAendern('woran') },
                {
                  etikett: 'Verantwortlich',
                  wert: konten?.find((k) => k.value === e.verantwortlich)?.label ?? '-',
                  onAendern: () => setAendern('verantwortlich'),
                },
              ]}
            />
            {aendern === 'titel' && <NwTextfeld label="Audit" wert={e.titel} onWert={(t) => setze({ titel: t })} fehler={fehler.titel} />}
            {aendern === 'woran' && <NwTextfeld label="Woran prüfen Sie?" wert={e.woran} onWert={(woran) => setze({ woran })} mehrzeilig fehler={fehler.woran} />}
            {aendern === 'verantwortlich' && (
              <VpPicker
                label="Verantwortlich"
                options={konten ?? []}
                value={e.verantwortlich || null}
                onChange={(verantwortlich) => setze({ verantwortlich })}
                placeholder="Konto wählen"
                loading={konten === null}
                error={fehler.verantwortlich ?? null}
              />
            )}
          </>
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
