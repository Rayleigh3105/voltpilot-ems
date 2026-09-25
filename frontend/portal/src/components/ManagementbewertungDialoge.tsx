import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  type Bericht,
  type Managementbewertung,
  type ManagementbewertungBeschluss,
  type ManagementbewertungBeschlussArt,
  type ManagementbewertungBeschlussFesthalten,
  type ManagementbewertungFolgeVerknuepfen,
} from '../api';
import { anlegenFehler } from '../berichtDialoge';
import { VOKABULARE } from '../energiemanagement';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import * as M from '../managementbewertung';
import { MANAGEMENTBEWERTUNG } from '../uemsBericht';
import { Formular } from './DokumentDialoge';
import { Textfeld, usePersonen } from './InternesAuditDialoge';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

const ABBRECHEN = 'Abbrechen';

/**
 * „Managementbewertung anlegen“ (UEMS AP-19 IP-24, MG1): legt den Bericht der Vorlage `managementbewertung` am
 * Unternehmen für ein Jahr an (`POST /api/v1/berichte`, Recht `energiemanagement.verwalten`). Eine je Jahr — gibt es sie
 * schon, spricht der Dialog den Satz der Route (`bericht_gibt_es_schon`) und bietet sie zum Öffnen an.
 */
export function ManagementbewertungAnlegenDialog({
  heute,
  onClose,
  onAngelegt,
}: {
  heute: string;
  onClose: () => void;
  /** Angelegt ODER die schon vorhandene geöffnet — die Kennung des Berichts. */
  onAngelegt: (kennung: string) => void;
}) {
  const basis = `mb-${useId().replace(/:/g, '')}`;
  const jahre = M.jahreZurWahl(heute);
  const [jahr, setJahr] = useState<string | null>(jahre[0].id);
  const [unternehmen, setUnternehmen] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [vorhanden, setVorhanden] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let aktiv = true;
    api.unternehmen().then(
      (u) => aktiv && setUnternehmen(u.id),
      () => aktiv && setSatz(M.LADEFEHLER),
    );
    return () => {
      aktiv = false;
    };
  }, []);

  async function senden() {
    if (!jahr || !unternehmen) return;
    setBusy(true);
    setSatz(null);
    setVorhanden(null);
    try {
      const b: Bericht = await api.berichtAnlegen({ vorlage: MANAGEMENTBEWERTUNG, geltung_id: unternehmen, zeitraum: jahr });
      onAngelegt(b.kennung);
    } catch (err) {
      const f = anlegenFehler(err);
      setSatz(f.satz);
      setVorhanden(f.kennung);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={M.KNOPF_MB_ANLEGEN}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          {vorhanden ? (
            <Button onClick={() => onAngelegt(vorhanden)} data-testid="mb-vorhandene-oeffnen">
              {`${vorhanden} öffnen`}
            </Button>
          ) : (
            <Button type="submit" form={`${basis}-form`} disabled={busy || !jahr || !unternehmen} data-testid="mb-anlegen-senden">
              {M.KNOPF_MB_ANLEGEN}
            </Button>
          )}
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="mb-anlegen-dialog" onSubmit={() => void senden()}>
        <VpPicker
          label={M.JAHR}
          options={jahre.map((j) => ({ value: j.id, label: j.label }))}
          value={jahr}
          onChange={(v) => {
            setJahr(v);
            setVorhanden(null);
            setSatz(null);
          }}
          search="nie"
        />
        <p className="vp-ez-leise">{M.ANLEGEN_HINWEIS}</p>
        <Fuss satz={satz} />
      </Formular>
    </Modal>
  );
}

/** Ablehnung der Route, Verantwortungs- und Grenz-Satz am Fuß jedes Dialogs (SP4) — ein Dialog ist eine eigene Fläche. */
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

