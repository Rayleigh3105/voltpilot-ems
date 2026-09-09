import { describe, expect, it } from 'vitest';
import {
  ANSCHLUSSARTEN,
  BOOL_AGGREGATE,
  MAX_ZUORDNUNGEN,
  SOC_METHODEN,
  ZIEL_KANAELE,
  ausConnection,
  ausVorlage,
  brokerFehler,
  chemieWort,
  istTopicFilter,
  istWertePfad,
  bindungFehler,
  bindungWort,
  bindungsKanaele,
  kanalGewaehlt,
  kurveFehler,
  ladestandVon,
  neuerBroker,
  neueBindung,
  neueSoc,
  neueZuordnung,
  pruefen,
  socFehler,
  speicherRumpf,
  speicherZiele,
  vorlageWarnung,
  vorschauErgebnis,
  vorschauRumpf,
  zuordnungFehler,
  zuordnungenFehler,
  type BindungForm,
  type SocCurveTemplate,
  type ZuordnungZeile,
} from './batterieAnschluss';

function zelle(over: Partial<ZuordnungZeile> = {}): ZuordnungZeile {
  return {
    ...neueZuordnung('cell_min_mv'),
    topic: 'diybms/bank/+/cell/+',
    path: 'voltage',
    aggregate: 'min',
    scale: '1000',
    ...over,
  };
}

const VORLAGE: SocCurveTemplate = {
  id: 'diybms-176s-nmc',
  label: 'DIYBMS 176s NMC (Kundenkurven, 25 °C)',
  chemistry: 'nmc',
  cellsInSeries: 176,
  refTempC: 25,
  cellMinV: 3.26,
  cellMaxV: 4.18,
  curveCharge: [
    [3.26, 0],
    [3.71, 50],
    [4.18, 100],
  ],
  curveDischarge: [
    [3.26, 0],
    [3.71, 50],
    [4.18, 100],
  ],
};

describe('Anschlussart (Schritt 1)', () => {
  /**
   * HTTP und Modbus stehen SICHTBAR da, obwohl nur MQTT gebaut ist: sonst
   * ließe die Liste den Kunden raten, ob VoltPilot seinen Fall grundsätzlich
   * nicht kann oder nur noch nicht.
   */
  it('bietet MQTT an und nennt an den gesperrten Arten den Grund', () => {
    const mqtt = ANSCHLUSSARTEN.find((a) => a.id === 'mqtt');
    expect(mqtt?.verfuegbar).toBe(true);
    for (const art of ANSCHLUSSARTEN.filter((a) => !a.verfuegbar)) {
      expect(art.bald, `„${art.label}" ohne Erklärung`).toBeTruthy();
    }
  });
});

