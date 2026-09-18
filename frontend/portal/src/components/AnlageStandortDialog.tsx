import { Recht } from './Recht';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type AnlageUmzug, type StandorteAmStichtag } from '../api';
import type { BerichteFolgen } from '../berichteFolgen';
import {
  FOLGEN_AENDERT_TITEL,
  FOLGEN_BLEIBT_TITEL,
  FOLGEN_PRUEFEN,
  FOLGEN_WAEHLEN,
  HINWEIS_BEGRUENDUNG,
  KORREKTUR_VORSPANN,
  KNOPF_FERTIG,
  KNOPF_ZUORDNEN,
  LABEL_BEGRUENDUNG,
  LABEL_GUELTIG_AB,
  LABEL_ZIEL,
  UMZUG_GESPEICHERT_TITEL,
  UMZUG_TITEL,
  UMZUG_VORSPANN,
  VERLAUF_TITEL,
  ergebnisSatz,
  folgenKarte,
  pruefeUmzug,
  umzugAnfrage,
  umzugFeldAusServer,
  umzugStart,
  verlaufZeilen,
  zielOptionen,
  type FolgenKarte,
  type UmzugFehler,
  type UmzugFeld,
  type UmzugForm,
} from '../anlageUmziehen';
import { alsOrtFehler } from '../standorte';
import { useBerichteFolgen } from '../useBerichteFolgen';
import { ArchivierenDialog, type ArchivObjekt } from './ArchivierenDialog';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import './StandortDialog.css';
import './FlaecheDialog.css';
import './AnlageStandortDialog.css';

type Vorschau = { stand: 'leer' } | { stand: 'pruefen' } | { stand: 'da'; umzug: AnlageUmzug } | { stand: 'abgelehnt' };
type ArchivAngebot = { objekt: ArchivObjekt; archiviert: boolean } | null;

/**
 * Dialog „Anlage zuordnen“ (UEMS AP-02 IP-11, Mockup T6b): neuer Standort, „gültig ab“, eine
 * freiwillige Begründung — und die Folgen-Karte, BEVOR gespeichert wird. Die Karte kommt aus
 * `GET …/standort/vorschau` (dieselbe Regel wie der Eintrag) und nennt, was sich ändert und was
 * bleibt: Box, Datenwege, Freigaben, Betriebsmodell … und dass kein Befehl gesendet wird.
 * Lehnt der Server ab, steht sein Satz am Feld, das er nennt. Nach dem Speichern zeigt der Dialog
 * die Zuordnungen, wie der Server sie gelesen hat.
 */