/** Der gemeinsame Rahmen: Titel, Abbrechen, Senden-Knopf mit Testkennung. */
function Rahmen({
  titel, basis, testid, knopf, busy, bereit, onClose, children,
}: {
  titel: string; basis: string; testid: string; knopf: string; busy: boolean; bereit: boolean; onClose: () => void; children: ReactNode;
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
          <Button type="submit" form={`${basis}-form`} disabled={busy || !bereit} data-testid={`${testid}-senden`}>
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
 * „Sitzung festhalten“ (MG4, `PUT …/managementbewertungen/{kennung}/sitzung`): Tag (nie in der Zukunft), Leitung — die
 * Person mit der Aufgabe „Leitung des Unternehmens“ am Tag ist vorgewählt, auch ohne Konto —, Teilnehmende, wahlfrei Ort.
 * Ein zweites Festhalten ersetzt die erste Angabe; bis zur Freigabe.
 */
export function SitzungDialog({
  kennung, heute, vorher, onClose, onFertig,
}: {
  kennung: string; heute: string; vorher: Managementbewertung['sitzung']; onClose: () => void; onFertig: (mb: Managementbewertung) => void;
}) {
  const basis = `ms-${useId().replace(/:/g, '')}`;
  const { personen, optionen } = usePersonen();
  const [tag, setTag] = useState(vorher?.tag ?? heute);
  const [leitung, setLeitung] = useState<string | null>(vorher?.leitung.id ?? null);
  const [teilnehmende, setTeilnehmende] = useState<string[]>(vorher?.teilnehmende.map((p) => p.id) ?? []);
  const [ort, setOrt] = useState(vorher?.ort ?? '');
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (vorher || !tag) return;
    let aktiv = true;
    // PA3: wer am Tag der Sitzung die Aufgabe „Leitung des Unternehmens“ hat — nur ein Vorschlag, die Route prüft.
    api.energiemanagementAufgaben(tag).then(
      (a) => aktiv && a.leitung.length > 0 && setLeitung((l) => l ?? a.leitung[0].id),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, [tag, vorher]);
  async function senden() {
    if (!tag || !leitung) return;
    setBusy(true);
    setSatz(null);
    try {
      onFertig(
        await api.managementbewertungSitzung(kennung, {
          tag,
          leitung,
          teilnehmende: teilnehmende.filter((p) => p !== leitung),
          ...(ort.trim() ? { ort: ort.trim() } : {}),
        }),
      );
    } catch (err) {
      setSatz(M.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Rahmen titel={vorher ? M.KNOPF_SITZUNG_AENDERN : M.KNOPF_SITZUNG} basis={basis} testid="mb-sitzung" knopf={M.KNOPF_SITZUNG} busy={busy} bereit={!!tag && !!leitung} onClose={onClose}>
      <Formular id={`${basis}-form`} testid="mb-sitzung-dialog" onSubmit={() => void senden()}>
        <VpDatePicker label={M.TAG_DER_SITZUNG} value={tag || null} onChange={setTag} max={heute} />
        <VpPicker id={`${basis}-leitung`} label={M.LEITUNG} options={optionen} value={leitung} onChange={setLeitung} placeholder="Person wählen" loading={personen === null} hint={M.SITZUNG_HINWEIS} />
        <VpPicker
          id={`${basis}-teilnehmende`}
          label={M.TEILNEHMENDE}
          options={optionen.filter((o) => o.value !== leitung)}
          values={teilnehmende}
          onChangeMany={setTeilnehmende}
          placeholder="Personen wählen"
          loading={personen === null}
        />
        <Input id={`${basis}-ort`} label={M.ORT} value={ort} onChange={(ev) => setOrt(ev.target.value)} maxLength={200} />
        <Fuss satz={satz} />
      </Formular>
    </Rahmen>
  );
}

/**
 * „Beschluss festhalten“ und „Beschluss ändern“ (MG5, `POST …/beschluesse`, `PUT …/beschluesse/{nr}`): Art, Wortlaut,
 * entschieden von (die Leitung der Sitzung vorgewählt), wahlfrei zuständig und Termin — bis zur Freigabe.
 */
export function BeschlussDialog({
  kennung, mb, beschluss = null, onClose, onFertig,
}: {
  kennung: string; mb: Managementbewertung; beschluss?: ManagementbewertungBeschluss | null; onClose: () => void; onFertig: (mb: Managementbewertung) => void;
}) {
  const basis = `mbe-${useId().replace(/:/g, '')}`;
  const { personen, optionen } = usePersonen();
  const [art, setArt] = useState<string | null>(beschluss?.art ?? null);
  const [wortlaut, setWortlaut] = useState(beschluss?.wortlaut ?? '');
  const [entschieden, setEntschieden] = useState<string | null>(beschluss?.entschieden_von.id ?? mb.sitzung?.leitung.id ?? null);
  const [zustaendig, setZustaendig] = useState<string | null>(beschluss?.zustaendig?.id ?? null);
  const [termin, setTermin] = useState(beschluss?.termin ?? '');
  const [fehler, setFehler] = useState<string | undefined>();
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function senden() {
    const w = wortlaut.trim();
    if (!art) return;
    if (!w || w.length > M.WORTLAUT_HOECHSTENS) return setFehler(`1 bis ${M.WORTLAUT_HOECHSTENS} Zeichen.`);
    setFehler(undefined);
    setBusy(true);
    setSatz(null);
    const body: ManagementbewertungBeschlussFesthalten = {
      art: art as ManagementbewertungBeschlussArt,
      wortlaut: w,
      ...(entschieden ? { entschieden_von: entschieden } : {}),
      ...(zustaendig ? { zustaendig } : {}),
      ...(termin ? { termin } : {}),
    };
    try {
      onFertig(beschluss ? await api.managementbewertungBeschlussAendern(kennung, beschluss.nr, body) : await api.managementbewertungBeschluss(kennung, body));
    } catch (err) {
      setSatz(M.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }
  const titel = beschluss ? `${M.KNOPF_BESCHLUSS_AENDERN} (Beschluss ${beschluss.nr})` : M.KNOPF_BESCHLUSS;
  return (
    <Rahmen titel={titel} basis={basis} testid="mb-beschluss" knopf={beschluss ? M.KNOPF_BESCHLUSS_AENDERN : M.KNOPF_BESCHLUSS} busy={busy} bereit={!!art && !!wortlaut.trim()} onClose={onClose}>
      <Formular id={`${basis}-form`} testid="mb-beschluss-dialog" onSubmit={() => void senden()}>
        <VpPicker
          id={`${basis}-art`}
          label={M.ART}
          options={VOKABULARE.beschluss_art.map((a) => ({ value: a, label: M.BESCHLUSS_ART_WORT[a] ?? a }))}
          value={art}
          onChange={setArt}
          placeholder="Art wählen"
          search="nie"
        />
        <Textfeld id={`${basis}-wortlaut`} label={M.WORTLAUT} wert={wortlaut} setze={setWortlaut} fehler={fehler} hinweis={M.BESCHLUSS_HINWEIS} />
        <VpPicker id={`${basis}-entschieden`} label={M.ENTSCHIEDEN_VON} options={optionen} value={entschieden} onChange={setEntschieden} placeholder="Person wählen" loading={personen === null} />
        <VpPicker id={`${basis}-zustaendig`} label={M.ZUSTAENDIG} options={optionen} value={zustaendig} onChange={setZustaendig} placeholder="Person wählen" loading={personen === null} />
        <VpDatePicker label={M.TERMIN} value={termin || null} onChange={setTermin} />
        <Fuss satz={satz} />
      </Formular>
    </Rahmen>
  );
}

type Objekt = { value: string; label: string; sub?: string };

/** Die Objekte, die eine Folge sein können — gelesen über ihre Listen-Routen, nie geraten. */
async function objekte(art: string): Promise<Objekt[]> {
  switch (art) {
    case 'energieziel':
      return (await api.energieziele()).energieziele.map((z) => ({ value: z.kennzeichen, label: `${z.kennzeichen} ${z.wortlaut}` }));
    case 'dokument':
      return (await api.energiemanagementDokumente()).dokumente
        .filter((d) => d.gueltige_fassung !== null)
        .map((d) => ({ value: `${d.kennzeichen}/${d.gueltige_fassung}`, label: `${d.kennzeichen} ${d.titel}`, sub: `Fassung ${d.gueltige_fassung}` }));
    case 'aufgabe':
      return (await api.energiemanagementAufgaben()).zuordnungen
        .filter((z) => z.zustand === 'laufend')
        .map((z) => ({ value: z.id, label: `${z.wort} — ${z.person.name}`, sub: `ab ${M.tag(z.gilt_ab)}` }));
    case 'audit':
      return (await api.energiemanagementAudits()).audits.map((a) => ({ value: a.kennzeichen, label: `${a.kennzeichen} ${a.titel}` }));
    default:
      return [];
  }
}

/**
 * „Folge verknüpfen“ (MG6, `POST …/beschluesse/{nr}/folgen`): nach der Freigabe ein Energieziel, eine Dokument-Fassung,
 * eine Aufgabe oder ein internes Audit — nur anhängen, der Stand ändert sich nicht. Die Maßnahme legt man mit der Herkunft
 * an („Maßnahme anlegen“), sie verknüpft sich selbst.
 */
export function FolgeDialog({
  kennung, beschluss, onClose, onFertig,
}: {
  kennung: string; beschluss: ManagementbewertungBeschluss; onClose: () => void; onFertig: (mb: Managementbewertung) => void;
}) {
  const basis = `mf-${useId().replace(/:/g, '')}`;
  const vorgabe = (M.FOLGE_VERKNUEPFBAR as readonly string[]).includes(beschluss.art) ? beschluss.art : null;
  const [art, setArt] = useState<string | null>(vorgabe);
  const [liste, setListe] = useState<Objekt[] | null>(null);
  const [objekt, setObjekt] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!art) return;
    let aktiv = true;
    setListe(null);
    setObjekt(null);
    objekte(art).then(
      (l) => aktiv && setListe(l),
      () => aktiv && setListe([]),
    );
    return () => {
      aktiv = false;
    };
  }, [art]);
  async function senden() {
    if (!art || !objekt) return;
    setBusy(true);
    setSatz(null);
    try {
      onFertig(await api.managementbewertungFolge(kennung, beschluss.nr, { art, objekt } as ManagementbewertungFolgeVerknuepfen));
    } catch (err) {
      setSatz(M.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Rahmen titel={`${M.KNOPF_FOLGE} (Beschluss ${beschluss.nr})`} basis={basis} testid="mb-folge" knopf={M.KNOPF_FOLGE} busy={busy} bereit={!!art && !!objekt} onClose={onClose}>
      <Formular id={`${basis}-form`} testid="mb-folge-dialog" onSubmit={() => void senden()}>
        <p className="vp-ez-satz">{M.beschlussSatz(beschluss)}</p>
        <VpPicker
          id={`${basis}-art`}
          label={M.ART}
          options={M.FOLGE_VERKNUEPFBAR.map((a) => ({ value: a, label: M.FOLGE_ART_WORT[a] }))}
          value={art}
          onChange={setArt}
          placeholder="Art wählen"
          search="nie"
        />
        <VpPicker
          id={`${basis}-objekt`}
          label={M.OBJEKT}
          options={liste ?? []}
          value={objekt}
          onChange={setObjekt}
          placeholder={art ? 'Wählen' : 'Zuerst die Art wählen'}
          loading={!!art && liste === null}
          disabled={!art}
          emptyText={() => M.LEER_FOLGE_OBJEKTE}
        />
        <p className="vp-ez-leise">{M.FOLGE_HINWEIS}</p>
        <Fuss satz={satz} />
      </Formular>
    </Rahmen>
  );
}
