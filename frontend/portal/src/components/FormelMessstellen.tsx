import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type MessstelleRegisterZeile, type MessstelleVerteilungAnteil } from '../api';
import { messstellenImKontext, messstellenTerm, type AssistentTyp, type FormelTerm } from '../formelAssistent';
import { VpPicker } from './VpPicker';

/** Quellen-Ergänzung im vorhandenen Assistenten, keine eigene Speicherlogik. */
export function FormelMessstellen({ siteId, komponenten, typ, ab, terme, onAdd, onRemove }: {
  siteId: string; komponenten: string[]; typ: AssistentTyp; ab: string; terme: FormelTerm[];
  onAdd: (term: FormelTerm) => void; onRemove: (term: FormelTerm) => void;
}) {
  const [offen, setOffen] = useState(false);
  const [zeilen, setZeilen] = useState<MessstelleRegisterZeile[]>([]);
  const [id, setId] = useState('');
  const [anteile, setAnteile] = useState<MessstelleVerteilungAnteil[] | null>(null);
  const [ziel, setZiel] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [laden, setLaden] = useState(false);
  const grenze = komponenten.join('|');
  const sichtbar = offen || typ === 'saldo';
  useEffect(() => {
    if (!sichtbar) return;
    let aktiv = true;
    setId(''); setZeilen([]); setFehler(null); setLaden(true);
    void api.messstellenRegister({ anlage: siteId, stichtag: ab }).then(r => {
      if (aktiv) setZeilen(messstellenImKontext(r.register ?? [], grenze.split('|'), typ));
    }).catch(() => { if (aktiv) setFehler('Die Messstellen konnten nicht geladen werden.'); })
      .finally(() => { if (aktiv) setLaden(false); });
    return () => { aktiv = false; };
  }, [sichtbar, siteId, ab, grenze, typ]);
  useEffect(() => {
    let aktiv = true;
    setAnteile(null); setZiel('');
    if (!id || typ === 'saldo') return;
    void api.messstelleVerteilung(id, ab).then(r => { if (aktiv) setAnteile(r.anteile); })
      .catch(() => { if (aktiv) { setAnteile([]); setFehler('Die Verteilung konnte nicht geladen werden.'); } });
    return () => { aktiv = false; };
  }, [id, ab, typ]);
  const m = zeilen.find(z => z.id === id);
  const a = anteile?.find(a => a.kostenstelle.id === ziel);
  const doppelt = terme.some(t => t.bezug?.messstelle === id && (t.bezug.ziel ?? '') === ziel);
  const bereit = !!m && (typ === 'saldo' || !!a) && !doppelt;
  return <section className="vp-sw-group" aria-label={typ === 'saldo' ? 'Hauptzähler-Paar' : 'Verteilungs-Anteile'}>
    {typ === 'gewichtete_summe' && <Button variant="ghost" onClick={() => setOffen(v => !v)}>Verteilungs-Anteil {offen ? 'ausblenden' : 'hinzufügen'}</Button>}
    {sichtbar && <>
      <p className="vp-sw-sub">{typ === 'saldo' ? 'Bezug minus Abgabe derselben Anlage. Wählen Sie die beiden Hauptzähler.' : 'Der Anteil folgt der am gewählten Tag gültigen Kostenstellen-Verteilung.'}</p>
      {laden ? <p>Messstellen werden geladen …</p> : zeilen.length ? <>
        <VpPicker label="Messstelle als Eingang" value={id} options={zeilen.map(m => ({ value: m.id, label: `${m.kennzeichen} · ${m.name ?? ''} · ${m.hauptgroesse.richtung}` }))} onChange={setId} />
        {typ === 'gewichtete_summe' && id && (anteile === null ? <p>Verteilung wird geladen …</p>
          : anteile.length ? <VpPicker label="Kostenstellen-Anteil" value={ziel} options={anteile.map(a => ({ value: a.kostenstelle.id, label: `${a.kostenstelle.kennzeichen} · ${a.name} · ${a.anteil_prozent} %` }))} onChange={setZiel} />
            : <p>Für diesen Tag ist keine Verteilung eingerichtet.</p>)}
        <Button variant="outline" disabled={!bereit || terme.length >= 12} onClick={() => {
          if (bereit && m) { onAdd(messstellenTerm(m, typ === 'saldo' ? undefined : a)); setId(''); }
        }}>Eingang aufnehmen</Button>
      </> : <p>Keine passenden Messstellen mit führender Quelle in diesem Geräte- oder Anlagenbereich.</p>}
      <p className="vp-sw-sub">Die Live-Vorschau bleibt ohne vollständige Intervallmengen unbekannt.</p>
      {fehler && <p role="alert">{fehler}</p>}
    </>}
    {terme.filter(t => t.bezug).map(t => <div key={t.quelle.channel} className="vp-sw-row">
      <span className="vp-sw-mid">{t.quelle.name}</span><Button variant="ghost" onClick={() => onRemove(t)} aria-label={`${t.quelle.name} entfernen`}>Entfernen</Button>
    </div>)}
  </section>;
}
