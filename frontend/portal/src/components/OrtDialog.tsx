import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type Nutzung, type OrtsbaumAmStichtag } from '../api';
import {
  bereichZiele,
  DIREKT_AM_STANDORT,
  ersterOrtFehler,
  leeresOrtFormular,
  ortAnlegenAnfrage,
  ortBearbeitenAnfrage,
  ortDialogSenden,
  ortDialogTitel,
  ortDialogVorspann,
  ortFeldAusServer,
  ortFlaecheAnfrage,
  ortFormularAus,
  ortPruefen,
  zeitzoneSatz,
  type Knoten,
  type OrtDialogArt,
  type OrtFeld,
  type OrtFeldFehler,
  type OrtFormular,
} from '../ortsbaum';
import { alsOrtFehler, NUTZUNGEN } from '../standorte';
import { m2Text } from '../uemsOrtsbaum';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import './StandortDialog.css';
import './OrtDialog.css';

/**
 * Die Dialoge „Gebäude anlegen/bearbeiten“ (T4) und „Bereich anlegen/bearbeiten“
 * (T5) — UEMS AP-02 IP-7. Dieselbe Schale wie der Standort-Dialog (IP-6):
 * zentriertes `Modal`, der Formular-Stapel `vp-sd`, keine nativen Auswahlfelder,
 * vor dem Senden geprüft mit den Sätzen des Servers, der erste Fehler bekommt den
 * Fokus, eine Ablehnung landet am Feld aus `ortFeldAusServer`.
 *
 * Alles, was entschieden wird, steht in `ortsbaum.ts`.
 *
 * ⚠ „Hängt an“ wählt man nur beim Anlegen eines Bereichs; danach ist es
 * Verschieben mit „gültig ab“ (IP-12) und steht hier nur lesend.
 * ⚠ Die Fläche: beim Anlegen die erste (ab „Gültig ab“ = erster Tag des Knotens),
 * beim Bearbeiten nur, solange es keine gibt (`PUT …/flaeche`). Eine vorhandene
 * steht lesend da — ändern mit Verlauf ist IP-8 (T7).
 */
