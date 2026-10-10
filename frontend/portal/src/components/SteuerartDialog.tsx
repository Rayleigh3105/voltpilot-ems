import { Recht } from './Recht';
/**
 * Der STEUERART-DIALOG (Verbrauchsmanagement v1, Paket P2; Konzept
 * `vp-verbrauchsmgmt-konzept-v1` §6.2, Mockup „Steuerart-Dialog Schritt 1–4").
 *
 * Vier Schritte — **Quelle → Einstellungen → Ziel → Das passiert jetzt** — in
 * der Haus-Schale `AnlegenDialog`: am Rechner ein zentrierter Schritt-Dialog,
 * am Telefon eine Vollbild-Schrittfolge. Jede Regel, jeder Satz und jede
 * Vorgabe liegt in der reinen `src/steuerartDialog.ts`; hier wird NUR gerendert.
 *
 * **⚠ Er bietet nur an, was der Server auch annimmt.** Karten, Sperren und
 * Startwerte kommen aus `eintrag.optionen` (dem `SteuerartSatz` des Servers);
 * eine gesperrte Karte ist SICHTBAR und trägt ihren Grund, statt zu fehlen.
 * Denselben Zaun prüft der Schreibpfad ein zweites Mal — dem Client zu glauben
 * wäre keine Prüfung.
 *
 * **⚠ Ein Typ ohne Ziel überspringt Schritt 3**, statt eine leere Seite zu
 * zeigen; ein Typ ohne Folgefragen überspringt Schritt 2.
 */
import { useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { AnlegenDialog } from './AnlegenDialog';
import { VpPicker } from './VpPicker';
import { VpTimePicker } from './VpTimePicker';
import {
  DIALOG_TITEL,
  FRAGE_QUELLE_LADEN,
  FRAGE_QUELLE_LAUFEN,
  FRAGE_TEXT,
  FRAGE_ZIEL_LADEN,
  FRAGE_ZIEL_LAUFEN,
  SCHRITT_DETAILS,
  SCHRITT_FOLGEN,
  SCHRITT_QUELLE,
  SCHRITT_ZIEL,
  SPEICHERN,
  TAGE_WORT,
  WEITER,
  ZIEL_FRAGE,
  ZURUECK,
  entwurfAus,
  fehlt,
  mitVorbelegung,
  folgen,
  fragen,
  quellenKarten,
  wunschAus,
  zielKarten,
  type FrageId,
  type KartenView,
  type SteuerartEntwurf,
  type SteuerartWunsch,
} from '../steuerartDialog';
import type { Steuerart, VerbraucherEintrag } from '../verbraucherZone';
import { zeilenName } from '../verbraucherZone';
import './SteuerartDialog.css';

export interface SteuerartDialogProps {
  eintrag: VerbraucherEintrag;
  /** Der Anlagen-Standard — nur für den Abweichungs-Satz der Folgen-Karte. */
  standard?: Steuerart | null;
  busy?: boolean;
  /** Der Grund, warum das Speichern gerade gescheitert ist (Server-Satz). */
  fehler?: string | null;
  /**
   * Ein VORSCHLAG hat den Dialog geöffnet (§6.1): sein Wunsch belegt den
   * Entwurf vor, und der Dialog startet auf der FOLGEN-Karte — der Kunde sieht
   * zuerst, was passiert, und kann mit „Zurück" jede Antwort ändern.
   */
  vorbelegung?: SteuerartWunsch | null;
  onSpeichern: (wunsch: SteuerartWunsch) => void;
  onClose: () => void;
}

export function SteuerartDialog({
  eintrag, standard, busy = false, fehler, vorbelegung, onSpeichern, onClose,
}: SteuerartDialogProps) {
  const optionen = eintrag.optionen ?? null;
  const ladepunkt = eintrag.ladepunkt;
  const [entwurf, setEntwurf] = useState<SteuerartEntwurf>(
    () => mitVorbelegung(entwurfAus(eintrag), vorbelegung));
  const [schritt, setSchritt] = useState(vorbelegung ? Number.MAX_SAFE_INTEGER : 1);

  const quellen = useMemo(() => quellenKarten(optionen, ladepunkt), [optionen, ladepunkt]);
  const ziele = useMemo(() => zielKarten(optionen, ladepunkt), [optionen, ladepunkt]);
  const detailFragen = fragen(entwurf.quelle, ladepunkt);

  // Die Schritt-Leiste hängt am gewählten Weg: ohne Folgefragen und ohne Ziel
  // sind es zwei Schritte, nicht vier leere.
  const schritte = [SCHRITT_QUELLE];
  if (detailFragen.length > 0) schritte.push(SCHRITT_DETAILS);
  if (ziele.length > 0) schritte.push(SCHRITT_ZIEL);
  schritte.push(SCHRITT_FOLGEN);

  const aktiv = Math.min(schritt, schritte.length);
  const marke = schritte[aktiv - 1];
  const einwand = fehlt(entwurf, optionen);
  const patch = (p: Partial<SteuerartEntwurf>) => setEntwurf((e) => ({ ...e, ...p }));

  const kontext = {
    name: zeilenName(eintrag),
    ladepunkt,
    regeln: eintrag.regeln,
    standard: standard ?? null,
    zielFensterStunden: optionen?.vorgaben?.zielFensterStunden ?? null,
  };

  const weiter = () => setSchritt((s) => Math.min(s + 1, schritte.length));
  const zurueck = () => setSchritt((s) => Math.max(1, s - 1));

  return (
    <AnlegenDialog
      titel={`${DIALOG_TITEL} · ${zeilenName(eintrag)}`}
      schritte={schritte}
      aktiv={aktiv}
      onClose={onClose}
      onBack={aktiv > 1 ? zurueck : null}
      footer={(
        <div className="vp-sa-fuss">
          {aktiv > 1 && (
            <Button variant="ghost" onClick={zurueck} disabled={busy}>{ZURUECK}</Button>
          )}
          {marke === SCHRITT_FOLGEN ? (
            <Recht aktion="betriebsweise.aendern"><Button
              onClick={() => onSpeichern(wunschAus(entwurf, ladepunkt))}
              disabled={busy || einwand != null}
            >
              {SPEICHERN}
            </Button></Recht>
          ) : (
            <Button onClick={weiter} disabled={busy || (aktiv === 1 && !entwurf.quelle)}>
              {WEITER}
            </Button>
          )}
        </div>
      )}
    >
      {fehler && <p className="vp-sa-fehler" role="alert">{fehler}</p>}

      {marke === SCHRITT_QUELLE && (
        <section className="vp-sa-schritt">
          <h3>{ladepunkt ? FRAGE_QUELLE_LADEN : FRAGE_QUELLE_LAUFEN}</h3>
          <Karten
            karten={quellen}
            gewaehlt={entwurf.quelle}
            onWahl={(id) => patch({ quelle: id, ziel: '' })}
            name="steuerart-quelle"
          />
        </section>
      )}

      {marke === SCHRITT_DETAILS && (
        <section className="vp-sa-schritt">
          <h3>Wie genau?</h3>
          {detailFragen.map((f) => (
            <Frage key={f} id={f} entwurf={entwurf} patch={patch} />
          ))}
        </section>
      )}

      {marke === SCHRITT_ZIEL && (
        <section className="vp-sa-schritt">
          <h3>{ladepunkt ? FRAGE_ZIEL_LADEN : FRAGE_ZIEL_LAUFEN}</h3>
          <Karten
            karten={ziele}
            gewaehlt={entwurf.ziel}
            onWahl={(id) => patch({ ziel: id })}
            name="steuerart-ziel"
          />
          {entwurf.ziel && (
            <div className="vp-sa-felder">
              <VpTimePicker
                label={ZIEL_FRAGE.uhrzeit}
                value={entwurf.zielUhrzeit || null}
                onChange={(v) => patch({ zielUhrzeit: v })}
              />
              <VpPicker
                label={ZIEL_FRAGE.tage}
                value={entwurf.zielTage}
                onChange={(v) => patch({ zielTage: v })}
                options={Object.entries(TAGE_WORT).map(([id, label]) => ({ value: id, label }))}
              />
              {entwurf.ziel === 'bis_uhrzeit' && (
                <Input
                    label={`${ZIEL_FRAGE.energie} (kWh)`}
                  type="number"
                  min={0}
                  step={0.5}
                  value={entwurf.zielEnergieKwh ?? ''}
                  onChange={(e) => patch({ zielEnergieKwh: num(e.target.value) })}
                />
              )}
              {entwurf.ziel === 'laufzeit_bis' && (
                <>
                  <Input
                    label={`${ZIEL_FRAGE.laufzeit} (Min.)`}
                    type="number"
                    min={1}
                    value={entwurf.zielLaufzeitMinuten ?? ''}
                    onChange={(e) => patch({ zielLaufzeitMinuten: num(e.target.value) })}
                  />
                  <label className="vp-sa-check">
                    <input
                      type="checkbox"
                      checked={entwurf.zielAmStueck}
                      onChange={(e) => patch({ zielAmStueck: e.target.checked })}
                    />
                    <span>{ZIEL_FRAGE.amStueck}</span>
                  </label>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {marke === SCHRITT_FOLGEN && (
        <section className="vp-sa-schritt">
          <h3>{SCHRITT_FOLGEN}</h3>
          {einwand ? (
            <p className="vp-sa-fehler" role="alert">{einwand}</p>
          ) : (
            <ul className="vp-sa-folgen">
              {folgen(entwurf, kontext).map((satz) => <li key={satz}>{satz}</li>)}
            </ul>
          )}
        </section>
      )}
    </AnlegenDialog>
  );
}

/**
 * Die Karten-Auswahl eines Schritts. Eine GESPERRTE Karte bleibt sichtbar,
 * lässt sich nicht wählen und trägt ihren Grund — die Haus-Regel „eine
 * Handlung, die nichts bewirken kann, wird nicht angeboten; stattdessen steht
 * ihr Grund da".
 */
function Karten({ karten, gewaehlt, onWahl, name }: {
  karten: KartenView[];
  gewaehlt: string;
  onWahl: (id: string) => void;
  name: string;
}) {
  return (
    <div className="vp-sa-karten" role="radiogroup">
      {karten.map((k) => (
        <label
          key={k.id || 'kein'}
          className={`vp-sa-karte${k.gesperrt ? ' is-gesperrt' : ''}${
            gewaehlt === k.id ? ' is-gewaehlt' : ''}`}
        >
          <input
            type="radio"
            name={name}
            value={k.id}
            checked={gewaehlt === k.id}
            disabled={k.gesperrt}
            onChange={() => onWahl(k.id)}
          />
          <span className="vp-sa-karte-text">
            <b>{k.titel}</b>
            <small>{k.zeile}</small>
            {k.gesperrt && k.grund && <em className="vp-sa-grund">{k.grund}</em>}
          </span>
        </label>
      ))}
    </div>
  );
}

/** Eine Folgefrage (§3.2) — Beschriftung, Einheit und ihr ruhiger Hinweis. */
function Frage({ id, entwurf, patch }: {
  id: FrageId;
  entwurf: SteuerartEntwurf;
  patch: (p: Partial<SteuerartEntwurf>) => void;
}) {
  const t = FRAGE_TEXT[id];
  // ⚠ Die Modus-Frage ist eine WAHL, kein Zahlenfeld — und das kW-Feld erscheint
  // NUR bei „Mindestleistung halten": bei „pausieren" wäre es eine Zahl ohne
  // Wirkung, die der Kunde als Zusage lesen würde.
  if (id === 'ueberschussModus') {
    return (
      <div className="vp-sa-felder">
        <VpPicker
          label={t.label}
          value={entwurf.ueberschussModus || 'pausieren'}
          onChange={(v) => patch({ ueberschussModus: v })}
          options={[
            { value: 'pausieren', label: 'Pausieren (kein Netzstrom)' },
            { value: 'mindestleistung', label: 'Mindestleistung halten' },
          ]}
          hint={t.hinweis}
        />
        {entwurf.ueberschussModus === 'mindestleistung' && (
          <Input
            label="Mindestleistung (kW)"
            type="number"
            min={0}
            step={0.1}
            hint="So viel wird gehalten, auch wenn die Sonne nicht reicht."
            value={entwurf.mindestleistungKw ?? ''}
            onChange={(e) => patch({ mindestleistungKw: num(e.target.value) })}
          />
        )}
      </div>
    );
  }
  if (id === 'fenster') {
    return (
      <div className="vp-sa-felder">
        <VpTimePicker
          label="Von"
          value={entwurf.fensterVon || null}
          onChange={(v) => patch({ fensterVon: v })}
        />
        <VpTimePicker
          label="Bis"
          value={entwurf.fensterBis || null}
          onChange={(v) => patch({ fensterBis: v })}
        />
        <VpPicker
          label="An welchen Tagen"
          value={entwurf.fensterTage}
          onChange={(v) => patch({ fensterTage: v })}
          options={Object.entries(TAGE_WORT).map(([wert, label]) => ({ value: wert, label }))}
        />
      </div>
    );
  }
  const wert = id === 'schwelle' ? entwurf.schwelleKw
    : id === 'preisgrenze' ? entwurf.preisgrenzeCtKwh
      : id === 'mindestlaufzeit' ? entwurf.mindestlaufzeitMinuten
        : entwurf.sperrzeitMinuten;
  const setze = (v: number | null) => patch(
    id === 'schwelle' ? { schwelleKw: v }
      : id === 'preisgrenze' ? { preisgrenzeCtKwh: v }
        : id === 'mindestlaufzeit' ? { mindestlaufzeitMinuten: v }
          : { sperrzeitMinuten: v },
  );
  return (
    <div className="vp-sa-felder">
      <Input
        label={t.einheit ? `${t.label} (${t.einheit})` : t.label}
        type="number"
        min={0}
        step={id === 'schwelle' || id === 'preisgrenze' ? 0.1 : 1}
        hint={t.hinweis}
        value={wert ?? ''}
        onChange={(e) => setze(num(e.target.value))}
      />
    </div>
  );
}

function num(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
