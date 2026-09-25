import { useEffect, useId, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  type EnergiemanagementDokumentKurz,
  type FeststellungEintrag,
  type FeststellungErgebnis,
  type FeststellungMitVerlauf,
  type InternesAudit,
} from '../api';
import * as A from '../auditFeststellung';
import { VOKABULARE, WOERTER } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_ENTSCHIEDEN_VON, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { Begruendung, Formular } from './DokumentDialoge';
import { Textfeld, ablehnung, useKonten, usePersonen } from './InternesAuditDialoge';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

const ABBRECHEN = 'Abbrechen';
const heute = () => new Date().toISOString().slice(0, 10);

/** Ablehnung, Verantwortungs- und Grenz-Satz am Fuß jedes Dialogs (SP4) — ein Dialog ist eine eigene Fläche. */
function DialogFuss({ satz }: { satz: string | null }) {
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

/**
 * Feststellung erfassen (UEMS AP-19 IP-20, FS1): aus einem internen Audit (vorbelegt an der Audit-Seite), eigene oder
 * von außen; Wortlaut, Vorgabe (Dokument-Fassung und/oder Wortlaut), wahlfrei Bezug, festgestellt von (Person, auch ohne
 * Konto), Verantwortlich (Konto), Frist — ohne Angabe setzt die Route 90 Tage nach dem Tag der Feststellung.
 */
export function FeststellungErfassenDialog({
  audit,
  onClose,
  onErfasst,
}: {
  /** Vorbelegt an der Seite eines durchgeführten Audits. */
  audit: Pick<InternesAudit, 'id' | 'kennzeichen' | 'auditoren' | 'durchgefuehrt_am'> | null;
  onClose: () => void;
  onErfasst: (f: FeststellungMitVerlauf) => void;
}) {
  const basis = `fe-${useId().replace(/:/g, '')}`;
  const [e, setE] = useState<A.FeststellungEntwurf>(() =>
    A.leereFeststellung(audit ? { id: audit.id, auditorId: audit.auditoren[0]?.id ?? null, am: audit.durchgefuehrt_am } : null),
  );
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dokumente, setDokumente] = useState<EnergiemanagementDokumentKurz[] | null>(null);
  const [audits, setAudits] = useState<InternesAudit[] | null>(null);
  const { personen, optionen } = usePersonen();
  const konten = useKonten();
  const setze = (t: Partial<A.FeststellungEntwurf>) => setE((alt) => ({ ...alt, ...t }));
  useEffect(() => {
    api.energiemanagementDokumente().then(
      (r) => setDokumente(r.dokumente.filter((d) => d.gueltige_fassung != null)),
      () => setDokumente([]),
    );
    if (!audit) {
      api.energiemanagementAudits().then(
        (r) => setAudits(r.audits.filter((a) => a.zustand === 'durchgefuehrt')),
        () => setAudits([]),
      );
    }
  }, [audit]);
  async function senden() {
    const r = A.feststellungKoerper(e);
    if ('fehler' in r) return setFehler(r.fehler);
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onErfasst(await api.energiemanagementFeststellungErfassen(r.koerper));
    } catch (err) {
      setSatz(ablehnung(err));
    } finally {
      setBusy(false);
    }
  }
  const dokument = (dokumente ?? []).find((d) => d.id === e.vorgabeDokument) ?? null;
  return (
    <Modal
      open
      onClose={onClose}
      title={A.KNOPF_FESTSTELLUNG}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="feststellung-erfassen-senden">
            {A.KNOPF_FESTSTELLUNG}
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="feststellung-erfassen-dialog" onSubmit={() => void senden()}>
        {audit ? (
          <p className="vp-ez-leise" data-testid="feststellung-quelle-vorbelegt">
            {`Quelle: ${A.quelleWort({ art: 'internes_audit', audit_id: audit.id, kennung: audit.kennzeichen, wortlaut: null })}`}
          </p>
        ) : (
          <>
            <VpPicker
              id={`${basis}-quelle`}
              label="Quelle"
              options={A.QUELLE_WAHL}
              value={e.quelle}
              onChange={(q) => setze({ quelle: q as A.FeststellungEntwurf['quelle'] })}
            />
            {e.quelle === 'internes_audit' && (
              <VpPicker
                id={`${basis}-audit`}
                label="Internes Audit"
                options={(audits ?? []).map((a) => ({ value: a.id, label: `${a.kennzeichen} ${a.titel}` }))}
                value={e.auditId || null}
                onChange={(auditId) => setze({ auditId })}
                placeholder="Audit wählen"
                loading={audits === null}
                hint="Nur durchgeführte Audits."
                error={fehler.auditId ?? null}
              />
            )}
            {e.quelle === 'extern' && (
              <Input id={`${basis}-extern`} label="Von wem" value={e.extern} onChange={(ev) => setze({ extern: ev.target.value })} error={fehler.extern ?? null} />
            )}
          </>
        )}
        <Textfeld id={`${basis}-wortlaut`} label="Was nicht erfüllt ist" wert={e.wortlaut} setze={(wortlaut) => setze({ wortlaut })} fehler={fehler.wortlaut} />
        <fieldset className="vp-em-verweis" data-testid="feststellung-vorgabe">
          <legend>Vorgabe</legend>
          <div className="vp-em-paar">
            <VpPicker
              id={`${basis}-dokument`}
              label="Dokument (wahlfrei)"
              options={[{ value: '', label: 'kein Dokument' }, ...(dokumente ?? []).map((d) => ({ value: d.id, label: `${d.kennzeichen} ${d.titel}` }))]}
              value={e.vorgabeDokument}
              onChange={(id) => setze({ vorgabeDokument: id, vorgabeFassung: String((dokumente ?? []).find((d) => d.id === id)?.gueltige_fassung ?? '') })}
              loading={dokumente === null}
            />
            {dokument && (
              <Input id={`${basis}-fassung`} label="Fassung" value={e.vorgabeFassung} onChange={(ev) => setze({ vorgabeFassung: ev.target.value.replace(/\D/g, '') })} error={fehler.vorgabeFassung ?? null} />
            )}
          </div>
          <Textfeld id={`${basis}-vorgabe-wortlaut`} label="Wortlaut der Vorgabe" wert={e.vorgabeWortlaut} setze={(vorgabeWortlaut) => setze({ vorgabeWortlaut })} fehler={fehler.vorgabe} hinweis="Ein Dokument mit Fassung, der Wortlaut oder beides." />
        </fieldset>
        <div className="vp-em-paar">
          <VpPicker
            id={`${basis}-aufgabe`}
            label="Bezug: Aufgabe (wahlfrei)"
            options={[{ value: '', label: 'keine Aufgabe' }, ...VOKABULARE.aufgabe.map((a) => ({ value: a, label: WOERTER.aufgabe[a] }))]}
            value={e.aufgabe}
            onChange={(aufgabe) => setze({ aufgabe })}
          />
          <Input id={`${basis}-objekte`} label="Bezug: Kennzeichen (wahlfrei)" value={e.objekte} onChange={(ev) => setze({ objekte: ev.target.value })} placeholder="etwa BB-0001, BB-0002" />
        </div>
        <div className="vp-em-paar">
          <VpPicker
            id={`${basis}-festgestellt`}
            label="Festgestellt von"
            options={optionen}
            value={e.festgestelltVon || null}
            onChange={(festgestelltVon) => setze({ festgestelltVon })}
            placeholder="Person wählen"
            loading={personen === null}
            error={fehler.festgestelltVon ?? null}
          />
          <VpDatePicker label="am" value={e.festgestelltAm || null} onChange={(festgestelltAm) => setze({ festgestelltAm })} max={heute()} />
        </div>
        <div className="vp-em-paar">
          <VpPicker
            id={`${basis}-verantwortlich`}
            label="Verantwortlich"
            options={konten ?? []}
            value={e.verantwortlich || null}
            onChange={(verantwortlich) => setze({ verantwortlich })}
            placeholder="Konto wählen"
            loading={konten === null}
            error={fehler.verantwortlich ?? null}
          />
          <VpDatePicker label="Frist (wahlfrei)" value={e.frist || null} onChange={(frist) => setze({ frist })} error={fehler.frist ?? null} />
        </div>
        <p className="vp-ez-leise">Ohne Frist gilt der Tag der Feststellung plus 90 Tage.</p>
        <DialogFuss satz={satz} />
      </Formular>
    </Modal>
  );
}

