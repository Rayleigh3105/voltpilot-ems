import { Recht } from './Recht';
import { useId, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  ApiError,
  type AnlageOrtErgebnis,
  type AnlageUmzug,
  type OrtTreffer,
  type StandortAmStichtag,
  type StandorteAmStichtag,
} from '../api';
import { api } from '../apiVoll';
import {
  adresseWaehlen,
  geaendert,
  landFolgen,
  ortAnfrage,
  ortFormAus,
  pinZiehen,
  uebernahmeAnbieten,
  type OrtForm,
  type OrtPunkt,
} from '../anlageOrtBerichtigen';
import { gehoertZuText, KNOPF_GEHOERT_ZU_AENDERN } from '../anlageStandort';
import { adresseAusTreffer, adresseText, type Adresse } from '../anlageOrt';
import { alsOrtFehler } from '../standorte';
import { AdressSuche, type AdressWahl } from './AdressSuche';
import { AnlageStandortDialog } from './AnlageStandortDialog';
import { KoordinatenManuellFelder } from './KoordinatenManuellFelder';
import { LocationMap } from './LocationMap';
import './AnlageOrtBlatt.css';

export const ORT_BLATT_TITEL = 'Standort';
const KNOPF_SPEICHERN = 'Speichern';
const KNOPF_ABBRECHEN = 'Abbrechen';
const KNOPF_DETAILS = 'Details';
const KNOPF_RUECKGAENGIG = 'Rückgängig';
const KNOPF_FERTIG = 'Fertig';

/**
 * Das Blatt der neuen Zeile „Standort" (vp-standort-konzept §6.1, B1/B3/B6): Karte oben, Adresse
 * darunter — dieselbe Karte ({@link LocationMap}) und dieselbe Adresssuche ({@link AdressSuche})
 * wie in der Einrichtung. Die Adresse setzt den Pin; ihn fein ziehen ändert nie die Adresse (Regel
 * 3). „Speichern" wird erst aktiv, wenn sich etwas ändert (Regel 2); nie ein Datum (Regel 5) — der
 * Server schreibt Adresse, Lage, Gebotszone, Box-Neubau und Wetter-Nachholung in einem Zug
 * (`api.anlageOrtBerichtigen`).
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
  onGespeichert: (ergebnis: AnlageOrtErgebnis) => void;
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

  return (
    <Modal
      open
      onClose={ergebnis ? fertig : onClose}
      title={ORT_BLATT_TITEL}
      footer={
        ergebnis ? (
          <Button onClick={fertig}>{KNOPF_FERTIG}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {KNOPF_ABBRECHEN}
            </Button>
            <Recht aktion="anlage.verwalten">
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
        {ergebnis ? (
          <div className="vp-ob-ergebnis" aria-live="polite">
            <p>
              <strong>Gespeichert.</strong> Vorher: {adresseText(start.adresse)}
            </p>
            <Recht aktion="anlage.verwalten">
              <button type="button" className="vp-linklike" onClick={() => void rueckgaengig()} disabled={busy}>
                {KNOPF_RUECKGAENGIG}
              </button>
            </Recht>
          </div>
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
    </Modal>
  );
}