describe('Feld-Zuordnung', () => {
  it('kennt genau die Standard-Kanäle des Typkatalogs - ohne soc_source_code', () => {
    expect(ZIEL_KANAELE.map((k) => k.channel)).toEqual([
      'soc_pct',
      'voltage_v',
      'current_a',
      'power_kw',
      'cell_min_mv',
      'cell_max_mv',
      'temp_max_c',
      'charge_allowed',
      'discharge_allowed',
      'charge_limit_a',
      'discharge_limit_a',
    ]);
  });

  it('nimmt eine vollständige Zeile an', () => {
    expect(zuordnungFehler(zelle())).toEqual([]);
  });

  it('verlangt Ziel-Kanal und Topic', () => {
    expect(zuordnungFehler(zelle({ channel: '' }))[0]).toContain('welchen Messwert');
    expect(zuordnungFehler(zelle({ topic: '' }))[0]).toContain('Topic');
  });

  it('prüft den Topic-Filter wie die Box: „+" eine Ebene, „#" nur am Ende', () => {
    expect(istTopicFilter('diybms/bank/+/cell/+')).toBe(true);
    expect(istTopicFilter('diybms/#')).toBe(true);
    expect(istTopicFilter('diybms/#/cell')).toBe(false);
    expect(istTopicFilter('diybms/bank+/cell')).toBe(false);
    expect(istTopicFilter('diybms/ bank')).toBe(false);
    expect(istTopicFilter('')).toBe(false);
  });

  /** Die Box geht diesen Pfad durch eine JSON-Struktur - `__proto__` ist tabu. */
  it('prüft den Wertepfad und sperrt die Prototyp-Namen', () => {
    expect(istWertePfad('')).toBe(true);
    expect(istWertePfad('bms.soc')).toBe(true);
    expect(istWertePfad('__proto__')).toBe(false);
    expect(istWertePfad('bms.constructor')).toBe(false);
    expect(istWertePfad('bms..soc')).toBe(false);
  });

  /**
   * Die SUMME von Freigaben ist keine Freigabe, und ein Mittel von 0,5 wäre
   * eine Zahl, die kein Gerät je gemeldet hat.
   */
  it('lässt einen Ja/Nein-Wert nur konservativ zusammenfassen', () => {
    expect(BOOL_AGGREGATE).toEqual(['last', 'min', 'max']);
    const bool = zelle({ channel: 'charge_allowed', valueType: 'bool', aggregate: 'sum' });
    expect(zuordnungFehler(bool).join(' ')).toContain('Ja/Nein-Wert');
    expect(zuordnungFehler({ ...bool, aggregate: 'min' })).toEqual([]);
  });

  it('folgt beim Kanal-Wechsel der Wert-Art des Ziels', () => {
    const nach = kanalGewaehlt(neueZuordnung('soc_pct'), 'charge_allowed');
    expect(nach.valueType).toBe('bool');
    expect(BOOL_AGGREGATE).toContain(nach.aggregate);
  });

  /** Eine Skalierung, die der Kunde eingetippt hat, überlebt jeden Kanal-Wechsel. */
  it('lässt eine eingetippte Skalierung beim Kanal-Wechsel stehen', () => {
    const vorher = { ...neueZuordnung('cell_min_mv'), scale: '1000' };
    expect(kanalGewaehlt(vorher, 'cell_max_mv').scale).toBe('1000');
  });

  it('lehnt eine Skalierung von 0 und eine unmögliche Haltbarkeit ab', () => {
    expect(zuordnungFehler(zelle({ scale: '0' })).join(' ')).toContain('Skalierung');
    expect(zuordnungFehler(zelle({ staleS: '1' })).join(' ')).toContain('Haltbarkeit');
  });

  it('erkennt denselben Ziel-Kanal zweimal', () => {
    expect(zuordnungenFehler([zelle(), zelle()])[0]).toContain('zweimal zugeordnet');
    expect(zuordnungenFehler([zelle(), zelle({ channel: 'cell_max_mv' })])).toEqual([]);
  });

  it('verlangt mindestens eine und höchstens MAX_ZUORDNUNGEN Zeilen', () => {
    expect(zuordnungenFehler([])[0]).toContain('mindestens ein Feld');
    const viele = Array.from({ length: MAX_ZUORDNUNGEN + 1 }, () => zelle({ channel: '' }));
    expect(zuordnungenFehler(viele).join(' ')).toContain(String(MAX_ZUORDNUNGEN));
  });
});

describe('Broker', () => {
  it('erzwingt eine Adresse im eigenen Netz', () => {
    const b = { ...neuerBroker(), host: '8.8.8.8' };
    expect(brokerFehler(b).join(' ')).toContain('eigenen Netzwerk');
    expect(brokerFehler({ ...b, host: '192.168.0.44' })).toEqual([]);
  });

  it('prüft Port und Sende-Abstand', () => {
    expect(brokerFehler({ ...neuerBroker(), host: '10.0.0.5', port: '0' }).join(' ')).toContain(
      'Port',
    );
    expect(
      brokerFehler({ ...neuerBroker(), host: '10.0.0.5', publishIntervalS: '1' }).join(' '),
    ).toContain('Sende-Abstand');
  });
});

