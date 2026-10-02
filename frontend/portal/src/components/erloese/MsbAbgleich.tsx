import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { Button } from '../../../designsystem/components/core/Button';
import { Recht } from '../Recht';
import {
  AMPEL_WORT,
  abgleichApi,
  eurText,
  farbeText,
  grundWort,
  kwhText,
  monatName,
  satz,
  schwellenText,
  unterschiedText,
  wirkungKurz,
  zaehlerName,
  type AbgleichErgebnis,
  type AbgleichMonat,
  type Ampel,
  type MessstelleAbgleich,
  type Wirkung,
} from '../../mispelAbgleich';
import './MsbAbgleich.css';

/**
 * Abgleich Gerät ↔ Messstellenbetreiber (MiSpeL MP-15, Bedienkonzept BK-15 Variante A, abgestimmt 02.10.2026):
 * der Satz mit der größten Abweichung in der Monatskarte (MP-18), das Blatt „Abgleich“ mit den Zählrichtungen und an
 * der Messstelle die Tabelle je Monat mit dem Import. Kein neuer Reiter. Maßgeblich bleiben die Werte des
 * Messstellenbetreibers (Tenor S. 28) — die Ampel erklärt, sie ersetzt nichts.
 */

const MASSGEBLICH = 'Gerätewerte (Vorschau) gegen Werte des Messstellenbetreibers — maßgeblich sind die Werte des Messstellenbetreibers (Tenor S. 28).';

export function AmpelMarke({ ampel }: { ampel: Ampel }) {
  return (
    <span className={`vp-ab-ampel ab-${ampel}`}>
      <i aria-hidden="true" />
      {AMPEL_WORT[ampel]}
    </span>
  );
}

/** Der Satz in der Monatskarte; nichts, solange der Messstellenbetreiber für den Monat keine Werte geliefert hat. */
export function MsbAbgleichSatz({ siteId, monat }: { siteId: string; monat: string }) {
  const [daten, setDaten] = useState<AbgleichMonat | null>(null);
  const [offen, setOffen] = useState(false);
  useEffect(() => {
    let aktiv = true;
    setDaten(null);
    abgleichApi.monat(siteId, monat).then((d) => aktiv && setDaten(d)).catch(() => aktiv && setDaten(null));
    return () => {
      aktiv = false;
    };
  }, [siteId, monat]);
  const s = daten ? satz(daten) : null;
  if (!daten || !s) return null;
  return (
    <div className={`vp-ab-satz ab-${s.ampel}`} data-testid="msb-abgleich-satz">
      <span className="vp-ab-punkt" aria-hidden="true" />
      <p>
        <b>{s.kopf}</b> {s.text}{' '}
        <button type="button" className="vp-ab-link" onClick={() => setOffen(true)}>
          Abgleich ansehen ›
        </button>
      </p>
      <AbgleichBlatt daten={daten} offen={offen} onClose={() => setOffen(false)} />
    </div>
  );
}

function AbgleichBlatt({ daten, offen, onClose }: { daten: AbgleichMonat; offen: boolean; onClose: () => void }) {
  const ziel = daten.zaehler.find((z) => z.groesse === daten.groessteAbweichung) ?? daten.zaehler[0];
  return (
    <Modal
      open={offen}
      onClose={onClose}
      title={`Abgleich ${monatName(daten.monat)}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Schließen</Button>
          {ziel && (
            <Button onClick={() => { onClose(); window.location.hash = `#/portfolio/messstellen/${ziel.messstelleId}`; }}>
              Zur Messstelle
            </Button>
          )}
        </>
      }
    >
      <div className="vp-ab-blatt" data-testid="msb-abgleich-blatt">
        <p className="vp-ab-hinweis">{MASSGEBLICH}</p>
        <ul className="vp-ab-zeilen">
          {daten.zaehler.map((z) => (
            <li key={z.groesse}>
              <b>{zaehlerName(z)}</b>
              {z.abgleich ? <AmpelMarke ampel={z.abgleich.ampel} /> : <span />}
              <span className="vp-ab-klein">
                Gerät {kwhText(z.abgleich?.geraetKwh)} · Messstellenbetreiber {z.abgleich?.msbKwh == null ? 'noch keine Werte' : kwhText(z.abgleich.msbKwh)}
                {z.abgleich?.grund ? ` · ${grundWort(z.abgleich.grund)}` : ''}
              </span>
              <b className="vp-ab-zahl">{z.abgleich ? unterschiedText(z.abgleich).replace(/.*\((.*)\)$/, '$1') : '—'}</b>
            </li>
          ))}
        </ul>
        <h3 className="vp-ab-label">Wirkung auf den Monat</h3>
        {daten.wirkung ? <WirkungListe wirkung={daten.wirkung} /> : (
          <p className="vp-ab-klein">Noch kein endgültiger Monat — die Wirkung steht hier, sobald der Monat mit den Werten des Messstellenbetreibers gerechnet ist.</p>
        )}
        <p className="vp-ab-schwellen">Ampel: {schwellenText(daten.schwellen)}</p>
      </div>
    </Modal>
  );
}

