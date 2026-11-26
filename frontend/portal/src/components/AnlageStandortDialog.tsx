import { Recht } from './Recht';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { ApiError, type AnlageUmzug, type StandorteAmStichtag, type Unternehmen } from '../api';
import { api } from '../apiVoll';
import type { BerichteFolgen } from '../berichteFolgen';
import {
  FOLGEN_AENDERT_TITEL,
  FOLGEN_BLEIBT_TITEL,
  FOLGEN_PRUEFEN,
  GEHOERT_ZU_TITEL,
  HINWEIS_BEGRUENDUNG,
  KNOPF_DETAILS,
  KNOPF_FERTIG,
  KNOPF_NEUER_STANDORT,
  KNOPF_SPEICHERN,
  KNOPF_WEITER,
  LABEL_ALLE_FOLGEN,
  LABEL_BEGRUENDUNG,
  LABEL_GUELTIG_AB,
  LABEL_SEIT_WANN,
  SEIT_WANN_AB_EINEM_TAG,
  SEIT_WANN_SCHON_IMMER,
  UMZUG_GESPEICHERT_TITEL,
  VERLAUF_TITEL,
  aktuellerStandortName,
  ergebnisSatz,
  folgenKarte,
  kurzeFolgen,
  pruefeStandort,
  pruefeUmzug,
  seitWannFrage,
  umzugAnfrage,
  umzugFeldAusServer,
  umzugStart,
  verlaufZeilen,
  zielOptionen,
  zuWelchemStandortFrage,
  type FolgenKarte,
  type SeitWann,
  type UmzugFehler,
  type UmzugFeld,
  type UmzugForm,
} from '../anlageUmziehen';
import { alsOrtFehler } from '../standorte';
import { useBerichteFolgen } from '../useBerichteFolgen';
import { ArchivierenDialog, type ArchivObjekt } from './ArchivierenDialog';
import { StandortDialog } from './StandortDialog';
import { VpDatePicker } from './VpDatePicker';
import './StandortDialog.css';
import './FlaecheDialog.css';
import './AnlageStandortDialog.css';

type Vorschau = { stand: 'leer' } | { stand: 'pruefen' } | { stand: 'da'; umzug: AnlageUmzug } | { stand: 'abgelehnt' };
type ArchivAngebot = { objekt: ArchivObjekt; archiviert: boolean } | null;
type Schritt = 'standort' | 'seitwann';

/**
 * Blatt „Gehört zu › Ändern“ (vp-standort-konzept §6.2/§6.3/§6.5, vormals UEMS AP-02 IP-11 „Anlage
 * zuordnen" T6b), in zwei Schritten wie im Prototyp (Captain-Korrektur, Schritt 2c):
 * 1. „Zu welchem Standort gehört {Anlage}?" — die volle Liste aller Standorte (kein Dropdown,
 *    kein Blatt-im-Blatt), der heutige markiert, am Fuß „Neuer Standort" (B4). Knopf „Weiter".
 * 2. „Seit wann gehört {Anlage} zu {Ziel}?" — Ab einem Tag (mit dem Tag darunter, vorbelegt mit
 *    heute) oder Schon immer (war falsch, B2, kein sichtbares Datum - Regel 5). Darunter die Folgen
 *    in drei kurzen Sätzen aus der Vorschau des Servers; „Alle Folgen" zeigt die ganze Karte,
 *    „Details" die freiwillige Begründung. Knopf „Speichern".
 *
 * Die Folgen-Karte kommt aus `GET …/standort/vorschau` (dieselbe Regel wie der Eintrag) und nennt,
 * was sich ändert und was bleibt. Lehnt der Server ab, steht sein Satz am Feld, das er nennt. Nach
 * dem Speichern zeigt der Dialog die Zuordnungen, wie der Server sie gelesen hat.
 */