describe('Der Ladestand (Ebene 2)', () => {
  it('kennt alle drei gebauten Methoden', () => {
    expect(SOC_METHODEN.map((m) => m.id)).toEqual(['direct', 'ocv_curve', 'coulomb']);
  });

  /** Kein Ladestand ohne Eingang - die Regel der ganzen Ebene 2. */
  it('verlangt für „gemessen übernehmen" einen zugeordneten Ladestand', () => {
    const soc = { ...neueSoc(), methode: 'direct' as const };
    expect(socFehler(soc, [zelle()]).join(' ')).toContain('zugeordnet');
    expect(socFehler(soc, [zelle({ channel: 'soc_pct', scale: '1' })])).toEqual([]);
  });

  it('verlangt für die Kennlinie eine Kurve UND eine Spannungsquelle', () => {
    const ohne = { ...neueSoc(), methode: 'ocv_curve' as const };
    expect(socFehler(ohne, [zelle()]).join(' ')).toContain('Ladekurve');
    const mit = { ...neueSoc(), methode: 'ocv_curve' as const, ...ausVorlage(VORLAGE) };
    expect(socFehler(mit, [zelle()])).toEqual([]);
    // Ohne Zellspannung und ohne Packspannung+Zellzahl rechnet niemand.
    expect(
      socFehler({ ...mit, cellsInSeries: '' }, [zelle({ channel: 'temp_max_c' })]).join(' '),
    ).toContain('Zellspannung');
  });

  it('verlangt für die Ladungszählung Kapazität, eine Leistung und einen Anker', () => {
    const soc = { ...neueSoc(), methode: 'coulomb' as const };
    const fehler = socFehler(soc, [zelle()]).join(' ');
    expect(fehler).toContain('Kapazität');
    expect(fehler).toContain('Leistung');
    expect(fehler).toContain('Startwert');
    const gut = { ...soc, capacityKwh: '80', anchorSocPct: '50' };
    expect(socFehler(gut, [zelle({ channel: 'power_kw', scale: '1' })])).toEqual([]);
  });

  /**
   * Eine Kurve, die bei STEIGENDER Spannung fällt, beschreibt keine
   * Lithium-Zelle - sie ist ein Tippfehler, der still einen falschen
   * Ladestand ausgerechnet hätte.
   */
  it('lässt eine Kennlinie nur STEIGEN', () => {
    const fallend = [
      { key: 'a', v: '3,3', soc: '40' },
      { key: 'b', v: '3,9', soc: '10' },
    ];
    expect(kurveFehler(fallend, 'Ladekurve')[0]).toContain('eine Kennlinie steigt');
  });

  it('lehnt doppelte Spannungen, halbe Punkte und unmögliche Werte ab', () => {
    expect(
      kurveFehler(
        [
          { key: 'a', v: '3,3', soc: '10' },
          { key: 'b', v: '3,3', soc: '20' },
        ],
        'Ladekurve',
      )[0],
    ).toContain('zweimal');
    expect(
      kurveFehler(
        [
          { key: 'a', v: '3,3', soc: '' },
          { key: 'b', v: '3,9', soc: '20' },
        ],
        'Ladekurve',
      )[0],
    ).toContain('Spannung UND Ladestand');
    expect(
      kurveFehler(
        [
          { key: 'a', v: '3,3', soc: '10' },
          { key: 'b', v: '99', soc: '20' },
        ],
        'Ladekurve',
      )[0],
    ).toContain('Zellspannung');
  });

  it('braucht mindestens zwei Stützpunkte, akzeptiert aber gar keine Kurve', () => {
    expect(kurveFehler([], 'Ladekurve')).toEqual([]);
    expect(kurveFehler([{ key: 'a', v: '3,3', soc: '10' }], 'Ladekurve')[0]).toContain(
      'Stützpunkte',
    );
  });

  /**
   * Dieselbe Spannung bedeutet an einer LiFePO₄-Zelle einen völlig anderen
   * Ladestand - die Vorlage muss ihre Chemie NENNEN.
   */
  it('nennt die Chemie einer Vorlage samt Warnung', () => {
    expect(chemieWort('nmc')).toBe('NMC / NCA');
    expect(chemieWort('lfp')).toBe('LiFePO₄');
    expect(chemieWort(null)).toBeNull();
    const warnung = vorlageWarnung(VORLAGE);
    expect(warnung).toContain('NMC');
    expect(warnung).toContain('3,26');
  });

  it('füllt aus einer Vorlage die Stützpunkte und die Zellzahl vor', () => {
    const aus = ausVorlage(VORLAGE);
    expect(aus.template).toBe('diybms-176s-nmc');
    expect(aus.kurveLaden).toHaveLength(3);
    expect(aus.kurveLaden?.[0].v).toBe('3,26');
    expect(aus.kurveEntladen).toHaveLength(3);
    expect(aus.cellsInSeries).toBe('176');
    expect(aus.refTempC).toBe('25');
  });
});

