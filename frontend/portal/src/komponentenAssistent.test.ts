import { describe, expect, it } from 'vitest';
import {
  ABSCHLUSS_HINWEIS,
  ROLLEN,
  ablehnungText,
  bilanzHinweis,
  fehlendeFelder,
  felder,
  initialeVerbindung,
  marken,
  messwerte,
  nameHilfe,
  nameVorschau,
  pruefen,
  rolleVerfuegbar,
  sollIstText,
  sollIstTon,
  templatesFuerTuer,
  testErgebnis,
  testFehlerText,
  tueren,
  uebernahmeHinweis,
  type ComponentMatch,
  type ComponentTemplate,
  verwaltungsHinweis,
} from './komponentenAssistent';

const deye: ComponentTemplate = {
  templateRef: 'builtin:deye:sun-30k-sg01hp3',
  kind: 'builtin',
  version: 1,
  brand: 'deye',
  brandLabel: 'Deye',
  model: 'sun-30k-sg01hp3',
  modelLabel: 'SUN-30K-SG01HP3-EU',
  family: 'hybrid_3p',
  familyLabel: 'Hybrid, 3-phasig',
  communication: 'solarman_v5',
  communicationLabel: 'Solarman-V5 (WiFi-Datenlogger, TCP 8899)',
  transportSchema: [
    { key: 'ip', label: 'IP-Adresse des Datenloggers', type: 'text', required: true },
    { key: 'port', label: 'Port', type: 'number', default: 8899 },
    { key: 'serial', label: 'Datenlogger-Seriennummer', type: 'text', required: true },
    { key: 'invert_grid_sign', label: 'Netz-Vorzeichen invertieren', type: 'checkbox' },
    {
      key: 'power_scale',
      label: 'Leistungsskalierung',
      type: 'select',
      default: 0,
      options: [
        { value: 0, label: 'Automatisch (empfohlen)' },
        { value: 10, label: 'Dekawatt (×10)' },
      ],
    },
  ],
};

const fronius: ComponentTemplate = {
  ...deye,
  templateRef: 'builtin:fronius_sunspec:fronius-eco-27-3-s',
  brand: 'fronius_sunspec',
  brandLabel: 'Fronius (Modbus / SunSpec)',
  model: 'fronius-eco-27-3-s',
  modelLabel: 'Fronius Eco 27.0-3-S',
  communication: 'fronius_sunspec',
  communicationLabel: 'SunSpec über Modbus TCP',
  transportSchema: [{ key: 'ip', label: 'IP-Adresse', type: 'text', required: true }],
};

const geprueft: ComponentTemplate = { ...fronius, templateRef: 'certified:x:y', kind: 'certified' };

describe('die drei Türen', () => {
  it('öffnet die Selbstbau-Tür - seit Stufe 3 ist sie begehbar', () => {
    const t = tueren([deye]);
    const selbstbau = t.find((d) => d.id === 'selbstbau')!;
    expect(selbstbau.verfuegbar).toBe(true);
    // ⚠ Kein „bald verfügbar" mehr: sie führt jetzt wirklich irgendwohin, und
    // ein Hinhalte-Satz an einer offenen Tür wäre eine Falschaussage.
    expect(selbstbau.bald).toBeUndefined();
    expect(selbstbau.label).toContain('Eigenes Gerät');
    // Sie hängt an KEINER Vorlage - genau deshalb gibt es sie.
    expect(tueren([]).find((d) => d.id === 'selbstbau')!.verfuegbar).toBe(true);
  });

  it('sagt bei leerer Vorlagen-Liste ehrlich, dass sie leer IST', () => {
    const t = tueren([deye]);
    const vorlage = t.find((d) => d.id === 'vorlage')!;
    expect(vorlage.verfuegbar).toBe(false);
    expect(vorlage.hint).toContain('Liste leer');
  });

  it('öffnet die Vorlagen-Tür, sobald es geprüfte Vorlagen gibt', () => {
    const t = tueren([deye, geprueft]);
    expect(t.find((d) => d.id === 'vorlage')!.verfuegbar).toBe(true);
    expect(templatesFuerTuer([deye, geprueft], 'vorlage')).toEqual([geprueft]);
    expect(templatesFuerTuer([deye, geprueft], 'katalog')).toEqual([deye]);
  });

  it('gruppiert die Katalog-Vorlagen alphabetisch nach Marke', () => {
    const m = marken([fronius, deye]);
    expect(m.map((b) => b.brand)).toEqual(['deye', 'fronius_sunspec']);
    expect(m[0].models).toEqual([deye]);
  });
});

