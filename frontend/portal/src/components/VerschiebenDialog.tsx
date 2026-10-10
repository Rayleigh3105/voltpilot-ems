import { Recht } from './Recht';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type OrtVerschiebenZiel, type OrtVerschiebung } from '../api';
import {
  ERGEBNIS_TITEL,
  FOLGEN_PRUEFEN,
  FOLGEN_WAEHLEN,
  HINWEIS_BEGRUENDUNG,
  KNOPF_FERTIG,
  KNOPF_SPEICHERN,
  LABEL_BEGRUENDUNG,
  LABEL_GUELTIG_AB,
  NICHTS_BLEIBT,
  PROTOKOLL_TITEL,
  TITEL_AUSWERTUNGEN,
  TITEL_BLEIBT,
  TITEL_ZIEHT_MIT,
  ZEITSTRAHL_TITEL,
  ergebnisSatz,
  folgenKarte,
  protokollZeile,
  pruefeVerschieben,
  verschiebenAnfrage,
  verschiebenFeldAusServer,
  verschiebenStart,
  verschiebenTitel,
  vorspann,
  zeitpunktSatz,
  zeitstrahl,
  zielLabel,
  zielOptionen,
  type VerschiebenArt,
  type VerschiebenFehler,
  type VerschiebenFeld,
  type VerschiebenForm,
  type VerschiebenKarte,
} from '../ortVerschieben';
import { alsOrtFehler } from '../standorte';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import type { BerichteFolgen } from '../berichteFolgen';
import { useBerichteFolgen } from '../useBerichteFolgen';
import { Zeitstrahl } from './Zeitstrahl';
import './StandortDialog.css';
import './FlaecheDialog.css';
import './AnlageStandortDialog.css';
import './VerschiebenDialog.css';

type Vorschau = { stand: 'leer' } | { stand: 'pruefen' } | { stand: 'da'; v: OrtVerschiebung } | { stand: 'abgelehnt' };

export interface VerschiebenOrt {
  id: string;
  art: VerschiebenArt;
  name: string;
  kurzzeichen: string;
  /** Woran der Ort heute hängt (Name) — steht im Kopf. */
  eltern: string | null;
}

/**
 * Dialog „… verschieben“ (UEMS AP-02 IP-12, Mockups V2–V4): Ziel, „gültig ab“, eine freiwillige
 * Begründung — und die Folgen-Karte, BEVOR gespeichert wird (V3). Die Ziele sind die `aktionen` des
 * Servers (der bisherige Elternknoten steht nicht zur Wahl); die Karte kommt aus
 * `GET …/verschieben/vorschau` (dieselbe Regel wie der Eintrag) und nennt, was mitzieht, was bleibt —
 * mit Weg — und dass sich an Anlagen, Netzanschlüssen und Boxen nichts ändert. Unter dem Datum steht,
 * was der Tag bedeutet (geplant · ab heute · rückwirkend); ein Tag vor dem Beginn kommt als Satz des
 * Servers an das Feld. Nach dem Speichern (V4): der Zeitstrahl, wie der Server die Zuordnungen gelesen
 * hat, und der Protokolleintrag mit Zeit, was, gilt ab und wer.
 */