describe('Was an den Server geht', () => {
  it('baut den Speicher-Rumpf mit Broker, Zuordnungen und Ableitung', () => {
    const body = speicherRumpf(
      ' Pack Keller ',
      { host: ' 192.168.0.44 ', port: '1883', publishIntervalS: '15' },
      [zelle(), zelle({ channel: 'soc_pct', scale: '1', aggregate: 'last' })],
      { ...neueSoc(), methode: 'direct' },
    ) as Record<string, never>;
    expect(body.label).toBe('Pack Keller');
    expect(body.broker).toEqual({ host: '192.168.0.44', port: 1883 });
    expect(body.publishIntervalS).toBe(15);
    const mappings = body.mappings as unknown as Record<string, unknown>[];
    expect(mappings).toHaveLength(2);
    expect(mappings[0]).toMatchObject({
      channel: 'cell_min_mv',
      topic: 'diybms/bank/+/cell/+',
      path: 'voltage',
      aggregate: 'min',
      valueType: 'number',
      scale: 1000,
      offset: 0,
      staleS: 300,
    });
    expect(body.socDerivation).toMatchObject({ method: 'direct', preferDirect: true });
  });

  /**
   * Eine Ableitung ohne Eingang wäre eine Behauptung: ohne zugeordneten
   * Ladestand reist bei „gemessen übernehmen" GAR KEIN Block.
   */
  it('lässt den Ableitungs-Block weg, wenn es keine Quelle gibt', () => {
    const body = speicherRumpf('x', neuerBroker(), [zelle()], neueSoc());
    expect(body.socDerivation).toBeUndefined();
  });

  /** Ein Ja/Nein-Wert kennt keine Skalierung - 0/1 IST die Aussage. */
  it('schickt für einen Ja/Nein-Wert keine Skalierung, aber seine Wörter', () => {
    const body = speicherRumpf(
      'x',
      neuerBroker(),
      [
        zelle({
          channel: 'charge_allowed',
          valueType: 'bool',
          aggregate: 'min',
          trueValues: 'true, on',
          falseValues: 'false, off',
        }),
      ],
      neueSoc(),
    );
    const m = (body.mappings as Record<string, unknown>[])[0];
    expect(m.scale).toBeUndefined();
    expect(m.offset).toBeUndefined();
    expect(m.trueValues).toEqual(['true', 'on']);
    expect(m.falseValues).toEqual(['false', 'off']);
  });

  /** Ein „nicht gemessen"-Rohwert reist nur, wenn einer genannt wurde. */
  it('schickt den Sentinel nur, wenn er dasteht', () => {
    const ohne = speicherRumpf('x', neuerBroker(), [zelle()], neueSoc());
    expect((ohne.mappings as Record<string, unknown>[])[0].sentinel).toBeUndefined();
    const mit = speicherRumpf('x', neuerBroker(), [zelle({ sentinel: '-999' })], neueSoc());
    expect((mit.mappings as Record<string, unknown>[])[0].sentinel).toBe(-999);
  });

  it('nimmt ein deutsches Komma als Zahl an', () => {
    const body = speicherRumpf('x', neuerBroker(), [zelle({ scale: '0,001' })], neueSoc());
    expect((body.mappings as Record<string, unknown>[])[0].scale).toBe(0.001);
  });

  /** Die Vorschau fragt, was ANKOMMT - nicht, was daraus gerechnet wird. */
  it('lässt den Ableitungs-Block aus dem Vorschau-Rumpf weg', () => {
    const body = vorschauRumpf({ ...neuerBroker(), host: '10.0.0.5' }, [zelle()]);
    expect(body.socDerivation).toBeUndefined();
    expect(body.broker).toEqual({ host: '10.0.0.5', port: 1883 });
    expect((body.mappings as unknown[]).length).toBe(1);
  });

  /**
   * Ein `datetime-local` trägt keine Zeitzone. Sie unverändert weiterzureichen
   * hieße, die Box raten zu lassen - und ein um zwei Stunden verschobener
   * Anker verschiebt jede gezählte Kilowattstunde danach.
   */
  it('schickt den Anker-Zeitpunkt als eindeutigen Augenblick', () => {
    const body = speicherRumpf('x', neuerBroker(), [zelle({ channel: 'power_kw', scale: '1' })], {
      ...neueSoc(),
      methode: 'coulomb',
      capacityKwh: '80',
      anchorSocPct: '50',
      anchorAt: '2026-09-09T18:00',
    });
    const anchor = (
      (body.socDerivation as Record<string, unknown>).params as Record<string, unknown>
    ).anchor as { socPct: number; at: string };
    expect(anchor.socPct).toBe(50);
    expect(anchor.at).toBe(new Date('2026-09-09T18:00').toISOString());
    expect(anchor.at.endsWith('Z')).toBe(true);
  });

  /** Kein Zeitpunkt heißt „ab jetzt" - und reist gar nicht mit. */
  it('lässt einen leeren oder unlesbaren Anker-Zeitpunkt weg', () => {
    for (const at of ['', '   ', 'irgendwann']) {
      const body = speicherRumpf('x', neuerBroker(), [zelle({ channel: 'power_kw', scale: '1' })], {
        ...neueSoc(),
        methode: 'coulomb',
        capacityKwh: '80',
        anchorSocPct: '50',
        anchorAt: at,
      });
      const anchor = (
        (body.socDerivation as Record<string, unknown>).params as Record<string, unknown>
      ).anchor as Record<string, unknown>;
      expect(anchor, `at=${JSON.stringify(at)}`).toEqual({ socPct: 50 });
    }
  });

  it('schickt die Vorlagen-Kennung nur bei der Kennlinie mit', () => {
    const kurve = speicherRumpf('x', neuerBroker(), [zelle()], {
      ...neueSoc(),
      methode: 'ocv_curve',
      ...ausVorlage(VORLAGE),
    });
    expect((kurve.socDerivation as Record<string, unknown>).template).toBe('diybms-176s-nmc');
    const zaehlung = speicherRumpf('x', neuerBroker(), [zelle()], {
      ...neueSoc(),
      methode: 'coulomb',
      template: 'diybms-176s-nmc',
      capacityKwh: '80',
    });
    expect((zaehlung.socDerivation as Record<string, unknown>).template).toBeUndefined();
  });
});