describe('das Formular kommt aus der Vorlage, nicht aus dem Code', () => {
  it('rendert genau die Felder des transport_schema', () => {
    expect(felder(deye).map((f) => f.key)).toEqual([
      'ip',
      'port',
      'serial',
      'invert_grid_sign',
      'power_scale',
    ]);
    // Ein neues Gerät braucht damit KEINE Portal-Änderung.
    expect(felder(fronius).map((f) => f.key)).toEqual(['ip']);
  });

  it('belegt nur vor, was die Vorlage vorgibt', () => {
    expect(initialeVerbindung(deye)).toEqual({ port: 8899, power_scale: 0 });
  });

  it('behandelt eine Vorlage ohne Schema als leeres Formular', () => {
    expect(felder({ ...deye, transportSchema: null })).toEqual([]);
    expect(felder(null)).toEqual([]);
    expect(initialeVerbindung(null)).toEqual({});
  });

  it('nennt genau die fehlenden PFLICHTfelder', () => {
    expect(fehlendeFelder(deye, {}).map((f) => f.key)).toEqual(['ip', 'serial']);
    expect(fehlendeFelder(deye, { ip: '192.168.0.28', serial: '2985159064' })).toEqual([]);
  });

  it('wertet Leerzeichen als leer, aber `false` als WERT', () => {
    expect(fehlendeFelder(deye, { ip: '   ', serial: 'x' }).map((f) => f.key)).toEqual(['ip']);
    const pflichtCheckbox = {
      ...deye,
      transportSchema: [{ key: 'flag', label: 'Flag', type: 'checkbox', required: true }],
    };
    // false ist eine Antwort, keine Lücke.
    expect(fehlendeFelder(pflichtCheckbox, { flag: false })).toEqual([]);
    expect(fehlendeFelder(pflichtCheckbox, {}).map((f) => f.key)).toEqual(['flag']);
  });
});

describe('das Testergebnis', () => {
  it('ist ein Ja nur bei einer ok-Zeile ohne Gesamt-Ablehnung', () => {
    const r = testErgebnis({ results: [{ ok: true, reading: { pvKw: 12.4, socPct: 87 } }] });
    expect(r.zustand).toBe('bestanden');
    expect(r.messwerte.map((m) => m.label)).toEqual(['Solarleistung', 'Ladestand']);
  });

  it('nennt jede Fehlerklasse beim deutschen Namen', () => {
    expect(testErgebnis({ errorCode: 'timeout' }).zustand).toBe('fehlgeschlagen');
    expect(testErgebnis({ errorCode: 'timeout' }).text).toContain('nicht rechtzeitig');
    expect(testErgebnis({ results: [{ ok: false, errorCode: 'unreachable' }] }).text).toContain(
      'antwortet nichts',
    );
  });

  it('erfindet zu einem unbekannten Code KEINE Erklärung', () => {
    expect(testFehlerText('brandneu', 'Serversatz.')).toBe('Serversatz.');
    expect(testFehlerText('brandneu', null)).toBe('Die Prüfung ist fehlgeschlagen.');
  });

  it('ist eine leere Antwort NIE ein Ja', () => {
    expect(testErgebnis({ results: [] }).zustand).toBe('fehlgeschlagen');
    expect(testErgebnis(null).zustand).toBe('fehlgeschlagen');
  });

  it('zeigt nur Kanäle, die das Gerät WIRKLICH meldet - nie eine 0', () => {
    expect(messwerte({ pvKw: 3.1 }).map((m) => m.label)).toEqual(['Solarleistung']);
    expect(messwerte({ pvKw: null, loadKw: 0 }).map((m) => m.label)).toEqual(['Verbrauch']);
    expect(messwerte(null)).toEqual([]);
  });

  it('meldet ein Ja ohne Messwerte ehrlich als „antwortet"', () => {
    const r = testErgebnis({ results: [{ ok: true, reading: {} }] });
    expect(r.zustand).toBe('bestanden');
    expect(r.messwerte).toEqual([]);
    expect(r.text).toBe('Das Gerät antwortet.');
  });
});

