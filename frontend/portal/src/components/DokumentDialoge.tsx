import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  type EnergiemanagementDokument,
  type EnergiemanagementFassung,
  type EnergiemanagementPerson,
  type EnergiemanagementPersonKurz,
  type StandortAmStichtag,
} from '../api';
import { heute } from '../bewertung';
import { SAETZE, WOERTER } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_ENTSCHIEDEN_VON, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG, UEMS_WORTLAUT, UEMS_VERWEIS } from '../glossar';
import { pruefsummeLokal } from '../uemsMessmittel';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import '../pages/Energiemanagement.css';
import '../pages/Verbesserung.css';

const ABBRECHEN = 'Abbrechen';

/** Grenz- und Verantwortungs-Satz am Fuß jedes Dialogs (SP4) — ein Dialog ist eine eigene Fläche. */
function Fuss({ satz }: { satz: string | null }) {
  return (
    <>
      {satz && (
        <p className="vp-ez-fehler" role="alert" data-testid="energiemanagement-ablehnung">
          {satz}
        </p>
      )}
      <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
      <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
    </>
  );
}

export function Begruendung({ id, wert, setze, fehler, pflicht }: { id: string; wert: string; setze: (t: string) => void; fehler?: string; pflicht: boolean }) {
  return (
    <div className="vp-ez-feld">
      <label className="vp-ez-label" htmlFor={id}>
        Begründung{pflicht ? '' : ' (wahlfrei)'}
      </label>
      <textarea id={id} rows={3} value={wert} onChange={(e) => setze(e.target.value)} aria-invalid={!!fehler} />
      <p className={fehler ? 'vp-ez-fehler' : 'vp-ez-leise'}>{fehler ?? E.BEGRUENDUNG_HINWEIS}</p>
    </div>
  );
}

