import { describe, expect, it } from 'vitest';
import { KUNDENROLLEN } from './benutzer';
import { benutzerTon, benutzerWorte, ROLLE_BESCHREIBUNG } from './benutzerWorte';
import { ROLLE_KUNDENWORT, type Rolle } from './rechte';

describe('Benutzer-Seite · Wörter nach dem Anwendungsprofil (Privat-Nebenbefund 5)', () => {
  it('Haushaltssicht nur, wenn jede Anlage privat ist', () => {
    expect(benutzerTon([{ profil: 'privat' }])).toBe('privat');
    expect(benutzerTon([{ profil: 'privat' }, { profil: 'privat' }])).toBe('privat');
    expect(benutzerTon([{ profil: 'privat' }, { profil: 'gewerbe' }])).toBe('gewerbe');
    expect(benutzerTon([{ profil: 'privat' }, { profil: null }])).toBe('gewerbe');
    expect(benutzerTon([{}])).toBe('gewerbe');
    expect(benutzerTon([])).toBe('gewerbe');
    expect(benutzerTon(undefined)).toBe('gewerbe');
  });

  it('Gewerbe bleibt zeichengleich: Kundenwort und Beschreibung wie bisher', () => {
    const w = benutzerWorte('gewerbe');
    for (const r of KUNDENROLLEN) {
      expect(w.rolle(r.value)).toBe(ROLLE_KUNDENWORT[r.value as Rolle]);
      expect(w.beschreibung(r.value)).toBe(ROLLE_BESCHREIBUNG[r.value]);
    }
    expect(w.orte).toBe('Standorte');
    expect(w.giltFuerAlle).toBe('Gilt für alle Standorte des Unternehmens, auch künftige.');
  });

  it('Privat: keine Gewerbe-Wörter in Rollen, Beschreibungen und Geltungsbereich', () => {
    const w = benutzerWorte('privat');
    const gewerbe = /Energiemanager|Bearbeiter|Kundenadministrator|Unternehmen|Standort|Kolleg|Leitung|Prüfende/;
    for (const r of KUNDENROLLEN) {
      expect(w.rolle(r.value), r.value).not.toMatch(gewerbe);
      expect(w.beschreibung(r.value), r.value).toBeTruthy();
      expect(w.beschreibung(r.value), r.value).not.toMatch(gewerbe);
    }
    for (const [k, v] of Object.entries(w)) {
      if (typeof v === 'string') expect(v, k).not.toMatch(gewerbe);
    }
    // Jede zuweisbare Rolle hat einen eigenen Namen - der Wähler bleibt eindeutig.
    const namen = KUNDENROLLEN.map((r) => w.rolle(r.value));
    expect(new Set(namen).size).toBe(namen.length);
  });
});
