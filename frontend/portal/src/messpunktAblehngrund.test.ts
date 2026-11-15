import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLGEMEINER_GRUND, BEKANNTE_GRUENDE, ablehngrundText } from './messpunktAblehngrund';

/**
 * Je Grund ein Fall (Befund PR 1886: `edge_too_old` lief roh bis zum Kunden durch).
 * Der letzte Fall gleicht die übersetzte Liste gegen den Vertrag ab, damit ein
 * neuer Server-Grund ohne Übersetzung hier auffällt, statt roh beim Kunden zu landen.
 */
const VERTRAG = JSON.parse(readFileSync(
  resolve(process.cwd(), '../../docs/contracts/v2/mqtt-measurement-config-status.schema.json'), 'utf8',
)) as { $defs: { rejection: { properties: { reason: { enum: string[] } } } } };
const VERTRAGS_GRUENDE: string[] = VERTRAG.$defs.rejection.properties.reason.enum;

describe('messpunktAblehngrund · jeder Server-Grund bekommt einen verständlichen deutschen Satz', () => {
  it('unknown_point', () => {
    expect(ablehngrundText('unknown_point')).toBe('Dieser Punkt ist der VoltPilot-Box unbekannt.');
  });

  it('unsupported_catalog - nennt die automatische Nachlieferung, keinen Kunden-Schritt', () => {
    expect(ablehngrundText('unsupported_catalog')).toContain('liefert ihn automatisch');
  });

  it('edge_too_old - nennt das Update der Box als nächsten Schritt', () => {
    expect(ablehngrundText('edge_too_old')).toContain('Update der Box einspielen');
  });

  it('invalid_cadence - nennt die Kadenz als nächsten Schritt', () => {
    expect(ablehngrundText('invalid_cadence')).toContain('andere Kadenz wählen');
  });

  it('budget_samples', () => {
    expect(ablehngrundText('budget_samples')).toContain('Werte-Budget der Box');
  });

  it('budget_requests', () => {
    expect(ablehngrundText('budget_requests')).toContain('Abfrage-Budget der Box');
  });

  it('budget_duty_cycle', () => {
    expect(ablehngrundText('budget_duty_cycle')).toContain('Bus-Auslastung der Box');
  });

  it('driver_unavailable', () => {
    expect(ablehngrundText('driver_unavailable')).toContain('keinen Treiber');
  });

  it('ocpp_configuration_incompatible', () => {
    expect(ablehngrundText('ocpp_configuration_incompatible')).toContain('OCPP-Konfiguration');
  });

  it('binding_unavailable - nennt die Selbstheilung, keinen Kunden-Schritt', () => {
    expect(ablehngrundText('binding_unavailable')).toContain('von selbst');
  });

  it('ein unbekannter Code, null und ein leerer Code fallen auf den allgemeinen Satz zurück - nie roh', () => {
    expect(ablehngrundText('ein_kuenftiger_server_grund')).toBe(ALLGEMEINER_GRUND);
    expect(ablehngrundText(null)).toBe(ALLGEMEINER_GRUND);
    expect(ablehngrundText(undefined)).toBe(ALLGEMEINER_GRUND);
  });

  it('kein übersetzter Satz enthält selbst wieder einen rohen Code', () => {
    for (const grund of VERTRAGS_GRUENDE) {
      expect(ablehngrundText(grund)).not.toBe(grund);
    }
  });

  it('die Liste deckt GENAU die geschlossene Wortliste des Vertrags ab - '
    + 'ein neuer Server-Grund ohne Übersetzung fällt hier auf', () => {
    expect(new Set(BEKANNTE_GRUENDE)).toEqual(new Set(VERTRAGS_GRUENDE));
  });
});
