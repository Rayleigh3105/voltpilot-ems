/**
 * Die reine Ableitung der Plattform-Fläche „Steuerungs-Freigabe"
 * (Captain-Order 10.08.2026).
 *
 * Sie beantwortet ZWEI Fragen getrennt, weil es zwei Entscheidungen sind:
 *
 *  1. **Ist dieses Wechselrichter-MODELL freigegeben?** Eine Aussage über ein
 *     PRODUKT, einmal am Prüfstand getroffen und danach flottenweit gültig -
 *     das Gedächtnis, das bis hierher gefehlt hat.
 *  2. **Darf DIESE Anlage steuern?** Eine Entscheidung über eine
 *     KUNDENANLAGE, und die bleibt ein ausdrücklicher Klick - es geht um
 *     Schreibzugriff auf den Wechselrichter eines Kunden.
 *
 * Diese Datei rendert nichts; sie sortiert, benennt und leitet ab. Ehrlichkeit
 * ist hart verdrahtet: was das Gerät nicht gemeldet hat, wird nicht behauptet.
 */
import type { ControlCertification, ControlActivation } from './admin/adminApi';
import type { PlatformCertVerdict } from './api';

export type CertTone = 'ok' | 'warn' | 'off';

/** Der Zustand einer Anlagen-Zeile - vier Situationen, vier Sätze. */
export type PlantCertState =
  | 'aktiv' // scharfgeschaltet, Modell gedeckt
  | 'bereit' // Modell gedeckt, ein Klick fehlt
  | 'pruefstand' // Modell (noch) nicht im Register
  | 'unbekannt'; // das Gerät hat nichts gemeldet

export interface PlantCertView {
  state: PlantCertState;
  label: string;
  tone: CertTone;
  /** Der eine Satz, der sagt, was jetzt zu tun ist (oder '' - nichts). */
  hint: string;
  /** Ist der EINE Klick jetzt sinnvoll? */
  canActivate: boolean;
}

/**
 * Der Zustand einer Anlage aus (Scharfschaltung, gemeldetes Register-Urteil).
 *
 * ⚠ `verdict` fehlt oder ist `unknown`, wenn das Gerät nichts gemeldet hat
 * (ältere Edge-Version, oder es hat das Cloud-Dokument nie gesehen). Das ist
 * NICHT dasselbe wie „Modell nicht zertifiziert": ein Klick wird dann trotzdem
 * angeboten - die Freigabe entsteht ohnehin erst, wenn die Box das Modell
 * wiedererkennt, und ihr etwas zu VERWEIGERN, das wir nicht gemessen haben,
 * wäre die falsche Richtung. Der Hinweis sagt genau das.
 */
export function plantCertView(
  activated: boolean,
  verdict?: PlatformCertVerdict | null,
): PlantCertView {
  if (activated) {
    if (verdict === 'not_covered') {
      // Scharf, aber das Modell ist nicht (mehr) gedeckt: das Gerät steuert
      // nicht, und das darf nicht wie „läuft" aussehen.
      return {
        state: 'pruefstand',
        label: 'Aktiviert, Modell nicht freigegeben',
        tone: 'warn',
        hint:
          'Diese Anlage ist scharfgeschaltet, ihr Wechselrichter-Modell steht aber nicht im ' +
          'Register - das Gerät steuert deshalb nicht.',
        canActivate: false,
      };
    }
    return {
      state: 'aktiv',
      label: 'Steuerung aktiv',
      tone: 'ok',
      hint: '',
      canActivate: false,
    };
  }
  if (verdict === 'covered_not_activated') {
    return {
      state: 'bereit',
      label: 'Bereit - ein Klick',
      tone: 'warn',
      hint: 'Das Modell ist freigegeben. Es fehlt nur die Aktivierung für diese Anlage.',
      canActivate: true,
    };
  }
  if (verdict === 'not_covered') {
    return {
      state: 'pruefstand',
      label: 'Prüfstand nötig',
      tone: 'off',
      hint:
        'Dieses Wechselrichter-Modell steht noch nicht im Register - es braucht einen ' +
        'Prüfstandslauf, kein Klick ersetzt ihn.',
      canActivate: false,
    };
  }
  return {
    state: 'unbekannt',
    label: 'Meldet noch nichts',
    tone: 'off',
    hint:
      'Das Gerät hat noch nicht gemeldet, ob sein Modell im Register steht (ältere Version, ' +
      'oder es war seit der Einrichtung nicht verbunden).',
    canActivate: true,
  };
}

/** Woher eine bestehende Freigabe kommt - für die Spalte „Quelle". */
export const CERT_SOURCE_LABEL: Record<string, string> = {
  env: 'Flotten-Allowlist',
  device: 'Am Gerät freigegeben',
  platform: 'Register',
};

export function certSourceLabel(source?: string | null): string {
  return (source && CERT_SOURCE_LABEL[source]) || '';
}