export function Formular({ id, testid, onSubmit, children }: { id: string; testid: string; onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      id={id}
      className="vp-ez-form"
      noValidate
      data-testid={testid}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/**
 * Der Verweis (G3, §5.8, Muster `MessmittelBlatt` aus AP-16): wo das Original bei Ihnen liegt — Ablage (Pflicht),
 * Bezeichnung, Kennung, Adresse, beim Verweis einer Fassung auch Fassungsangabe und Tag. Wer eine Datei wählt,
 * bekommt ihre SHA-256 im Browser gebildet; in den Körper der Route gelangt nur sie, nie die Datei.
 */
export function VerweisFelder({
  basis,
  titel,
  wert,
  setze,
  mitFassung,
  fehler,
}: {
  basis: string;
  titel: string;
  wert: E.VerweisEntwurf;
  setze: (v: E.VerweisEntwurf) => void;
  mitFassung: boolean;
  fehler?: string;
}) {
  const [dateiName, setDateiName] = useState<string | null>(null);
  const [rechnet, setRechnet] = useState(false);
  const teil = (t: Partial<E.VerweisEntwurf>) => setze({ ...wert, ...t });
  async function dateiGewaehlt(liste: FileList | null) {
    const datei = liste?.[0];
    if (!datei) return;
    setRechnet(true);
    try {
      const sha256 = await pruefsummeLokal(datei);
      setDateiName(datei.name);
      teil({ sha256, bezeichnung: wert.bezeichnung || datei.name });
    } finally {
      setRechnet(false);
    }
  }
  return (
    <fieldset className="vp-em-verweis" data-testid={`${basis}-verweis`}>
      <legend>{titel}</legend>
      <p className="vp-ez-leise">{SAETZE.verweis_keine_datei}</p>
      <Input id={`${basis}-ablage`} label="Ablage bei Ihnen" value={wert.ablage} onChange={(e) => teil({ ablage: e.target.value })} placeholder="etwa QM-Laufwerk, Ordner Energiemanagement/Politik" error={fehler ?? null} />
      <Input id={`${basis}-bezeichnung`} label="Bezeichnung" value={wert.bezeichnung} onChange={(e) => teil({ bezeichnung: e.target.value })} />
      <div className="vp-em-paar">
        <Input id={`${basis}-kennung`} label="Kennung bei Ihnen" value={wert.kennung} onChange={(e) => teil({ kennung: e.target.value })} placeholder="etwa IH-SG-01" />
        <Input id={`${basis}-adresse`} label="Adresse (wahlfrei)" value={wert.adresse} onChange={(e) => teil({ adresse: e.target.value })} placeholder="etwa ein Link in Ihr System" />
      </div>
      {mitFassung && (
        <div className="vp-em-paar">
          <Input id={`${basis}-fassungsangabe`} label="Ihre Fassungsangabe" value={wert.fassungsangabe} onChange={(e) => teil({ fassungsangabe: e.target.value })} placeholder="etwa Rev. 4" />
          <VpDatePicker label="vom" value={wert.datum || null} onChange={(v) => teil({ datum: v })} max={heute()} />
        </div>
      )}
      <label className="vp-em-datei" htmlFor={`${basis}-datei`}>
        <span className="vp-em-datei-knopf">
          <Icon name="file-text" size={14} />
          Datei wählen
        </span>
        <input id={`${basis}-datei`} type="file" onChange={(ev) => void dateiGewaehlt(ev.target.files)} data-testid={`${basis}-datei`} />
      </label>
      <p className="vp-ez-leise" data-testid={`${basis}-pruefsumme`} aria-live="polite">
        {rechnet
          ? 'Prüfsumme wird in Ihrem Browser gebildet …'
          : wert.sha256
            ? `Prüfsumme ${E.kurz(wert.sha256)}${dateiName ? ` aus „${dateiName}“.` : '.'} ${SAETZE.verweis_pruefsumme}`
            : SAETZE.verweis_pruefsumme}
      </p>
    </fieldset>
  );
}

function useStandorte() {
  const [standorte, setStandorte] = useState<StandortAmStichtag[]>([]);
  useEffect(() => {
    let aktiv = true;
    api.standorte().then((s) => aktiv && setStandorte(s.standorte.filter((st) => st.zustand !== 'archiviert')), () => undefined);
    return () => {
      aktiv = false;
    };
  }, []);
  return standorte;
}

// ------------------------------------------------------------------ Dokument anlegen (DK1)

/**
 * Dokument anlegen (DK1). Mit `fest` ist es „Nachweis festhalten“ (IP-15, §5.3): der Bezug ist der Einsatz bzw. die
 * Person der Seite und steht fest, die Arten sind die des Bezugs, und das Original folgt im nächsten Schritt als Fassung.
 */
export function DokumentAnlegenDialog({
  onClose,
  onAngelegt,
  fest = null,
}: {
  onClose: () => void;
  onAngelegt: (d: EnergiemanagementDokument) => void;
  fest?: E.NachweisBezug | null;
}) {
  const basis = `dk-${useId().replace(/:/g, '')}`;
  const standorte = useStandorte();
  const [e, setE] = useState<E.AnlegenEntwurf>(() => {
    const art = fest ? E.NACHWEIS_ARTEN[fest.art][0] : '';
    return { art, titel: art ? WOERTER.dokument_art[art] : '', bezug: 'unternehmen', standortId: '', original: E.LEERER_VERWEIS };
  });
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setze = (t: Partial<E.AnlegenEntwurf>) => setE((alt) => ({ ...alt, ...t }));

  async function senden() {
    const r = E.anlegenKoerper(e, fest);
    if ('fehler' in r) return setFehler(r.fehler ?? {});
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onAngelegt(await api.energiemanagementDokumentAnlegen(r.koerper));
    } catch (err) {
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={fest ? E.KNOPF_NACHWEIS : E.KNOPF_ANLEGEN}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="dokument-anlegen-senden">
            Anlegen
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid={fest ? 'nachweis-anlegen-dialog' : 'dokument-anlegen-dialog'} onSubmit={() => void senden()}>
        <VpPicker
          id={`${basis}-art`}
          label="Art"
          options={fest ? E.nachweisArtOptionen(fest.art) : E.artOptionen()}
          value={e.art || null}
          // Der vorbelegte Titel folgt der Art, solange niemand ihn geändert hat.
          onChange={(art) => setze({ art, titel: !e.titel || e.titel === WOERTER.dokument_art[e.art] ? WOERTER.dokument_art[art] : e.titel })}
          placeholder="Art wählen"
          error={fehler.art ?? null}
        />
        {e.art && <p className="vp-ez-leise" data-testid="dokument-art-satz">{E.ART_SATZ[e.art]}</p>}
        <Input id={`${basis}-titel`} label="Titel" value={e.titel} onChange={(ev) => setze({ titel: ev.target.value })} error={fehler.titel ?? null} />
        {fest ? (
          <div className="vp-ez-feld">
            <span className="vp-ez-label">Bezug</span>
            <p className="vp-ez-satz" data-testid="nachweis-bezug">
              {E.nachweisBezugWort(fest)}
            </p>
          </div>
        ) : (
          <div className="vp-ez-feld" role="radiogroup" aria-label="Bezug">
            <span className="vp-ez-label">Bezug</span>
            <div className="vp-ez-wahl">
              {(['unternehmen', 'standort'] as const).map((b) => (
                <label key={b} className="vp-ez-wahl-punkt">
                  <input type="radio" name={`${basis}-bezug`} checked={e.bezug === b} onChange={() => setze({ bezug: b })} />
                  {b === 'unternehmen' ? 'das ganze Unternehmen' : 'ein Standort'}
                </label>
              ))}
            </div>
          </div>
        )}
        {!fest && e.bezug === 'standort' && (
          <VpPicker
            id={`${basis}-standort`}
            label="Standort"
            options={standorte.map((s) => ({ value: s.id, label: s.name, sub: s.kurzzeichen }))}
            value={e.standortId || null}
            onChange={(standortId) => setze({ standortId })}
            error={fehler.bezug ?? null}
          />
        )}
        {!fest && (
          <VerweisFelder
            basis={`${basis}-original`}
            titel="Original bei Ihnen (wahlfrei)"
            wert={e.original}
            setze={(original) => setze({ original })}
            mitFassung={false}
            fehler={fehler.original}
          />
        )}
        <p className="vp-ez-leise">
          {fest
            ? 'Das Dokument entsteht als Entwurf; das Kennzeichen D-… vergibt VoltPilot. Im nächsten Schritt halten Sie fest, wo das Original bei Ihnen liegt.'
            : 'Das Dokument entsteht als Entwurf; das Kennzeichen D-… vergibt VoltPilot. Den Wortlaut oder Verweis halten Sie danach als Fassung fest.'}
        </p>
        <Fuss satz={satz} />
      </Formular>
    </Modal>
  );
}

// ------------------------------------------------------------------ Fassung entwerfen (DK2, G3) — Wortlaut oder Verweis

export function FassungDialog({
  dokument,
  onClose,
  onGespeichert,
  form,
}: {
  dokument: EnergiemanagementDokument;
  onClose: () => void;
  onGespeichert: (d: EnergiemanagementDokument) => void;
  /** Die Form der ersten Fassung — „Nachweis festhalten“ (IP-15) beginnt mit dem Verweis, auch an einer Vorgabe-Art. */
  form?: 'wortlaut' | 'verweis';
}) {
  const basis = `fs-${useId().replace(/:/g, '')}`;
  const standorte = useStandorte();
  const offen = E.offeneFassung(dokument);
  const vorlage = offen ?? E.gezeigteFassung(dokument);
  const nr = offen?.status === 'entwurf' ? offen.nr : Math.max(0, ...dokument.fassungen.map((f) => f.nr)) + 1;
  const [e, setE] = useState<E.FassungEntwurf>(() => ({
    form: vorlage?.form ?? form ?? (dokument.klasse === 'nachweis' ? 'verweis' : 'wortlaut'),
    wortlaut: vorlage?.wortlaut ?? '',
    verweis: vorlage?.verweis
      ? {
          bezeichnung: vorlage.verweis.bezeichnung ?? '',
          ablage: vorlage.verweis.ablage ?? '',
          kennung: vorlage.verweis.kennung ?? '',
          adresse: vorlage.verweis.adresse ?? '',
          fassungsangabe: vorlage.verweis.fassungsangabe ?? '',
          datum: vorlage.verweis.datum ?? '',
          sha256: vorlage.verweis.sha256 ?? null,
        }
      : E.LEERER_VERWEIS,
    standortIds: vorlage?.anwendungsbereich?.standorte.map((s) => s.id) ?? [],
    traeger: vorlage?.anwendungsbereich?.traeger ?? [],
    begruendung: offen?.status === 'entwurf' ? (offen.begruendung ?? '') : '',
  }));
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setze = (t: Partial<E.FassungEntwurf>) => setE((alt) => ({ ...alt, ...t }));

  async function senden() {
    const r = E.fassungKoerper(e, dokument.art, nr);
    if ('fehler' in r) return setFehler(r.fehler ?? {});
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onGespeichert(await api.energiemanagementFassungEntwerfen(dokument.id, r.koerper));
    } catch (err) {
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Fassung ${nr} festhalten`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="fassung-senden">
            Als Entwurf festhalten
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="fassung-dialog" onSubmit={() => void senden()}>
        <p className="vp-ez-leise">
          {dokument.art_wort} {dokument.kennzeichen} · {dokument.titel}
        </p>
        <div className="vp-ez-feld" role="radiogroup" aria-label="Form">
          <span className="vp-ez-label">Form</span>
          <div className="vp-ez-wahl">
            {(['wortlaut', 'verweis'] as const).map((f) => (
              <label key={f} className="vp-ez-wahl-punkt">
                <input type="radio" name={`${basis}-form-wahl`} checked={e.form === f} onChange={() => setze({ form: f })} data-testid={`fassung-form-${f}`} />
                {f === 'wortlaut' ? `${UEMS_WORTLAUT} in VoltPilot` : `${UEMS_VERWEIS} auf Ihr System`}
              </label>
            ))}
          </div>
        </div>
        {e.form === 'wortlaut' ? (
          <div className="vp-ez-feld">
            <label className="vp-ez-label" htmlFor={`${basis}-wortlaut`}>
              {UEMS_WORTLAUT}
            </label>
            <textarea id={`${basis}-wortlaut`} rows={8} value={e.wortlaut} onChange={(ev) => setze({ wortlaut: ev.target.value })} aria-invalid={!!fehler.wortlaut} />
            <p className={fehler.wortlaut ? 'vp-ez-fehler' : 'vp-ez-leise'}>
              {fehler.wortlaut ?? `Text in VoltPilot, höchstens ${(20000).toLocaleString('de-DE')} Zeichen — keine Datei.`}
            </p>
          </div>
        ) : (
          <VerweisFelder basis={`${basis}-verweis`} titel="Wo das Original liegt" wert={e.verweis} setze={(verweis) => setze({ verweis })} mitFassung fehler={fehler.verweis} />
        )}
        {dokument.art === 'anwendungsbereich' && (
          <fieldset className="vp-em-verweis">
            <legend>Anwendungsbereich</legend>
            <VpPicker
              id={`${basis}-standorte`}
              label="Standorte"
              options={standorte.map((s) => ({ value: s.id, label: s.name, sub: s.kurzzeichen }))}
              values={e.standortIds}
              onChangeMany={(standortIds) => setze({ standortIds })}
              error={fehler.standorte ?? null}
            />
            <VpPicker
              id={`${basis}-traeger`}
              label="Energieträger"
              options={E.TRAEGER.map((t) => ({ value: t, label: t }))}
              values={e.traeger}
              onChangeMany={(traeger) => setze({ traeger })}
              error={fehler.traeger ?? null}
            />
          </fieldset>
        )}
        <Begruendung id={`${basis}-begruendung`} wert={e.begruendung} setze={(begruendung) => setze({ begruendung })} fehler={fehler.begruendung} pflicht={nr >= 2} />
        {offen?.status === 'entwurf' && <p className="vp-ez-leise">Der offene Entwurf (Fassung {offen.nr}) wird überschrieben.</p>}
        <Fuss satz={satz} />
      </Formular>
    </Modal>
  );
}

// ------------------------------------------------------------------ Freigeben (DK3, DK4) — mit „entschieden von“

export function FreigabeDialog({
  dokument,
  fassung,
  onClose,
  onGespeichert,
}: {
  dokument: EnergiemanagementDokument;
  fassung: EnergiemanagementFassung;
  onClose: () => void;
  onGespeichert: (d: EnergiemanagementDokument) => void;
}) {
  const basis = `fg-${useId().replace(/:/g, '')}`;
  const zweitePerson = fassung.status === 'beantragt';
  const leitungNoetig = E.leitungsPflicht(dokument.art);
  const [e, setE] = useState<E.FreigabeEntwurf>({ entschiedenVon: '', entschiedenAm: heute(), begruendung: '' });
  const [personen, setPersonen] = useState<EnergiemanagementPersonKurz[] | null>(null);
  const [beantragen, setBeantragen] = useState(false);
  const [personDialog, setPersonDialog] = useState(false);
  const [neu, setNeu] = useState(0);
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setze = (t: Partial<E.FreigabeEntwurf>) => setE((alt) => ({ ...alt, ...t }));

  // Bei Energiepolitik, Anwendungsbereich und Bestellung entscheidet die Leitung am Tag der Entscheidung (PA3).
  useEffect(() => {
    if (zweitePerson) return;
    let aktiv = true;
    const laden = leitungNoetig
      ? api.energiemanagementAufgaben(e.entschiedenAm || undefined).then((a) => a.leitung)
      : api.energiemanagementPersonen().then((p) =>
          p.personen.filter((x: EnergiemanagementPerson) => x.zustand === 'aktiv').map((x) => ({ id: x.id, name: x.name, funktion: x.funktion, kuerzel: x.kuerzel, mit_konto: !!x.konto })),
        );
    laden.then(
      (liste) => {
        if (!aktiv) return;
        setPersonen(liste);
        setE((alt) => ({ ...alt, entschiedenVon: liste.some((p) => p.id === alt.entschiedenVon) ? alt.entschiedenVon : liste.length === 1 ? liste[0].id : '' }));
      },
      (err) => aktiv && setSatz(E.ablehnungSatz(err)),
    );
    return () => {
      aktiv = false;
    };
  }, [leitungNoetig, zweitePerson, e.entschiedenAm, neu]);

  const ohneLeitung = leitungNoetig && personen !== null && personen.length === 0;
  const knopf = zweitePerson ? E.KNOPF_BESTAETIGEN : beantragen ? E.KNOPF_BEANTRAGEN : E.KNOPF_FREIGEBEN;

  async function senden() {
    const r = E.freigabeKoerper(e, zweitePerson);
    if ('fehler' in r) return setFehler(r.fehler ?? {});
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      const d = beantragen
        ? await api.energiemanagementFassungBeantragen(dokument.id, fassung.nr, r.koerper)
        : await api.energiemanagementFassungFreigeben(dokument.id, fassung.nr, r.koerper);
      onGespeichert(d);
    } catch (err) {
      // Vier-Augen (DK3): ein Entwurf wird erst beantragt — der Dialog sagt es und bietet den Antrag an.
      if (E.ablehnungCode(err) === 'vieraugen_beantragen') setBeantragen(true);
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal
        open={!personDialog}
        onClose={onClose}
        title={`Fassung ${fassung.nr} freigeben`}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {ABBRECHEN}
            </Button>
            <Button type="submit" form={`${basis}-form`} disabled={busy || ohneLeitung} data-testid="freigabe-senden">
              {knopf}
            </Button>
          </>
        }
      >
        <Formular id={`${basis}-form`} testid="freigabe-dialog" onSubmit={() => void senden()}>
          <p className="vp-ez-leise">
            {dokument.art_wort} {dokument.kennzeichen} · {dokument.titel}
          </p>
          {zweitePerson ? (
            <p className="vp-ez-satz">
              Beantragt — {UEMS_ENTSCHIEDEN_VON} {E.personWort(fassung.entschieden_von)} am {E.tagText(fassung.entschieden_am)}. Sie bestätigen als zweite Person.
            </p>
          ) : (
            <>
              {ohneLeitung ? (
                <p className="vp-ez-satz" data-testid="freigabe-ohne-leitung">
                  {SAETZE.freigabe_ohne_leitung}
                </p>
              ) : (
                <VpPicker
                  id={`${basis}-person`}
                  label={UEMS_ENTSCHIEDEN_VON}
                  options={(personen ?? []).map((p) => ({ value: p.id, label: p.name, sub: `${p.funktion}${p.mit_konto ? '' : ' · ohne Konto'}` }))}
                  value={e.entschiedenVon || null}
                  onChange={(entschiedenVon) => setze({ entschiedenVon })}
                  placeholder="Person wählen"
                  loading={personen === null}
                  hint={leitungNoetig ? 'Bei dieser Art entscheidet die Leitung des Unternehmens.' : 'Eine Person im Energiemanagement, auch ohne Konto.'}
                  error={fehler.entschiedenVon ?? null}
                />
              )}
              <Button variant="ghost" onClick={() => setPersonDialog(true)} data-testid="freigabe-person-anlegen">
                {ohneLeitung ? `${E.KNOPF_PERSON} (Leitung)` : E.KNOPF_PERSON}
              </Button>
              <VpDatePicker label="entschieden am" value={e.entschiedenAm || null} onChange={(entschiedenAm) => setze({ entschiedenAm })} max={heute()} />
            </>
          )}
          <Begruendung id={`${basis}-begruendung`} wert={e.begruendung} setze={(begruendung) => setze({ begruendung })} fehler={fehler.begruendung} pflicht={!zweitePerson} />
          <p className="vp-ez-leise">Eingetragen wird die Freigabe unter Ihrem Konto — „eingetragen von“ steht neben „entschieden von“.</p>
          <Fuss satz={satz} />
        </Formular>
      </Modal>
      {personDialog && (
        <PersonAnlegenDialog
          leitung={leitungNoetig}
          ab={e.entschiedenAm || heute()}
          onClose={() => setPersonDialog(false)}
          onAngelegt={(p) => {
            setPersonDialog(false);
            setE((alt) => ({ ...alt, entschiedenVon: p.id }));
            setNeu((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ Person anlegen (PA1), wahlweise mit der Leitung (PA3)

export function PersonAnlegenDialog({
  leitung,
  ab,
  onClose,
  onAngelegt,
}: {
  /** Vorbelegt: die Person bekommt die Aufgabe „Leitung des Unternehmens“. */
  leitung: boolean;
  ab: string;
  onClose: () => void;
  onAngelegt: (p: EnergiemanagementPerson) => void;
}) {
  const basis = `ps-${useId().replace(/:/g, '')}`;
  const [e, setE] = useState<E.PersonEntwurf>({ name: '', funktion: '', kuerzel: '', organisation: '', leitung, leitungAb: ab, begruendung: '' });
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [angelegt, setAngelegt] = useState<EnergiemanagementPerson | null>(null);
  const setze = (t: Partial<E.PersonEntwurf>) => setE((alt) => ({ ...alt, ...t }));

  async function senden() {
    const r = E.personKoerper(e);
    if ('fehler' in r) return setFehler(r.fehler ?? {});
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      // Zwei Schritte, zwei Routen (IP-6): erst die Person, dann die Aufgabe — schlägt die zweite fehl, bleibt die Person.
      const person = angelegt ?? (await api.energiemanagementPersonAnlegen(r.person)).person;
      setAngelegt(person);
      if (r.leitung) await api.energiemanagementAufgabeZuordnen({ ...r.leitung, person_id: person.id });
      onAngelegt(person);
    } catch (err) {
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={E.KNOPF_PERSON}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="person-senden">
            {E.KNOPF_PERSON}
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="person-dialog" onSubmit={() => void senden()}>
        <p className="vp-ez-leise">Eine Person im Energiemanagement braucht kein Konto — so kann die Leitung als „entschieden von“ erscheinen, ohne sich anzumelden.</p>
        <Input id={`${basis}-name`} label="Name" value={e.name} onChange={(ev) => setze({ name: ev.target.value })} error={fehler.name ?? null} disabled={!!angelegt} />
        <Input id={`${basis}-funktion`} label="Funktion" value={e.funktion} onChange={(ev) => setze({ funktion: ev.target.value })} placeholder="etwa Geschäftsführer" error={fehler.funktion ?? null} disabled={!!angelegt} />
        <div className="vp-em-paar">
          <Input id={`${basis}-kuerzel`} label="Kürzel (wahlfrei)" value={e.kuerzel} onChange={(ev) => setze({ kuerzel: ev.target.value })} error={fehler.kuerzel ?? null} disabled={!!angelegt} />
          <Input id={`${basis}-organisation`} label="Organisation (wahlfrei)" value={e.organisation} onChange={(ev) => setze({ organisation: ev.target.value })} disabled={!!angelegt} />
        </div>
        <label className="vp-ez-wahl-punkt">
          <input type="checkbox" checked={e.leitung} onChange={(ev) => setze({ leitung: ev.target.checked })} data-testid="person-leitung" />
          hat die Aufgabe „{WOERTER.aufgabe.unternehmensleitung}“
        </label>
        {e.leitung && (
          <>
            <VpDatePicker label="ab" value={e.leitungAb || null} onChange={(leitungAb) => setze({ leitungAb })} error={fehler.leitungAb ?? null} />
            <Begruendung id={`${basis}-begruendung`} wert={e.begruendung} setze={(begruendung) => setze({ begruendung })} fehler={fehler.begruendung} pflicht />
          </>
        )}
        {angelegt && <p className="vp-ez-leise">{angelegt.name} ist angelegt; es fehlt noch die Aufgabe.</p>}
        <Fuss satz={satz} />
      </Formular>
    </Modal>
  );
}