describe('Rolle + Bilanz', () => {
  it('bietet die vier Rollen des Assistenten', () => {
    expect(ROLLEN.map((r) => r.id)).toEqual([
      'inverter',
      'pv-generation',
      'grid-meter',
      'consumer',
    ]);
  });

  it('sagt beim Verbraucher, dass er NICHT doppelt gezählt wird', () => {
    expect(bilanzHinweis('consumer')).toContain('bereits enthalten');
    expect(bilanzHinweis('pv-generation')).toContain('addiert');
  });

  it('nennt die 0-1-Regel des Netz-Zählers VOR dem Klick', () => {
    expect(rolleVerfuegbar('grid-meter', ['pv-generation'])).toEqual({ ok: true });
    const gesperrt = rolleVerfuegbar('grid-meter', ['grid-meter']);
    expect(gesperrt.ok).toBe(false);
    expect(gesperrt.ok === false && gesperrt.grund).toContain('nur einer');
  });
});

describe('Prüfen & Abschluss', () => {
  it('zeigt Name, Gerät, Art und jedes gefüllte Verbindungsfeld', () => {
    const rows = pruefen(deye, 'inverter', ' Dach Süd ', {
      ip: '192.168.0.28',
      port: 8899,
      serial: '2985159064',
      invert_grid_sign: false,
      power_scale: 10,
    });
    const map = Object.fromEntries(rows.map((r) => [r.label, r.wert]));
    expect(map.Name).toBe('Dach Süd');
    expect(map.Art).toBe('Wechselrichter / Speicher');
    // Ein Kontrollkästchen auf `false` ist keine Angabe und steht nicht da.
    expect(rows.some((r) => r.label.includes('Vorzeichen'))).toBe(false);
    // Eine Auswahl erscheint mit ihrem KLARTEXT, nie mit ihrem Rohwert.
    expect(map.Leistungsskalierung).toBe('Dekawatt (×10)');
  });

  it('fällt ohne eigenen Namen auf das Modell zurück', () => {
    expect(pruefen(deye, 'pv-generation', '  ', {})[0].wert).toBe('SUN-30K-SG01HP3-EU');
  });

  it('behauptet am Ende KEINE Zustellung, die niemand gemessen hat', () => {
    expect(ABSCHLUSS_HINWEIS).toContain('sobald sie das nächste Mal');
    expect(ABSCHLUSS_HINWEIS).not.toMatch(/fertig|übernommen\b/i);
  });
});

describe('Soll/Ist', () => {
  it('nennt die laufende Fassung, wenn Soll und Ist übereinstimmen', () => {
    expect(sollIstText('in_sync', 3)).toBe('Läuft auf dem Gerät · Fassung 3');
    expect(sollIstTon('in_sync')).toBe('ok');
  });

  it('sagt bei einer offenen Änderung „unterwegs"', () => {
    expect(sollIstText('pending', 4)).toContain('unterwegs');
    expect(sollIstTon('pending')).toBe('busy');
  });

  it('liest ein Schweigen als UNBEKANNT, nie als „nicht angekommen"', () => {
    expect(sollIstText('unreported', 1)).toBe('Stand auf dem Gerät unbekannt');
    expect(sollIstText(undefined, 1)).toBe('Stand auf dem Gerät unbekannt');
    expect(sollIstTon(null)).toBe('unbekannt');
  });

  it('nennt bei einer Ablehnung BEIDES: dass der alte Stand läuft UND warum', () => {
    const t = ablehnungText('r7', 'Wechselrichter "x": Unbekannte Marke.')!;
    expect(t).toContain('vorherige Stand');
    expect(t).toContain('Unbekannte Marke');
  });

  it('behauptet ohne Ablehnung nichts', () => {
    expect(ablehnungText(null, 'egal')).toBeNull();
    expect(ablehnungText(undefined, undefined)).toBeNull();
  });
});

// --- Einheitsmodell Stufe 2: wo wird gepflegt? -------------------------------