describe('Bearbeiten: die gespeicherte Anbindung zurück ins Formular', () => {
  const gespeichert = {
    schema_version: '1.0',
    transport: 'mqtt_local',
    broker: { host: '192.168.0.44', port: 1883 },
    publish_interval_s: 20,
    mappings: [
      {
        channel: 'cell_min_mv',
        unit: 'mV',
        topic: 'diybms/bank/+/cell/+',
        path: 'voltage',
        aggregate: 'min',
        value_type: 'number',
        scale: 1000,
        offset: 0,
        stale_s: 120,
      },
      {
        channel: 'charge_allowed',
        unit: '',
        topic: 'diybms/status',
        path: 'charge',
        aggregate: 'min',
        value_type: 'bool',
        scale: 1,
        offset: 0,
        stale_s: 300,
        true_values: ['true', 'on'],
      },
    ],
    soc_derivation: {
      method: 'ocv_curve',
      prefer_direct: true,
      hold_s: 900,
      template: 'diybms-176s-nmc',
      inputs: { cell_min: 'cell_min_mv' },
      params: {
        curve_charge: [
          [3.26, 0],
          [4.18, 100],
        ],
        cells_in_series: 176,
        conservative_min: true,
        round_pct: 0.1,
        ref_temp_c: 25,
      },
    },
  };

  it('liest Broker, Zuordnungen und Ableitung zurück', () => {
    const form = ausConnection(gespeichert)!;
    expect(form.broker).toEqual({ host: '192.168.0.44', port: '1883', publishIntervalS: '20' });
    expect(form.zeilen).toHaveLength(2);
    expect(form.zeilen[0]).toMatchObject({
      channel: 'cell_min_mv',
      aggregate: 'min',
      scale: '1000',
      staleS: '120',
    });
    expect(form.zeilen[1].trueValues).toBe('true, on');
    expect(form.soc.methode).toBe('ocv_curve');
    expect(form.soc.template).toBe('diybms-176s-nmc');
    expect(form.soc.kurveLaden).toHaveLength(2);
    expect(form.soc.cellsInSeries).toBe('176');
  });

  /** Was rausgeht, kommt unverändert zurück: sonst hieße Bearbeiten Umbauen. */
  it('überlebt eine Runde Formular → Server-Form → Formular', () => {
    const form = ausConnection(gespeichert)!;
    const body = speicherRumpf('Pack', form.broker, form.zeilen, form.soc);
    expect(body.broker).toEqual({ host: '192.168.0.44', port: 1883 });
    expect((body.mappings as Record<string, unknown>[])[0]).toMatchObject({
      channel: 'cell_min_mv',
      scale: 1000,
      staleS: 120,
    });
    expect((body.socDerivation as Record<string, unknown>).method).toBe('ocv_curve');
  });

  /** Der Anker überlebt die Runde als derselbe AUGENBLICK, nicht als Zeichenkette. */
  it('liest den Anker-Zeitpunkt als Ortszeit zurück und schickt ihn unverändert wieder', () => {
    const iso = new Date('2026-09-09T18:00').toISOString();
    const form = ausConnection({
      ...gespeichert,
      soc_derivation: {
        method: 'coulomb',
        prefer_direct: true,
        hold_s: 900,
        inputs: {},
        params: { capacity_kwh: 80, conservative_min: true, anchor: { soc_pct: 50, at: iso } },
      },
    })!;
    expect(form.soc.anchorAt).toBe('2026-09-09T18:00');
    const body = speicherRumpf('Pack', form.broker, form.zeilen, form.soc);
    const anchor = (
      (body.socDerivation as Record<string, unknown>).params as Record<string, unknown>
    ).anchor as { at: string };
    expect(anchor.at).toBe(iso);
  });

  it('erkennt eine fremde Anbindung als „nicht meine"', () => {
    expect(ausConnection(null)).toBeNull();
    expect(ausConnection({ transport: 'modbus_tcp' })).toBeNull();
  });
});

