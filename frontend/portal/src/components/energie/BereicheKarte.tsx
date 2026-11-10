import { useEffect, useMemo, useState } from 'react';
import { api, type EntityEnergy, type History, type HistoryRange, type SiteTopology } from '../../api';
import { chartTheme } from '../../chartTheme';
import { deviceName } from '../../entityLabel';
import { csvDateiname } from '../../erloeseSeite';
import { fmtNum } from '../../format';
import { ladeCsv } from '../../ladeCsv';
import { bereicheCsv, verbrauchBereiche, type BereichEingabe } from '../../verbrauchBereiche';
import { VrKarte } from '../VerlaufRahmen';
import './EnergieSeite.css';

/** Die Teile der Karte: dieselben Mitglieder wie „Verbrauch im Detail“ (ohne das Haus selbst). */
interface Teil {
  entityId: string;
  label: string;
  unterzaehler: boolean;
  /** Zählerbaum-Konzept (R1): die Eltern-Komponente, oder `null` = Wurzel. */
  haengtAn: string | null;
}

/**
 * Die Mitglieder des Verbraucher-Knotens und der Ladepunkte HINTER dem Anschluss - die Teile, die
 * im Hausverbrauch stecken. Eine Säule am eigenen Anschluss (`charging-own`) gehört nicht dazu.
 */
export function bereicheTeile(topology: SiteTopology | null): Teil[] {
  if (!topology) return [];
  const byId = new Map(topology.entities.map((e) => [e.id, e] as const));
  const out: Teil[] = [];
  const seen = new Set<string>();
  for (const n of topology.topology.nodes) {
    if (n.role !== 'consumer' && n.role !== 'charging') continue;
    for (const m of n.members) {
      const e = byId.get(m.entity_id);
      if (!e || e.entityType === 'house-load' || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({
        entityId: e.id,
        label: deviceName({ storedLabel: m.label, typeLabel: e.typeLabel }) ?? 'Gerät',
        unterzaehler: e.entityType === 'sub-meter',
        haengtAn: m.haengt_an ?? null,
      });
    }
  }
  return out;
}

const kwh = (v: number | null) => (v == null ? '—' : fmtNum(v, 'kWh', 1));
const prozent = (a: number | null) => (a == null ? null : `${Math.round(a * 100)} %`);

/** Die Farbe des i-ten Teils: der Verbraucher-Ton der Portal-Palette, nach hinten heller. */
function farbe(i: number): { background: string; opacity: number } {
  return { background: chartTheme().consumer, opacity: [1, 0.5, 0.3][i] ?? 0.2 };
}

/**
 * **Verbrauch nach Bereichen** - erscheint, sobald die Anlage einen Unterzähler hat (Konzept
 * `vp-unterzaehler-anzeige`, UV-2 A). Die Zahlen bildet {@link verbrauchBereiche}.
 */
export function BereicheKarte({
  site,
  range,
  at,
  history,
}: {
  site: { id: string; name: string; profil?: string | null };
  range: HistoryRange;
  at: string;
  history: History | null;
}) {
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  useEffect(() => {
    let aktiv = true;
    api.topology(site.id).then((t) => aktiv && setTopology(t), () => aktiv && setTopology(null));
    return () => {
      aktiv = false;
    };
  }, [site.id]);

  const teile = useMemo(() => bereicheTeile(topology), [topology]);
  const mitUnterzaehler = teile.some((t) => t.unterzaehler);
  const schluessel = teile.map((t) => t.entityId).join(',');

  const [energie, setEnergie] = useState<{ key: string; werte: (EntityEnergy | null)[] } | null>(null);
  const abrufKey = `${schluessel}|${range}|${at}`;
  useEffect(() => {
    if (!mitUnterzaehler) return;
    let aktiv = true;
    Promise.all(teile.map((t) => api.entityEnergy(site.id, t.entityId, range, at).catch(() => null))).then(
      (werte) => aktiv && setEnergie({ key: abrufKey, werte }),
    );
    return () => {
      aktiv = false;
    };
    // `teile` ändert sich genau mit `schluessel` (abrufKey).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id, abrufKey, mitUnterzaehler]);

  const bereiche = useMemo(() => {
    if (!energie || energie.key !== abrufKey) return null;
    const eingaben: BereichEingabe[] = teile.map((t, i) => ({ ...t, energie: energie.werte[i] ?? null }));
    return verbrauchBereiche({ history, teile: eingaben, range, profil: site.profil });
  }, [energie, abrufKey, teile, history, range, site.profil]);

  if (!mitUnterzaehler || !bereiche) return null;
  const teilZeilen = bereiche.zeilen.filter((z) => z.art === 'teil');
  const hoechste = Math.max(0, ...bereiche.saeulen.map((s) => s.haus ?? 0));

  return (
    <VrKarte
      titel="Verbrauch nach Bereichen"
      sub={bereiche.hausKwh == null ? null : `${kwh(bereiche.hausKwh)} im Haus`}
      info={{
        titel: 'So entsteht die Aufteilung',
        text: 'Je Unterzähler der Zuwachs seines Zählerstands im Zeitraum. Der Rest ist berechnet: der Hausverbrauch minus alle gemessenen Teile - dieselbe Rechnung wie „Verbrauch im Detail“ im Cockpit.',
      }}
      aktionen={
        <button
          type="button"
          className="vp-vr-textbtn"
          onClick={() => ladeCsv(bereicheCsv(bereiche, range), csvDateiname('verbrauch-bereiche', site.name, range, at))}
        >
          CSV
        </button>
      }
      className="vp-vr-bereiche"
    >
      <dl className="vp-vr-kv">
        {bereiche.zeilen.map((z) => {
          const i = teilZeilen.indexOf(z);
          return (
            <div key={z.key} className={z.art === 'rest' ? 'is-rest' : undefined}>
              <dt>
                <span
                  className="vp-vr-key"
                  style={z.art === 'rest' ? { background: chartTheme().idle } : farbe(i)}
                  aria-hidden="true"
                />{' '}
                {z.label}
                <small>{z.sub}</small>
              </dt>
              <dd>
                {kwh(z.kwh)}
                {prozent(z.anteil) && <small> · {prozent(z.anteil)}</small>}
              </dd>
            </div>
          );
        })}
      </dl>
      {bereiche.saeulen.length > 1 && hoechste > 0 && (
        <div
          className="vp-vr-saeulen"
          role="img"
          aria-label={`Verbrauch je ${range === 'day' ? 'Stunde' : range === 'year' ? 'Monat' : 'Tag'} nach Bereichen`}
        >
          {bereiche.saeulen.map((s) => (
            <div key={s.start.getTime()} className="vp-vr-saeule" title={`${s.kopf}: ${kwh(s.haus)}`}>
              <div className="vp-vr-saeule-stapel" style={{ height: `${((s.haus ?? 0) / hoechste) * 100}%` }}>
                {s.teile.map((v, i) =>
                  v != null && v > 0 && s.haus ? (
                    <i key={i} style={{ height: `${(v / s.haus) * 100}%`, ...farbe(i) }} />
                  ) : null,
                )}
                {s.rest != null && s.rest > 0 && s.haus ? (
                  <i style={{ height: `${(s.rest / s.haus) * 100}%`, background: chartTheme().idle }} />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
      {bereiche.saeulen.length > 1 && hoechste > 0 && (
        <div className="vp-vr-saeulen-achse" aria-hidden="true">
          <span>{bereiche.saeulen[0].kopf}</span>
          <span>{bereiche.saeulen[bereiche.saeulen.length - 1].kopf}</span>
        </div>
      )}
    </VrKarte>
  );
}