function WirkungListe({ wirkung }: { wirkung: Wirkung }) {
  return (
    <dl className="vp-ab-kv">
      {wirkung.farben.filter((f) => f.farbe !== 'grau').map((f) => (
        <div key={f.farbe}>
          <dt>{farbeText(f)}</dt>
          <dd>{kwhText(f.vorherKwh)} → {kwhText(f.nachherKwh)}</dd>
        </div>
      ))}
      <div>
        <dt>Saldierung</dt>
        <dd>{eurText(wirkung.saldierungVorherEur)} → {eurText(wirkung.saldierungNachherEur)}</dd>
      </div>
    </dl>
  );
}

/** An der Messstelle: der Abgleich je Monat und das Einlesen der Werte des Messstellenbetreibers. */
export function MsbAbgleichKarte({ messstelleId }: { messstelleId: string }) {
  const [daten, setDaten] = useState<MessstelleAbgleich | null>(null);
  const [stand, setStand] = useState(0);
  const [meldung, setMeldung] = useState<{ ton: 'ok' | 'fehler'; text: string } | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const datei = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let aktiv = true;
    abgleichApi.messstelle(messstelleId).then((d) => aktiv && setDaten(d)).catch(() => aktiv && setDaten(null));
    return () => {
      aktiv = false;
    };
  }, [messstelleId, stand]);
  if (!daten || !daten.rolle) return null;

  async function einlesen(f: File) {
    setLaeuft(true);
    setMeldung(null);
    try {
      const e = await abgleichApi.einlesen(messstelleId, f);
      const r = e.richtungen.map((x) => (x === 'bezug' ? 'Bezug' : 'Abgabe')).join(', ');
      setMeldung({
        ton: 'ok',
        text: e.neu
          ? `Eingelesen: ${e.importDatei.viertelstunden.toLocaleString('de-DE')} Viertelstunden (${r}) aus ${f.name}.`
          : `${f.name} war schon eingelesen — nichts geändert.`,
      });
      setStand((s) => s + 1);
    } catch (err) {
      const body = (err as { body?: { message?: string } }).body;
      setMeldung({ ton: 'fehler', text: body?.message ?? (err as Error).message ?? 'Die Datei ließ sich nicht einlesen.' });
    } finally {
      setLaeuft(false);
      if (datei.current) datei.current.value = '';
    }
  }

  return (
    <section className="vp-mss-karte vp-ab-karte" aria-labelledby="vp-ab-titel" data-testid="msb-abgleich">
      <h2 id="vp-ab-titel">Abgleich Gerät ↔ Messstellenbetreiber</h2>
      <p className="vp-ab-klein">
        Die Vorschau rechnet mit den Werten Ihrer Geräte; maßgeblich für Nachweis und Abrechnung sind die Werte des
        Messstellenbetreibers (Tenor S. 28).
        {daten.zaehlpunkt ? ` Zählpunkt ${daten.zaehlpunkt}` : ''}
        {daten.messstellenbetreiber ? ` · ${daten.messstellenbetreiber}` : ''}.
      </p>
      <div className="vp-ab-tabelle">
        <table>
          <thead>
            <tr>
              <th>Monat</th>
              <th className="n">Gerät</th>
              <th className="n">Messstellenbetreiber</th>
              <th className="n">Unterschied</th>
              <th>Ampel</th>
              <th>Wirkung</th>
            </tr>
          </thead>
          <tbody>
            {daten.monate.map((m) => (
              <tr key={m.monat}>
                <td><b>{monatName(m.monat)}</b></td>
                <td className="n">{kwhText(m.abgleich.geraetKwh)}</td>
                <td className="n">{m.abgleich.msbKwh == null ? 'noch keine Werte' : kwhText(m.abgleich.msbKwh)}</td>
                <td className="n">{zelleUnterschied(m.abgleich)}</td>
                <td><AmpelMarke ampel={m.abgleich.ampel} /></td>
                <td>{wirkungKurz(m.wirkung)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="vp-ab-schwellen">Ampel: {schwellenText(daten.schwellen)}</p>
      <Recht aktion="messstelle.bearbeiten">
        <div className="vp-ab-import">
          <input
            ref={datei}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="vp-ab-datei"
            id={`vp-ab-datei-${messstelleId}`}
            aria-label="Datei mit Werten des Messstellenbetreibers"
            disabled={laeuft}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void einlesen(f);
            }}
          />
          <Button variant="outline" disabled={laeuft} onClick={() => datei.current?.click()}>
            {laeuft ? 'Wird eingelesen …' : 'Werte des Messstellenbetreibers einlesen'}
          </Button>
          <p className="vp-ab-klein">
            CSV je Viertelstunde mit den Spalten zeitstempel;zaehlpunkt;richtung;kwh — Beginn der Viertelstunde mit
            Versatz, Richtung bezug/abgabe oder OBIS 1-1:1.29.0/1-1:2.29.0.
            {daten.importe[0] ? ` Zuletzt: ${daten.importe[0].dateiname ?? 'Datei'}, ${daten.importe[0].viertelstunden.toLocaleString('de-DE')} Viertelstunden.` : ''}
          </p>
          {meldung && (
            <p className={`vp-ab-meldung ab-${meldung.ton}`} role={meldung.ton === 'fehler' ? 'alert' : 'status'}>
              {meldung.text}
            </p>
          )}
        </div>
      </Recht>
    </section>
  );
}

function zelleUnterschied(e: AbgleichErgebnis): string {
  if (e.unterschiedKwh == null) return e.grund && e.grund !== 'keine_msb_werte' ? grundWort(e.grund) : '—';
  return unterschiedText(e);
}