describe('Live-Vorschau', () => {
  const zeilen = [zelle(), zelle({ channel: 'charge_allowed', valueType: 'bool' })];

  it('stellt Roh- und umgerechneten Wert nebeneinander', () => {
    const res = vorschauErgebnis(
      {
        results: [
          {
            id: 'batterie',
            ok: true,
            samples: [
              {
                channel: 'cell_min_mv',
                topic: 'diybms/bank/3/cell/11',
                raw: 3.393,
                value: 3393,
                count: 176,
              },
              { channel: 'charge_allowed', count: 4, raw: 1, value: 1 },
            ],
          },
        ],
      },
      zeilen,
    );
    expect(res.zustand).toBe('bestanden');
    expect(res.zeilen[0]).toMatchObject({
      label: 'Niedrigste Zellspannung',
      zustand: 'empfangen',
      roh: '3,393',
      wert: '3.393 mV',
      topic: 'diybms/bank/3/cell/11',
    });
  });

  /** „nicht gemessen" ist nie „gemessen 0". */
  it('zeigt eine Zuordnung ohne Empfang als leer - nie als 0', () => {
    const res = vorschauErgebnis(
      {
        results: [
          {
            id: 'batterie',
            ok: true,
            samples: [
              { channel: 'cell_min_mv', raw: 3.393, value: 3393, count: 5 },
              { channel: 'charge_allowed', count: 0 },
            ],
          },
        ],
      },
      zeilen,
    );
    expect(res.zeilen[1]).toMatchObject({ zustand: 'leer', roh: null, wert: null });
    expect(res.text).toContain('1 von 2');
  });

  it('sagt es, wenn im Fenster gar nichts ankam', () => {
    const res = vorschauErgebnis(
      { results: [{ id: 'batterie', ok: false, errorCode: 'no_answer', samples: [] }] },
      zeilen,
    );
    expect(res.zustand).toBe('leer');
    expect(res.text).toContain('Lauschfenster');
    expect(res.zeilen.every((z) => z.zustand === 'leer')).toBe(true);
  });

  /**
   * Ein fehlender `samples`-Block ist eine Aussage über die BOX, nie über die
   * Zuordnung - und kein Fehlschlag: die Vorschau ist ein Angebot.
   */
  it('liest eine Antwort ohne samples-Block als „diese Box kann es noch nicht"', () => {
    const res = vorschauErgebnis({ results: [{ id: 'batterie', ok: true }] }, zeilen);
    expect(res.zustand).toBe('nicht_moeglich');
    expect(res.text).toContain('noch nicht mithören');
    expect(res.text).toContain('trotzdem speichern');
  });

  it('reicht eine Ganz-Anfrage-Ablehnung als benannte Klasse durch', () => {
    const res = vorschauErgebnis({ errorCode: 'rate_limited', results: [] }, zeilen);
    expect(res.zustand).toBe('fehlgeschlagen');
    expect(res.text).toContain('zu viele Prüfungen');
    const box = vorschauErgebnis({ errorCode: 'not_supported', results: [] }, zeilen);
    expect(box.zustand).toBe('nicht_moeglich');
  });

  /** Empfangen, aber ohne auswertbare Zahl: weder ein Wert noch ein Schweigen. */
  it('zeigt eine halbe Lesung als unklar statt als Zahl', () => {
    const res = vorschauErgebnis(
      {
        results: [
          { id: 'batterie', ok: true, samples: [{ channel: 'cell_min_mv', count: 3, value: 41 }] },
        ],
      },
      [zelle()],
    );
    expect(res.zeilen[0]).toMatchObject({ zustand: 'unklar', roh: null, wert: null, count: 3 });
  });
});

