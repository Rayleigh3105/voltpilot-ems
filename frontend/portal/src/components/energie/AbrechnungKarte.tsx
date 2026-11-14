/**
 * **Abrechnung prüfen** — die Karte direkt unter der Statuszeile von Verlauf › Energie, wenn der Abschnitt
 * „Zeitraum“ gewählt ist (Bedienkonzept `vp-privatkunde-bedienkonzept` §7.1, Variante A; BK-9/BK-10 = A).
 *
 * Am Rechner eine kleine Tabelle (Gemessen · Laut Rechnung · Unterschied), am Telefon dieselben Angaben
 * untereinander. Unter jeder Menge grau, woraus sie entsteht (Zählerstand oder „aus Messwerten summiert“). Die
 * Zahl von der Rechnung wird beim Verlassen des Felds gespeichert; ein leeres Feld löscht sie. „Frühere
 * Prüfungen“ öffnet die gemerkten Zeiträume — einer setzt den Zeitraum der Seite.
 *
 * Alle Ableitungen wohnen im reinen `abrechnungPruefen.ts`; hier wird nur gezeichnet und gespeichert.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Input } from '../../../designsystem/components/forms/Input';
import { api, ApiError, type Abrechnung, type AbrechnungPruefung } from '../../api';
import {
  abrechnungKarte,
  eingabeText,
  eingabeWert,
  fruehereZeile,
  WORT,
  type Richtung,
  type Zeitraum,
} from '../../abrechnungPruefen';
import { useRollen } from '../../rollen';
import { useIsPhone } from '../../useIsPhone';
import { VerlaufFehler, VerlaufKarteSkeleton } from '../States';
import { VrKarte } from '../VerlaufRahmen';
import './AbrechnungKarte.css';

/** Das Recht, die Zahlen von der Rechnung zu schreiben (wie eine eigene Auswertung der Anlage). */
const SCHREIBRECHT = 'auswertung.anlegen';

type Felder = Record<Richtung, string>;

function felderAus(p: AbrechnungPruefung | null | undefined): Felder {
  return { bezug: eingabeText(p?.bezugKwh), einspeisung: eingabeText(p?.einspeisungKwh) };
}

