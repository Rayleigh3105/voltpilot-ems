import { describe, expect, it } from 'vitest';
import { buildGuidedFlow, type GuidedRule } from '../flows/guidedBuilder';
import type { EditorEntity } from '../flows/model';
import { VORRANG_FOLGEN, VORRANG_ZEILE } from './satz';
import {
  BLEIBT_GLEICH,
  BLOCK_TITEL,
  KEIN_FAHRPLAN,
  NICHT_ABSCHAETZBAR,
  RUECKNAHME_REGEL,
  folgenZeilen,
  regelFolgen,
  vorrangArt,
} from './folgen';

const ENTITIES: EditorEntity[] = [
  { id: 'e-batt', entityType: 'battery-hybrid', label: 'Speicher', measure: ['soc_pct'], actuate: ['setpoint_kw'] },
  { id: 'e-wb', entityType: 'wallbox', label: 'Wallbox Garage', measure: ['power_kw'], actuate: ['on_off'] },
];

function doc(action: GuidedRule['action']) {
  return buildGuidedFlow(
    {
      conditions: [{ kind: 'price', direction: 'below', threshold: 5 }],
      combinator: 'and',
      action,
    },
    'Testregel',
    's-1',
  );
}

describe('Die Folgen-Karte — die fünf Blöcke', () => {
  it('trägt IMMER alle fünf Blöcke, auch wenn wenig zu sagen ist', () => {
    const k = regelFolgen({ name: 'Wallbox bei Überschuss', satz: null, art: 'geraet' });
    expect(k.bloecke.map((b) => b.key)).toEqual([
      'passiert', 'fahrplan', 'risiko', 'gleich', 'ende',
    ]);
    for (const b of k.bloecke) {
      expect(b.titel).toBe(BLOCK_TITEL[b.key]);
      expect(b.zeilen.length).toBeGreaterThan(0);
    }
  });

  it('nimmt den Klartext-Satz der Regel als Intro — sonst einen ehrlichen Ersatz', () => {
    const mit = regelFolgen({
      name: 'Heizstab mittags',
      satz: 'Wenn der Börsenpreis unter 5 ct/kWh liegt, schaltet VoltPilot den Heizstab ein.',
      art: 'geraet',
    });
    expect(mit.intro).toContain('Heizstab');
    const ohne = regelFolgen({ name: 'Eigene Regel', satz: null, art: 'geraet' });
    expect(ohne.intro).toContain('Eigene Regel');
    expect(ohne.intro).toContain('aktiv');
  });

  it('nennt die Regel beim Namen — im Titel und auf dem Knopf', () => {
    const k = regelFolgen({ name: 'Wallbox bei Überschuss', satz: null, art: 'geraet' });
    expect(k.titel).toContain('Wallbox bei Überschuss');
    expect(k.bestaetigen).toBe('Regel aktivieren');
  });
});

describe('Die Folgen-Karte — die Zahl wird NICHT erfunden', () => {
  it('sagt für die Fahrplan-Auswirkung „nicht abschätzbar" MIT Grund', () => {
    const k = regelFolgen({ name: 'R', satz: null, art: 'geraet' });
    const fp = k.bloecke.find((b) => b.key === 'fahrplan')!;
    expect(fp.zeilen[0]).toBe(NICHT_ABSCHAETZBAR);
    expect(fp.zeilen[0]).toMatch(/[Nn]icht abschätzbar/);
    // Kein Euro-Betrag, keine kWh — nichts, was niemand gerechnet hat.
    expect(fp.zeilen.join(' ')).not.toMatch(/\d+[,.]\d+\s*(€|kWh)/);
  });

  it('sagt bei fehlendem Fahrplan den ANDEREN Grund', () => {
    const k = regelFolgen({ name: 'R', satz: null, art: 'geraet', hatFahrplan: false });
    expect(k.bloecke.find((b) => b.key === 'fahrplan')!.zeilen[0]).toBe(KEIN_FAHRPLAN);
  });

  it('behauptet mit vorhandenem Fahrplan nicht mehr als ohne', () => {
    const a = regelFolgen({ name: 'R', satz: null, art: 'geraet', hatFahrplan: true });
    const b = regelFolgen({ name: 'R', satz: null, art: 'geraet' });
    expect(a.bloecke).toEqual(b.bloecke);
  });
});