export function VerschiebenDialog({
  open,
  ort,
  ziele,
  heute,
  onClose,
  onFertig,
}: {
  open: boolean;
  ort: VerschiebenOrt;
  /** `aktionen.verschieben.ziele` des Knotens. */
  ziele: OrtVerschiebenZiel[];
  /** Heute am Standort (der Stichtag der Antwort ohne „Stand am“). */
  heute: string;
  onClose: () => void;
  onFertig: (v: OrtVerschiebung) => void;
}) {
  const basis = `vp-vd-${useId().replace(/:/g, '')}`;
  const [form, setForm] = useState<VerschiebenForm>(() => verschiebenStart(heute));
  const [versucht, setVersucht] = useState(false);
  const [serverFehler, setServerFehler] = useState<VerschiebenFehler>({});
  const [allgemein, setAllgemein] = useState<string | null>(null);
  const [vorschau, setVorschau] = useState<Vorschau>({ stand: 'leer' });
  const [busy, setBusy] = useState(false);
  const [ergebnis, setErgebnis] = useState<OrtVerschiebung | null>(null);
  const ergebnisKopf = useRef<HTMLParagraphElement>(null);

  const pruefung = pruefeVerschieben(form, ort.art);
  const fehler: VerschiebenFehler = { ...(versucht ? pruefung : {}), ...serverFehler };
  const feldId = (feld: VerschiebenFeld) => `${basis}-${feld}`;
  const { options, groups } = zielOptionen(ort.art, ziele);
  // AP-12 IP-14 (Wege zu IP-9): welche freigegebenen Berichtsstände das Verschieben ab dem Tag träfe — gefragt, sobald
  // Ziel und Tag gewählt sind; ein Anstoß entsteht nur bei einem Standortwechsel (die Route löst auf).
  const berichte = useBerichteFolgen(ort.id, form.zielId ? form.gueltigAb : null, 'zuordnung_rueckwirkend', 'aendern');

  // Die Folgen zu jeder Wahl — die jüngste Antwort gewinnt, eine ältere wird verworfen.
  useEffect(() => {
    const { zielId, gueltigAb } = form;
    if (!zielId || !gueltigAb) {
      setVorschau({ stand: 'leer' });
      return;
    }
    let aktiv = true;
    setVorschau({ stand: 'pruefen' });
    const warten = setTimeout(() => {
      api
        .ortVerschiebenVorschau(ort.id, zielId, gueltigAb)
        .then((v) => {
          if (aktiv) setVorschau({ stand: 'da', v });
        })
        .catch((err: unknown) => {
          if (!aktiv) return;
          const ortFehler = err instanceof ApiError ? alsOrtFehler(err.body) : null;
          const feld = ortFehler ? verschiebenFeldAusServer(ortFehler) : null;
          setVorschau({ stand: 'abgelehnt' });
          if (ortFehler && feld) setServerFehler({ [feld]: ortFehler.message });
          else setAllgemein(ortFehler?.message ?? 'Die Folgen konnten nicht geprüft werden.');
        });
    }, 200);
    return () => {
      aktiv = false;
      clearTimeout(warten);
    };
  }, [ort.id, form.zielId, form.gueltigAb]); // eslint-disable-line react-hooks/exhaustive-deps

  function setze<K extends keyof VerschiebenForm>(feld: K, wert: VerschiebenForm[K]) {
    setForm((f) => ({ ...f, [feld]: wert }));
    setServerFehler({});
    setAllgemein(null);
  }

  function fokus(feld: VerschiebenFeld) {
    requestAnimationFrame(() => document.getElementById(feldId(feld))?.focus());
  }

  async function senden(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setVersucht(true);
    setAllgemein(null);
    const anfrage = verschiebenAnfrage(form, ort.art);
    if (!anfrage) {
      fokus(pruefung.zielId ? 'zielId' : pruefung.gueltigAb ? 'gueltigAb' : 'begruendung');
      return;
    }
    setBusy(true);
    try {
      const v = await api.ortVerschieben(ort.id, anfrage);
      setErgebnis(v);
      requestAnimationFrame(() => ergebnisKopf.current?.focus());
    } catch (err) {
      const ortFehler = err instanceof ApiError ? alsOrtFehler(err.body) : null;
      const feld = ortFehler ? verschiebenFeldAusServer(ortFehler) : null;
      if (ortFehler && feld) {
        setServerFehler({ [feld]: ortFehler.message });
        fokus(feld);
      } else {
        setAllgemein(
          ortFehler?.message ?? (err instanceof Error ? err.message : 'Die Verschiebung konnte nicht gespeichert werden.'),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const fertig = () => {
    if (ergebnis) onFertig(ergebnis);
  };
  const eintrag = ergebnis?.protokoll[0] ?? null;

  return (
    <Modal
      open={open}
      onClose={ergebnis ? fertig : onClose}
      title={ergebnis ? ERGEBNIS_TITEL : verschiebenTitel(ort.name)}
      footer={
        ergebnis ? (
          <Recht aktion="gebaeude.pflegen"><Button onClick={fertig}>{KNOPF_FERTIG}</Button></Recht>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Recht aktion="gebaeude.pflegen" rueckwirkend={!!form.gueltigAb && form.gueltigAb < heute}><Button type="submit" form={`${basis}-form`} disabled={busy}>
              {KNOPF_SPEICHERN}
            </Button></Recht>
          </>
        )
      }
    >
      <form id={`${basis}-form`} className="vp-sd vp-au vp-vd" noValidate onSubmit={(e) => void senden(e)}>
        {ergebnis ? (
          <>
            <p className="vp-au-ergebnis" tabIndex={-1} ref={ergebnisKopf}>
              {ergebnisSatz(ergebnis)}
            </p>
            <Zeitstrahl titel={ZEITSTRAHL_TITEL} abschnitte={zeitstrahl(ergebnis)} />
            {eintrag && <ProtokollAnsicht v={ergebnis} eintrag={eintrag} />}
          </>
        ) : (
          <>
            <div className="vp-fd-kopf">
              <p className="vp-fd-name">
                {ort.name}
                {ort.eltern && <span className="vp-vd-heute"> · heute an {ort.eltern}</span>}
              </p>
              <p className="vp-sd-vorspann">{vorspann(ort.art)}</p>
            </div>
            <VpPicker
              id={feldId('zielId')}
              label={zielLabel(ort.art)}
              placeholder="Ziel wählen"
              options={options}
              groups={groups}
              value={form.zielId}
              onChange={(v) => setze('zielId', v)}
              error={fehler.zielId}
            />
            <VpDatePicker
              id={feldId('gueltigAb')}
              label={LABEL_GUELTIG_AB}
              value={form.gueltigAb}
              onChange={(v) => setze('gueltigAb', v)}
              hint={vorschau.stand === 'da' ? zeitpunktSatz(vorschau.v) : undefined}
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
              <FolgenKarteAnsicht karte={folgenKarte(vorschau.v)} berichte={berichte} />
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
    </Modal>
  );
}

function FolgenKarteAnsicht({ karte, berichte = null }: { karte: VerschiebenKarte; berichte?: BerichteFolgen | null }) {
  return (
    <section className="vp-au-folgen vp-vd-folgen" aria-live="polite" data-testid="verschieben-folgen">
      <div className="vp-au-teil">
        <h4>{TITEL_ZIEHT_MIT}</h4>
        <ul className="vp-au-aendert">
          {karte.ziehtMit.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
      <div className="vp-au-teil">
        <h4>{TITEL_BLEIBT}</h4>
        {karte.bleibt.length ? (
          <ul className="vp-au-bleibt">
            {karte.bleibt.map((b) => (
              <li key={b.satz}>
                <span className="vp-au-haken" aria-hidden="true">
                  ✓
                </span>
                <span className="vp-vd-bleibt-text">
                  <span>{b.satz}</span>
                  {b.weg && <span className="vp-vd-weg">{b.weg}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="vp-vd-leer">{NICHTS_BLEIBT}</p>
        )}
      </div>
      <div className="vp-au-teil">
        <h4>{TITEL_AUSWERTUNGEN}</h4>
        <ul className="vp-au-aendert">
          {karte.auswertungen.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
      {berichte && (
        <p className="vp-au-berichte" data-testid="berichte-folgen">
          <strong>{berichte.titel}:</strong> {berichte.text}
        </p>
      )}
      <p className="vp-au-befehl">{karte.nichts}</p>
    </section>
  );
}

function ProtokollAnsicht({ v, eintrag }: { v: OrtVerschiebung; eintrag: OrtVerschiebung['protokoll'][number] }) {
  const z = protokollZeile(v, eintrag);
  return (
    <section className="vp-vd-protokoll" data-testid="verschieben-protokoll">
      <h4>{PROTOKOLL_TITEL}</h4>
      <dl>
        <div>
          <dt>Zeit</dt>
          <dd>{z.zeit}</dd>
        </div>
        <div>
          <dt>Was</dt>
          <dd>{z.was}</dd>
        </div>
        <div>
          <dt>Gilt ab</dt>
          <dd>{z.giltAb}</dd>
        </div>
        <div>
          <dt>Wer</dt>
          <dd>{z.wer}</dd>
        </div>
      </dl>
    </section>
  );
}