describe('verwaltungsHinweis', () => {
  it('sagt einer box-verwalteten Anlage, dass sie noch wartet - und dass sie nichts tun muss', () => {
    const text = verwaltungsHinweis('box', null);
    expect(text).toBeTruthy();
    // Ohne diesen Satz wäre die Abwesenheit des Assistenten unerklärlich.
    expect(text).toMatch(/Box/);
    expect(text).toMatch(/nichts tun/);
  });

  it('erklärt eine ÜBERNOMMENE Anlage - inklusive der Zusage, dass am Gerät nichts passiert ist', () => {
    const text = verwaltungsHinweis('portal', '2026-08-12T09:00:00Z');
    expect(text).toBeTruthy();
    expect(text).toMatch(/im Portal gepflegt/);
    expect(text).toMatch(/nichts geändert/);
  });

  it('schweigt bei einer Anlage, die immer schon im Portal entstanden ist', () => {
    // Portal-verwaltet OHNE Übernahme: es gibt nichts zu erklären, also wird
    // nichts behauptet.
    expect(verwaltungsHinweis('portal', null)).toBeNull();
    expect(verwaltungsHinweis('portal', undefined)).toBeNull();
  });

  it('liest alles, was nicht wörtlich portal ist, als box (die Autoritäts-Regel des Hauses)', () => {
    for (const authority of [null, undefined, '', 'BOX', 'irgendwas-neues']) {
      expect(verwaltungsHinweis(authority, null)).toMatch(/Box/);
    }
  });
});

// --- Alias-Kontinuität: die verwaiste Komponente wird ÜBERNOMMEN --------------
// Live-Fall Anlage Pilsting/Herzogau, 20.08.2026 (Captain: „beim neu hinzufügen
// sind die Aliase jetzt weg").

describe('Übernahme statt Verdopplung', () => {
  const benannt: ComponentMatch = {
    entityId: 'wr1',
    label: 'Fronius Anlage WR1',
    role: 'pv-generation',
    brand: 'fronius_sunspec',
    model: 'fronius-eco-27-3-s',
    orphaned: true,
  };

  it('nameVorschau: ein leeres Feld ÜBERSCHREIBT den Kundennamen nie', () => {
    expect(nameVorschau(fronius, '', benannt)).toBe('Fronius Anlage WR1');
    expect(nameVorschau(fronius, '   ', benannt)).toBe('Fronius Anlage WR1');
  });

  it('nameVorschau: ein getippter Name gewinnt', () => {
    expect(nameVorschau(fronius, ' Dach Süd ', benannt)).toBe('Dach Süd');
  });

  it('nameVorschau: ohne Übernahme und ohne Eingabe steht der Modellname als Vorschau', () => {
    expect(nameVorschau(fronius, '', null)).toBe(fronius.modelLabel);
    expect(nameVorschau(fronius, '', { entityId: 'x', label: null })).toBe(fronius.modelLabel);
  });

  it('uebernahmeHinweis nennt den bisherigen Namen und sagt, was erhalten bleibt', () => {
    const text = uebernahmeHinweis(benannt, fronius)!;
    expect(text).toContain('Fronius Anlage WR1');
    expect(text).toMatch(/Verbindung zu diesem Gerät war unterbrochen/);
    expect(text).toMatch(/statt eine zweite anzulegen/);
    expect(text).toMatch(/Name, Verlauf und Zuordnungen bleiben erhalten/);
  });

  it('uebernahmeHinweis erfindet keinen Namen, wenn die Zeile keinen trägt', () => {
    const text = uebernahmeHinweis({ entityId: 'x', label: null, orphaned: false }, fronius)!;
    expect(text).toMatch(/eine Komponente, die Sie schon angelegt haben/);
    expect(text).toMatch(/noch keinem Gerät zugeordnet/);
    expect(text).not.toContain('„"');
  });

  it('ohne Übernahme wird nichts behauptet', () => {
    expect(uebernahmeHinweis(null, fronius)).toBeNull();
    expect(uebernahmeHinweis(undefined, fronius)).toBeNull();
  });

  it('nameHilfe sagt, was ein LEERES Feld bedeutet', () => {
    expect(nameHilfe(benannt)).toContain('Fronius Anlage WR1');
    expect(nameHilfe(benannt)).toMatch(/Leer lassen/);
    expect(nameHilfe(null)).toMatch(/Marke und Modell/);
  });

  it('pruefen zeigt die Übernahme - und die Namens-Vorschau, die daraus folgt', () => {
    const rows = pruefen(fronius, 'pv-generation', '', {}, benannt);
    expect(rows.find((r) => r.label === 'Komponente')?.wert)
      .toBe('Vorhandene Komponente wird wieder verbunden');
    expect(rows.find((r) => r.label === 'Name')?.wert).toBe('Fronius Anlage WR1');
    // Ohne Übernahme bleibt die Liste unverändert (kein neuer Eintrag).
    const ohne = pruefen(fronius, 'pv-generation', '', {});
    expect(ohne.some((r) => r.label === 'Komponente')).toBe(false);
    expect(ohne.find((r) => r.label === 'Name')?.wert).toBe(fronius.modelLabel);
  });
});