describe('Prüfen & anlegen', () => {
  it('fasst zusammen, was gleich gespeichert wird', () => {
    const zeilen = [zelle(), zelle({ channel: 'soc_pct', scale: '1' })];
    const rows = pruefen(
      'Pack Keller',
      { host: '192.168.0.44', port: '1883', publishIntervalS: '15' },
      zeilen,
      { ...neueSoc(), methode: 'direct' },
    );
    expect(rows.find((r) => r.label === 'Broker')?.wert).toBe('192.168.0.44:1883');
    expect(rows.find((r) => r.label === 'Zugeordnete Messwerte')?.wert).toContain('Ladestand');
    expect(rows.find((r) => r.label === 'Ladestand')?.wert).toBe('Gemessen übernehmen');
  });

  /**
   * Eine Batterie OHNE Ladestand ist ein legitimer Zustand - die
   * Zusammenfassung sagt es, statt eine Quelle zu behaupten.
   */
  it('sagt ehrlich, wenn diese Batterie vorerst keinen Ladestand meldet', () => {
    const rows = pruefen('Pack', neuerBroker(), [zelle()], neueSoc());
    expect(rows.find((r) => r.label === 'Ladestand')?.wert).toContain('keiner');
  });
});

describe('Die SPEISER-BINDUNG (P6)', () => {
  const soc = (): ZuordnungZeile => zelle({ channel: 'soc_pct', scale: '1', aggregate: 'last' });
  const grenze = (): ZuordnungZeile =>
    zelle({ channel: 'charge_limit_a', scale: '1', aggregate: 'last' });
  const leistung = (): ZuordnungZeile =>
    zelle({ channel: 'power_kw', scale: '0,001', aggregate: 'last' });
  const anInverter = (id = 'inv-1'): BindungForm => ({
    modus: 'feeds_inverter',
    inverterEntityId: id,
  });

  /**
   * ⚠ DER Entscheid dieses Pakets (Captain E6 (a)): NICHTS geschieht von
   * selbst. Eine frisch angelegte Batterie ist ungebunden, auch wenn sie einen
   * Ladestand meldet - der Kanalname sagt nicht, WESSEN Ladestand das ist.
   */
  it('ist ohne Angabe ungebunden und speist nichts ein', () => {
    const b = neueBindung();
    expect(b.modus).toBe('unbound');
    expect(bindungsKanaele(b, [soc()], neueSoc())).toEqual([]);
    expect(bindungFehler(b, [soc()], neueSoc())).toEqual([]);
  });

  /**
   * Der Speiser gibt Ladestand und Grenzen weiter - die LEISTUNG nie: sie wird
   * am Wechselrichter gemessen, und dieselben Kilowatt zweimal zu zählen wäre
   * schlicht falsch.
   */
  it('gibt beim Speiser Ladestand und Grenzen weiter, nie die Leistung', () => {
    const zeilen = [soc(), grenze(), leistung()];
    expect(bindungsKanaele(anInverter(), zeilen, neueSoc()))
      .toEqual(['soc_pct', 'charge_limit_a']);
  });

  it('gibt bei der eigenständigen Batterie auch die Leistung weiter', () => {
    const zeilen = [soc(), leistung()];
    expect(bindungsKanaele({ modus: 'standalone', inverterEntityId: '' }, zeilen, neueSoc()))
      .toEqual(['soc_pct', 'power_kw']);
  });

  /** Ein BERECHNETER Ladestand zählt - er ist der Grund für dieses Paket. */
  it('zählt den berechneten Ladestand als einspeisbaren Kanal', () => {
    const zeilen = [zelle()];
    const s = { ...neueSoc(), methode: 'ocv_curve' as const };
    expect(bindungsKanaele({ modus: 'standalone', inverterEntityId: '' }, zeilen, s))
      .toEqual(['soc_pct']);
  });

  it('verlangt beim Speiser den Wechselrichter', () => {
    expect(bindungFehler(anInverter(''), [soc()], neueSoc())[0]).toContain('Wechselrichter');
    expect(bindungFehler(anInverter(), [soc()], neueSoc())).toEqual([]);
  });

  /**
   * Eine Bindung, die nichts einspeisen kann, wäre ein Versprechen ohne
   * Wirkung: der Kunde bindet und die Speicher-Kachel bleibt leer.
   */
  it('lehnt eine Bindung ohne einzuspeisenden Kanal ab', () => {
    expect(bindungFehler(anInverter(), [zelle()], neueSoc())[0]).toContain('noch nicht speisen');
  });

  it('schickt die Bindung IMMER mit - auch als „ungebunden"', () => {
    const offen = speicherRumpf('Pack', neuerBroker(), [soc()], neueSoc());
    expect(offen.binding).toEqual({ mode: 'unbound' });
    const gebunden = speicherRumpf('Pack', neuerBroker(), [soc()], neueSoc(), anInverter('inv-9'));
    expect(gebunden.binding).toEqual({ mode: 'feeds_inverter', inverterEntityId: 'inv-9' });
  });

  /** Ein Anschluss von VOR P6 trägt keinen Block - er ist ungebunden. */
  it('liest die gespeicherte Bindung zurück und behandelt alte Fassungen als ungebunden', () => {
    const alt = ausConnection({
      transport: 'mqtt_local',
      broker: { host: '192.168.0.5', port: 1883 },
      publish_interval_s: 15,
      mappings: [],
    });
    expect(alt?.bindung.modus).toBe('unbound');

    const neu = ausConnection({
      transport: 'mqtt_local',
      broker: { host: '192.168.0.5', port: 1883 },
      publish_interval_s: 15,
      mappings: [],
      binding: { mode: 'feeds_inverter', inverter_entity_id: 'inv-7' },
    });
    expect(neu?.bindung).toEqual({ modus: 'feeds_inverter', inverterEntityId: 'inv-7' });
  });

  /**
   * Eine Batterie an eine Batterie zu hängen wäre keine Bindung, sondern eine
   * Schleife - und sich selbst zu wählen erst recht.
   */
  it('bietet nur fremde Speicher-Wechselrichter als Ziel an', () => {
    const rows = [
      { id: 'inv-1', role: 'storage', entityType: 'battery-hybrid', label: 'Deye SUN-30K' },
      { id: 'bat-1', role: 'storage', entityType: 'user-defined-battery', label: 'DIY' },
      { id: 'pv-1', role: 'pv', entityType: 'producer', label: 'Fronius' },
      { id: 'inv-2', role: 'storage', entityType: 'battery-hybrid', label: 'Zweiter' },
    ];
    expect(speicherZiele(rows, 'inv-2')).toEqual([{ id: 'inv-1', label: 'Deye SUN-30K' }]);
  });

  it('nennt den Wechselrichter beim Namen und formuliert „Ladestand von"', () => {
    const ziele = [{ id: 'inv-1', label: 'Deye SUN-30K' }];
    expect(bindungWort(anInverter(), ziele)).toContain('Deye SUN-30K');
    expect(bindungWort({ modus: 'unbound', inverterEntityId: '' }, ziele))
      .toContain('Energiebilanz');
    expect(ladestandVon('DIY-Speicher')).toBe('Ladestand von: DIY-Speicher');
    expect(ladestandVon('   ')).toBeNull();
  });

  it('führt die Zuordnung in der Zusammenfassung', () => {
    const rows = pruefen('Pack', neuerBroker(), [soc()], neueSoc(), anInverter(),
      [{ id: 'inv-1', label: 'Deye SUN-30K' }]);
    expect(rows.find((r) => r.label === 'Speicher-Zuordnung')?.wert).toContain('Deye SUN-30K');
  });
});
