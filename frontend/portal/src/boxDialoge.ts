import type { ApiError, Device, UemsDatenquelle } from './api';

const name = (box: Pick<Device, 'name' | 'externalRef'>): string => box.name?.trim() || box.externalRef;

export function wechselFolgen(
  quelle: Pick<UemsDatenquelle, 'kennzeichen'>,
  box: Pick<Device, 'name' | 'externalRef'>,
  zeitText: string,
): string[] {
  return [
    `Die Messstellen an ${quelle.kennzeichen} behalten ihre Quelle.`,
    `${zeitText} liest ${name(box)}.`,
    'Die Übergabe erfolgt mit einer kurzen Lücke (unter 1 Minute), sichtbar im Verlauf.',
  ];
}

export function tauschFolgen(
  alt: Pick<Device, 'name' | 'externalRef'>,
  neu: Pick<Device, 'name' | 'externalRef'>,
  quellen: readonly Pick<UemsDatenquelle, 'kennzeichen'>[],
  fuehrt: boolean,
): string[] {
  const teile = [
    'Heimat-Anlage',
    fuehrt ? 'Rolle führende Box' : 'Rolle lesende Box',
    quellen.length ? `Datenquellen ${quellen.map((q) => q.kennzeichen).join(', ')}` : 'Datenquellen',
    'Messwert-Auswahl',
    'Freigaben',
    'Update-Zuordnung',
  ];
  return [
    `${name(neu)} übernimmt: ${teile.join(', ')}.`,
    `${name(alt)} (${alt.externalRef}) wird als ausgebaut geführt; ihre Werte und Protokolle bleiben.`,
  ];
}

export function tauschFehler(error: unknown): string {
  const api = error as Partial<ApiError> | null;
  const body = api?.body as { grund?: string; satz?: string } | undefined;
  if (api?.status === 404) return 'Eine der beiden Boxen wurde nicht gefunden. Bitte laden Sie die Seite neu.';
  if (api?.status === 409) {
    if (body?.grund === 'nachfolger_andere_heimat') return 'Ein Box-Tausch ist nur innerhalb derselben Anlage möglich.';
    return body?.satz || api.message || 'Der Box-Tausch ist im aktuellen Zustand nicht möglich.';
  }
  return api?.message || 'Der Box-Tausch konnte nicht vorbereitet werden.';
}

export function geplanterWechsel(quelle: Pick<UemsDatenquelle, 'zeitraeume'>, jetzt = new Date()): UemsDatenquelle['zeitraeume'][number] | null {
  return quelle.zeitraeume
    .filter((z) => Date.parse(z.effective_from) > jetzt.getTime())
    .sort((a, b) => Date.parse(a.effective_from) - Date.parse(b.effective_from))[0] ?? null;
}
