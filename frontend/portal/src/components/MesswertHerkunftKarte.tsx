import { useEffect, useMemo, useState } from 'react';
import { api, type MeasurementHistory, type MeasurementHerkunft } from '../api';
import './Messwerte.css';

export interface HerkunftNamen {
  geraete?: Readonly<Record<string, string>>;
  boxen?: Readonly<Record<string, string>>;
}

export interface HerkunftKontext extends HerkunftNamen {
  /** Komponenten-Verlauf: feste Box; Messstellen-Verlauf: zeitgültige Box des gewählten Schritts. */
  deviceId: string | ((zeitpunkt: string) => string | null);
  siteId: string;
  entityId: string;
  pointKey: string;
}

const zeit = (iso: string) => new Date(iso).toLocaleString('de-DE', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  timeZone: 'Europe/Berlin',
});

const tag = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
const zahl = (n: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 }).format(n);

const zustellung = (h: MeasurementHerkunft): string | null => {
  if (!h.letzteEingangszeit) return null;
  const art = h.zustellart === 'nachgeliefert' || (h.nachgeliefert ?? 0) > 0 ? 'nachgeliefert' : 'direkt';
  return `${zeit(h.letzteEingangszeit)} (${art})`;
};

const qualitaet = (h: MeasurementHerkunft): string | null => {
  const teile = [
    h.nGood == null ? null : `${h.nGood} × gut`,
    h.nUncertain == null || h.nUncertain === 0 ? null : `${h.nUncertain} × unsicher`,
    h.nInvalid == null || h.nInvalid === 0 ? null : `${h.nInvalid} × ungültig`,
    h.nStale == null || h.nStale === 0 ? null : `${h.nStale} × veraltet`,
    h.nDeviceError == null || h.nDeviceError === 0 ? null : `${h.nDeviceError} × Gerätefehler`,
  ].filter((x): x is string => x !== null);
  return teile.length > 0 ? teile.join(' · ') : null;
};

export function rohwerteHinweis(history: MeasurementHistory): string | null {
  if (!history.meta.rohGrenze) return history.meta.quelleErklaerung ?? null;
  return `Rohwerte (60 s) bis ${tag(history.meta.rohGrenze)} verfügbar — ab hier Viertelstundenwerte.`;
}

export function nachlieferungMarker(history: MeasurementHistory, marker: MeasurementHistory['markers'][number]): string {
  const until = marker.until;
  if (marker.kind !== 'data_gap' || !until) return marker.label;
  const spaet = history.data
    .filter((d) => d.time >= marker.time && d.time < until && (d.herkunft?.nachgeliefert ?? 0) > 0)
    .map((d) => d.herkunft?.letzteEingangszeit)
    .filter((x): x is string => Boolean(x))
    .sort()[0];
  return spaet
    ? `nachgeliefert um ${zeit(spaet).slice(12, 17)} (${zeit(marker.time).slice(12, 17)}–${zeit(until).slice(12, 17)})`
    : marker.label;
}

