import { describe, expect, it } from 'vitest';
import type { ControlCertification } from './admin/adminApi';
import {
  activateConsequences,
  certSourceLabel,
  deactivateConsequences,
  isoDate,
  plantCertView,
  registerRows,
  registerSummary,
  revokeConsequences,
} from './controlCertification';

const deye: ControlCertification = {
  brand: 'deye',
  model: 'sun-30k-sg01hp3',
  family: 'hybrid_3p',
  controlPath: 'remote',
  invertControlSign: null,
  certifiedAt: '2026-07-27T14:05:00Z',
  firmwareNote: 'Protokoll V105.1+',
  note: 'Prüfstand Pilsting',
  createdAt: '2026-08-10T09:00:00Z',
  createdBy: 'admin',
};

describe('plantCertView - vier Situationen, vier Sätze', () => {
  it('nennt „ein Klick", wenn das Modell gedeckt ist', () => {
    const v = plantCertView(false, 'covered_not_activated');
    expect(v.state).toBe('bereit');
    expect(v.canActivate).toBe(true);
    expect(v.hint).toMatch(/Aktivierung/);
  });

  it('nennt den Prüfstand, wenn das Modell NICHT gedeckt ist - und bietet keinen Klick', () => {
    const v = plantCertView(false, 'not_covered');
    expect(v.state).toBe('pruefstand');
    expect(v.canActivate).toBe(false);
    expect(v.hint).toMatch(/Prüfstandslauf/);
  });

  it('behauptet ohne Meldung NICHTS und verweigert trotzdem nichts', () => {
    for (const verdict of [null, undefined, 'unknown' as const]) {
      const v = plantCertView(false, verdict);
      expect(v.state).toBe('unbekannt');
      // ⚠ „unbekannt" darf nie wie „Prüfstand nötig" wirken: der Klick bleibt.
      expect(v.canActivate).toBe(true);
      expect(v.hint).toMatch(/noch nicht gemeldet/);
    }
  });

  it('sagt bei einer scharfen Anlage ohne gedecktes Modell ehrlich, dass nichts steuert', () => {
    const v = plantCertView(true, 'not_covered');
    expect(v.tone).toBe('warn');
    expect(v.hint).toMatch(/steuert deshalb nicht/);
    expect(v.canActivate).toBe(false);
  });

  it('ist bei einer laufenden Anlage ruhig und ohne Aufgabe', () => {
    const v = plantCertView(true, 'granted');
    expect(v.state).toBe('aktiv');
    expect(v.tone).toBe('ok');
    expect(v.hint).toBe('');
    expect(v.canActivate).toBe(false);
  });
});

describe('registerRows', () => {
  it('benennt den Steuerpfad in Worten und lässt eine fehlende Aussage WEG', () => {
    const [r] = registerRows([deye]);
    expect(r.model).toBe('sun-30k-sg01hp3');
    expect(r.pathLabel).toBe('Remote-Register');
    // ⚠ Ohne Prüfstands-Aussage steht dort NICHTS - „nicht umgekehrt" wäre
    // eine Behauptung über einen Lauf, der die Frage nie beantwortet hat.
    expect(r.signLabel).toBe('');
    expect(r.certifiedAt).toBe('27.07.2026');
    expect(r.note).toContain('V105.1');
  });

  it('benennt eine vorhandene Vorzeichen-Aussage in BEIDE Richtungen', () => {
    expect(registerRows([{ ...deye, invertControlSign: false }])[0].signLabel)
      .toBe('nicht umgekehrt');
    expect(registerRows([{ ...deye, invertControlSign: true }])[0].signLabel)
      .toBe('umgekehrt');
  });

  it('sortiert die neueste Zertifizierung nach oben', () => {
    const older: ControlCertification = { ...deye, model: 'alt', certifiedAt: '2026-01-01T00:00:00Z' };
    expect(registerRows([older, deye]).map((r) => r.model)).toEqual(['sun-30k-sg01hp3', 'alt']);
  });
});

describe('registerSummary', () => {
  it('sagt AUSDRÜCKLICH, dass ein Eintrag allein nichts steuert', () => {
    const s = registerSummary([deye], 3);
    expect(s).toContain('1 Modell');
    expect(s).toContain('3 Anlagen');
    expect(s).toMatch(/steuert nichts/);
  });

  it('ist beim leeren Register ehrlich statt leer', () => {
    expect(registerSummary([], 0)).toMatch(/Noch kein Modell/);
  });
});

describe('Folgenlisten', () => {
  it('nennt beim Aktivieren, was GLEICH bleibt - sonst liest es sich wie ein Lockern', () => {
    const list = activateConsequences('Mienbach');
    expect(list.join(' ')).toContain('Mienbach');
    expect(list.join(' ')).toMatch(/Schutzgrenzen bleiben unverändert/);
    expect(list.join(' ')).toMatch(/§ 14a/);
    expect(list.join(' ')).toMatch(/zurücknehmen/);
  });

  it('sagt beim Zurücknehmen, dass das MODELL im Register bleibt', () => {
    const list = deactivateConsequences('Mienbach');
    expect(list.join(' ')).toMatch(/nur noch ausgelesen/);
    expect(list.join(' ')).toMatch(/bleibt im Register/);
  });

  it('warnt beim Register-Widerruf mit der Zahl betroffener Anlagen', () => {
    expect(revokeConsequences('sun-30k', 2).join(' ')).toContain('2 Anlagen');
    // Ohne scharfe Anlage wird keine Zahl erfunden.
    expect(revokeConsequences('sun-30k', 0).join(' ')).not.toMatch(/Anlagen scharfgeschaltet/);
    // Und die First-Light-Freigabe am Gerät bleibt - das ist die Wahrheit.
    expect(revokeConsequences('sun-30k', 0).join(' ')).toMatch(/First-Light-Freigabe bleibt/);
  });
});

describe('kleine Helfer', () => {
  it('übersetzt die Quelle, erfindet aber nichts', () => {
    expect(certSourceLabel('platform')).toBe('Register');
    expect(certSourceLabel('device')).toBe('Am Gerät freigegeben');
    expect(certSourceLabel(null)).toBe('');
    expect(certSourceLabel('telepathie')).toBe('');
  });

  it('formatiert ein Datum nur, wenn es eines IST', () => {
    expect(isoDate('2026-07-27T14:05:00Z')).toBe('27.07.2026');
    expect(isoDate(null)).toBe('');
    expect(isoDate('irgendwann')).toBe('');
  });
});
