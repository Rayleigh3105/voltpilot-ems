import { useEffect, useId, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type EnergiemanagementPerson, type InternesAuditHinweis, type InternesAuditMitVerlauf, type Massnahme } from '../api';
import * as A from '../auditFeststellung';
import { benutzerApi } from '../benutzer';
import * as E from '../energiemanagementPortal';
import { UEMS_ENTSCHIEDEN_VON, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { Begruendung, Formular, VerweisFelder } from './DokumentDialoge';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

const ABBRECHEN = 'Abbrechen';
const heute = () => new Date().toISOString().slice(0, 10);

/** Ablehnung, Verantwortungs- und Grenz-Satz am Fuß jedes Dialogs (SP4) — ein Dialog ist eine eigene Fläche. */
export function DialogFuss({ satz }: { satz: string | null }) {
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

/** Die Ablehnung einer Route in Kundenwörtern: erst die Sätze der Audits und Feststellungen, sonst die des Bereichs. */
export function ablehnung(e: unknown): string {
  const code = E.ablehnungCode(e);
  const body = e && typeof e === 'object' && 'body' in e ? ((e as { body?: { satz?: unknown } }).body ?? null) : null;
  // „Vier-Augen nicht erfüllbar: …“ nennt die Route selbst — der Satz nennt die Personen (FS6).
  if (code === 'vieraugen_nicht_erfuellbar' && typeof body?.satz === 'string') return body.satz;
  return code && A.ABLEHNUNG[code] ? A.ABLEHNUNG[code] : E.ablehnungSatz(e);
}

/** Die aktiven Personen im Energiemanagement — auch ohne Konto (die Prüferin, die Leitung). */
export function usePersonen() {
  const [personen, setPersonen] = useState<EnergiemanagementPerson[] | null>(null);
  useEffect(() => {
    api.energiemanagementPersonen().then(
      (r) => setPersonen(r.personen.filter((p) => p.zustand === 'aktiv')),
      () => setPersonen([]),
    );
  }, []);
  const optionen = (personen ?? []).map((p) => ({ value: p.id, label: p.name, sub: `${p.funktion}${p.konto ? '' : ' · ohne Konto'}` }));
  return { personen, optionen };
}

/** Die Konten — „Verantwortlich“ ist immer ein Konto. */
export function useKonten() {
  const [konten, setKonten] = useState<{ value: string; label: string; sub?: string }[] | null>(null);
  useEffect(() => {
    benutzerApi.liste().then(
      (liste) => setKonten(liste.filter((b) => b.zustand === 'aktiv').map((b) => ({ value: b.sub, label: b.anzeigename, sub: b.email }))),
      () => setKonten([]),
    );
  }, []);
  return konten;
}

/**
 * Audit planen (UEMS AP-19 IP-20, IA1): Titel, Termin, Auditorin oder Auditor (Personen, auch ohne Konto),
 * Unabhängigkeit als Wortlaut, was und woran geprüft wird, Verantwortlich (Konto). Wer prüft, braucht kein Schreibrecht.
 */
export function AuditPlanenDialog({ onClose, onGeplant }: { onClose: () => void; onGeplant: (a: InternesAuditMitVerlauf) => void }) {
  const basis = `ap-${useId().replace(/:/g, '')}`;
  const [e, setE] = useState<A.AuditEntwurf>(A.LEERES_AUDIT);
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { personen, optionen } = usePersonen();
  const konten = useKonten();
  const setze = (t: Partial<A.AuditEntwurf>) => setE((alt) => ({ ...alt, ...t }));
  async function senden() {
    const r = A.auditKoerper(e);
    if ('fehler' in r) return setFehler(r.fehler);
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
  return (
    <Modal
      open
      onClose={onClose}
      title={A.KNOPF_AUDIT_PLANEN}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="audit-planen-senden">
            {A.KNOPF_AUDIT_PLANEN}
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="audit-planen-dialog" onSubmit={() => void senden()}>
        <Input id={`${basis}-titel`} label="Titel" value={e.titel} onChange={(ev) => setze({ titel: ev.target.value })} error={fehler.titel ?? null} />
        <VpDatePicker label="Termin" value={e.termin || null} onChange={(termin) => setze({ termin })} error={fehler.termin ?? null} />
        <VpPicker
          id={`${basis}-auditor`}
          label="Wer prüft"
          options={optionen}
          values={e.auditorIds}
          onChangeMany={(auditorIds) => setze({ auditorIds })}
          placeholder="Person wählen"
          loading={personen === null}
          hint="Eine Person im Energiemanagement, auch ohne Konto — sie braucht kein Schreibrecht."
          error={fehler.auditorIds ?? null}
        />
        <Textfeld id={`${basis}-unabhaengigkeit`} label="Unabhängigkeit" wert={e.unabhaengigkeit} setze={(unabhaengigkeit) => setze({ unabhaengigkeit })} fehler={fehler.unabhaengigkeit} hinweis="Warum prüft diese Person keine eigene Arbeit? In Ihren Worten." />
        <Textfeld id={`${basis}-was`} label="Was geprüft wird" wert={e.was} setze={(was) => setze({ was })} fehler={fehler.was} />
        <Textfeld id={`${basis}-woran`} label="Woran geprüft wird" wert={e.woran} setze={(woran) => setze({ woran })} fehler={fehler.woran} hinweis="Etwa die Energiepolitik D-0001, Fassung 1." />
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
        <DialogFuss satz={satz} />
      </Formular>
    </Modal>
  );
}

/** Ein mehrzeiliges Feld mit Beschriftung und Hinweis — Wortlaut, nie ein Urteil des Systems. */
export function Textfeld({ id, label, wert, setze, fehler, hinweis }: { id: string; label: string; wert: string; setze: (t: string) => void; fehler?: string; hinweis?: string }) {
  return (
    <div className="vp-ez-feld">
      <label className="vp-ez-label" htmlFor={id}>
        {label}
      </label>
      <textarea id={id} rows={3} value={wert} onChange={(ev) => setze(ev.target.value)} aria-invalid={!!fehler} />
      {(fehler || hinweis) && <p className={fehler ? 'vp-ez-fehler' : 'vp-ez-leise'}>{fehler ?? hinweis}</p>}
    </div>
  );
}

/** Durchgeführt melden: geplant → durchgeführt, mit dem Tag der Durchführung (nie in der Zukunft). */
export function AuditDurchgefuehrtDialog({ id, termin, onClose, onFertig }: { id: string; termin: string; onClose: () => void; onFertig: (a: InternesAuditMitVerlauf) => void }) {
  const basis = `ad-${useId().replace(/:/g, '')}`;
  const [am, setAm] = useState(termin <= heute() ? termin : heute());
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function senden() {
    setBusy(true);
    setSatz(null);
    try {
      onFertig(await api.energiemanagementAuditDurchgefuehrt(id, am));
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
      title={A.KNOPF_DURCHGEFUEHRT}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy || !am} data-testid="audit-durchgefuehrt-senden">
            {A.KNOPF_DURCHGEFUEHRT}
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="audit-durchgefuehrt-dialog" onSubmit={() => void senden()}>
        <VpDatePicker label="Durchgeführt am" value={am || null} onChange={setAm} max={heute()} />
        <p className="vp-ez-leise">Danach halten Sie die Ergebnisse fest: Hinweise und Feststellungen, jeweils mit der Person, die sie festgestellt hat.</p>
        <DialogFuss satz={satz} />
      </Formular>
    </Modal>
  );
}

/** Einen Hinweis festhalten (IA2, IA5): „festgestellt von“ ist die Person, die prüft, „eingetragen von“ Ihr Konto. */
export function HinweisDialog({
  id,
  am,
  vorbelegt,
  onClose,
  onFertig,
}: {
  id: string;
  am: string;
  vorbelegt: string | null;
  onClose: () => void;
  onFertig: (a: InternesAuditMitVerlauf) => void;
}) {
  const basis = `ah-${useId().replace(/:/g, '')}`;
  const [e, setE] = useState({ wortlaut: '', personId: vorbelegt ?? '', am });
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { personen, optionen } = usePersonen();
  async function senden() {
    const r = A.hinweisKoerper(e);
    if ('fehler' in r) return setFehler(r.fehler ?? {});
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onFertig(await api.energiemanagementAuditHinweis(id, r.koerper!));
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
      title={A.KNOPF_HINWEIS}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="hinweis-senden">
            {A.KNOPF_HINWEIS}
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="hinweis-dialog" onSubmit={() => void senden()}>
        <Textfeld id={`${basis}-wortlaut`} label="Hinweis im Wortlaut" wert={e.wortlaut} setze={(wortlaut) => setE((x) => ({ ...x, wortlaut }))} fehler={fehler.wortlaut} />
        <div className="vp-em-paar">
          <VpPicker
            id={`${basis}-person`}
            label="Festgestellt von"
            options={optionen}
            value={e.personId || null}
            onChange={(personId) => setE((x) => ({ ...x, personId }))}
            placeholder="Person wählen"
            loading={personen === null}
            error={fehler.personId ?? null}
          />
          <VpDatePicker label="am" value={e.am || null} onChange={(t) => setE((x) => ({ ...x, am: t }))} max={heute()} />
        </div>
        <DialogFuss satz={satz} />
      </Formular>
    </Modal>
  );
}

/**
 * Audit abschließen (IA3): „entschieden von“, der Bericht als Verweis (Prüfsumme im Browser) ODER eine Zusammenfassung,
 * je Hinweis wahlfrei die Maßnahme, die aus ihm wurde (nur Maßnahmen mit Herkunft dieses Audits). Danach unveränderlich.
 */
export function AuditAbschliessenDialog({
  id,
  kennzeichen,
  hinweise,
  onClose,
  onFertig,
}: {
  id: string;
  kennzeichen: string;
  hinweise: InternesAuditHinweis[];
  onClose: () => void;
  onFertig: (a: InternesAuditMitVerlauf) => void;
}) {
  const basis = `aa-${useId().replace(/:/g, '')}`;
  const [e, setE] = useState<A.AuditAbschlussEntwurf>({ entschiedenVon: '', am: heute(), zusammenfassung: '', bericht: E.LEERER_VERWEIS, massnahmen: {} });
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ausAudit, setAusAudit] = useState<Massnahme[]>([]);
  const { personen, optionen } = usePersonen();
  useEffect(() => {
    api.massnahmen().then(
      (r) => setAusAudit(r.massnahmen.filter((m) => m.herkunft.art === 'audit' && m.herkunft.kennung === kennzeichen)),
      () => setAusAudit([]),
    );
  }, [kennzeichen]);
  const setze = (t: Partial<A.AuditAbschlussEntwurf>) => setE((alt) => ({ ...alt, ...t }));
  async function senden() {
    const r = A.auditAbschlussKoerper(e);
    if ('fehler' in r) return setFehler(r.fehler);
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onFertig(await api.energiemanagementAuditAbschliessen(id, r.koerper));
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
      title={A.KNOPF_AUDIT_ABSCHLIESSEN}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="audit-abschliessen-senden">
            {A.KNOPF_AUDIT_ABSCHLIESSEN}
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="audit-abschliessen-dialog" onSubmit={() => void senden()}>
        <div className="vp-em-paar">
          <VpPicker
            id={`${basis}-entschieden`}
            label={UEMS_ENTSCHIEDEN_VON}
            options={optionen}
            value={e.entschiedenVon || null}
            onChange={(entschiedenVon) => setze({ entschiedenVon })}
            placeholder="Person wählen"
            loading={personen === null}
            error={fehler.entschiedenVon ?? null}
          />
          <VpDatePicker label="am" value={e.am || null} onChange={(am) => setze({ am })} max={heute()} />
        </div>
        <VerweisFelder basis={`${basis}-bericht`} titel="Der unterschriebene Bericht (Verweis)" wert={e.bericht} setze={(bericht) => setze({ bericht })} mitFassung={false} fehler={fehler.bericht} />
        <Textfeld id={`${basis}-zusammenfassung`} label="Zusammenfassung (wahlfrei mit Bericht)" wert={e.zusammenfassung} setze={(zusammenfassung) => setze({ zusammenfassung })} fehler={fehler.zusammenfassung} />
        {hinweise.length > 0 && ausAudit.length > 0 && (
          <fieldset className="vp-em-verweis" data-testid="audit-abschliessen-massnahmen">
            <legend>Maßnahmen aus den Hinweisen (wahlfrei)</legend>
            {hinweise.map((h) => (
              <VpPicker
                key={h.nr}
                id={`${basis}-hinweis-${h.nr}`}
                label={`Hinweis ${h.nr}`}
                options={[{ value: '', label: 'keine Maßnahme' }, ...ausAudit.map((m) => ({ value: m.kennzeichen, label: `${m.kennzeichen} ${m.titel}` }))]}
                value={e.massnahmen[h.nr] ?? ''}
                onChange={(m) => setze({ massnahmen: { ...e.massnahmen, [h.nr]: m } })}
              />
            ))}
          </fieldset>
        )}
        <p className="vp-ez-leise">Nach dem Abschluss bleibt das Audit, wie es ist — mit Kopie und Prüfsumme.</p>
        <DialogFuss satz={satz} />
      </Formular>
    </Modal>
  );
}

/** Ein geplantes Audit absagen — mit Begründung; es bleibt im Auditprogramm lesbar. */
export function AuditAbsagenDialog({ id, onClose, onFertig }: { id: string; onClose: () => void; onFertig: (a: InternesAuditMitVerlauf) => void }) {
  const basis = `ab-${useId().replace(/:/g, '')}`;
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
      onFertig(await api.energiemanagementAuditAbsagen(id, begruendung.trim()));
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
      title={A.KNOPF_AUDIT_ABSAGEN}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="audit-absagen-senden">
            {A.KNOPF_AUDIT_ABSAGEN}
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="audit-absagen-dialog" onSubmit={() => void senden()}>
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={fehler} pflicht />
        <DialogFuss satz={satz} />
      </Formular>
    </Modal>
  );
}