/** ISO → DD.MM.YYYY; nichts Erfundenes, wenn das Format nicht passt. */
export function isoDate(iso?: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** Ein Register-Eintrag als Zeile: Marke + Modell zuerst, dann die Fakten. */
export interface RegisterRow {
  key: string;
  brand: string;
  model: string;
  family: string;
  /** „Remote-Register" / „Time-of-Use" / '' - nie ein Rohwort. */
  pathLabel: string;
  /**
   * Was der Prüfstand zum Schreib-VORZEICHEN gesagt hat. '' heißt, er hat die
   * Frage nicht beantwortet - das Gerät prüft dann nichts, und eine
   * Behauptung („nicht invertiert") wäre falsch.
   */
  signLabel: string;
  certifiedAt: string;
  note: string;
}

const PATH_LABEL: Record<string, string> = {
  remote: 'Remote-Register',
  tou: 'Time-of-Use',
};

/** Neueste Zertifizierung zuerst; bei gleichem Datum alphabetisch. */
export function registerRows(register: ControlCertification[]): RegisterRow[] {
  return [...register]
    .sort((a, b) => {
      const d = (b.certifiedAt || '').localeCompare(a.certifiedAt || '');
      return d !== 0 ? d : `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`, 'de');
    })
    .map((c) => ({
      key: `${c.brand}/${c.model}`,
      brand: c.brand,
      model: c.model,
      family: c.family,
      pathLabel: (c.controlPath && PATH_LABEL[c.controlPath]) || '',
      signLabel:
        c.invertControlSign == null
          ? ''
          : c.invertControlSign
            ? 'umgekehrt'
            : 'nicht umgekehrt',
      certifiedAt: isoDate(c.certifiedAt),
      note: [c.firmwareNote, c.note].filter(Boolean).join(' · '),
    }));
}

/**
 * Der ruhige Satz über dem Register. Er sagt AUSDRÜCKLICH, dass ein Eintrag
 * allein nichts steuert - sonst liest sich eine lange Liste wie eine große
 * Menge scharfgeschalteter Anlagen.
 */
export function registerSummary(register: ControlCertification[], activations: number): string {
  if (register.length === 0) {
    return 'Noch kein Modell freigegeben. Ein Prüfstandslauf endet hier als Eintrag.';
  }
  const models = register.length === 1 ? '1 Modell' : `${register.length} Modelle`;
  const plants = activations === 1 ? '1 Anlage' : `${activations} Anlagen`;
  return `${models} freigegeben · ${plants} aktiviert. Ein Eintrag allein steuert nichts - jede Anlage wird einzeln aktiviert.`;
}

/** Die Folgenliste des Aktivieren-Dialogs (das Haus-Muster). */
export function activateConsequences(siteName: string): string[] {
  return [
    `VoltPilot darf ab sofort den Wechselrichter von „${siteName}" ansteuern (Batterie laden/entladen laut Fahrplan).`,
    'Alle Schutzgrenzen bleiben unverändert: Not-Aus, Leistungsband, SoC-Fenster, § 14a und die EEG-Solarladen-Regel.',
    'Das Gerät prüft selbst, ob sein Modell wirklich im Register steht - passt es nicht, steuert es nicht.',
    'Sie können die Aktivierung jederzeit zurücknehmen; die Anlage fällt dann sofort auf Nur-Lesen zurück.',
  ];
}

/** Die Folgenliste der Rücknahme. */
export function deactivateConsequences(siteName: string): string[] {
  return [
    `„${siteName}" wird ab sofort nur noch ausgelesen - der Fahrplan erreicht den Wechselrichter nicht mehr.`,
    'Das Modell bleibt im Register; nur diese Anlage ist nicht mehr scharfgeschaltet.',
    'Die Anlage arbeitet weiter mit ihrer eigenen Werkseinstellung bzw. der eingebauten Sicherung.',
  ];
}

/** Die Folgenliste, wenn ein MODELL aus dem Register genommen wird. */
export function revokeConsequences(model: string, activePlants: number): string[] {
  const list = [
    `„${model}" gilt nicht mehr als freigegeben - jede Anlage mit diesem Modell steuert danach nicht mehr.`,
    'Betroffen sind nur Anlagen, deren Freigabe AUS dem Register kommt; eine am Gerät erteilte First-Light-Freigabe bleibt.',
  ];
  if (activePlants > 0) {
    list.unshift(
      activePlants === 1
        ? 'Aktuell ist 1 Anlage scharfgeschaltet.'
        : `Aktuell sind ${activePlants} Anlagen scharfgeschaltet.`,
    );
  }
  return list;
}

/** Eine Anlagen-Zeile für die Tabelle. */
export interface PlantRow {
  deviceId: string;
  siteId: string;
  siteName: string;
  tenantName: string;
  externalRef: string;
  activated: boolean;
  activatedAt: string;
  activatedBy: string;
  view: PlantCertView;
}

/**
 * Die Anlagen-Liste: die scharfgeschalteten zuerst (dort passiert etwas), dann
 * alphabetisch. Der Eingang ist bewusst schmal (die Aktivierungs-Liste plus,
 * je Anlage, das gemeldete Urteil) - so bleibt die Fläche unabhängig davon,
 * welches Aggregat sie speist.
 */
export function plantRows(
  activations: ControlActivation[],
  verdictBySite: (siteId: string) => PlatformCertVerdict | null | undefined,
): PlantRow[] {
  return activations
    .map((a) => ({
      deviceId: a.deviceId,
      siteId: a.siteId,
      siteName: a.siteName,
      tenantName: a.tenantName,
      externalRef: a.externalRef,
      activated: true,
      activatedAt: isoDate(a.activatedAt),
      activatedBy: a.activatedBy,
      view: plantCertView(true, verdictBySite(a.siteId)),
    }))
    .sort((x, y) => x.siteName.localeCompare(y.siteName, 'de'));
}
