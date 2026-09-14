/**
 * „Ändern ab <Zeitpunkt>“ — eine Einstellung eines Geräts ab einem Zeitpunkt
 * (UEMS AP-04 IP-12, §5.7, Mockup W1). Zentriertes Modal wie jede
 * Aufgabenfläche; die Felder, die Prüfung und die Folgen-Karte kommen aus
 * `geraetEinstellungen.ts`, das den Vertrags-Zwilling `uemsEinstellung.ts`
 * aufruft — der Dialog rendert nur.
 *
 * ⚠ Die Folgen-Karte steht VOR dem Eintragen und sagt, was bleibt: kein
 * gespeicherter Wert ändert sich, und ein falsch erfasster Zeitraum wird über
 * eine Korrektur berichtigt. Es gibt deshalb keinen Knopf „neu berechnen“.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type EinstellungEingetragen, type EinstellungFassung } from '../api';
import {
  aenderungPruefen,
  ANWENDUNG_WAHL,
  eintragenText,
  felderAusWert,
  jetztEingabe,
  WERT_FELDER,
  type AenderungEingabe,
  type AenderungFeld,
} from '../geraetEinstellungen';
import { ARTEN, gueltigZu, type AnwendungsArt, type ArtCode } from '../uemsEinstellung';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import { VpTimePicker } from './VpTimePicker';

/** Was geändert wird: Art (oder `null` = der Kunde wählt sie) und Quelle. */
export interface AenderungZiel {
  art: string | null;
  entityId: string | null;
  kanal: string | null;
  /** „Wandlerverhältnis Strom · Messwert Leistung“ — steht unter dem Titel. */
  bezug: string | null;
}

const FELD_ID: Record<AenderungFeld, string> = {
  wert: 'vp-einst-wert',
  gueltig_ab: 'vp-einst-ab',
  tatsaechlich_ab: 'vp-einst-tatsaechlich',
};

