import { useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  type Einspeiseart,
  type Erzeugungsanlage,
  type ErzeugungsanlageArt,
  type Erzeugungsanlagen,
  type ErzeugungsanlageVorschlag,
  type MastrPreview,
} from '../api';
import { validateSeeNummer } from '../anlageFlow';
import { STICHTAG_FRAGE, STICHTAG_WAHL, tagText } from '../einspeiseverguetung';
import * as E from '../erzeugungsanlagen';
import { fmtNum } from '../format';
import { PreviewCard } from './MastrDrawer';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import './Erzeugungsanlagen.css';

const SPEICHER_FEHLER = 'Die Erzeugungsanlage wurde nicht gespeichert. Bitte versuchen Sie es erneut.';
type Gilt = 'korrektur' | 'ab';

/**
 * Eine Erzeugungsanlage anlegen oder bearbeiten (Messkonzepte S1, nur Anzeige). Der Weg über das
 * Marktstammdatenregister ist derselbe wie beim Verknüpfen der Anlage: SEE-Nummer, Nachschlagen, Vorschau,
 * bestätigen - die bestätigten Werte füllen Inbetriebnahme und Leistung und reisen mit ihrer Herkunft zum Server.
 *
 * Folgt EA 1 der Anlage, kommen Leistung, Inbetriebnahme, MaStR-Nummer und eigener Satz aus der Anlage: diese
 * Felder stehen nur zur Ansicht da, frei sind Name, Art und Einspeiseart. Eine Änderung an Leistung,
 * Einspeiseart oder eigenem Satz wird eine Fassung - als Korrektur der laufenden oder ab einem Tag.
 */
