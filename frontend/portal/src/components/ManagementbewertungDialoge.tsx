import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Bericht, type Managementbewertung, type ManagementbewertungBeschluss, type ManagementbewertungFolgeVerknuepfen } from '../api';
import { anlegenFehler } from '../berichtDialoge';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import * as M from '../managementbewertung';
import { MANAGEMENTBEWERTUNG } from '../uemsBericht';
import { Formular } from './DokumentDialoge';
import { GrenzSatz } from './GrenzSatz';
import { NwBlatt } from './nachweisen/NwBlatt';
import { AntwortKarten } from './nachweisen/NwSchritte';
import { VpPicker } from './VpPicker';

const ABBRECHEN = 'Abbrechen';

/**
 * „Managementbewertung anlegen“ als Blatt (Konzept Nachweisen n1 Runde 2, §6.7; vorher UEMS AP-19 IP-24, MG1): eine
 * Frage „Für welches Jahr?“ mit den abgelaufenen Jahren als Antwort-Karten - das laufende Jahr kann noch nicht beginnen,
 * ein Jahr, das es schon gibt, steht grau mit „gibt es schon“. Legt den Bericht der Vorlage `managementbewertung` am
 * Unternehmen an (`POST /api/v1/berichte`, Recht `energiemanagement.verwalten`); lehnt die Route ab
 * (`bericht_gibt_es_schon`), spricht das Blatt ihren Satz und bietet die vorhandene zum Öffnen an.
 */
export function ManagementbewertungAnlegenBlatt({
  heute,
  vorhanden: schonDa = [],
  onClose,
  onAngelegt,
}: {
  heute: string;
  /** Die Jahre, für die es schon eine gibt. */
  vorhanden?: readonly string[];
  onClose: () => void;
  /** Angelegt ODER die schon vorhandene geöffnet — die Kennung des Berichts. */
  onAngelegt: (kennung: string) => void;
}) {
  const jahre = M.jahreZurWahl(heute).filter((j) => Number(j.id) < Number(heute.slice(0, 4)));
  const [jahr, setJahr] = useState<string | null>(M.vorgewaehltesJahr(jahre, schonDa));
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
    <NwBlatt open titel={M.KNOPF_MB_ANLEGEN} onClose={onClose} testId="mb-anlegen-dialog">
      <div className="vp-nw-schritt-inhalt">
        <AntwortKarten
          frage="Für welches Jahr?"
          optionen={jahre.map((j) => ({ wert: j.id, titel: j.label, zusatz: schonDa.includes(j.id) ? 'gibt es schon' : null, aus: schonDa.includes(j.id) }))}
          wert={jahr}
          onWahl={(v) => {
            setJahr(v);
            setVorhanden(null);
            setSatz(null);
          }}
          testid="mb-anlegen-jahr"
        />
        {satz && (
          <p className="vp-nw-feld-fehler" role="alert" data-testid="energiemanagement-ablehnung">
            {satz}
          </p>
        )}
        <div className="vp-nw-vb-knoepfe">
          {vorhanden ? (
            <Button onClick={() => onAngelegt(vorhanden)} data-testid="mb-vorhandene-oeffnen">
              {`${vorhanden} öffnen`}
            </Button>
          ) : (
            <Button onClick={() => void senden()} disabled={busy || !jahr || !unternehmen} data-testid="mb-anlegen-senden">
              Anlegen
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
        </div>
        {/* Grenz- und Verantwortungs-Satz: einmal am Fuß des Bereichs, unter dem das Blatt liegt (K7/D5). */}
        <GrenzSatz verantwortung />
      </div>
    </NwBlatt>
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