export function EinstellungAendernDialog({
  geraetId,
  ziel,
  historie,
  beginn,
  jetzt,
  onClose,
  onEingetragen,
}: {
  geraetId: string;
  ziel: AenderungZiel | null;
  historie: readonly EinstellungFassung[];
  /** Der Einbau des Geräts — früher kann keine Fassung beginnen. */
  beginn: string;
  jetzt: string;
  onClose: () => void;
  onEingetragen: (e: EinstellungEingetragen) => void;
}) {
  const [eingabe, setEingabe] = useState<AenderungEingabe | null>(null);
  const [versucht, setVersucht] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverFehler, setServerFehler] = useState<string | null>(null);

  // Vorbelegt mit dem Wert, der JETZT gilt, und mit „jetzt“ auf die Minute.
  useEffect(() => {
    if (!ziel) {
      setEingabe(null);
      return;
    }
    const art = ziel.art ?? ARTEN[0].art;
    const jetztGilt = gueltigZu(
      historie
        .filter((f) => f.art === art && f.entity_id === ziel.entityId && f.kanal === ziel.kanal)
        .map((f) => ({ id: f.id, wert: f.wert, anwendung: f.anwendung, gueltigAb: f.gueltig_ab, gueltigBis: f.gueltig_bis })),
      jetzt,
    );
    const { datum, uhrzeit } = jetztEingabe(jetzt);
    setEingabe({
      art,
      entityId: ziel.entityId,
      kanal: ziel.kanal,
      felder: felderAusWert(art, jetztGilt?.wert ?? null),
      anwendung: jetztGilt?.anwendung ?? 'dokumentiert',
      datum,
      uhrzeit,
      frueher: false,
      tatsaechlichDatum: datum,
      tatsaechlichUhrzeit: '00:00',
      begruendung: '',
    });
    setVersucht(false);
    setServerFehler(null);
    setBusy(false);
    // Nur beim Öffnen vorbelegen — nicht bei jeder neuen Uhrzeit der Seite.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ziel]);

  const urteil = useMemo(
    () => (eingabe ? aenderungPruefen(eingabe, historie, beginn, jetzt) : null),
    [eingabe, historie, beginn, jetzt],
  );

  if (!ziel || !eingabe || !urteil) return null;
  const patch = (p: Partial<AenderungEingabe>) => setEingabe({ ...eingabe, ...p });
  const fehler = versucht ? urteil.fehler : {};
  const felder = WERT_FELDER[eingabe.art as ArtCode] ?? [];

  async function eintragen() {
    if (!eingabe || !urteil) return;
    setVersucht(true);
    setServerFehler(null);
    if (!urteil.neu) {
      const erstes = (['wert', 'gueltig_ab', 'tatsaechlich_ab'] as AenderungFeld[]).find((f) => urteil.fehler[f]);
      if (erstes) document.getElementById(FELD_ID[erstes])?.focus();
      return;
    }
    setBusy(true);
    try {
      onEingetragen(await api.geraetEinstellungEintragen(geraetId, urteil.neu));
    } catch (e) {
      setServerFehler(e instanceof ApiError || e instanceof Error ? e.message : 'Die Einstellung konnte nicht eingetragen werden.');
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={ziel.art ? 'Einstellung ändern' : 'Einstellung eintragen'}
      icon={<Icon name="sliders" size={20} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button onClick={() => void eintragen()} disabled={busy}>
            {busy ? 'Trage ein …' : eintragenText(eingabe.datum, eingabe.uhrzeit)}
          </Button>
        </>
      }
    >
      <div className="vp-form-stack vp-einst" data-testid="einstellung-aendern">
        {ziel.bezug && <p className="vp-note">{ziel.bezug}</p>}
        {ziel.art === null && (
          <VpPicker
            label="Einstellung"
            value={eingabe.art}
            onChange={(art) => patch({ art, felder: felderAusWert(art, null) })}
            options={ARTEN.map((a) => ({ value: a.art, label: a.kundenwort }))}
          />
        )}

        <fieldset className="vp-einst-wert">
          <legend>
            Neuer Wert
            {urteil.bisher && <span className="vp-einst-bisher">bisher {urteil.bisher}</span>}
          </legend>
          <div className="vp-einst-felder">
            {felder.map((f, i) =>
              f.typ === 'janein' ? (
                <VpPicker
                  key={f.feld}
                  id={i === 0 ? FELD_ID.wert : undefined}
                  label={f.label}
                  value={eingabe.felder[f.feld] ?? 'nein'}
                  onChange={(v) => patch({ felder: { ...eingabe.felder, [f.feld]: v } })}
                  options={[
                    { value: 'nein', label: 'nein' },
                    { value: 'ja', label: 'ja' },
                  ]}
                />
              ) : (
                <Input
                  key={f.feld}
                  id={i === 0 ? FELD_ID.wert : undefined}
                  label={f.einheit ? `${f.label} (${f.einheit})` : f.label}
                  inputMode={f.typ === 'zahl' ? 'decimal' : undefined}
                  value={eingabe.felder[f.feld] ?? ''}
                  onChange={(ev) => patch({ felder: { ...eingabe.felder, [f.feld]: ev.target.value } })}
                />
              ),
            )}
          </div>
          {fehler.wert && (
            <p className="vp-einst-fehler" role="alert">
              {fehler.wert}
            </p>
          )}
        </fieldset>

        <fieldset className="vp-einst-wahl">
          <legend>Wer rechnet damit?</legend>
          <div className="vp-einst-karten" role="radiogroup">
            {ANWENDUNG_WAHL.map((w) => (
              <label key={w.id} className={`vp-einst-karte${eingabe.anwendung === w.id ? ' is-gewaehlt' : ''}`}>
                <input
                  type="radio"
                  name="einstellung-wirkung"
                  value={w.id}
                  checked={eingabe.anwendung === w.id}
                  onChange={() => patch({ anwendung: w.id as AnwendungsArt })}
                />
                <span>
                  <b>{w.titel}</b>
                  <small>{w.zeile}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="vp-einst-zeit">
          <legend>Gilt ab</legend>
          <div className="vp-einst-felder">
            <VpDatePicker
              id={FELD_ID.gueltig_ab}
              label="Datum"
              value={eingabe.datum}
              onChange={(datum) => patch({ datum })}
            />
            <VpTimePicker label="Uhrzeit" value={eingabe.uhrzeit} onChange={(uhrzeit) => patch({ uhrzeit })} />
          </div>
          {fehler.gueltig_ab && (
            <p className="vp-einst-fehler" role="alert">
              {fehler.gueltig_ab}
            </p>
          )}
          <label className="vp-einst-check">
            <input type="checkbox" checked={eingabe.frueher} onChange={(ev) => patch({ frueher: ev.target.checked })} />
            <span>Die Änderung am Gerät geschah schon früher</span>
          </label>
          {eingabe.frueher && (
            <div className="vp-einst-felder">
              <VpDatePicker
                id={FELD_ID.tatsaechlich_ab}
                label="Tatsächlich am"
                value={eingabe.tatsaechlichDatum}
                onChange={(tatsaechlichDatum) => patch({ tatsaechlichDatum })}
              />
              <VpTimePicker
                label="Uhrzeit"
                value={eingabe.tatsaechlichUhrzeit}
                onChange={(tatsaechlichUhrzeit) => patch({ tatsaechlichUhrzeit })}
              />
            </div>
          )}
          {fehler.tatsaechlich_ab && (
            <p className="vp-einst-fehler" role="alert">
              {fehler.tatsaechlich_ab}
            </p>
          )}
        </fieldset>

        <Input
          label="Begründung (optional)"
          value={eingabe.begruendung}
          maxLength={500}
          onChange={(ev) => patch({ begruendung: ev.target.value })}
        />

        {urteil.folgen.length > 0 && (
          <section className="vp-einst-folgen" aria-label="Was geschieht" data-testid="einstellung-folgen">
            <h4>Was geschieht</h4>
            <ul>
              {urteil.folgen.map((satz) => (
                <li key={satz}>{satz}</li>
              ))}
            </ul>
          </section>
        )}
        {serverFehler && (
          <div className="vp-alert vp-alert-err" role="alert">
            {serverFehler}
          </div>
        )}
      </div>
    </Modal>
  );
}
