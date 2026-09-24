import { useRef } from 'react';
import { AXIS, BAR, FILL, NARROW_PX, STROKE, ghostItem, ghostLine, nowLineStyle, withAlpha } from '../../chartStyle';
import { chartTheme } from '../../chartTheme';
import { kopf, notizZeile, tooltip, TOOLTIP_CSS, wertZeile } from '../../chartTooltip';
import { zeigerSchwebt } from '../../chartFokus';
import { fmtNum } from '../../format';
import type { EnergieBilanzView, EnergieTag } from '../../energieSeite';
import { useEChart } from '../../useEChart';

/**
 * Die zwei Diagramme der Energie-Seite (Konzept „Verlauf-Rework", Paket P3,
 * Entscheid E4 = A) — reine Render-Schicht über `energieSeite.ts`.
 *
 * - {@link EnergieTagChart}: der Tag in bis zu vier Feldern über EINER
 *   Zeitachse — jedes Feld mit eigener Einheit, nie zwei Skalen in einem.
 * - {@link EnergieBilanzChart}: Woche, Monat und Jahr als gespiegelte Bilanz —
 *   oben woher die Energie kam, unten wohin sie ging.
 *
 * Farben sind die Rollen der Zuordnungstabelle (`--vp-c-chart-*`): Erzeugung
 * Orange, Verbrauch Violett, Netz Petrol, Speicher Grün.
 */

export type TagReihe = 'pv' | 'load' | 'netz' | 'soc' | 'preis';

const kwText = (v: number | null) => (v == null ? '—' : fmtNum(Math.abs(v), 'kW', 1));

