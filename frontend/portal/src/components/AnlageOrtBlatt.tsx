import { Recht } from './Recht';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  ApiError,
  type AnlageOrtErgebnis,
  type AnlageOrtUmzugErgebnis,
  type AnlageUmzug,
  type OrtTreffer,
  type StandortAmStichtag,
  type StandorteAmStichtag,
  type UmzugMerkzettel,
} from '../api';
import { api } from '../apiVoll';
import {
  adresseWaehlen,
  entfernungKmGerundet,
  geaendert,
  istUmzugsfrage,
  landFolgen,
  ortAnfrage,
  ortFormAus,
  pinZiehen,
  uebernahmeAnbieten,
  umzugAnfrage,
  umzugErgebnisSatz,
  umzugsFolgenSaetze,
  type OrtForm,
  type OrtPunkt,
  type UmzugForm,
} from '../anlageOrtBerichtigen';
import { datumText, type Tag } from '../uemsOrtsbaum';
import { folgenKarte, tagPlus } from '../anlageUmziehen';
import { gehoertZuText, KNOPF_GEHOERT_ZU_AENDERN } from '../anlageStandort';
import { adresseAusTreffer, adresseText, type Adresse } from '../anlageOrt';
import { alsOrtFehler } from '../standorte';
import { AdressSuche, type AdressWahl } from './AdressSuche';
import { AnlageStandortDialog, FolgenKarteAnsicht } from './AnlageStandortDialog';
import { ArchivierenDialog, type ArchivObjekt } from './ArchivierenDialog';
import { KoordinatenManuellFelder } from './KoordinatenManuellFelder';
import { UmzugMerkzettelKarte } from './UmzugMerkzettelKarte';
import { LocationMap } from './LocationMap';
import { VpDatePicker } from './VpDatePicker';
import './AnlageOrtBlatt.css';
import './AnlageStandortDialog.css';

export const ORT_BLATT_TITEL = 'Standort';
const KNOPF_SPEICHERN = 'Speichern';
const KNOPF_ABBRECHEN = 'Abbrechen';
const KNOPF_DETAILS = 'Details';
const KNOPF_RUECKGAENGIG = 'Rückgängig';
const KNOPF_FERTIG = 'Fertig';
// §7, E1 = B: "Ist Ihre Anlage umgezogen?" statt die weite Adresse wortlos zu übernehmen.
const UMZUGSFRAGE_TITEL = 'Ist Ihre Anlage umgezogen?';
const KNOPF_WAR_FALSCH = 'Nein, die Adresse war falsch';
const KNOPF_UMGEZOGEN = 'Ja, wir sind umgezogen';
const KNOPF_ZURUECK = 'Zurück';
const LABEL_UMZUGSTAG = 'Seit wann?';
const LABEL_ALLE_FOLGEN = 'Alle Folgen';
type ArchivAngebot = { objekt: ArchivObjekt; archiviert: boolean } | null;

/**
 * Das Blatt der neuen Zeile „Standort" (vp-standort-konzept §6.1, B1/B3/B6): Karte oben, Adresse
 * darunter — dieselbe Karte ({@link LocationMap}) und dieselbe Adresssuche ({@link AdressSuche})
 * wie in der Einrichtung. Die Adresse setzt den Pin; ihn fein ziehen ändert nie die Adresse (Regel
 * 3). „Speichern" wird erst aktiv, wenn sich etwas ändert (Regel 2); nie ein Datum (Regel 5) — der
 * Server schreibt Adresse, Lage, Gebotszone, Box-Neubau und Wetter-Nachholung in einem Zug
 * (`api.anlageOrtBerichtigen`).
 *
 * <p>„Umzug" (§7, E1 = B): eine über die Adresssuche gewählte Adresse mehr als 2 km vom
 * ursprünglichen Punkt fragt erst „Ist Ihre Anlage umgezogen?" statt die Berichtigung wortlos zu
 * übernehmen. „Nein" bleibt die Berichtigung oben; „Ja" fragt den Umzugstag (heute oder davor,
 * nie in der Zukunft) und speichert über den eigenen Weg (`api.anlageOrtUmziehen`) — ein neuer
 * Standort entsteht still (heißt wie die Anlage). Das Ergebnis trägt EIGENE Umzugs-Sätze
 * (`umzugErgebnisSatz`/`umzugsFolgenSaetze`), nicht die Zuordnungs-Sätze von „Gehört zu" (ein „X
 * gehört zu X" wäre doppelt und sinnlos) — der Titel bleibt durchgehend „Standort". Danach bietet
 * das Blatt das Archivieren des leeren bisherigen Standorts an (wie „Zuordnung korrigieren").
 */
