import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import * as A from '../abweichungen';
import { api, type Abweichung, type AbweichungErgebnis, type Massnahme } from '../api';
import { heute } from '../bewertung';
import * as Z from '../energieziele';
import { UEMS_AUSSAGE_VON, UEMS_NORMGRENZE } from '../glossar';
import { useAktiveKonten, VerantwortlichWahl } from './AuffaelligkeitZeile';
import { Ablehnung, Begruendung } from './EnergiezielDialoge';
import { MassnahmeAnlegenDialog } from './MassnahmeDialoge';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import '../pages/Verbesserung.css';

const ABBRECHEN = 'Abbrechen';
const OHNE_KONTO = '__ohne_konto';

type Props = { abweichung: Abweichung; onClose: () => void; onFertig: (a: Abweichung) => void; tagHeute?: string };

function Rahmen({ titel, basis, busy, knopf, testid, onClose, children }: {
  titel: string; basis: string; busy: boolean; knopf: string; testid: string; onClose: () => void; children: ReactNode;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={titel}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid={`${testid}-senden`}>
            {knopf}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

/**
 * Eine Ursache-Aussage (A4, U1–U3): der Wortlaut einer Person, wer ausgesagt hat (ein aktives Konto oder ein Name ohne
 * Konto), an welchem Tag, wahlfrei eine Beleg-Kennung. Wer einträgt, muss nicht wer aussagt sein (R2). Das System
 * nennt keine Ursache — es trägt ein, was eine Person sagt, und zeigt es immer mit „Aussage von …“.
 */
export function UrsacheAussageDialog({ abweichung, onClose, onFertig, tagHeute = heute() }: Props) {
  const basis = `ua-${useId().replace(/:/g, '')}`;
  const { geladen, konten } = useAktiveKonten();
  const [e, setE] = useState<A.AussageEntwurf>({ wortlaut: '', person: '', am: tagHeute, beleg: '' });
  const [name, setName] = useState('');
  const [zeigen, setZeigen] = useState<Partial<Record<keyof A.AussageEntwurf, string>>>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setze = (t: Partial<A.AussageEntwurf>) => setE((alt) => ({ ...alt, ...t }));

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const person = e.person === OHNE_KONTO ? (name.trim() ? OHNE_KONTO : '') : e.person;
    const fehler = A.aussagePruefen({ ...e, person }, tagHeute);
    setZeigen(fehler);
    if (Object.keys(fehler).length) {
      document.getElementById(`${basis}-${Object.keys(fehler)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onFertig(
        await api.abweichungEintrag(abweichung.id, {
          art: 'ursache_aussage',
          wortlaut: e.wortlaut.trim(),
          ...(e.person === OHNE_KONTO ? { aussage_name: name.trim() } : { aussage_sub: e.person }),
          aussage_am: e.am,
          ...(e.beleg.trim() ? { beleg_kennung: e.beleg.trim() } : {}),
        }),
      );
    } catch (x) {
      setSatz(A.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Rahmen titel={`${abweichung.kennzeichen}: ${A.KNOPF_AUSSAGE}`} basis={basis} busy={busy} knopf={A.KNOPF_AUSSAGE} testid="ursache-aussage" onClose={onClose}>
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid="ursache-aussage">
        <p className="vp-ez-basis">{A.AUSSAGE_HINWEIS}</p>
        <VpPicker
          id={`${basis}-person`}
          label={`${UEMS_AUSSAGE_VON} …`}
          options={[...(konten ?? []), { value: OHNE_KONTO, label: 'einer Person ohne Konto' }]}
          loading={!geladen}
          value={e.person || null}
          onChange={(v) => setze({ person: v ?? '' })}
          error={zeigen.person ?? null}
        />
        {e.person === OHNE_KONTO && <Input id={`${basis}-name`} label="Name der Person" value={name} onChange={(x) => setName(x.target.value)} />}
        <VpDatePicker id={`${basis}-am`} label="Tag der Aussage" value={e.am} onChange={(v) => setze({ am: v })} max={tagHeute} error={zeigen.am ?? null} />
        <div className="vp-ez-feld">
          <label className="vp-ez-label" htmlFor={`${basis}-wortlaut`}>
            Wortlaut der Aussage
          </label>
          <textarea id={`${basis}-wortlaut`} rows={3} value={e.wortlaut} onChange={(x) => setze({ wortlaut: x.target.value })} aria-invalid={!!zeigen.wortlaut} />
          <p className={zeigen.wortlaut ? 'vp-ez-fehler' : 'vp-ez-leise'}>{zeigen.wortlaut ?? '10 bis 500 Zeichen, so wie die Person es gesagt hat.'}</p>
        </div>
        <Input id={`${basis}-beleg`} label="Beleg (wahlfrei)" value={e.beleg} onChange={(x) => setze({ beleg: x.target.value })} hint={A.BELEG_HINWEIS} />
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Rahmen>
  );
}

/** „Frist ändern“ (A4): nie vor dem Eröffnungstag, mit Begründung; nur offen. */
export function FristDialog({ abweichung, onClose, onFertig }: Props) {
  const basis = `af-${useId().replace(/:/g, '')}`;
  const [frist, setFrist] = useState(abweichung.frist.termin);
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    if (!Z.begruendungOk(begruendung)) {
      setZeigen(Z.BEGRUENDUNG_HINWEIS);
      document.getElementById(`${basis}-begruendung`)?.focus();
      return;
    }
    setZeigen(null);
    setBusy(true);
    setSatz(null);
    try {
      onFertig(await api.abweichungFrist(abweichung.id, { frist, begruendung: begruendung.trim() }));
    } catch (x) {
      setSatz(A.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Rahmen titel={`${abweichung.kennzeichen}: ${A.KNOPF_FRIST}`} basis={basis} busy={busy} knopf={A.KNOPF_FRIST} testid="abweichung-frist" onClose={onClose}>
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid="abweichung-frist">
        <VpDatePicker id={`${basis}-frist`} label={A.FRIST} value={frist} onChange={setFrist} min={abweichung.eroeffnet_am} />
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={zeigen} />
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Rahmen>
  );
}

/** „Verantwortlich ändern“ (A4, RE3): ein aktives Konto, mit Begründung; nur offen. */
export function VerantwortlicherDialog({ abweichung, onClose, onFertig }: Props) {
  const basis = `av-${useId().replace(/:/g, '')}`;
  const [wer, setWer] = useState(abweichung.verantwortlich.sub);
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<{ verantwortlich?: string; begruendung?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const fehler = {
      ...(!wer ? { verantwortlich: 'Bitte wählen Sie, wer verantwortlich ist.' } : {}),
      ...(!Z.begruendungOk(begruendung) ? { begruendung: Z.BEGRUENDUNG_HINWEIS } : {}),
    };
    setZeigen(fehler);
    if (Object.keys(fehler).length) {
      document.getElementById(`${basis}-${Object.keys(fehler)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onFertig(await api.abweichungVerantwortlicher(abweichung.id, { benutzer: wer, begruendung: begruendung.trim() }));
    } catch (x) {
      setSatz(A.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Rahmen titel={`${abweichung.kennzeichen}: ${A.KNOPF_VERANTWORTLICH}`} basis={basis} busy={busy} knopf={A.KNOPF_VERANTWORTLICH} testid="abweichung-verantwortlich" onClose={onClose}>
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid="abweichung-verantwortlich">
        <VerantwortlichWahl id={`${basis}-verantwortlich`} wert={wer} setze={setWer} fehler={zeigen.verantwortlich ?? null} />
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={zeigen.begruendung ?? null} />
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Rahmen>
  );
}

/**
 * „Abschließen“ (A6, §5.3; Recht `verbesserung.abschliessen`): Ergebnis und Begründung immer. Bei „Maßnahme“ der
 * Verweis auf eine bestehende Maßnahme — oder der Sprung in den Dialog „Maßnahme anlegen“ (IP-13), vorbelegt mit
 * Herkunft `abweichung`, Kennung, Kennzahl und den Monaten des Anlasses; die neue Maßnahme steht danach gewählt hier.
 * Einmalig; nichts an der Kennzahl ändert sich (A5).
 */
export function AbschliessenDialog({ abweichung, onClose, onFertig }: Props) {
  const basis = `ab-${useId().replace(/:/g, '')}`;
  const [ergebnis, setErgebnis] = useState<AbweichungErgebnis | ''>('');
  const [massnahme, setMassnahme] = useState('');
  const [begruendung, setBegruendung] = useState('');
  const [massnahmen, setMassnahmen] = useState<Massnahme[] | null>(null);
  const [anlegen, setAnlegen] = useState(false);
  const [zeigen, setZeigen] = useState<Partial<Record<'ergebnis' | 'massnahme' | 'begruendung', string>>>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ergebnis !== 'massnahme' || massnahmen) return;
    let aktiv = true;
    api.massnahmen().then(
      (l) => aktiv && setMassnahmen(l.massnahmen.filter((m) => m.zustand !== 'verworfen')),
      () => aktiv && setMassnahmen([]),
    );
    return () => {
      aktiv = false;
    };
  }, [ergebnis, massnahmen]);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const fehler = A.abschlussPruefen(ergebnis, begruendung, massnahme);
    setZeigen(fehler);
    if (Object.keys(fehler).length) {
      document.getElementById(`${basis}-${Object.keys(fehler)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onFertig(
        await api.abweichungAbschliessen(abweichung.id, {
          ergebnis: ergebnis as AbweichungErgebnis,
          begruendung: begruendung.trim(),
          ...(ergebnis === 'massnahme' ? { massnahme } : {}),
        }),
      );
    } catch (x) {
      setSatz(A.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  if (anlegen) {
    return (
      <MassnahmeAnlegenDialog
        vorbelegung={A.massnahmeVorbelegung(abweichung)}
        onClose={() => setAnlegen(false)}
        onAngelegt={(m) => {
          setMassnahmen((alt) => [m, ...(alt ?? []).filter((x) => x.id !== m.id)]);
          setMassnahme(m.id);
          setAnlegen(false);
        }}
      />
    );
  }

  // Die Maßnahmen aus dieser Abweichung zuerst — wählbar ist jede sichtbare.
  const optionen = [...(massnahmen ?? [])]
    .sort((a, b) => Number(b.herkunft.kennung === abweichung.kennzeichen) - Number(a.herkunft.kennung === abweichung.kennzeichen) || a.kennzeichen.localeCompare(b.kennzeichen))
    .map((m) => ({ value: m.id, label: `${m.kennzeichen} ${m.titel}` }));

  return (
    <Rahmen titel={`${abweichung.kennzeichen} ${A.KNOPF_ABSCHLIESSEN}`} basis={basis} busy={busy} knopf={A.KNOPF_ABSCHLIESSEN} testid="abweichung-abschliessen" onClose={onClose}>
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid="abweichung-abschliessen">
        <p className="vp-ez-leise">{A.ABSCHLUSS_HINWEIS}</p>
        <fieldset className="vp-ez-periode" data-testid="abschluss-ergebnis">
          <legend>{A.SPALTEN.ergebnis}</legend>
          <div className="vp-ez-wahl" role="radiogroup" aria-label={A.SPALTEN.ergebnis}>
            {(Object.keys(A.ERGEBNIS_WORT) as AbweichungErgebnis[]).map((r, i) => (
              <label key={r} className="vp-ez-wahl-punkt">
                <input
                  id={i === 0 ? `${basis}-ergebnis` : undefined}
                  type="radio"
                  name={`${basis}-ergebnis`}
                  value={r}
                  checked={ergebnis === r}
                  onChange={() => setErgebnis(r)}
                  data-testid={`abschluss-${r}`}
                />
                {A.ERGEBNIS_WORT[r]}
              </label>
            ))}
          </div>
          {zeigen.ergebnis && <p className="vp-ez-fehler">{zeigen.ergebnis}</p>}
        </fieldset>
        {ergebnis === 'massnahme' && (
          <div className="vp-ez-feld" data-testid="abschluss-massnahme">
            <VpPicker
              id={`${basis}-massnahme`}
              label={A.MASSNAHME_WAHL}
              options={optionen}
              loading={massnahmen === null}
              value={massnahme || null}
              onChange={(v) => setMassnahme(v ?? '')}
              error={zeigen.massnahme ?? null}
            />
            <p className="vp-ez-leise">{A.MASSNAHME_ODER}</p>
            <div className="vp-ez-aktionen">
              <Button size="sm" variant="outline" onClick={() => setAnlegen(true)} data-testid="abschluss-massnahme-anlegen">
                {A.KNOPF_MASSNAHME_ANLEGEN}
              </Button>
            </div>
          </div>
        )}
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={zeigen.begruendung ?? null} />
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Rahmen>
  );
}

