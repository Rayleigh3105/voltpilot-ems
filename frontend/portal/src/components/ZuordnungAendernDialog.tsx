import { Recht } from './Recht';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  type BerichtStrukturAnlass,
  type Messstelle,
  type MessstelleRegisterZeile,
  type OrtsbaumAmStichtag,
  type StandorteAmStichtag,
} from '../api';
import { UEMS_KOSTENSTELLE } from '../glossar';
import {
  anlageOptionen,
  anlageWahlen,
  KNOPF,
  ortOptionen,
  ortWahlen,
  stellungOptionen,
  unterzaehlerOptionen,
} from '../messstelleDialog';
import {
  AENDERN_TITEL,
  aendernAblehnung,
  aendernPruefen,
  anteileSumme,
  bisherAm,
  BISHER,
  eintragenKnopf,
  folgen,
  formularAus,
  GILT_AB,
  hatAendernFehler,
  kostenstelleOptionen,
  ortAbTagAnfrage,
  prozentText,
  prozessOptionen,
  prozesseAbTagAnfrage,
  restAnteil,
  stellungAbTagAnfrage,
  unveraendertFehler,
  verteilungAbTagAnfrage,
  zeitformAm,
  type AendernArt,
  type AendernFeld,
  type AendernFormular,
  type Kataloge,
  type ZuordnungsBestand,
} from '../messstelleZuordnung';
import type { Tag } from '../uemsOrtsbaum';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import './StandortDialog.css';
import './FlaecheDialog.css';
import './ZuordnungAendernDialog.css';
import { useBerichteFolgen } from '../useBerichteFolgen';

/**
 * AP-12 IP-14 (Wege zu IP-9): welche Änderung einer Messstelle ein freigegebener Bericht als Strukturänderung liest —
 * der Ort (`ort_zugeordnet`/`ort_korrigiert`) und die Verteilung (`verteilung_geaendert` mit Korrektur). Stellung und
 * Prozesse fragen nicht.
 */
const BERICHTE_ANLASS: Partial<Record<AendernArt, BerichtStrukturAnlass>> = {
  ort: 'zuordnung_rueckwirkend',
  verteilung: 'verteilung_rueckwirkend',
};

const REIHENFOLGE: AendernFeld[] = ['ort', 'anlage', 'stellung', 'unterzaehlerVon', 'prozesse', 'anteile', 'tag'];

/**
 * „Ändern ab <Tag>“ einer Zuordnungs-Karte der Messstellen-Seite (UEMS AP-04 IP-8, Mockup Z4):
 * der neue Wert, „Gilt ab“ (`VpDatePicker`, heute vorbelegt), darunter „Bisher“ und „Was geschieht“
 * mit dem Kennzeichen „rückwirkend (n Tage)“ bzw. „geplant“ — BEVOR etwas gespeichert ist.
 *
 * Geschrieben wird über die Route, die es für den Sachverhalt gibt: `PUT …/ort`, `…/stellung`
 * (AP-04 IP-7), `…/prozesse` (AP-10 IP-7), `…/verteilung` (AP-10 IP-8). Eine Ablehnung lässt den
 * Dialog offen und nennt den Satz am Feld. Jede Entscheidung steht in `messstelleZuordnung.ts`.
 */