export function AnlageOrtBlatt({
  siteId,
  standort,
  antwort,
  mehrereStandorte,
  onStandorteNeuLaden,
  onClose,
  onGespeichert,
}: {
  siteId: string;
  standort: StandortAmStichtag;
  /** `GET /api/v1/standorte` von heute — für „Gehört zu › Ändern" (Zielliste und „heute"). */
  antwort: StandorteAmStichtag;
  /** §6.2: ab zwei Standorten trägt die Adresse „Gilt für alle Anlagen im Werk". */
  mehrereStandorte: boolean;
  /** §6.5: nach „Neuer Standort" im „Gehört zu"-Dialog die Liste neu lesen (B4). */
  onStandorteNeuLaden?: () => void;
  onClose: () => void;
  onGespeichert: (ergebnis: AnlageOrtErgebnis | AnlageOrtUmzugErgebnis) => void;
}) {
  const basis = `vp-ob-${useId().replace(/:/g, '')}`;
  const start = ortFormAus(standort);
  const [form, setForm] = useState<OrtForm | null>(start);
  const [suche, setSuche] = useState(start ? adresseText(start.adresse) : '');
  const [gewaehlt, setGewaehlt] = useState<AdressWahl | null>(start ? { adresse: start.adresse, punkt: start.punkt } : null);
  const [fokus, setFokus] = useState(0);
  const [uebernahme, setUebernahme] = useState<{ adresse: Adresse; punkt: OrtPunkt } | null>(null);
  const [detailsOffen, setDetailsOffen] = useState(false);
  const [gehoertZuOffen, setGehoertZuOffen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<AnlageOrtErgebnis | null>(null);
  // §7: die weit entfernte Wahl, solange die Frage „umgezogen?" noch nicht beantwortet ist.
  const [weitWeg, setWeitWeg] = useState<{ adresse: Adresse; punkt: OrtPunkt } | null>(null);
  const [umzugSchritt, setUmzugSchritt] = useState<'frage' | 'datum' | null>(null);
  const [umzugTag, setUmzugTag] = useState<Tag>(antwort.stichtag);
  const [umzugBusy, setUmzugBusy] = useState(false);
  const [umzugFehler, setUmzugFehler] = useState<string | null>(null);
  const [umzugErgebnis, setUmzugErgebnis] = useState<AnlageOrtUmzugErgebnis | null>(null);
  const [alleFolgenOffen, setAlleFolgenOffen] = useState(false);
  const [archivAngebot, setArchivAngebot] = useState<ArchivAngebot>(null);
  const [archivDialog, setArchivDialog] = useState(false);
  const [merkzettel, setMerkzettel] = useState<UmzugMerkzettel | null>(null);
  const zuordnung = standort.anlagen.find((a) => a.id === siteId) ?? null;
  // Der Punkt VOR dem laufenden Zug — in onChange festgehalten, bevor der State sich ändert, denn
  // die Auflösung (onOrtAufgeloest) kommt immer erst NACH dem nächsten Render mit dem NEUEN Punkt.
  const vorZugRef = useRef<OrtPunkt | null>(start?.punkt ?? null);

  if (!start || !form) {
    // Randfall (B1-Vorgänger): ein Standort ohne vollständige Adresse ODER ohne Lage — hier fehlt
    // der Pin, den dieses Blatt voraussetzt (Regel: nie ohne Punkt speichern).
    return (
      <Modal open onClose={onClose} title={ORT_BLATT_TITEL} footer={<Button variant="ghost" onClick={onClose}>Schließen</Button>}>
        <p>
          Für diesen Standort fehlt noch eine vollständige Adresse mit Punkt auf der Karte. Bitte wenden Sie sich an
          den Support.
        </p>
      </Modal>
    );
  }

  const hatSichGeaendert = geaendert(form, start);
  const { gebotszone, zeitzone } = landFolgen(form.adresse.land);

  function ortAufgeloest(treffer: OrtTreffer) {
    if (!form) return;
    const aufgeloest = adresseAusTreffer(treffer);
    const punkt = { breitengrad: treffer.breitengrad, laengengrad: treffer.laengengrad };
    const vorZug = vorZugRef.current ?? punkt;
    if (uebernahmeAnbieten(vorZug, punkt, aufgeloest, form.adresse)) {
      setUebernahme(aufgeloest ? { adresse: aufgeloest, punkt } : null);
    } else {
      setUebernahme(null);
    }
  }

  // Dieselbe Regel für den gezogenen Pin wie für die manuell eingetragenen Koordinaten unter
  // „Details" (Regel 3: ein verschobener Punkt ändert nie die Adresse).
  function pinSetzen(lat: number | null, lon: number | null) {
    if (!form || lat == null || lon == null) return;
    vorZugRef.current = form.punkt;
    setForm((f) => (f ? pinZiehen(f, { breitengrad: lat, laengengrad: lon }) : f));
  }

  function uebernahmeAnnehmen() {
    if (!uebernahme) return;
    setForm((f) => (f ? adresseWaehlen(f, uebernahme.adresse, uebernahme.punkt) : f));
    setSuche(adresseText(uebernahme.adresse));
    setGewaehlt({ adresse: uebernahme.adresse, punkt: uebernahme.punkt });
    setUebernahme(null);
  }

  async function speichern(werte: OrtForm, nachSpeichern: (r: AnlageOrtErgebnis) => void) {
    setBusy(true);
    setFehler(null);
    try {
      const r = await api.anlageOrtBerichtigen(siteId, ortAnfrage(werte));
      setForm(werte);
      nachSpeichern(r);
    } catch (e) {
      const ortFehler = e instanceof ApiError ? alsOrtFehler(e.body) : null;
      setFehler(ortFehler?.message ?? (e instanceof Error ? e.message : 'Die Änderung konnte nicht gespeichert werden.'));
    } finally {
      setBusy(false);
    }
  }

  // Rückgängig schreibt die alten Werte als weitere Berichtigung zurück (§6.6) — direkt fertig,
  // keine zweite "Vorher"-Zeile, die den gerade wiederhergestellten Stand als "vorher" nennen würde.
  async function rueckgaengig() {
    if (!start) return;
    await speichern(start, onGespeichert);
  }

  const fertig = () => {
    if (ergebnis) onGespeichert(ergebnis);
  };

  // „Gehört zu › Ändern" (§6.5) zieht die Anlage zu einem anderen Standort um - dieses Blatt
  // zeigt dann einen Standort, zu dem die Anlage nicht mehr gehört. Statt mit dem veralteten
  // Stand weiterzumachen, schließt das ganze Blatt und „Meine Anlage" liest neu.
  function gehoertZuGespeichert(_umzug: AnlageUmzug) {
    setGehoertZuOffen(false);
    onStandorteNeuLaden?.();
    onClose();
  }

  // §7, E1 = B: „Nein, die Adresse war falsch" bleibt die Berichtigung von oben — die weit
  // entfernte Wahl wird einfach ganz normal übernommen (kein Datum, Regel 5).
  function weitWegIstBerichtigung() {
    if (!weitWeg) return;
    setForm((f) => (f ? adresseWaehlen(f, weitWeg.adresse, weitWeg.punkt) : f));
    setSuche(adresseText(weitWeg.adresse));
    setGewaehlt({ adresse: weitWeg.adresse, punkt: weitWeg.punkt });
    vorZugRef.current = weitWeg.punkt;
    setWeitWeg(null);
    setUmzugSchritt(null);
    setFokus((n) => n + 1);
  }

  function weitWegIstUmzug() {
    setUmzugTag(antwort.stichtag);
    setUmzugSchritt('datum');
  }

  function umzugAbbrechen() {
    setWeitWeg(null);
    setUmzugSchritt(null);
    setUmzugFehler(null);
  }

  async function umzugSpeichern() {
    if (!weitWeg) return;
    setUmzugBusy(true);
    setUmzugFehler(null);
    try {
      const form: UmzugForm = { adresse: weitWeg.adresse, punkt: weitWeg.punkt, gueltigAb: umzugTag };
      const r = await api.anlageOrtUmziehen(siteId, umzugAnfrage(form));
      setUmzugErgebnis(r);
      // Bericht 6.6 Punkt 7: der echte, gerade angelegte Stand vom Server - kein geratener Anfangswert.
      api.umzugMerkzettelLesen(siteId).then(setMerkzettel).catch(() => {});
    } catch (e) {
      const ortFehler = e instanceof ApiError ? alsOrtFehler(e.body) : null;
      setUmzugFehler(ortFehler?.message ?? (e instanceof Error ? e.message : 'Der Umzug konnte nicht gespeichert werden.'));
    } finally {
      setUmzugBusy(false);
    }
  }

  const umzugFertig = () => {
    if (umzugErgebnis) onGespeichert(umzugErgebnis);
  };

  // Nach dem Umzug: derselbe Lese-Weg wie bei „Zuordnung korrigieren" — ist der bisherige
  // Standort jetzt leer, bietet das Blatt das Archivieren an (keine eigene Mechanik hier).
  useEffect(() => {
    const bisher = umzugErgebnis?.umzug.bisher;
    if (!bisher) {
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
  }, [umzugErgebnis]);

  return (
    <Modal
      open
      onClose={umzugErgebnis ? umzugFertig : ergebnis ? fertig : onClose}
      title={ORT_BLATT_TITEL}
      footer={
        umzugErgebnis ? (
          <Button onClick={umzugFertig}>{KNOPF_FERTIG}</Button>
        ) : ergebnis ? (
          <Button onClick={fertig}>{KNOPF_FERTIG}</Button>
        ) : umzugSchritt === 'frage' ? (
          <>
            <Button variant="ghost" onClick={umzugAbbrechen}>
              {KNOPF_ABBRECHEN}
            </Button>
          </>
        ) : umzugSchritt === 'datum' ? (
          <>
            <Button variant="ghost" onClick={() => setUmzugSchritt('frage')} disabled={umzugBusy}>
              {KNOPF_ZURUECK}
            </Button>
            <Recht aktion="anlage.ort_berichtigen">
              <Button variant="primary" disabled={umzugBusy} onClick={() => void umzugSpeichern()}>
                {umzugBusy ? 'Wird gespeichert …' : KNOPF_SPEICHERN}
              </Button>
            </Recht>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {KNOPF_ABBRECHEN}
            </Button>
            <Recht aktion="anlage.ort_berichtigen">
              <Button
                variant="primary"
                disabled={busy || !hatSichGeaendert}
                onClick={() => void speichern(form, setErgebnis)}
              >
                {busy ? 'Wird gespeichert …' : KNOPF_SPEICHERN}
              </Button>
            </Recht>
          </>
        )
      }
    >
      <div className="vp-ob">
        {umzugErgebnis ? (
          <div className="vp-ob-ergebnis" aria-live="polite">
            <p>
              <strong>Gespeichert.</strong> {umzugErgebnisSatz(weitWeg!.adresse, umzugErgebnis.umzug.gueltigAb)}
            </p>
            <div className="vp-au-folgen-kurz">
              <ul>
                {umzugsFolgenSaetze(umzugErgebnis.umzug).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
            <p className="vp-au-folgen-links">
              <button
                type="button"
                className="vp-linklike vp-linklike-quiet"
                aria-expanded={alleFolgenOffen}
                onClick={() => setAlleFolgenOffen((o) => !o)}
              >
                {LABEL_ALLE_FOLGEN}
              </button>
            </p>
            {alleFolgenOffen && <FolgenKarteAnsicht karte={folgenKarte(umzugErgebnis.umzug)} />}
            {archivAngebot && (
              <section className="vp-au-archiv" data-testid="standort-archiv-angebot">
                {archivAngebot.archiviert ? (
                  <p>Der bisherige Standort {archivAngebot.objekt.name} ist archiviert. Seine Geschichte bleibt erhalten.</p>
                ) : (
                  <>
                    <p>Der bisherige Standort {archivAngebot.objekt.name} ist jetzt leer. Sie können ihn archivieren; seine Geschichte bleibt erhalten.</p>
                    <Recht aktion="standort.verwalten">
                      <Button type="button" variant="outline" onClick={() => setArchivDialog(true)}>
                        Standort archivieren
                      </Button>
                    </Recht>
                  </>
                )}
              </section>
            )}
            {merkzettel && (
              <UmzugMerkzettelKarte siteId={siteId} merkzettel={merkzettel} onGeaendert={setMerkzettel} />
            )}
          </div>
        ) : ergebnis ? (
          <div className="vp-ob-ergebnis" aria-live="polite">
            <p>
              <strong>Gespeichert.</strong> Vorher: {adresseText(start.adresse)}
            </p>
            <Recht aktion="anlage.ort_berichtigen">
              <button type="button" className="vp-linklike" onClick={() => void rueckgaengig()} disabled={busy}>
                {KNOPF_RUECKGAENGIG}
              </button>
            </Recht>
          </div>
        ) : umzugSchritt === 'frage' && weitWeg ? (
          <>
            <p className="vp-au-frage">{UMZUGSFRAGE_TITEL}</p>
            <p className="vp-au-frage-sub">
              {adresseText(weitWeg.adresse)} ist {entfernungKmGerundet(start.punkt, weitWeg.punkt)} km entfernt.
            </p>
            <div className="vp-au-opts" role="radiogroup" aria-label={UMZUGSFRAGE_TITEL}>
              <label className="vp-au-opt">
                <input type="radio" name={`${basis}-umzug`} onChange={weitWegIstBerichtigung} />
                <span className="vp-au-opt-text">
                  <b>{KNOPF_WAR_FALSCH}</b>
                  <small>Wir berichtigen sie.</small>
                </span>
              </label>
              <label className="vp-au-opt">
                <input type="radio" name={`${basis}-umzug`} onChange={weitWegIstUmzug} />
                <span className="vp-au-opt-text">
                  <b>{KNOPF_UMGEZOGEN}</b>
                  <small>{LABEL_UMZUGSTAG}</small>
                </span>
              </label>
            </div>
          </>
        ) : umzugSchritt === 'datum' && weitWeg ? (
          <>
            <p className="vp-au-frage">
              Seit wann gehört {zuordnung?.name ?? 'die Anlage'} zu {adresseText(weitWeg.adresse)}?
            </p>
            <VpDatePicker
              id={`${basis}-umzugstag`}
              label={LABEL_UMZUGSTAG}
              value={umzugTag}
              max={antwort.stichtag}
              onChange={setUmzugTag}
            />
            <ul className="vp-ob-umzug-folgen">
              <li>
                Der Verlauf läuft weiter. Bis {datumText(tagPlus(umzugTag, -1))} zählt er zum bisherigen Standort.
              </li>
              <li>Wetter und Prognose rechnen ab dem Umzugstag am neuen Ort.</li>
              <li>Die Anlage bleibt dieselbe: Box, Freigaben und Fahrpläne bleiben, wie sie sind.</li>
            </ul>
            {umzugFehler && (
              <div className="vp-alert vp-alert-err" role="alert">
                {umzugFehler}
              </div>
            )}
          </>
        ) : (
          <>
            {mehrereStandorte && zuordnung && (
              <p className="vp-ob-gehoert-zu">
                {gehoertZuText(standort)} ·{' '}
                <Recht aktion="anlage.zuordnen">
                  <button
                    type="button"
                    className="vp-linklike"
                    aria-label={`${KNOPF_GEHOERT_ZU_AENDERN}: ${zuordnung.name}`}
                    onClick={() => setGehoertZuOffen(true)}
                  >
                    {KNOPF_GEHOERT_ZU_AENDERN}
                  </button>
                </Recht>
              </p>
            )}
            {mehrereStandorte && (
              <p className="vp-ob-gilt-fuer-alle">Gilt für alle Anlagen im Werk.</p>
            )}
            <LocationMap
              lat={form.punkt.breitengrad}
              lon={form.punkt.laengengrad}
              fokus={fokus}
              pflichtPunkt
              manuellAusblenden
              ortAufloesen
              onOrtAufgeloest={ortAufgeloest}
              onChange={pinSetzen}
            />
            {uebernahme && (
              <p className="vp-ob-uebernahme" role="status">
                Adresse hier: {adresseText(uebernahme.adresse)}.{' '}
                <button type="button" className="vp-linklike" onClick={uebernahmeAnnehmen}>
                  Adresse übernehmen?
                </button>
              </p>
            )}
            <AdressSuche
              id={`${basis}-adresse`}
              suche={suche}
              onSuche={setSuche}
              gewaehlt={gewaehlt}
              onWahl={(wahl) => {
                setGewaehlt(wahl);
                if (!wahl) return;
                // §7, E1 = B: eine weit entfernte Wahl fragt erst "umgezogen?" - sie wird NICHT
                // sofort übernommen (die Antwort "Nein" tut das weiter unten). Ohne aufgelösten
                // Punkt (freier Text ohne Vorschlag) gilt wie bisher die Berichtigung.
                if (wahl.punkt && istUmzugsfrage(start.punkt, wahl.punkt)) {
                  setWeitWeg({ adresse: wahl.adresse, punkt: wahl.punkt });
                  setUmzugSchritt('frage');
                  return;
                }
                setForm((f) => {
                  const next = f ? adresseWaehlen(f, wahl.adresse, wahl.punkt) : f;
                  if (next) vorZugRef.current = next.punkt;
                  return next;
                });
                setUebernahme(null);
                setFokus((n) => n + 1);
              }}
            />
            <button
              type="button"
              className="vp-linklike vp-linklike-quiet vp-ob-details-knopf"
              aria-expanded={detailsOffen}
              onClick={() => setDetailsOffen((o) => !o)}
            >
              {KNOPF_DETAILS}
            </button>
            {detailsOffen && (
              <div className="vp-ob-details">
                <dl className="vp-ob-details-werte">
                  <div>
                    <dt>Strommarkt</dt>
                    <dd>{gebotszone}</dd>
                  </div>
                  <div>
                    <dt>Zeitzone</dt>
                    <dd>{zeitzone}</dd>
                  </div>
                </dl>
                <KoordinatenManuellFelder lat={form.punkt.breitengrad} lon={form.punkt.laengengrad} onChange={pinSetzen} />
              </div>
            )}
            {fehler && (
              <div className="vp-alert vp-alert-err" role="alert">
                {fehler}
              </div>
            )}
          </>
        )}
      </div>
      {gehoertZuOffen && zuordnung && (
        <AnlageStandortDialog
          open
          anlageId={zuordnung.id}
          anlageName={zuordnung.name}
          standorte={antwort}
          gueltigAbVorgabe={zuordnung.gueltigAb}
          onClose={() => setGehoertZuOffen(false)}
          onStandorteNeuLaden={onStandorteNeuLaden}
          onGespeichert={gehoertZuGespeichert}
        />
      )}
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