export function OrtDialog({
  open,
  art,
  antwort,
  knoten,
  vorwahl = null,
  startFeld = null,
  onClose,
  onGespeichert,
  onOeffnen,
}: {
  open: boolean;
  art: OrtDialogArt;
  /** Der Ortsbaum des Standorts heute — Ziele, Namensregel, Stichtag. */
  antwort: OrtsbaumAmStichtag;
  /** `null`: anlegen; sonst der Knoten, der bearbeitet wird. */
  knoten: Knoten | null;
  /** Bereich anlegen: das vorgewählte Ziel (L1: der Standort). */
  vorwahl?: string | null;
  /** Das Feld, das beim Öffnen den Fokus bekommt („Fläche eintragen“ → die Fläche). */
  startFeld?: OrtFeld | null;
  onClose: () => void;
  onGespeichert: () => void;
  /** „oder öffnen Sie …“ — öffnet den Knoten, der den Namen schon trägt. */
  onOeffnen?: (id: string) => void;
}) {
  const fassung = knoten ? 'bearbeiten' : 'anlegen';
  const basis = `vp-od-${useId().replace(/:/g, '')}`;
  const feldId = (f: OrtFeld) => `${basis}-${f}`;
  const standort = antwort.standort;

  const [form, setForm] = useState<OrtFormular>(() =>
    knoten ? ortFormularAus(knoten, antwort) : leeresOrtFormular(art, antwort, vorwahl),
  );
  const [versucht, setVersucht] = useState(false);
  const [serverFehler, setServerFehler] = useState<OrtFeldFehler>({});
  const [allgemein, setAllgemein] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pruefung = useMemo(
    () => ortPruefen(art, fassung, form, antwort, knoten),
    [art, fassung, form, antwort, knoten],
  );
  const fehler: OrtFeldFehler = versucht ? { ...pruefung.fehler, ...serverFehler } : serverFehler;
  const ziele = useMemo(() => (art === 'bereich' && !knoten ? bereichZiele(antwort) : []), [art, knoten, antwort]);
  const vorhandeneFlaeche = knoten?.quelle?.flaecheM2 ?? null;
  const flaecheEingabe = fassung === 'anlegen' || vorhandeneFlaeche == null;

  function setze<K extends keyof OrtFormular>(feld: K, wert: OrtFormular[K]) {
    setForm((f) => ({ ...f, [feld]: wert }));
    setServerFehler((s) => {
      if (!(feld in s)) return s;
      const rest = { ...s };
      delete rest[feld as OrtFeld];
      return rest;
    });
    setAllgemein(null);
  }

  function fokus(feld: OrtFeld | null) {
    if (!feld) return;
    requestAnimationFrame(() => document.getElementById(feldId(feld))?.focus());
  }

  // Das Modal fokussiert beim Öffnen seine Fläche; das Startfeld kommt einen Rahmen danach.
  useEffect(() => {
    if (!open || !startFeld) return;
    const r = requestAnimationFrame(() => fokus(startFeld));
    return () => cancelAnimationFrame(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startFeld]);

  /** Eine Ablehnung am Feld — oder über dem Fuß, wenn der Dialog das Feld nicht zeigt. */
  function ablehnung(err: unknown, sichtbar: OrtFeld[]) {
    const ort = err instanceof ApiError ? alsOrtFehler(err.body) : null;
    const feld = ort ? ortFeldAusServer(ort) : null;
    if (ort && feld && sichtbar.includes(feld)) {
      setServerFehler({ [feld]: ort.message });
      fokus(feld);
    } else {
      setAllgemein(
        ort?.message ??
          (err instanceof Error
            ? err.message
            : `${art === 'gebaeude' ? 'Das Gebäude' : 'Der Bereich'} konnte nicht gespeichert werden.`),
      );
    }
  }

  const sichtbareFelder: OrtFeld[] = [
    'name',
    ...(fassung === 'bearbeiten' ? (['kurzzeichen'] as const) : []),
    ...(art === 'bereich' && fassung === 'anlegen' ? (['elternId'] as const) : []),
    'nutzung',
    ...(flaecheEingabe ? (['flaeche', 'gueltigAb'] as const) : []),
    ...(art === 'gebaeude' ? (['baujahr'] as const) : []),
    'notiz',
  ];

  async function senden(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setVersucht(true);
    setAllgemein(null);
    const erster = ersterOrtFehler(pruefung.fehler);
    if (erster) {
      fokus(erster);
      return;
    }
    setBusy(true);
    try {
      if (!knoten) {
        await api.ortAnlegen(standort.id, ortAnlegenAnfrage(art, form, antwort));
      } else {
        await api.ortBearbeiten(knoten.id!, ortBearbeitenAnfrage(art, form));
        const flaeche = flaecheEingabe ? ortFlaecheAnfrage(form) : null;
        // Erst die Stammdaten, dann die erste Fläche. Scheitert die Fläche, bleibt der
        // Dialog offen mit dem Satz am Feld — ein zweites „Speichern“ schreibt die
        // unveränderten Stammdaten nicht noch einmal ins Protokoll (`OrtService`).
        if (flaeche) await api.ortFlaeche(knoten.id!, flaeche);
      }
      onGespeichert();
    } catch (err) {
      ablehnung(err, sichtbareFelder);
    } finally {
      setBusy(false);
    }
  }

  const belegtVon = fehler.name ? pruefung.belegtVon : null;
  const titel = ortDialogTitel(art, fassung);
  const eltern = knoten?.eltern ?? null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={titel}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy}>
            {ortDialogSenden(art, fassung)}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-sd" noValidate onSubmit={(e) => void senden(e)}>
        <p className="vp-sd-vorspann">{ortDialogVorspann(art, standort)}</p>

        <Input
          id={feldId('name')}
          label="Name *"
          value={form.name}
          autoComplete="off"
          onChange={(e) => setze('name', e.target.value)}
          error={fehler.name}
        />
        {belegtVon && onOeffnen && (
          <button type="button" className="vp-sd-verweis" onClick={() => onOeffnen(belegtVon.id)}>
            {belegtVon.name} öffnen
          </button>
        )}

        {fassung === 'bearbeiten' && (
          <Input
            id={feldId('kurzzeichen')}
            label="Kurzzeichen *"
            value={form.kurzzeichen}
            autoComplete="off"
            onChange={(e) => setze('kurzzeichen', e.target.value)}
            error={fehler.kurzzeichen}
          />
        )}

        {art === 'bereich' && fassung === 'anlegen' && (
          <VpPicker
            id={feldId('elternId')}
            label="Hängt an *"
            placeholder="Gebäude oder Standort wählen"
            options={ziele.map((z) => ({
              value: z.id,
              label: z.label,
              sub: z.sub,
            }))}
            value={form.elternId}
            onChange={(v) => setze('elternId', v)}
            error={fehler.elternId}
          />
        )}
        {art === 'bereich' && eltern && (
          <div className="vp-sd-flaeche" data-testid="haengt-an">
            <span className="vp-sd-flaeche-label">Hängt an</span>
            <span className="vp-sd-flaeche-wert">
              {eltern.art === 'gebaeude' ? `Gebäude ${eltern.name}` : `${DIREKT_AM_STANDORT} ${eltern.name}`}
            </span>
          </div>
        )}

        <VpPicker
          id={feldId('nutzung')}
          label="Nutzung"
          placeholder="Nutzung wählen"
          options={NUTZUNGEN.map((n) => ({ value: n.code, label: n.wort }))}
          values={form.nutzung}
          onChangeMany={(v) => setze('nutzung', v as Nutzung[])}
          hint="Die erste Auswahl ist die Hauptnutzung."
          error={fehler.nutzung}
        />

        {flaecheEingabe ? (
          <div className="vp-sd-reihe">
            <div className="vp-od-flaeche">
              <Input
                id={feldId('flaeche')}
                label="Bezugsfläche (m²)"
                value={form.flaeche}
                inputMode="numeric"
                autoComplete="off"
                onChange={(e) => setze('flaeche', e.target.value)}
                error={fehler.flaeche}
              />
            </div>
            <div className="vp-od-ab">
              <VpDatePicker
                id={feldId('gueltigAb')}
                label="Gültig ab"
                value={form.gueltigAb}
                onChange={(v) => setze('gueltigAb', v)}
                error={fehler.gueltigAb}
              />
            </div>
          </div>
        ) : (
          vorhandeneFlaeche != null && (
            <div className="vp-sd-flaeche">
              <span className="vp-sd-flaeche-label">Bezugsfläche</span>
              <span className="vp-sd-flaeche-wert">{m2Text(vorhandeneFlaeche)}</span>
            </div>
          )
        )}

        {art === 'gebaeude' && (
          <Input
            id={feldId('baujahr')}
            label="Baujahr"
            value={form.baujahr}
            inputMode="numeric"
            autoComplete="off"
            onChange={(e) => setze('baujahr', e.target.value)}
            error={fehler.baujahr}
          />
        )}

        <Input
          id={feldId('notiz')}
          label="Notiz"
          value={form.notiz}
          onChange={(e) => setze('notiz', e.target.value)}
          error={fehler.notiz}
        />

        <p className="vp-sd-vorspann">{zeitzoneSatz(standort.zeitzone)}</p>

        {allgemein && (
          <div className="vp-alert vp-alert-err" role="alert">
            {allgemein}
          </div>
        )}
      </form>
    </Modal>
  );
}