export function ZuordnungAendernDialog({
  art,
  messstelle,
  bestand,
  kataloge,
  standorte,
  baeume,
  register,
  heute,
  zone,
  onClose,
  onGespeichert,
}: {
  art: AendernArt;
  messstelle: Messstelle;
  bestand: ZuordnungsBestand;
  kataloge: Kataloge;
  standorte: StandorteAmStichtag | null;
  baeume: Readonly<Record<string, OrtsbaumAmStichtag | undefined>>;
  /** Das Register von heute — Hauptzähler und „Unterzähler von …“ derselben Anlage. */
  register: readonly MessstelleRegisterZeile[];
  heute: Tag;
  zone: string;
  onClose: () => void;
  onGespeichert: (art: AendernArt, tag: Tag) => void;
}) {
  const basis = `vp-za-${useId().replace(/:/g, '')}`;
  const feldId = (f: AendernFeld) => `${basis}-${f}`;
  const [form, setForm] = useState<AendernFormular>(() => formularAus(bestand, heute));
  const [versucht, setVersucht] = useState(false);
  const [server, setServer] = useState<Partial<Record<AendernFeld, string>>>({});
  const [allgemein, setAllgemein] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pruefung = useMemo(() => aendernPruefen(art, form, bestand, kataloge), [art, form, bestand, kataloge]);
  // „Nichts zu ändern“ steht sofort am Feld; Pflichtfelder erst nach dem ersten Senden.
  const fehler = versucht ? { ...pruefung, ...server } : { ...unveraendertFehler(art, form, bestand, kataloge), ...server };
  const zf = zeitformAm(form.tag, heute, zone);
  const bisher = bisherAm(art, bestand, form.tag, kataloge.namen);
  const vorher = folgen({ art, kennzeichen: messstelle.kennzeichen, f: form, b: bestand, k: kataloge, heute, zone });
  const berichteAnlass = BERICHTE_ANLASS[art] ?? null;
  const berichte = useBerichteFolgen(
    messstelle.id,
    vorher && berichteAnlass ? form.tag : null,
    berichteAnlass ?? 'zuordnung_rueckwirkend',
    'aendern',
  );

  const orte = useMemo(() => (standorte ? ortWahlen(standorte, baeume) : []), [standorte, baeume]);
  const anlagen = useMemo(() => (standorte ? anlageWahlen(standorte, null) : []), [standorte]);
  const anlage = anlagen.find((a) => a.id === form.anlage) ?? null;
  const gewaehlterOrt = orte.find((o) => o.kurzzeichen === form.ort) ?? null;

  function setze<K extends keyof AendernFormular>(feld: K, wert: AendernFormular[K]) {
    setForm((f) => ({ ...f, [feld]: wert }));
    setServer({});
    setAllgemein(null);
  }

  function fokus(feld: AendernFeld) {
    requestAnimationFrame(() => document.getElementById(feldId(feld))?.focus());
  }

  async function senden(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setVersucht(true);
    setAllgemein(null);
    if (hatAendernFehler(pruefung)) {
      const erstes = REIHENFOLGE.find((f) => pruefung[f]);
      if (erstes) fokus(erstes);
      return;
    }
    setBusy(true);
    try {
      const id = messstelle.id;
      if (art === 'ort') await api.messstelleOrtAendern(id, ortAbTagAnfrage(form, bestand));
      else if (art === 'stellung') await api.messstelleStellungAendern(id, stellungAbTagAnfrage(form, bestand));
      else if (art === 'prozesse') await api.messstelleProzesseSetzen(id, prozesseAbTagAnfrage(form));
      else await api.messstelleVerteilungSetzen(id, verteilungAbTagAnfrage(form, bestand));
      onGespeichert(art, form.tag);
    } catch (err) {
      const a = aendernAblehnung(
        art,
        err instanceof ApiError
          ? { status: err.status, message: err.message, body: err.body }
          : { message: err instanceof Error ? err.message : undefined },
        kataloge.namen.anlage,
      );
      if (a.feld) {
        setServer({ [a.feld]: a.satz });
        fokus(a.feld);
      } else {
        setAllgemein(a.satz);
      }
    } finally {
      setBusy(false);
    }
  }

  const anteil = (i: number, teil: Partial<AendernFormular['anteile'][number]>) =>
    setze(
      'anteile',
      form.anteile.map((a, j) => (j === i ? { ...a, ...teil } : a)),
    );
  const summe = anteileSumme(form.anteile);

  return (
    <Modal
      open
      onClose={onClose}
      title={AENDERN_TITEL[art]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {KNOPF.abbrechen}
          </Button>
          <Recht aktion={art === 'verteilung' ? 'messstelle.verteilung' : 'messstelle.bearbeiten'}><Button type="submit" form={`${basis}-form`} disabled={busy}>
            {busy ? KNOPF.speichert : eintragenKnopf(art, form.tag)}
          </Button></Recht>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-sd vp-za" noValidate onSubmit={(e) => void senden(e)}>
        <p className="vp-fd-name">
          {messstelle.kennzeichen} {messstelle.name}
        </p>

        {art === 'ort' && (
          <VpPicker
            id={feldId('ort')}
            label="Neuer Ort *"
            options={ortOptionen(orte)}
            value={form.ort || null}
            onChange={(v) => setze('ort', v)}
            hint={gewaehlterOrt?.pfad}
            error={fehler.ort}
          />
        )}

        {art === 'stellung' && (
          <>
            <VpPicker
              id={feldId('anlage')}
              label="Anlage *"
              options={anlageOptionen(anlagen)}
              value={form.anlage || null}
              onChange={(v) => setze('anlage', v)}
              error={fehler.anlage}
            />
            <VpPicker
              id={feldId('stellung')}
              label="Elektrische Stellung *"
              options={stellungOptionen([...register], anlage, messstelle.id)}
              value={form.stellung || null}
              onChange={(v) => setze('stellung', v as AendernFormular['stellung'])}
              error={fehler.stellung}
            />
            {form.stellung === 'Unterzähler' && (
              <VpPicker
                id={feldId('unterzaehlerVon')}
                label="Unterzähler von *"
                options={form.anlage ? unterzaehlerOptionen([...register], form.anlage, messstelle.kennzeichen) : []}
                value={form.unterzaehlerVon || null}
                onChange={(v) => setze('unterzaehlerVon', v)}
                error={fehler.unterzaehlerVon}
              />
            )}
          </>
        )}

        {art === 'prozesse' && (
          <VpPicker
            id={feldId('prozesse')}
            label="Prozesse"
            placeholder="Keinem Prozess zugeordnet"
            options={prozessOptionen(kataloge.prozesse, form.tag)}
            values={form.prozesse}
            onChangeMany={(v) => setze('prozesse', v)}
            error={fehler.prozesse}
          />
        )}

        {art === 'verteilung' && (
          <fieldset className="vp-za-anteile">
            <legend>{UEMS_KOSTENSTELLE}n</legend>
            {form.anteile.length === 0 && (
              <p className="vp-sd-vorspann">Ohne Kostenstelle ist die Messstelle ab dem Tag „nicht verteilt“.</p>
            )}
            {form.anteile.map((a, i) => (
              <div className="vp-za-anteil" key={i}>
                <div className="vp-za-anteil-ks">
                  <VpPicker
                    id={i === 0 ? feldId('anteile') : `${basis}-anteile-${i}`}
                    label={`${UEMS_KOSTENSTELLE} ${i + 1}`}
                    options={kostenstelleOptionen(kataloge.kostenstellen, form.tag)}
                    value={a.kostenstelle || null}
                    onChange={(v) => anteil(i, { kostenstelle: v })}
                  />
                </div>
                <div className="vp-za-anteil-wert">
                  <Input
                    label="Anteil (%)"
                    value={a.anteil}
                    inputMode="decimal"
                    autoComplete="off"
                    onChange={(e) => anteil(i, { anteil: e.target.value })}
                  />
                </div>
                <Button
                  variant="ghost"
                  aria-label={`${UEMS_KOSTENSTELLE} ${i + 1} entfernen`}
                  onClick={() => setze('anteile', form.anteile.filter((_, j) => j !== i))}
                >
                  {KNOPF.entfernen}
                </Button>
              </div>
            ))}
            {form.anteile.length > 0 && (
              <p className="vp-za-summe" data-testid="zuordnung-summe">
                Summe: {summe === null ? '—' : prozentText(summe)}
              </p>
            )}
            {fehler.anteile && (
              <p className="vp-za-fehler" role="alert">
                {fehler.anteile}
              </p>
            )}
            <Button
              variant="outline"
              onClick={() => setze('anteile', [...form.anteile, { kostenstelle: '', anteil: restAnteil(form.anteile) }])}
            >
              {UEMS_KOSTENSTELLE} hinzufügen
            </Button>
          </fieldset>
        )}

        <div className="vp-za-ab">
          <VpDatePicker
            id={feldId('tag')}
            label={GILT_AB}
            value={form.tag}
            onChange={(v) => setze('tag', v)}
            hint={zf?.hinweis ?? undefined}
            error={fehler.tag}
          />
        </div>

        {bisher && (
          <section className="vp-za-bisher" aria-label={BISHER}>
            <h4>{BISHER}</h4>
            <p className="vp-za-wert">{bisher.wert}</p>
            <p className="vp-za-neben">{bisher.neben}</p>
          </section>
        )}

        {vorher && (
          <section className="vp-fd-folgen" aria-live="polite" data-testid="zuordnung-folgen">
            <h4 className="vp-za-folgen-kopf">
              {vorher.titel}
              {vorher.marke && <Badge variant={zf?.art === 'rueckwirkend' ? 'warn' : 'tint'}>{vorher.marke}</Badge>}
            </h4>
            {vorher.saetze.map((s) => (
              <p key={s}>{s}</p>
            ))}
            {berichte && (
              <p data-testid="berichte-folgen">
                <strong>{berichte.titel}:</strong> {berichte.text}
              </p>
            )}
          </section>
        )}

        {allgemein && (
          <div className="vp-alert vp-alert-err" role="alert">
            {allgemein}
          </div>
        )}
      </form>
    </Modal>
  );
}
