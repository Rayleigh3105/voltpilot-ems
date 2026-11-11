/**
 * Der Satz „Ladestand von: <Gerät>" - die EINE Formulierung, damit Cockpit
 * und Geräteseite sie nicht zweimal verschieden erfinden.
 */
export function ladestandVon(label: string | null | undefined): string | null {
  const name = (label ?? '').trim();
  return name === '' ? null : `Ladestand von: ${name}`;
}