export function EnergieTagChart({
  tag,
  vergleich,
  sichtbar,
  label,
}: {
  tag: EnergieTag;
  /** Der Vergleichstag (F8) — blass gestrichelt hinter Erzeugung und Verbrauch. */
  vergleich?: { name: string; tag: EnergieTag } | null;
  /** Welche Reihen gezeigt werden (Legende = Bedienung). `preis` schaltet das vierte Feld zu. */
  sichtbar: ReadonlySet<TagReihe>;
  label: string;
}) {
  const felder: { key: 'pvload' | 'netz' | 'soc' | 'preis'; titel: string }[] = [
    { key: 'pvload', titel: 'Erzeugung und Verbrauch · kW' },
    { key: 'netz', titel: 'Netz · kW · oben Bezug, unten Einspeisung' },
    ...(tag.hatSoc ? [{ key: 'soc' as const, titel: 'Ladestand · %' }] : []),
    ...(sichtbar.has('preis') && tag.hatPreis ? [{ key: 'preis' as const, titel: 'Börsenpreis · ct/kWh' }] : []),
  ];
  const hoehe = felder.length === 2 ? 'mittel' : felder.length === 3 ? 'hoch' : 'sehrhoch';

  const ref = useEChart(
    (chart, width) => {
      const t = chartTheme();
      const narrow = width < NARROW_PX;
      const left = narrow ? 40 : 48;
      const right = 12;
      const total = chart.getHeight();
      const titelH = 20;
      const achseH = 24;
      const gap = 14;
      // Gewichte: das erste Feld trägt die Hauptaussage, die übrigen sind schmaler.
      const gewicht = { pvload: 2.2, netz: 1.4, soc: 1, preis: 1 } as const;
      const summe = felder.reduce((a, f) => a + gewicht[f.key], 0);
      const verfuegbar = total - felder.length * (titelH + gap) - achseH;
      let y = 0;
      const lagen = felder.map((f) => {
        const h = Math.max(48, (verfuegbar * gewicht[f.key]) / summe);
        const lage = { ...f, top: y + titelH, h };
        y += titelH + h + gap;
        return lage;
      });
      const idx = (k: string) => lagen.findIndex((l) => l.key === k);
      const n = tag.achse.length;
      const letzte = lagen.length - 1;
      const plot = Math.max(100, width - left - right);
      const stunde = Math.max(1, Math.round(n / 24));
      const proLabel = narrow ? 6 : plot / 24 < 30 ? 3 : 2;

      const band = (fi: number) => ({
        silent: true,
        data: tag.baender.map((b) => [
          {
            xAxis: b.von,
            itemStyle: {
              color: b.art === 'negativpreis' ? withAlpha(t.cPrice, 0.1) : withAlpha(t.axis, b.art === 'luecke' ? 0.14 : 0.05),
            },
            label: {
              show: fi === 0 && !narrow && b.bis - b.von >= 3,
              position: 'insideTop',
              color: t.axis,
              fontSize: AXIS.fontSize,
              formatter: b.art === 'negativpreis' ? 'Preis negativ' : b.art === 'luecke' ? 'keine Messwerte' : 'vor Messbeginn',
            },
          },
          { xAxis: b.bis },
        ]),
      });
      const jetzt = (fi: number) =>
        tag.jetzt == null
          ? undefined
          : {
              silent: true,
              symbol: 'none',
              lineStyle: nowLineStyle(t),
              label: { show: fi === 0, formatter: 'Jetzt', color: t.axis, fontSize: AXIS.fontSize, position: 'insideEndTop' as const, rotate: 0 },
              data: [{ xAxis: tag.jetzt }],
            };
      const linie = (
        name: string,
        data: (number | null)[],
        farbe: string,
        fi: number,
        extra: Record<string, unknown> = {},
      ) => ({
        name,
        type: 'line' as const,
        xAxisIndex: fi,
        yAxisIndex: fi,
        data,
        symbol: 'none',
        connectNulls: false,
        smooth: 0.15,
        lineStyle: { color: farbe, width: STROKE.lead },
        itemStyle: { color: farbe },
        ...extra,
      });

      const series: Record<string, unknown>[] = [];
      const pvIdx = idx('pvload');
      series.push(
        linie('Erzeugung', sichtbar.has('pv') ? tag.pv : [], t.cPv, pvIdx, {
          areaStyle: { color: withAlpha(t.cPv, FILL.wash) },
          markArea: band(pvIdx),
          markLine: jetzt(pvIdx),
        }),
        linie('Verbrauch', sichtbar.has('load') ? tag.load : [], t.cLoad, pvIdx),
      );
      if (vergleich) {
        const auf = (a: (number | null)[]) => tag.achse.map((_, i) => a[i] ?? null);
        if (sichtbar.has('pv')) {
          series.push(
            linie(`Erzeugung ${vergleich.name}`, auf(vergleich.tag.pv), t.cPv, pvIdx, {
              silent: true,
              z: 0,
              lineStyle: ghostLine(t.cPv),
              itemStyle: ghostItem(t.cPv),
            }),
          );
        }
        if (sichtbar.has('load')) {
          series.push(
            linie(`Verbrauch ${vergleich.name}`, auf(vergleich.tag.load), t.cLoad, pvIdx, {
              silent: true,
              z: 0,
              lineStyle: ghostLine(t.cLoad),
              itemStyle: ghostItem(t.cLoad),
            }),
          );
        }
      }
      const nIdx = idx('netz');
      series.push(
        linie('Netz', sichtbar.has('netz') ? tag.netz : [], t.cGrid, nIdx, {
          lineStyle: { color: t.cGrid, width: STROKE.context },
          areaStyle: { color: withAlpha(t.cGrid, FILL.band) },
          markArea: band(nIdx),
          markLine: jetzt(nIdx),
        }),
      );
      if (idx('soc') >= 0) {
        const s = idx('soc');
        series.push(
          linie('Ladestand', sichtbar.has('soc') ? tag.soc : [], t.cSoc, s, {
            lineStyle: { color: t.cSoc, width: STROKE.context },
            areaStyle: { color: withAlpha(t.cBatt, FILL.wash) },
            markArea: band(s),
            markLine: jetzt(s),
          }),
        );
      }
      if (idx('preis') >= 0) {
        const p = idx('preis');
        series.push(
          linie('Börsenpreis', tag.preis, t.cPrice, p, {
            step: 'end',
            smooth: false,
            lineStyle: { color: t.cPrice, width: STROKE.context },
            markArea: band(p),
            markLine: jetzt(p),
          }),
        );
      }

      chart.setOption(
        {
          textStyle: { fontFamily: t.font },
          title: lagen.map((l) => ({
            text: l.titel,
            left,
            top: l.top - titelH + 2,
            textStyle: { color: t.axis, fontSize: AXIS.fontSize, fontWeight: 500, fontFamily: t.font },
          })),
          grid: lagen.map((l) => ({ left, right, top: l.top, height: l.h, containLabel: false })),
          axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: t.axisLine } },
          tooltip: {
            trigger: 'axis',
            confine: true,
            extraCssText: TOOLTIP_CSS,
            axisPointer: { type: 'line' },
            formatter: (ps: { dataIndex: number }[]) => {
              const i = ps[0]?.dataIndex ?? 0;
              const z = tag.zustand[i];
              const titel = kopf(tag.titel[i] ?? '');
              if (z === 'zukunft') return tooltip(titel, notizZeile(t.axis, 'noch nicht gemessen'));
              if (z === 'luecke') return tooltip(titel, notizZeile(t.axis, 'keine Messwerte'));
              if (z === 'vorher') return tooltip(titel, notizZeile(t.axis, 'vor Messbeginn'));
              const netz = tag.netz[i];
              const sp = tag.speicher[i];
              return tooltip(
                titel,
                wertZeile(t.cPv, `<b>${kwText(tag.pv[i])}</b> Erzeugung`),
                wertZeile(t.cLoad, `<b>${kwText(tag.load[i])}</b> Verbrauch`),
                vergleich && (vergleich.tag.pv[i] != null || vergleich.tag.load[i] != null)
                  ? notizZeile(
                      t.axis,
                      `${vergleich.name}: ${kwText(vergleich.tag.pv[i] ?? null)} Erzeugung · ${kwText(vergleich.tag.load[i] ?? null)} Verbrauch`,
                    )
                  : null,
                netz == null
                  ? null
                  : wertZeile(t.cGrid, `<b>${kwText(netz)}</b> ${netz >= 0 ? 'Netzbezug' : 'Einspeisung'}`),
                sp == null
                  ? null
                  : wertZeile(
                      t.cBatt,
                      `<b>${kwText(sp)}</b> ${sp > 0.05 ? 'Speicher lädt' : sp < -0.05 ? 'Speicher entlädt' : 'Speicher ruht'}`,
                    ),
                tag.soc[i] == null ? null : wertZeile(t.cSoc, `<b>${Math.round(tag.soc[i] as number)} %</b> Ladestand`),
                tag.preis[i] == null
                  ? null
                  : wertZeile(
                      t.cPrice,
                      `<b>${(tag.preis[i] as number).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh</b> Börsenpreis`,
                    ),
              );
            },
          },
          xAxis: lagen.map((l, i) => ({
            type: 'category',
            gridIndex: i,
            data: tag.achse,
            boundaryGap: false,
            axisTick: { show: false },
            axisLine: { show: l.key === 'netz', lineStyle: { color: t.axisLine } },
            axisLabel: {
              show: i === letzte,
              color: t.axis,
              fontSize: AXIS.fontSize,
              interval: (index: number) => index % (stunde * proLabel) === 0,
              formatter: (v: string) => v.slice(0, 2),
            },
          })),
          yAxis: lagen.map((l, i) => ({
            type: 'value',
            gridIndex: i,
            splitNumber: l.key === 'pvload' ? 3 : 2,
            min: l.key === 'soc' ? 0 : undefined,
            max: l.key === 'soc' ? 100 : undefined,
            axisLabel: {
              color: t.axis,
              fontSize: AXIS.fontSize,
              formatter: (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })}`,
            },
            splitLine: { lineStyle: { color: t.grid } },
          })),
          series,
        },
        true,
      );
    },
    [tag, vergleich, sichtbar, felder.length],
  );

  return <div ref={ref} className={`vp-vr-chart ${hoehe}`} role="img" aria-label={label} />;
}

/** Die Rollen der Bilanz-Reihen, die die Legende ein- und ausschaltet. */
export type BilanzReihe = 'pv' | 'load' | 'netz' | 'speicher';

export function EnergieBilanzChart({
  bilanz,
  vergleich,
  sichtbar,
  onZelle,
  label,
}: {
  bilanz: EnergieBilanzView;
  /** Die Vergleichsperiode (F8) — feine Marken für Erzeugung und Verbrauch, nach Position. */
  vergleich?: { name: string; bilanz: EnergieBilanzView } | null;
  sichtbar: ReadonlySet<BilanzReihe>;
  onZelle?: (index: number) => void;
  label: string;
}) {
  const klick = useRef({ bilanz, onZelle });
  klick.current = { bilanz, onZelle };
  const gebunden = useRef(false);

  const ref = useEChart(
    (chart, width) => {
      if (!gebunden.current) {
        gebunden.current = true;
        chart.getZr().on('click', (e: { offsetX: number; offsetY: number }) => {
          const { bilanz: b, onZelle: oeffne } = klick.current;
          if (!oeffne || !zeigerSchwebt()) return;
          if (!chart.containPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY])) return;
          const i = Math.round(Number(chart.convertFromPixel({ xAxisIndex: 0 }, e.offsetX)));
          const z = b.zellen[i];
          if (!z || z.zustand === 'zukunft' || z.zustand === 'vorher') return;
          oeffne(i);
        });
      }
      const t = chartTheme();
      const narrow = width < NARROW_PX;
      const left = narrow ? 48 : 56;
      const n = bilanz.achse.length;
      const plot = Math.max(100, width - left - 12);
      const minPx = bilanz.range === 'week' ? 48 : bilanz.range === 'year' ? 34 : 26;
      const intervall = Math.max(0, Math.ceil(minPx / (plot / Math.max(1, n))) - 1);
      const z = bilanz.zellen;
      const wert = (v: number | null, i: number, vz = 1) =>
        z[i].zustand === 'ok' || z[i].zustand === 'laeuft' ? (v == null ? null : Math.round(vz * v * 10) / 10) : null;
      const reihe = (
        name: string,
        rolle: BilanzReihe,
        farbe: string,
        daten: (number | null)[],
        blass = false,
        extra: Record<string, unknown> = {},
      ) => ({
        name,
        type: 'bar' as const,
        stack: 'energie',
        barMaxWidth: BAR.maxWidth,
        barCategoryGap: BAR.categoryGap,
        data: sichtbar.has(rolle) ? daten : daten.map(() => null),
        itemStyle: { color: blass ? withAlpha(farbe, 0.72) : farbe, borderColor: t.surface, borderWidth: 1 },
        ...extra,
      });
      const leer = z
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.zustand === 'luecke' || c.zustand === 'zukunft' || c.zustand === 'vorher');
      const baender: [Record<string, unknown>, Record<string, unknown>][] = [];
      for (let k = 0; k < leer.length; k++) {
        let j = k;
        while (j + 1 < leer.length && leer[j + 1].i === leer[j].i + 1 && leer[j + 1].c.zustand === leer[k].c.zustand) j++;
        const art = leer[k].c.zustand;
        const span = j - k + 1;
        const text = art === 'luecke' ? (span > 1 ? 'keine Messwerte' : '') : art === 'zukunft' ? (span > 2 ? 'noch offen' : '') : span > 2 ? 'vor Messbeginn' : '';
        baender.push([
          {
            xAxis: leer[k].i,
            itemStyle: { color: withAlpha(t.axis, art === 'luecke' ? 0.12 : 0.05) },
            label: { show: !!text, position: 'insideTop', color: t.axis, fontSize: AXIS.fontSize, formatter: text },
          },
          { xAxis: leer[j].i },
        ]);
        k = j;
      }

      chart.setOption(
        {
          textStyle: { fontFamily: t.font },
          title: [
            { text: '↑ woher · kWh', left: left + 4, top: 0, textStyle: { color: t.axis, fontSize: AXIS.fontSize, fontWeight: 600 } },
            { text: '↓ wohin', left: left + 4, bottom: 26, textStyle: { color: t.axis, fontSize: AXIS.fontSize, fontWeight: 600 } },
          ],
          grid: { left, right: 12, top: 22, bottom: 28, containLabel: false },
          tooltip: {
            trigger: 'axis',
            confine: true,
            extraCssText: TOOLTIP_CSS,
            axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(t.axis, 0.08) } },
            formatter: (ps: { dataIndex: number }[]) => {
              const i = ps[0]?.dataIndex ?? 0;
              const c = z[i];
              const titel = kopf(bilanz.titel[i] ?? '');
              if (!c) return '';
              if (c.zustand === 'zukunft') return tooltip(titel, notizZeile(t.axis, 'liegt in der Zukunft'));
              if (c.zustand === 'vorher') return tooltip(titel, notizZeile(t.axis, 'vor Messbeginn'));
              if (c.zustand === 'luecke') return tooltip(titel, notizZeile(t.axis, 'keine Messwerte'));
              const k = (v: number | null) => (v == null ? '—' : fmtNum(v, 'kWh', 1));
              return tooltip(
                titel,
                notizZeile(t.axis, 'Woher'),
                wertZeile(t.cPv, `<b>${k(c.pvKwh)}</b> Erzeugung`),
                wertZeile(t.cGrid, `<b>${k(c.importKwh)}</b> Netzbezug`),
                wertZeile(t.cBatt, `<b>${k(c.entladenKwh)}</b> Speicher-Entladung`),
                notizZeile(t.axis, 'Wohin'),
                wertZeile(t.cLoad, `<b>${k(c.loadKwh)}</b> Verbrauch`),
                wertZeile(t.cGrid, `<b>${k(c.exportKwh)}</b> Einspeisung`),
                wertZeile(t.cBatt, `<b>${k(c.ladenKwh)}</b> Speicher-Ladung`),
                vergleich && vergleich.bilanz.zellen[i]
                  ? notizZeile(
                      t.axis,
                      `${vergleich.name}: ${k(vergleich.bilanz.zellen[i].pvKwh)} Erzeugung · ${k(vergleich.bilanz.zellen[i].loadKwh)} Verbrauch`,
                    )
                  : null,
                c.zustand === 'laeuft' ? notizZeile(t.axis, 'läuft noch') : null,
                onZelle && zeigerSchwebt()
                  ? notizZeile(t.axis, bilanz.drill === 'tag' ? 'Klick öffnet den Tag' : 'Klick öffnet den Monat')
                  : null,
              );
            },
          },
          xAxis: {
            type: 'category',
            data: bilanz.achse,
            axisTick: { show: false },
            axisLine: { show: false },
            axisLabel: { color: t.axis, fontSize: AXIS.fontSize, interval: intervall },
          },
          yAxis: {
            type: 'value',
            splitNumber: narrow ? 3 : 4,
            axisLabel: {
              color: t.axis,
              fontSize: AXIS.fontSize,
              formatter: (v: number) => `${Math.abs(v).toLocaleString('de-DE', { maximumFractionDigits: 0 })}`,
            },
            splitLine: { lineStyle: { color: t.grid } },
          },
          series: [
            reihe('Erzeugung', 'pv', t.cPv, z.map((c, i) => wert(c.pvKwh, i))),
            reihe('Netzbezug', 'netz', t.cGrid, z.map((c, i) => wert(c.importKwh, i))),
            reihe('Speicher-Entladung', 'speicher', t.cBatt, z.map((c, i) => wert(c.entladenKwh, i))),
            reihe('Verbrauch', 'load', t.cLoad, z.map((c, i) => wert(c.loadKwh, i, -1)), false, {
              markArea: { silent: true, data: baender },
              markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { color: t.axisLine, width: STROKE.ref, type: 'solid' },
                label: { show: false },
                data: [{ yAxis: 0 }],
              },
            }),
            reihe('Einspeisung', 'netz', t.cGrid, z.map((c, i) => wert(c.exportKwh, i, -1)), true),
            reihe('Speicher-Ladung', 'speicher', t.cBatt, z.map((c, i) => wert(c.ladenKwh, i, -1)), true),
            ...(vergleich
              ? [
                  { key: 'pv' as const, vz: 1, feld: 'pvKwh' as const },
                  { key: 'load' as const, vz: -1, feld: 'loadKwh' as const },
                ]
                  .filter((r) => sichtbar.has(r.key))
                  .map((r) => ({
                    name: `${r.key === 'pv' ? 'Erzeugung' : 'Verbrauch'} ${vergleich.name}`,
                    type: 'scatter' as const,
                    symbol: 'rect',
                    symbolSize: [narrow ? 10 : 16, 2],
                    silent: true,
                    z: 5,
                    data: z.map((_, i) => {
                      const v = vergleich.bilanz.zellen[i]?.[r.feld];
                      return v == null ? null : Math.round(r.vz * v * 10) / 10;
                    }),
                    itemStyle: { color: t.cPrice2 },
                  }))
              : []),
          ],
        },
        true,
      );
    },
    [bilanz, vergleich, sichtbar],
  );

  return (
    <div
      ref={ref}
      className={`vp-vr-chart${onZelle ? ' klickbar' : ''}`}
      role="img"
      aria-label={label}
    />
  );
}