export function ErzeugungsanlageDialog({
  siteId,
  ea,
  vorschlag,
  heute,
  ersteFolgt,
  onClose,
  onGespeichert,
}: {
  siteId: string;
  /** null = neu anlegen. */
  ea: Erzeugungsanlage | null;
  /** Neu aus einem Vorschlag: Name, Leistung, MaStR-Nummer und Komponente stehen vorne. */
  vorschlag?: ErzeugungsanlageVorschlag | null;
  heute: string;
  /** Folgt EA 1 heute der Anlage? Dann löst die neue EA sie davon - das Blatt sagt es vorher. */
  ersteFolgt?: Erzeugungsanlage | null;
  onClose: () => void;
  onGespeichert: (liste: Erzeugungsanlagen) => void;
}) {
  const folgt = ea?.folgtAnlage ?? false;
  const [e, setE] = useState<E.Entwurf>(() =>
    ea
      ? E.entwurfAus(ea)
      : {
          ...E.LEER,
          name: vorschlag?.name ?? '',
          leistung: vorschlag ? String(vorschlag.leistungKwp).replace('.', ',') : '',
          see: vorschlag?.registryUnitId ?? '',
        },
  );
  const [ab51a, setAb51a] = useState<boolean | null>(ea?.inbetriebnahmeAbSolarspitzengesetz ?? null);
  const [gilt, setGilt] = useState<Gilt>('korrektur');
  const [giltAb, setGiltAb] = useState(heute);
  const [vorschau, setVorschau] = useState<MastrPreview | null>(null);
  const [bestaetigt, setBestaetigt] = useState<MastrPreview | null>(null);
  const [fehler, setFehler] = useState<E.Pruefung | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entfernen, setEntfernen] = useState(false);
  const felder = {
    name: useRef<HTMLInputElement>(null),
    leistung: useRef<HTMLInputElement>(null),
    satz: useRef<HTMLInputElement>(null),
    see: useRef<HTMLInputElement>(null),
    inbetriebnahme: useRef<HTMLInputElement>(null),
  };

  const setze = (teil: Partial<E.Entwurf>) => {
    setE((alt) => ({ ...alt, ...teil }));
    setFehler(null);
    setMeldung(null);
  };
  const seeHinweis = e.see.trim() ? validateSeeNummer(e.see) : null;

  async function nachschlagen() {
    const see = E.seeAus(e.see);
    if (!see || seeHinweis) {
      setFehler({ feld: 'see', text: seeHinweis ?? 'Bitte geben Sie die SEE-Nummer an.' });
      felder.see.current?.focus();
      return;
    }
    setBusy(true);
    setMeldung(null);
    try {
      const p = await api.mastrLookup(siteId, see);
      if (p.kind !== 'pv') {
        setMeldung('Diese Nummer gehört zu einem Speicher. Eine Erzeugungsanlage hat eine eigene SEE-Nummer.');
        return;
      }
      setVorschau(p);
    } catch (err) {
      setMeldung(
        err instanceof ApiError ? err.message : 'Die Registerabfrage ist fehlgeschlagen. Bitte versuchen Sie es später erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  function uebernehmen(p: MastrPreview) {
    setE((alt) => ({
      ...alt,
      see: p.mastrNummer,
      inbetriebnahme: p.commissionedOn ?? alt.inbetriebnahme,
      leistung: p.powerKw != null ? String(p.powerKw).replace('.', ',') : alt.leistung,
      name: alt.name || p.name || '',
    }));
    setBestaetigt(p);
    setVorschau(null);
  }

  /** Bestätigte Registerwerte zählen nur, solange niemand Leistung oder Inbetriebnahme danach geändert hat. */
  function ausDemRegister(): boolean {
    if (!bestaetigt) return false;
    return (
      E.seeAus(e.see) === bestaetigt.mastrNummer &&
      (bestaetigt.commissionedOn ?? '') === e.inbetriebnahme &&
      (bestaetigt.powerKw == null || E.leistungAus(e.leistung) === bestaetigt.powerKw)
    );
  }

  async function speichern() {
    const p = E.pruefe(e, heute);
    if (p) {
      setFehler(p);
      felder[p.feld].current?.focus();
      return;
    }
    const leistung = E.leistungAus(e.leistung) ?? null;
    const satz = E.satzAus(e.satz) ?? null;
    const see = E.seeAus(e.see);
    const einspeiseart: Einspeiseart | null = e.einspeiseart === '' ? null : e.einspeiseart;
    const name = e.name.trim() || null;
    const inbetriebnahme = e.inbetriebnahme || null;
    const antwort = inbetriebnahme ? null : ab51a;
    const mastr = ausDemRegister();
    setBusy(true);
    setMeldung(null);
    try {
      let liste: Erzeugungsanlagen | null = null;
      if (!ea) {
        liste = await api.erzeugungsanlageAnlegen(siteId, {
          name,
          art: e.art,
          inbetriebnahme,
          inbetriebnahmeAbSolarspitzengesetz: antwort,
          registryUnitId: see,
          mastrBestaetigt: mastr,
          leistungKwp: leistung,
          einspeiseart,
          satzAngegebenCtKwh: satz,
          komponenteId: vorschlag?.komponenteId ?? null,
          eingang: null,
        });
      } else {
        const identitaetGeaendert =
          name !== ea.name ||
          e.art !== ea.art ||
          inbetriebnahme !== ea.inbetriebnahme ||
          antwort !== ea.inbetriebnahmeAbSolarspitzengesetz ||
          see !== ea.registryUnitId ||
          mastr;
        if (identitaetGeaendert) {
          liste = await api.erzeugungsanlageBearbeiten(siteId, ea.id, {
            name,
            art: e.art,
            inbetriebnahme,
            inbetriebnahmeAbSolarspitzengesetz: antwort,
            registryUnitId: see,
            mastrBestaetigt: mastr,
          });
        }
        const f = ea.fassung;
        const fassungGeaendert =
          leistung !== (f?.leistungKwp ?? null) ||
          einspeiseart !== (f?.einspeiseart ?? null) ||
          satz !== (f?.satzAngegebenCtKwh ?? null);
        if (fassungGeaendert) {
          liste = await api.erzeugungsanlageFassung(siteId, ea.id, {
            gueltigAb: gilt === 'korrektur' || folgt ? (f?.gueltigAb ?? null) : giltAb,
            leistungKwp: leistung,
            einspeiseart,
            satzAngegebenCtKwh: satz,
            mastrBestaetigt: mastr,
          });
        }
        if (!liste) {
          onClose();
          return;
        }
      }
      onGespeichert(liste);
    } catch (err) {
      setMeldung(err instanceof ApiError ? err.message : SPEICHER_FEHLER);
    } finally {
      setBusy(false);
    }
  }

  async function aufheben() {
    if (!ea) return;
    setBusy(true);
    setMeldung(null);
    try {
      onGespeichert(await api.erzeugungsanlageAufheben(siteId, ea.id));
    } catch (err) {
      setMeldung(err instanceof ApiError ? err.message : SPEICHER_FEHLER);
    } finally {
      setBusy(false);
    }
  }

  const fassungGeaendert =
    ea != null &&
    (E.leistungAus(e.leistung) !== (ea.fassung?.leistungKwp ?? null) ||
      (e.einspeiseart || null) !== (ea.fassung?.einspeiseart ?? null) ||
      E.satzAus(e.satz) !== (ea.fassung?.satzAngegebenCtKwh ?? null));

  return (
    <Modal
      open
      title={ea ? `${ea.bezeichnung} bearbeiten` : E.HINZUFUEGEN}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        vorschau ? (
          <>
            <Button variant="ghost" onClick={() => setVorschau(null)} disabled={busy}>
              Zurück
            </Button>
            <Button variant="primary" onClick={() => uebernehmen(vorschau)} disabled={busy}>
              Werte übernehmen
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Abbrechen
            </Button>
            <Button variant="primary" onClick={() => void speichern()} disabled={busy}>
              {busy ? 'Wird gespeichert…' : 'Speichern'}
            </Button>
          </>
        )
      }
    >
      {vorschau ? (
        <div className="vp-ea-form">
          <p className="vp-note">
            Gefunden im Marktstammdatenregister - bitte prüfen Sie, ob das diese Erzeugungsanlage ist. Erst „Speichern“
            schreibt die Werte.
          </p>
          <PreviewCard preview={vorschau} />
        </div>
      ) : (
        <form
          className="vp-ea-form"
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void speichern();
          }}
        >
          {!ea && ersteFolgt && (
            <p className="vp-note" data-testid="ea-erste-folgt">
              Bisher übernimmt {ersteFolgt.bezeichnung} die PV-Leistung Ihrer Anlage
              {ersteFolgt.fassung?.leistungKwp != null ? ` (${fmtNum(ersteFolgt.fassung.leistungKwp, 'kWp', 1)})` : ''}. Mit
              einer zweiten Erzeugungsanlage pflegen Sie beide selbst - prüfen Sie danach die Leistung von{' '}
              {ersteFolgt.bezeichnung}.
            </p>
          )}
          {folgt && <p className="vp-note">{E.FOLGT_ANLAGE}</p>}
          <Input
            ref={felder.name}
            id="ea-name"
            label="Name (freiwillig)"
            placeholder="z. B. PV Scheune"
            value={e.name}
            error={fehler?.feld === 'name' ? fehler.text : undefined}
            onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setze({ name: ev.target.value })}
          />
          <VpPicker
            id="ea-art"
            label="Art"
            value={e.art}
            options={(Object.keys(E.ART) as ErzeugungsanlageArt[]).map((a) => ({ value: a, label: E.ART[a] }))}
            onChange={(v) => setze({ art: v as ErzeugungsanlageArt })}
            disabled={busy}
          />
          <div className="vp-ea-see">
            <Input
              ref={felder.see}
              id="ea-see"
              label="MaStR-Nummer der Einheit"
              placeholder="SEE…"
              value={e.see}
              disabled={folgt}
              error={fehler?.feld === 'see' ? fehler.text : seeHinweis ?? undefined}
              onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setze({ see: ev.target.value })}
            />
            {!folgt && (
              <Button variant="outline" size="sm" onClick={() => void nachschlagen()} disabled={busy || !e.see.trim()}>
                Im Register nachschlagen
              </Button>
            )}
          </div>
          {bestaetigt && ausDemRegister() && (
            <p className="vp-note">Inbetriebnahme und Leistung aus dem Marktstammdatenregister übernommen.</p>
          )}
          <VpDatePicker
            id="ea-inbetriebnahme"
            label="Inbetriebnahme"
            value={e.inbetriebnahme || null}
            max={heute}
            heute={heute}
            placeholder={E.NICHT_ERHOBEN}
            disabled={folgt || busy}
            error={fehler?.feld === 'inbetriebnahme' ? fehler.text : undefined}
            onChange={(v) => setze({ inbetriebnahme: v })}
          />
          {!e.inbetriebnahme && !folgt && (
            <VpPicker
              id="ea-stichtag"
              label={STICHTAG_FRAGE}
              value={ab51a == null ? 'offen' : ab51a ? 'ab' : 'vor'}
              options={[
                { value: 'offen', label: 'nicht angegeben' },
                { value: 'vor', label: STICHTAG_WAHL.vor.label },
                { value: 'ab', label: STICHTAG_WAHL.ab.label },
              ]}
              onChange={(v) => setAb51a(v === 'offen' ? null : v === 'ab')}
              disabled={busy}
            />
          )}
          <Input
            ref={felder.leistung}
            id="ea-leistung"
            label="Leistung (kWp)"
            placeholder={E.NICHT_ERHOBEN}
            inputMode="decimal"
            value={e.leistung}
            disabled={folgt}
            error={fehler?.feld === 'leistung' ? fehler.text : undefined}
            onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setze({ leistung: ev.target.value })}
          />
          <VpPicker
            id="ea-einspeiseart"
            label="Einspeiseart"
            value={e.einspeiseart || 'offen'}
            options={[
              { value: 'offen', label: E.NICHT_ERHOBEN },
              { value: 'ueberschuss', label: E.EINSPEISEART.ueberschuss },
              { value: 'voll', label: E.EINSPEISEART.voll },
            ]}
            onChange={(v) => setze({ einspeiseart: v === 'offen' ? '' : (v as Einspeiseart) })}
            disabled={busy}
          />
          <Input
            ref={felder.satz}
            id="ea-satz"
            label="Eigener Satz (ct/kWh, freiwillig)"
            placeholder="aus dem EEG herleiten"
            inputMode="decimal"
            value={e.satz}
            disabled={folgt}
            hint="z. B. bei Volleinspeisung, Altanlage oder Sondervertrag"
            error={fehler?.feld === 'satz' ? fehler.text : undefined}
            onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setze({ satz: ev.target.value })}
          />
          {ea && !folgt && fassungGeaendert && (
            <div className="vp-ea-gilt">
              <VpPicker
                id="ea-gilt"
                label="Die Änderung gilt"
                value={gilt}
                options={[
                  {
                    value: 'korrektur',
                    label: ea.fassung?.gueltigAb
                      ? `als Korrektur der Fassung ab ${tagText(ea.fassung.gueltigAb)}`
                      : 'als Korrektur, von der Inbetriebnahme an',
                  },
                  { value: 'ab', label: 'ab einem Tag (z. B. Erweiterung, Ende der Förderung)' },
                ]}
                onChange={(v) => setGilt(v as Gilt)}
                disabled={busy}
              />
              {gilt === 'ab' && (
                <VpDatePicker
                  id="ea-gilt-ab"
                  label="Gilt ab"
                  value={giltAb}
                  min={ea.inbetriebnahme}
                  heute={heute}
                  onChange={setGiltAb}
                  disabled={busy}
                />
              )}
            </div>
          )}
          {meldung && (
            <div className="vp-alert vp-alert-err" role="alert">
              {meldung}
            </div>
          )}
          {ea && !folgt && (
            <div className="vp-ea-entfernen">
              {entfernen ? (
                <>
                  <span className="vp-note">
                    {ea.bezeichnung} wird entfernt; die Nummer {ea.nummer} wird nicht wieder vergeben.
                  </span>
                  <Button variant="outline" size="sm" onClick={() => void aufheben()} disabled={busy}>
                    Wirklich entfernen
                  </Button>
                </>
              ) : (
                <button type="button" className="vp-linklike" onClick={() => setEntfernen(true)} disabled={busy}>
                  Versehentlich angelegt? Erzeugungsanlage entfernen
                </button>
              )}
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}