export function MesswertHerkunftKarte({
  history, index, namen = {},
}: { history: MeasurementHistory; index: number; namen?: HerkunftNamen }) {
  const datum = history.data[index];
  const h = datum?.herkunft;
  if (!datum || !h) return <p className="vp-measure-hint">Herkunft für diesen Messwert nicht erfasst.</p>;
  const geraet = h.geraetEinbau ? namen.geraete?.[h.geraetEinbau] : null;
  const box = h.box ? namen.boxen?.[h.box] : null;
  const deckung = h.erhalten != null && h.erwartet != null ? `${h.erhalten} von ${h.erwartet}` : null;
  const endgueltig = h.zustand === 'endgueltig'
    ? `endgültig${h.endgueltigAb ? ` seit ${zeit(h.endgueltigAb)}` : ''}`
    : h.zustand === 'vorlaeufig' ? 'vorläufig' : null;
  const zeilen = [
    ['Wert', datum.value == null ? datum.text : `${zahl(datum.value)}${history.meta.unit ? `\u00a0${history.meta.unit}` : ''}`],
    ['Messzeit', zeit(datum.time)],
    ['Eingang', zustellung(h)],
    ['Qualität', qualitaet(h)],
    ['Verlauf', deckung],
    ['Gerät', geraet ?? (h.geraetEinbau ? 'Bezeichnung nicht erfasst' : null)],
    ['Fassung', h.fassung == null ? null : String(h.fassung)],
    ['Katalog', h.katalogVersion],
    ['Box', box ?? (h.box ? 'Bezeichnung nicht erfasst' : null)],
    ['Rolle', h.rolle === 'fuehrend' ? 'führend' : h.rolle],
    ['Stand', endgueltig],
    ['Stand am Ende', h.standEnde == null ? null : `${zahl(h.standEnde)}${history.meta.unit ? `\u00a0${history.meta.unit}` : ''}`],
    ['Version', h.version == null ? null : String(h.version)],
  ].filter((x): x is [string, string] => x[1] != null);
  return (
    <section className="vp-measure-origin" data-testid="herkunfts-karte" aria-label="Herkunft des Messwerts">
      <h4>Herkunft</h4>
      <dl>{zeilen.map(([name, wert]) => <div key={name}><dt>{name}</dt><dd>{wert}</dd></div>)}</dl>
    </section>
  );
}

export function HerkunftAmSchritt({ kontext, von, bis }: { kontext: HerkunftKontext; von: string; bis: string }) {
  const [history, setHistory] = useState<MeasurementHistory | null>(null);
  const [fehler, setFehler] = useState(false);
  const [darstellung, setDarstellung] = useState<'decoded' | 'raw'>('decoded');
  const deviceId = typeof kontext.deviceId === 'function' ? kontext.deviceId(von) : kontext.deviceId;
  useEffect(() => {
    if (!deviceId) return;
    let aktiv = true;
    setHistory(null);
    setFehler(false);
    api.measurementHistory(deviceId, kontext.pointKey, 'free', darstellung, von, bis,
      kontext.siteId, kontext.entityId).then(
      (h) => aktiv && setHistory(h),
      () => aktiv && setFehler(true),
    );
    return () => { aktiv = false; };
  }, [deviceId, kontext.pointKey, kontext.siteId, kontext.entityId, von, bis, darstellung]);
  const index = useMemo(() => history?.data.findIndex((d) => d.herkunft != null) ?? -1, [history]);
  if (fehler) return <p className="vp-measure-hint">Herkunft konnte nicht geladen werden.</p>;
  if (!deviceId) return <p className="vp-measure-hint">Herkunft für diesen Messwert nicht erfasst.</p>;
  if (!history) return <p className="vp-measure-hint" role="status">Herkunft wird geladen …</p>;
  return <div className="vp-measure-origin-wrap">
    <p className="vp-measure-hint">{rohwerteHinweis(history) ?? history.meta.quelleErklaerung}</p>
    <div className="vp-measure-range" aria-label="Wertdarstellung">
      <button type="button" aria-pressed={darstellung === 'decoded'} className={darstellung === 'decoded' ? 'is-active' : ''} onClick={() => setDarstellung('decoded')}>Dekodiert</button>
      <button type="button" aria-pressed={darstellung === 'raw'} className={darstellung === 'raw' ? 'is-active' : ''} disabled={!history.meta.rawAvailable} title={!history.meta.rawAvailable ? 'Rohwerte nicht mehr verfügbar (älter als 90 Tage)' : undefined} onClick={() => setDarstellung('raw')}>Rohwert</button>
    </div>
    {index >= 0
      ? <MesswertHerkunftKarte history={history} index={index} namen={kontext} />
      : <p className="vp-measure-hint">Herkunft für diesen Messwert nicht erfasst.</p>}
  </div>;
}