export function AbrechnungKarte({
  siteId,
  zeitraum,
  onZeitraum,
}: {
  siteId: string;
  zeitraum: Zeitraum;
  onZeitraum: (z: Zeitraum) => void;
}) {
  const isPhone = useIsPhone();
  const rollen = useRollen();
  const darfSchreiben = rollen.darf(SCHREIBRECHT, rollen.standort);
  const id = useId();

  const [daten, setDaten] = useState<Abrechnung | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laden, setLaden] = useState(0);
  const [felder, setFelder] = useState<Felder>({ bezug: '', einspeisung: '' });
  const [gespeichert, setGespeichert] = useState<Felder>({ bezug: '', einspeisung: '' });
  const [feldFehler, setFeldFehler] = useState<Partial<Record<Richtung, string>>>({});
  const [speichert, setSpeichert] = useState(false);
  const [fruehere, setFruehere] = useState<AbrechnungPruefung[] | null>(null);
  const [fruehereOffen, setFruehereOffen] = useState(false);

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api
      .abrechnung(siteId, zeitraum.von, zeitraum.bis)
      .then((a) => {
        if (!aktiv) return;
        setDaten(a);
        const f = felderAus(a.rechnung);
        setFelder(f);
        setGespeichert(f);
        setFeldFehler({});
      })
      .catch((e) => {
        if (aktiv) setFehler(e instanceof ApiError ? e.message : 'Fehler');
      });
    return () => {
      aktiv = false;
    };
  }, [siteId, zeitraum.von, zeitraum.bis, laden]);

  const ladeFruehere = useCallback(() => {
    api
      .abrechnungPruefungen(siteId)
      .then(setFruehere)
      .catch(() => setFruehere([]));
  }, [siteId]);
  useEffect(() => {
    ladeFruehere();
  }, [ladeFruehere]);

  const speichern = useCallback(
    async (richtung: Richtung) => {
      if (felder[richtung] === gespeichert[richtung]) return;
      const bezug = eingabeWert(felder.bezug);
      const einspeisung = eingabeWert(felder.einspeisung);
      const wert = richtung === 'bezug' ? bezug : einspeisung;
      if (wert === 'ungueltig') {
        setFeldFehler((f) => ({ ...f, [richtung]: 'Bitte eine Zahl in kWh eintragen, z. B. 5.131.' }));
        return;
      }
      setFeldFehler((f) => ({ ...f, [richtung]: undefined }));
      // Das andere Feld zählt mit seinem GESPEICHERTEN Stand: ein halb getipptes Nachbarfeld wird nicht mitgesendet.
      const andere = eingabeWert(gespeichert[richtung === 'bezug' ? 'einspeisung' : 'bezug']);
      const andereWert = andere === 'ungueltig' ? null : andere;
      setSpeichert(true);
      try {
        await api.abrechnungPruefungSpeichern(siteId, zeitraum.von, zeitraum.bis, {
          bezugKwh: richtung === 'bezug' ? wert : andereWert,
          einspeisungKwh: richtung === 'einspeisung' ? wert : andereWert,
        });
        setGespeichert((g) => ({ ...g, [richtung]: felder[richtung] }));
        ladeFruehere();
      } catch (e) {
        setFeldFehler((f) => ({
          ...f,
          [richtung]: e instanceof ApiError ? e.message : 'Die Zahl konnte nicht gespeichert werden.',
        }));
      } finally {
        setSpeichert(false);
      }
    },
    [felder, gespeichert, siteId, zeitraum.von, zeitraum.bis, ladeFruehere],
  );

  const andereFruehere = (fruehere ?? []).filter((p) => p.von !== zeitraum.von || p.bis !== zeitraum.bis);
  const aktionen =
    andereFruehere.length > 0 ? (
      <button
        type="button"
        className="vp-vr-textbtn vp-ab-fruehere-knopf"
        aria-expanded={fruehereOffen}
        aria-controls={`${id}-fruehere`}
        onClick={() => setFruehereOffen((o) => !o)}
      >
        {WORT.fruehere}
      </button>
    ) : null;

  if (fehler && !daten) {
    return (
      <VrKarte titel={WORT.titel} className="vp-ab-karte">
        <VerlaufFehler satz={`Die Mengen konnten nicht geladen werden (${fehler}).`} onRetry={() => setLaden((n) => n + 1)} />
      </VrKarte>
    );
  }
  if (!daten || daten.von !== zeitraum.von || daten.bis !== zeitraum.bis) {
    return (
      <VrKarte titel={WORT.titel} sub={null} className="vp-ab-karte">
        <VerlaufKarteSkeleton />
      </VrKarte>
    );
  }

  const rechnung = {
    bezug: ((v) => (v === 'ungueltig' ? null : v))(eingabeWert(gespeichert.bezug)),
    einspeisung: ((v) => (v === 'ungueltig' ? null : v))(eingabeWert(gespeichert.einspeisung)),
  };
  const view = abrechnungKarte(daten, rechnung);

  const feld = (richtung: Richtung, label: string) => {
    const fid = `${id}-${richtung}`;
    const f = feldFehler[richtung];
    if (!darfSchreiben) {
      return <span className="vp-ab-wert-lesend">{felder[richtung] ? `${felder[richtung]} kWh` : '–'}</span>;
    }
    return (
      <span className="vp-ab-eingabe">
        <Input
          id={fid}
          className="vp-ab-input"
          // Das Haus-Feld ist breit wie seine Spalte; hier ist es ein kurzes Zahlenfeld (Foto r-a: 96 bzw. 120 px).
          style={{
            width: isPhone ? 120 : 96,
            minHeight: 44,
            padding: '0.5rem 0.75rem',
            textAlign: 'right',
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
          }}
          inputMode="decimal"
          placeholder={WORT.eintragen}
          aria-label={`${label} laut Rechnung in kWh`}
          aria-invalid={f ? true : undefined}
          aria-describedby={f ? `${fid}-fehler` : undefined}
          value={felder[richtung]}
          onChange={(e) => setFelder((x) => ({ ...x, [richtung]: e.target.value }))}
          onBlur={() => void speichern(richtung)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <span className="vp-ab-einheit" aria-hidden="true">
          kWh
        </span>
      </span>
    );
  };

  return (
    <VrKarte
      titel={WORT.titel}
      sub={view.zeitraum}
      aktionen={aktionen}
      className={`vp-ab-karte${isPhone ? ' is-telefon' : ''}`}
    >
      {fruehereOffen && andereFruehere.length > 0 && (
        <ul className="vp-ab-fruehere" id={`${id}-fruehere`} aria-label={WORT.fruehere}>
          {andereFruehere.map((p) => (
            <li key={`${p.von}-${p.bis}`}>
              <button
                type="button"
                onClick={() => {
                  setFruehereOffen(false);
                  onZeitraum({ von: p.von, bis: p.bis });
                }}
              >
                {fruehereZeile(p)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className="vp-ab-tabelle"
        role="table"
        aria-label={`${WORT.titel} ${view.zeitraum}`}
        aria-busy={speichert || undefined}
      >
        {!isPhone && (
          <div className="vp-ab-zeile vp-ab-kopf" role="row">
            <span role="columnheader" className="vp-ab-c-name">
              <span className="vp-sr-only">Menge</span>
            </span>
            <span role="columnheader" className="vp-ab-c-zahl">
              {WORT.gemessen}
            </span>
            <span role="columnheader" className="vp-ab-c-rechnung">
              {WORT.lautRechnung}
            </span>
            <span role="columnheader" className="vp-ab-c-zahl">
              {WORT.unterschied}
            </span>
          </div>
        )}
        {view.zeilen.map((z) => (
          <div key={z.richtung} className={`vp-ab-zeile is-${z.richtung}`} role="row" data-testid={`abrechnung-${z.richtung}`}>
            <span role="rowheader" className="vp-ab-c-name">
              <span className="vp-ab-name">
                <span className={`vp-ab-marke is-${z.richtung}`} aria-hidden="true" />
                {z.label}
                {isPhone && <strong className="vp-ab-gemessen">{z.gemessen}</strong>}
              </span>
              {z.herkunft && <span className="vp-ab-herkunft">{z.herkunft}</span>}
            </span>
            {!isPhone && (
              <span role="cell" className="vp-ab-c-zahl vp-ab-gemessen">
                {z.gemessen}
              </span>
            )}
            <span role="cell" className="vp-ab-c-rechnung">
              {isPhone && <span className="vp-ab-telefon-label">{WORT.lautRechnung.replace('Laut', 'laut')}</span>}
              {feld(z.richtung, z.label)}
              {feldFehler[z.richtung] && (
                <span id={`${id}-${z.richtung}-fehler`} className="vp-ab-feldfehler" role="alert">
                  {feldFehler[z.richtung]}
                </span>
              )}
            </span>
            {(!isPhone || z.unterschied) && (
              <span role="cell" className={`vp-ab-c-zahl vp-ab-unterschied${z.unterschied?.gross ? ' is-gross' : ''}`}>
                {isPhone && <span className="vp-ab-telefon-label">{WORT.unterschied}</span>}
                <span>{z.unterschied ? z.unterschied.text : '–'}</span>
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="vp-ab-saetze">
        {view.saetze.map((s) => (
          <p key={s.text} className={`vp-ab-satz${s.ton === 'warn' ? ' is-warn' : ''}`}>
            {s.text}
          </p>
        ))}
      </div>
    </VrKarte>
  );
}
