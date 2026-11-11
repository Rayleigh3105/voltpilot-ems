/** Ton eines Glieds der Steuerzeile: die Spalten sprechen ok/warn/ruhig, der Satz ok/warn/off. */
export type KettenTon = 'ok' | 'warn' | 'ruhig';

export const tonAus = (t: 'ok' | 'warn' | 'off' | 'ruhig'): KettenTon => (t === 'off' ? 'ruhig' : t);