export function AnlageStandortDialog({
  open,
  anlageId,
  anlageName,
  standorte,
  gueltigAbVorgabe,
  anfangsSeitWann = 'ab_einem_tag',
  onClose,
  onGespeichert,
  onStandorteNeuLaden,
}: {
  open: boolean;
  anlageId: string;
  anlageName: string;
  /** `GET /api/v1/standorte` von heute — Zielliste und „heute“. */
  standorte: StandorteAmStichtag;
  /** Erster Tag der Anlage aus ihrer bestätigten Zuordnung — Vorbelegung für „Schon immer". */
  gueltigAbVorgabe: string;
  /** Geführter Einstieg (AP-14 IP-15): öffnet mit „Schon immer“ vorgewählt, bleibt umschaltbar. */
  anfangsSeitWann?: SeitWann;
  onClose: () => void;
  onGespeichert: (umzug: AnlageUmzug) => void;
  /** Nach „Neuer Standort": die Liste neu lesen, damit sie den frischen Standort zeigt (B4). */
  onStandorteNeuLaden?: () => void;
}) {
  const basis = `vp-au-${useId().replace(/:/g, '')}`;
  const [form, setForm] = useState<UmzugForm>(() => ({
    ...umzugStart(standorte.stichtag),
    seitWann: anfangsSeitWann,
    gueltigAb: anfangsSeitWann === 'schon_immer' ? gueltigAbVorgabe : standorte.stichtag,
  }));
  const [schritt, setSchritt] = useState<Schritt>('standort');
  const [versucht, setVersucht] = useState(false);
  const [serverFehler, setServerFehler] = useState<UmzugFehler>({});
  const [allgemein, setAllgemein] = useState<string | null>(null);
  const [vorschau, setVorschau] = useState<Vorschau>({ stand: 'leer' });
  const [busy, setBusy] = useState(false);
  const [ergebnis, setErgebnis] = useState<AnlageUmzug | null>(null);
  const [archivAngebot, setArchivAngebot] = useState<ArchivAngebot>(null);
  const [archivDialog, setArchivDialog] = useState(false);
  const [neuerStandort, setNeuerStandort] = useState<{ unternehmen: Unternehmen | null } | null>(null);
  const [alleFolgenOffen, setAlleFolgenOffen] = useState(false);
  const [detailsOffen, setDetailsOffen] = useState(false);
  const ergebnisKopf = useRef<HTMLParagraphElement>(null);
  const listeRef = useRef<HTMLDivElement>(null);
  const korrektur = form.seitWann === 'schon_immer';
  const ziel = standorte.standorte.find((s) => s.id === form.standortId) ?? null;

  // Nach einer Korrektur urteilt der bestehende Ortsbaum-Weg, ob der bisherige Standort
  // wirklich leer und damit archivierbar ist. Keine lokale Näherung aus Anlagenzahlen.
  useEffect(() => {
    const bisher = ergebnis?.bisher;
    if (!korrektur || !bisher) {
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
  }, [ergebnis, korrektur]);

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
        .anlageStandortVorschau(anlageId, standortId, gueltigAb, korrektur)
        .then((umzug) => {
          if (aktiv) setVorschau({ stand: 'da', umzug });
        })
        .catch((err: unknown) => {
          if (!aktiv) return;
          const ortFehler = err instanceof ApiError ? alsOrtFehler(err.body) : null;
          const feld = ortFehler ? umzugFeldAusServer(ortFehler) : null;
          setVorschau({ stand: 'abgelehnt' });
          // „standortId" hat auf Schritt 2 kein eigenes Feld mehr (die Liste steht auf Schritt 1) -
          // sein Satz steht darum allgemein, nicht an einem Feld, das gerade gar nicht zu sehen ist.
          if (ortFehler && feld && feld !== 'standortId') setServerFehler({ [feld]: ortFehler.message });
          else setAllgemein(ortFehler?.message ?? 'Die Folgen konnten nicht geprüft werden.');
        });
    }, 200);
    return () => {
      aktiv = false;
      clearTimeout(warten);
    };
  }, [anlageId, form.standortId, form.gueltigAb, korrektur]); // eslint-disable-line react-hooks/exhaustive-deps

  function setze<K extends keyof UmzugForm>(feld: K, wert: UmzugForm[K]) {
    setForm((f) => ({ ...f, [feld]: wert }));
    setServerFehler({});
    setAllgemein(null);
  }

  // „Schon immer“ fragt nie nach einem Datum (Regel 5): der erste Anlagentag gilt, nicht einmal
  // sichtbar. Zurück zu „Ab einem Tag“ setzt wieder den heutigen Tag vor.
  function setzeSeitWann(wert: SeitWann) {
    setForm((f) => ({ ...f, seitWann: wert, gueltigAb: wert === 'schon_immer' ? gueltigAbVorgabe : standorte.stichtag }));
    setServerFehler({});
    setAllgemein(null);
  }

  function fokus(feld: UmzugFeld) {
    requestAnimationFrame(() => document.getElementById(feldId(feld))?.focus());
  }

  // Schritt 1 → 2: ohne Standort bleibt die Liste offen und zeigt ihren Fehler.
  function weiter() {
    setVersucht(true);
    if (Object.keys(pruefeStandort(form)).length > 0) {
      requestAnimationFrame(() => listeRef.current?.focus());
      return;
    }
    setSchritt('seitwann');
  }

  function zurueckZurListe() {
    setSchritt('standort');
  }

  async function senden(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setVersucht(true);
    setAllgemein(null);
    const anfrage = umzugAnfrage(form, korrektur);
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
      if (ortFehler && feld && feld !== 'standortId') {
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

  // B4: „Neuer Standort“ am Fuß der Liste — derselbe Standort-Dialog, derselbe Weg wie am
  // Standort-Kopf (IP-6), hier nur mit einem anderen Rücksprung: gewählt statt geöffnet.
  async function neuerStandortOeffnen() {
    const unternehmen = await api.unternehmen().catch(() => null);
    setNeuerStandort({ unternehmen });
  }

  const aktuellerName = aktuellerStandortName(standorte, anlageId);

  return (
    <Modal
      open={open}
      onClose={ergebnis ? fertig : onClose}
      title={ergebnis ? UMZUG_GESPEICHERT_TITEL : GEHOERT_ZU_TITEL}
      icon={
        !ergebnis && schritt === 'seitwann' ? (
          <button type="button" className="vp-au-zurueck" onClick={zurueckZurListe} aria-label="Zurück zur Liste">
            <Icon name="chevron-left" size={20} />
          </button>
        ) : null
      }
      footer={
        ergebnis ? (
          <Recht aktion="anlage.zuordnen"><Button onClick={fertig}>{KNOPF_FERTIG}</Button></Recht>
        ) : schritt === 'standort' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="button" onClick={weiter}>
              {KNOPF_WEITER}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Recht aktion="anlage.zuordnen" rueckwirkend={!!form.gueltigAb && form.gueltigAb < standorte.stichtag}><Button type="submit" form={`${basis}-form`} disabled={busy}>
              {KNOPF_SPEICHERN}
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
        ) : schritt === 'standort' ? (
          <>
            <p className="vp-au-frage">{zuWelchemStandortFrage(anlageName)}</p>
            {aktuellerName && <p className="vp-au-frage-sub">Heute: {aktuellerName}.</p>}
            <div
              ref={listeRef}
              tabIndex={-1}
              role="radiogroup"
              aria-label={zuWelchemStandortFrage(anlageName)}
              className="vp-au-opts"
            >
              {zielOptionen(standorte, anlageId).map((opt) => (
                <label key={opt.value} className={`vp-au-opt${form.standortId === opt.value ? ' is-gewaehlt' : ''}`}>
                  <input
                    type="radio"
                    name={`${basis}-standort`}
                    value={opt.value}
                    checked={form.standortId === opt.value}
                    onChange={() => setze('standortId', opt.value)}
                  />
                  <span className="vp-au-opt-text">
                    <b>{opt.label}</b>
                    {opt.sub && <small>{opt.sub}</small>}
                  </span>
                </label>
              ))}
            </div>
            {fehler.standortId && (
              <div className="vp-alert vp-alert-err" role="alert">
                {fehler.standortId}
              </div>
            )}
            <button type="button" className="vp-au-neuer-standort" onClick={() => void neuerStandortOeffnen()}>
              <Icon name="plus" size={15} />
              {KNOPF_NEUER_STANDORT}
            </button>
          </>
        ) : (
          <>
            <p className="vp-au-frage">{seitWannFrage(anlageName, ziel?.name ?? '')}</p>
            <fieldset className="vp-au-seitwann">
              <legend className="vp-sr-only">{LABEL_SEIT_WANN}</legend>
              <div role="radiogroup" aria-label={LABEL_SEIT_WANN} className="vp-au-seitwann-wahl">
                <label className="vp-au-seitwann-option">
                  <input
                    type="radio"
                    name={`${basis}-seitwann`}
                    value="ab_einem_tag"
                    checked={form.seitWann === 'ab_einem_tag'}
                    onChange={() => setzeSeitWann('ab_einem_tag')}
                  />
                  <span>{SEIT_WANN_AB_EINEM_TAG}</span>
                </label>
                {form.seitWann === 'ab_einem_tag' && (
                  <VpDatePicker
                    id={feldId('gueltigAb')}
                    label={LABEL_GUELTIG_AB}
                    value={form.gueltigAb}
                    onChange={(v) => setze('gueltigAb', v)}
                    error={fehler.gueltigAb}
                  />
                )}
                <label className="vp-au-seitwann-option">
                  <input
                    type="radio"
                    name={`${basis}-seitwann`}
                    value="schon_immer"
                    checked={form.seitWann === 'schon_immer'}
                    onChange={() => setzeSeitWann('schon_immer')}
                  />
                  <span>{SEIT_WANN_SCHON_IMMER}</span>
                </label>
              </div>
            </fieldset>
            {vorschau.stand === 'da' ? (
              <div className="vp-au-folgen-kurz" data-testid="umzug-folgen-kurz" aria-live="polite">
                <ul>
                  {kurzeFolgen(folgenKarte(vorschau.umzug)).map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
                {berichte && (
                  <p className="vp-au-berichte" data-testid="berichte-folgen">
                    <strong>{berichte.titel}:</strong> {berichte.text}
                  </p>
                )}
              </div>
            ) : vorschau.stand === 'abgelehnt' ? null : (
              <p className="vp-au-folgen-hinweis" aria-live="polite">
                {FOLGEN_PRUEFEN}
              </p>
            )}
            <p className="vp-au-folgen-links">
              {vorschau.stand === 'da' && (
                <button
                  type="button"
                  className="vp-linklike vp-linklike-quiet"
                  aria-expanded={alleFolgenOffen}
                  onClick={() => setAlleFolgenOffen((o) => !o)}
                >
                  {LABEL_ALLE_FOLGEN}
                </button>
              )}
              <button
                type="button"
                className="vp-linklike vp-linklike-quiet"
                aria-expanded={detailsOffen}
                onClick={() => setDetailsOffen((o) => !o)}
              >
                {KNOPF_DETAILS}
              </button>
            </p>
            {alleFolgenOffen && vorschau.stand === 'da' && <FolgenKarteAnsicht karte={folgenKarte(vorschau.umzug)} />}
            {detailsOffen && (
              <div className="vp-au-details">
                <Input
                  id={feldId('begruendung')}
                  label={LABEL_BEGRUENDUNG}
                  hint={HINWEIS_BEGRUENDUNG}
                  value={form.begruendung}
                  autoComplete="off"
                  onChange={(e) => setze('begruendung', e.target.value)}
                  error={fehler.begruendung}
                />
              </div>
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
      {neuerStandort && (
        <StandortDialog
          open
          standort={null}
          unternehmen={neuerStandort.unternehmen}
          standorte={standorte.standorte}
          heute={standorte.stichtag}
          onClose={() => setNeuerStandort(null)}
          onGespeichert={(s) => {
            setNeuerStandort(null);
            setze('standortId', s.id);
            onStandorteNeuLaden?.();
          }}
          onOeffnen={(s) => {
            setNeuerStandort(null);
            setze('standortId', s.id);
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