/** Ein Eintrag (FS2): Kommentar, sofortige Behebung, Ursache als Aussage einer Person, ähnliche Fälle geprüft. */
export function EintragDialog({ id, onClose, onFertig }: { id: string; onClose: () => void; onFertig: (f: FeststellungMitVerlauf) => void }) {
  const basis = `fn-${useId().replace(/:/g, '')}`;
  const [e, setE] = useState<{ art: FeststellungEintrag['art'] | ''; wortlaut: string; personId: string; am: string }>({ art: '', wortlaut: '', personId: '', am: heute() });
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { personen, optionen } = usePersonen();
  async function senden() {
    const r = A.eintragKoerper(e);
    if ('fehler' in r) return setFehler(r.fehler ?? {});
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onFertig(await api.energiemanagementFeststellungEintrag(id, r.koerper!));
    } catch (err) {
      setSatz(ablehnung(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={A.KNOPF_EINTRAG}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="eintrag-senden">
            {A.KNOPF_EINTRAG}
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="eintrag-dialog" onSubmit={() => void senden()}>
        <VpPicker
          id={`${basis}-art`}
          label="Art"
          options={(['behebung', 'ursache_aussage', 'aehnliche_faelle', 'kommentar'] as const).map((a) => ({ value: a, label: A.EINTRAG_WORT[a] }))}
          value={e.art || null}
          onChange={(art) => setE((x) => ({ ...x, art: art as FeststellungEintrag['art'] }))}
          placeholder="Art wählen"
          error={fehler.art ?? null}
        />
        <Textfeld
          id={`${basis}-wortlaut`}
          label="Wortlaut"
          wert={e.wortlaut}
          setze={(wortlaut) => setE((x) => ({ ...x, wortlaut }))}
          fehler={fehler.wortlaut}
          hinweis={e.art === 'ursache_aussage' ? 'Die Ursache ist die Aussage einer Person — VoltPilot nennt keine.' : undefined}
        />
        <div className="vp-em-paar">
          <VpPicker
            id={`${basis}-person`}
            label="Person"
            options={optionen}
            value={e.personId || null}
            onChange={(personId) => setE((x) => ({ ...x, personId }))}
            placeholder="Person wählen"
            loading={personen === null}
            error={fehler.personId ?? null}
          />
          <VpDatePicker label="am" value={e.am || null} onChange={(am) => setE((x) => ({ ...x, am }))} max={heute()} />
        </div>
        <DialogFuss satz={satz} />
      </Formular>
    </Modal>
  );
}

export type StandArt = 'wirksamkeit' | 'ohne_massnahme' | 'zurueckgenommen';
const STAND_TITEL: Record<StandArt, string> = { wirksamkeit: A.KNOPF_WIRKSAMKEIT, ohne_massnahme: A.KNOPF_OHNE_MASSNAHME, zurueckgenommen: A.KNOPF_ZURUECKNEHMEN };

/**
 * Ein Stand an der Feststellung (FS4, FS5): „Wirksamkeit prüfen“ mit `wirksam` (schließt ab) oder `nicht wirksam`
 * (hält offen), „Ohne Maßnahme abschließen“, „Zurücknehmen“ — Begründung und die Person, die geprüft hat. Mit Vier-Augen
 * wird der Stand beantragt; die zweite Person bestätigt ihn (FS6).
 */
export function StandDialog({
  id,
  art,
  vieraugen,
  onClose,
  onFertig,
}: {
  id: string;
  art: StandArt;
  vieraugen: boolean;
  onClose: () => void;
  onFertig: (f: FeststellungMitVerlauf) => void;
}) {
  const basis = `fs-${useId().replace(/:/g, '')}`;
  const [e, setE] = useState<{ ergebnis: FeststellungErgebnis | ''; begruendung: string; entschiedenVon: string; am: string }>({
    ergebnis: art === 'wirksamkeit' ? '' : art, begruendung: '', entschiedenVon: '', am: heute(),
  });
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { personen, optionen } = usePersonen();
  async function senden() {
    const r = A.standKoerper(e);
    if ('fehler' in r) return setFehler(r.fehler ?? {});
    setFehler({});
    setBusy(true);
    setSatz(null);
    const weg = vieraugen ? 'wirksamkeit/beantragen' : art === 'wirksamkeit' ? 'wirksamkeit' : 'abschliessen';
    try {
      onFertig(await api.energiemanagementFeststellungStand(id, weg, r.koerper!));
    } catch (err) {
      setSatz(ablehnung(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={STAND_TITEL[art]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="stand-senden">
            {vieraugen ? E.KNOPF_BEANTRAGEN : STAND_TITEL[art]}
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="stand-dialog" onSubmit={() => void senden()}>
        {art === 'wirksamkeit' ? (
          <VpPicker
            id={`${basis}-ergebnis`}
            label="Ergebnis"
            options={(['wirksam', 'nicht_wirksam'] as const).map((x) => ({
              value: x,
              label: A.ERGEBNIS_WORT[x],
              sub: x === 'wirksam' ? 'Die Feststellung ist danach abgeschlossen.' : 'Die Feststellung bleibt offen.',
            }))}
            value={e.ergebnis || null}
            onChange={(ergebnis) => setE((x) => ({ ...x, ergebnis: ergebnis as FeststellungErgebnis }))}
            placeholder="Ergebnis wählen"
            error={fehler.ergebnis ?? null}
          />
        ) : (
          <p className="vp-ez-leise">
            {art === 'ohne_massnahme'
              ? 'Die sofortige Behebung genügt — die Feststellung wird ohne Maßnahme abgeschlossen.'
              : 'Es liegt keine Nichterfüllung vor — die Feststellung wird zurückgenommen.'}
          </p>
        )}
        <Begruendung id={`${basis}-begruendung`} wert={e.begruendung} setze={(begruendung) => setE((x) => ({ ...x, begruendung }))} fehler={fehler.begruendung} pflicht />
        <div className="vp-em-paar">
          <VpPicker
            id={`${basis}-entschieden`}
            label={`${UEMS_ENTSCHIEDEN_VON} (wer geprüft hat)`}
            options={optionen}
            value={e.entschiedenVon || null}
            onChange={(entschiedenVon) => setE((x) => ({ ...x, entschiedenVon }))}
            placeholder="Person wählen"
            loading={personen === null}
            error={fehler.entschiedenVon ?? null}
          />
          <VpDatePicker label="am" value={e.am || null} onChange={(am) => setE((x) => ({ ...x, am }))} max={heute()} />
        </div>
        <p className="vp-ez-leise">Der Stand hält eine Kopie mit Prüfsumme fest und wird nie zurückgenommen.</p>
        <DialogFuss satz={satz} />
      </Formular>
    </Modal>
  );
}

/** Die zweite Person lehnt einen beantragten Stand ab (FS6) — mit Begründung. */
export function AntragAblehnenDialog({ id, onClose, onFertig }: { id: string; onClose: () => void; onFertig: (f: FeststellungMitVerlauf) => void }) {
  const basis = `fa-${useId().replace(/:/g, '')}`;
  const [begruendung, setBegruendung] = useState('');
  const [fehler, setFehler] = useState<string | undefined>();
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function senden() {
    const b = E.begruendungFehler(begruendung);
    if (b) return setFehler(b);
    setFehler(undefined);
    setBusy(true);
    setSatz(null);
    try {
      onFertig(await api.energiemanagementFeststellungAblehnen(id, begruendung.trim()));
    } catch (err) {
      setSatz(ablehnung(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={A.KNOPF_ANTRAG_ABLEHNEN}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="antrag-ablehnen-senden">
            {A.KNOPF_ANTRAG_ABLEHNEN}
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="antrag-ablehnen-dialog" onSubmit={() => void senden()}>
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={fehler} pflicht />
        <DialogFuss satz={satz} />
      </Formular>
    </Modal>
  );
}