export function AnlageStandortDialog({
  open,
  anlageId,
  anlageName,
  standorte,
  modus = 'umzug',
  gueltigAbVorgabe,
  onClose,
  onGespeichert,
}: {
  open: boolean;
  anlageId: string;
  anlageName: string;
  /** `GET /api/v1/standorte` von heute — Zielliste und „heute“. */
  standorte: StandorteAmStichtag;
  /** Geführter Einstieg; Vorschau und Schreibweg bleiben identisch zum normalen Umzug. */
  modus?: 'umzug' | 'korrektur';
  /** Erster Tag der Anlage aus ihrer bestätigten Zuordnung. */
  gueltigAbVorgabe?: string;
  onClose: () => void;
  onGespeichert: (umzug: AnlageUmzug) => void;
}) {
  const basis = `vp-au-${useId().replace(/:/g, '')}`;
  const [form, setForm] = useState<UmzugForm>(() => umzugStart(standorte.stichtag, gueltigAbVorgabe));
  const [versucht, setVersucht] = useState(false);
  const [serverFehler, setServerFehler] = useState<UmzugFehler>({});
  const [allgemein, setAllgemein] = useState<string | null>(null);
  const [vorschau, setVorschau] = useState<Vorschau>({ stand: 'leer' });
  const [busy, setBusy] = useState(false);
  const [ergebnis, setErgebnis] = useState<AnlageUmzug | null>(null);
  const [archivAngebot, setArchivAngebot] = useState<ArchivAngebot>(null);
  const [archivDialog, setArchivDialog] = useState(false);
  const ergebnisKopf = useRef<HTMLParagraphElement>(null);

  // Nach einer Korrektur urteilt der bestehende Ortsbaum-Weg, ob der bisherige Standort
  // wirklich leer und damit archivierbar ist. Keine lokale Näherung aus Anlagenzahlen.
  useEffect(() => {
    const bisher = ergebnis?.bisher;
    if (modus !== 'korrektur' || !bisher) {
      setArchivAngebot(null);
      return;
    }
    let aktiv = true;
    api.standortOrte(bisher.id).then(
      (baum) => {
        if (!aktiv || !baum.aktionen?.archivieren?.erlaubt) return;
        setArchivAngebot({
          objekt: {
            art: 'standort', id: baum.standort.id, name: baum.standort.name,
            kurzzeichen: baum.standort.kurzzeichen, eltern: null,
            archiviertAm: baum.standort.archiviertAm ?? null, aktionen: baum.aktionen,
          },
          archiviert: false,
        });
      },
      () => undefined,
    );
    return () => { aktiv = false; };
  }, [ergebnis, modus]);

  const pruefung = pruefeUmzug(form);
  const fehler: UmzugFehler = { ...(versucht ? pruefung : {}), ...serverFehler };
  const feldId = (feld: UmzugFeld) => `${basis}-${feld}`;
  // AP-12 IP-9: welche freigegebenen Berichte die Zuordnung ab „gültig ab“ träfe — erst mit gewähltem Standort.
  const berichte = useBerichteFolgen(
    anlageId,
    form.standortId ? form.gueltigAb : null,
    'anlage_umzug_rueckwirkend',
    'aendern',
  );

  // Die Folgen zu jeder Wahl — die jüngste Antwort gewinnt, eine ältere wird verworfen.
  useEffect(() => {
    const { standortId, gueltigAb } = form;
    if (!standortId || !gueltigAb) {
      setVorschau({ stand: 'leer' });
      return;
    }
    let aktiv = true;
    setVorschau({ stand: 'pruefen' });
    const warten = setTimeout(() => {
      api
        .anlageStandortVorschau(anlageId, standortId, gueltigAb)
        .then((umzug) => {
          if (aktiv) setVorschau({ stand: 'da', umzug });
        })
        .catch((err: unknown) => {
          if (!aktiv) return;
          const ortFehler = err instanceof ApiError ? alsOrtFehler(err.body) : null;
          const feld = ortFehler ? umzugFeldAusServer(ortFehler) : null;
          setVorschau({ stand: 'abgelehnt' });
          if (ortFehler && feld) setServerFehler({ [feld]: ortFehler.message });
          else setAllgemein(ortFehler?.message ?? 'Die Folgen konnten nicht geprüft werden.');
        });
    }, 200);
    return () => {
      aktiv = false;
      clearTimeout(warten);
    };
  }, [anlageId, form.standortId, form.gueltigAb]); // eslint-disable-line react-hooks/exhaustive-deps

  function setze<K extends keyof UmzugForm>(feld: K, wert: UmzugForm[K]) {
    setForm((f) => ({ ...f, [feld]: wert }));
    setServerFehler({});
    setAllgemein(null);
  }

  function fokus(feld: UmzugFeld) {
    requestAnimationFrame(() => document.getElementById(feldId(feld))?.focus());
  }

  async function senden(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setVersucht(true);
    setAllgemein(null);
    const anfrage = umzugAnfrage(form);
    if (!anfrage) {
      fokus(pruefung.standortId ? 'standortId' : pruefung.gueltigAb ? 'gueltigAb' : 'begruendung');
      return;
    }
    setBusy(true);
    try {
      const umzug = await api.anlageStandortSetzen(anlageId, anfrage);
      setErgebnis(umzug);
      requestAnimationFrame(() => ergebnisKopf.current?.focus());
    } catch (err) {
      const ortFehler = err instanceof ApiError ? alsOrtFehler(err.body) : null;
      const feld = ortFehler ? umzugFeldAusServer(ortFehler) : null;
      if (ortFehler && feld) {
        setServerFehler({ [feld]: ortFehler.message });
        fokus(feld);
      } else {
        setAllgemein(
          ortFehler?.message ?? (err instanceof Error ? err.message : 'Die Zuordnung konnte nicht gespeichert werden.'),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const fertig = () => {
    if (ergebnis) onGespeichert(ergebnis);
  };

  return (
    <Modal
      open={open}
      onClose={ergebnis ? fertig : onClose}
      title={ergebnis ? UMZUG_GESPEICHERT_TITEL : UMZUG_TITEL}
      footer={
        ergebnis ? (
          <Recht aktion="anlage.zuordnen"><Button onClick={fertig}>{KNOPF_FERTIG}</Button></Recht>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Recht aktion="anlage.zuordnen" rueckwirkend={!!form.gueltigAb && form.gueltigAb < standorte.stichtag}><Button type="submit" form={`${basis}-form`} disabled={busy}>
              {KNOPF_ZUORDNEN}
            </Button></Recht>
          </>
        )
      }
    >
      <form id={`${basis}-form`} className="vp-sd vp-au" noValidate onSubmit={(e) => void senden(e)}>
        {ergebnis ? (
          <>
            <p className="vp-au-ergebnis" tabIndex={-1} ref={ergebnisKopf}>
              {ergebnisSatz(ergebnis)}
            </p>
            <section className="vp-fd-verlauf" aria-labelledby={`${basis}-verlauf`}>
              <h4 id={`${basis}-verlauf`}>{VERLAUF_TITEL}</h4>
              <ul>
                {verlaufZeilen(ergebnis).map((z) => (
                  <li key={`${z.zeitraum}-${z.standort}`} className="vp-fd-zeile">
                    <span className="vp-au-verlauf-text">
                      <span className="vp-au-verlauf-standort">{z.standort}</span>
                      <span className="vp-au-verlauf-zeitraum">{z.zeitraum}</span>
                    </span>
                    <span className="vp-au-chip">{z.zustand}</span>
                  </li>
                ))}
              </ul>
            </section>
            <FolgenKarteAnsicht karte={folgenKarte(ergebnis)} />
            {archivAngebot && (
              <section className="vp-au-archiv" data-testid="standort-archiv-angebot">
                {archivAngebot.archiviert ? (
                  <p>Der bisherige Standort {archivAngebot.objekt.name} ist archiviert. Seine Geschichte bleibt erhalten.</p>
                ) : (
                  <>
                    <p>Der bisherige Standort {archivAngebot.objekt.name} ist jetzt leer. Sie können ihn archivieren; seine Geschichte bleibt erhalten.</p>
                    <Recht aktion="standort.verwalten"><Button type="button" variant="outline" onClick={() => setArchivDialog(true)}>
                      Standort archivieren
                    </Button></Recht>
                  </>
                )}
              </section>
            )}
          </>
        ) : (
          <>
            <div className="vp-fd-kopf">
              <p className="vp-fd-name">{anlageName}</p>
              <p className="vp-sd-vorspann">{modus === 'korrektur' ? KORREKTUR_VORSPANN : UMZUG_VORSPANN}</p>
            </div>
            <VpPicker
              id={feldId('standortId')}
              label={LABEL_ZIEL}
              placeholder="Standort wählen"
              options={zielOptionen(standorte, anlageId)}
              value={form.standortId}
              onChange={(v) => setze('standortId', v)}
              error={fehler.standortId}
            />
            <VpDatePicker
              id={feldId('gueltigAb')}
              label={LABEL_GUELTIG_AB}
              value={form.gueltigAb}
              onChange={(v) => setze('gueltigAb', v)}
              error={fehler.gueltigAb}
            />
            <Input
              id={feldId('begruendung')}
              label={LABEL_BEGRUENDUNG}
              hint={HINWEIS_BEGRUENDUNG}
              value={form.begruendung}
              autoComplete="off"
              onChange={(e) => setze('begruendung', e.target.value)}
              error={fehler.begruendung}
            />
            {vorschau.stand === 'da' ? (
              <FolgenKarteAnsicht karte={folgenKarte(vorschau.umzug)} berichte={berichte} />
            ) : vorschau.stand === 'abgelehnt' ? null : (
              <p className="vp-au-folgen-hinweis" aria-live="polite">
                {vorschau.stand === 'pruefen' ? FOLGEN_PRUEFEN : FOLGEN_WAEHLEN}
              </p>
            )}
            {allgemein && (
              <div className="vp-alert vp-alert-err" role="alert">
                {allgemein}
              </div>
            )}
          </>
        )}
      </form>
      {archivDialog && archivAngebot && (
        <ArchivierenDialog
          open
          aktion="archivieren"
          objekt={archivAngebot.objekt}
          onClose={() => setArchivDialog(false)}
          onFertig={() => {
            setArchivDialog(false);
            setArchivAngebot({ ...archivAngebot, archiviert: true });
          }}
        />
      )}
    </Modal>
  );
}

function FolgenKarteAnsicht({ karte, berichte = null }: { karte: FolgenKarte; berichte?: BerichteFolgen | null }) {
  return (
    <section className="vp-au-folgen" aria-live="polite" data-testid="umzug-folgen">
      <div className="vp-au-teil">
        <h4>{FOLGEN_AENDERT_TITEL}</h4>
        <ul className="vp-au-aendert">
          {karte.aendert.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
      <div className="vp-au-teil">
        <h4>{FOLGEN_BLEIBT_TITEL}</h4>
        <ul className="vp-au-bleibt">
          {karte.bleibt.map((s) => (
            <li key={s}>
              <span className="vp-au-haken" aria-hidden="true">
                ✓
              </span>
              <span>{s}</span>
            </li>
          ))}
        </ul>
        {karte.befehl && <p className="vp-au-befehl">{karte.befehl}</p>}
      </div>
      {berichte && (
        <p className="vp-au-berichte" data-testid="berichte-folgen">
          <strong>{berichte.titel}:</strong> {berichte.text}
        </p>
      )}
    </section>
  );
}