describe('Die Folgen-Karte — der Vorrang-Hinweis ist nach der Sache getrennt', () => {
  it('sagt auf einer GERÄTE-Regel „Ihre Regel geht vor"', () => {
    const k = regelFolgen({ name: 'R', satz: null, art: 'geraet' });
    const risiko = k.bloecke.find((b) => b.key === 'risiko')!;
    expect(risiko.zeilen[0]).toBe(VORRANG_FOLGEN.geraet);
    expect(risiko.zeilen[0]).toContain('Ihre Regel geht vor');
    // Variante 1: das konkrete Beispiel UND der Rückweg stehen im Satz.
    expect(risiko.zeilen[0]).toContain('ausschalten');
  });

  it('behauptet auf einer SPEICHER-Regel NICHT, dass die Regel vorgeht', () => {
    const k = regelFolgen({ name: 'R', satz: null, art: 'speicher' });
    const risiko = k.bloecke.find((b) => b.key === 'risiko')!.zeilen[0];
    expect(risiko).toBe(VORRANG_FOLGEN.speicher);
    expect(risiko).not.toContain('Ihre Regel geht vor');
    expect(risiko).toContain('Fahrplan vor');
    // Auch hier: der Rückweg gehört in den Satz.
    expect(risiko).toContain('ausschalten');
  });

  it('die Zeile unter dem Schalter (Variante 3) ist die BEDINGTE Kurzform', () => {
    expect(VORRANG_ZEILE.geraet).toContain('Greift die Regel');
    expect(VORRANG_ZEILE.speicher).toContain('Fahrplan vor Regel');
    // Nie eine Live-Behauptung („bremst gerade").
    for (const z of Object.values(VORRANG_ZEILE)) {
      expect(z).not.toMatch(/gerade|seit \d/);
    }
  });

  it('erkennt die beanspruchte Sache aus dem Dokument', () => {
    expect(vorrangArt(doc({ kind: 'setpoint', entityId: 'e-batt', value: 3, ttlS: 300 }), ENTITIES))
      .toBe('speicher');
    expect(vorrangArt(doc({ kind: 'onoff', entityId: 'e-wb', ttlS: 300 }), ENTITIES))
      .toBe('geraet');
    // Ohne Dokument wird nichts über den Speicher behauptet.
    expect(vorrangArt(null, ENTITIES)).toBe('geraet');
  });
});

describe('Die Folgen-Karte — was gleich bleibt und wie man zurückkommt', () => {
  it('nennt ausdrücklich, was KEINE Regel aushebelt', () => {
    const k = regelFolgen({ name: 'R', satz: null, art: 'geraet' });
    const gleich = k.bloecke.find((b) => b.key === 'gleich')!;
    expect(gleich.zeilen).toEqual(BLEIBT_GLEICH);
    expect(gleich.zeilen.join(' ')).toContain('14a');
    expect(gleich.zeilen.join(' ')).toContain('Geräteschutz');
  });

  it('nennt den Rückweg', () => {
    const k = regelFolgen({ name: 'R', satz: null, art: 'geraet' });
    expect(k.bloecke.find((b) => b.key === 'ende')!.zeilen[0]).toBe(RUECKNAHME_REGEL);
  });
});

describe('Die Folgen-Karte im Haus-Dialog', () => {
  it('reicht die Blöcke als Folgenliste durch — ohne den Intro-Block doppelt', () => {
    const k = regelFolgen({ name: 'R', satz: 'Wenn X, dann Y.', art: 'geraet' });
    const zeilen = folgenZeilen(k);
    expect(zeilen[0]).toContain(BLOCK_TITEL.fahrplan);
    expect(zeilen.some((z) => z.startsWith(BLOCK_TITEL.passiert))).toBe(false);
    // Jede Block-Überschrift genau einmal, Folgezeilen ohne Wiederholung.
    expect(zeilen.filter((z) => z.startsWith(BLOCK_TITEL.gleich))).toHaveLength(1);
    expect(zeilen).toHaveLength(1 + 1 + BLEIBT_GLEICH.length + 1);
  });
});
