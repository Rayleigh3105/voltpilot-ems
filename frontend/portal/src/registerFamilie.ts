/**
 * Welche KATALOG-Familien ein einzelnes Gerät aufspannt - der Client-Zwilling
 * von `MeasurementCatalogFamilies.expand` (Java).
 *
 * **Der behobene Befund** (Konzept `data/vp-geraeteseite-rahmen-r2` §2.3/§7.1):
 * die Messbibliothek einer Geräteseite fragte mit der Geräte-UUID der BOX nach
 * „welche Punkte kann die Box lesen" - und die Antwort ist server-seitig die
 * Familien-VEREINIGUNG aller komponierten Punkte dieser Box, also praktisch
 * immer die Familie des primären Wechselrichters. Folge: die Wallbox-Seite zeigte
 * `hybrid_3p`-Register, und ein zweiter Wechselrichter sah die Liste des ersten
 * statt seine eigene.
 *
 * Diese Datei ist die Client-Hälfte des Fixes (Stufe 0, Captain-Entscheid D5a:
 * „Client-Filter jetzt, Server/Edge später"): sie leitet aus der Anbindung
 * DIESES Geräts die Katalog-Familien ab, mit denen die Fläche `?family=` sendet
 * und ihre eigenen Listen filtert.
 *
 * ⚠ **Drei Regeln tragen sie, alle vom Server abgeschrieben:**
 *
 * 1. **Dieselbe Abbildung wie `MeasurementCatalogFamilies.expand`** - `sunspec`
 *    und `sunspec_live` spannen `sunspec.model_*` auf, `goe_http_api` wird
 *    `goe.api_v2`, `shelly_http` wird `shelly.*`, alles mit `ocpp`-Präfix wird
 *    `ocpp.1_6`, sonst gilt der Name wörtlich. **Wer die Java-Seite ändert,
 *    ändert diese mit.**
 * 2. **Der abschliessende Schnitt mit dem Katalog** (`retainAll` dort,
 *    {@link KATALOG_FAMILIEN} hier) ist NICHT kosmetisch: ohne ihn käme eine
 *    Anbindung ohne Registerliste (Selbstbau, eine Box) als nicht-leere Menge
 *    zurück, die Ausblende-Regel griffe nicht und der Kunde bekäme einen LEEREN
 *    Kasten statt gar keinen.
 * 3. **Das gepflegte SOLL führt, das gemeldete IST folgt** - dieselbe Reihenfolge
 *    wie `geraetSeite.verbindungsWeg` und `geraetGesicht`s `communication`,
 *    damit die Flächen über denselben Weg nichts Verschiedenes annehmen.
 *
 * Rein und framework-frei (das `komponenten.ts`/`geraetSeite.ts`-Muster).
 */

/**
 * Die Familien des kanonischen Messpunkt-Katalogs
 * (`catalog/measurement-points/dist/`, die Fassung aus dessen `VERSION`).
 *
 * ⚠ Sie sind hier eine KOPIE, weil der Katalog-Endpunkt seine Familien-Liste
 * nicht mitliefert und ein Client sie deshalb nicht erfragen kann. Damit sie
 * keine zweite Wahrheit wird, liest `registerFamilie.test.ts` die kanonische
 * Datei PER PFAD und vergleicht - ein neuer SunSpec-Modellsatz macht den
 * Testlauf rot, statt hier still zu fehlen. Mit Stufe 3b (der Server nimmt die
 * Komponente entgegen und expandiert selbst) entfällt die Kopie ersatzlos.
 *
 * ⚠ **Nur Familien, die an eine Box gehen.** Eine Familie mit `an_der_box: false`
 * bietet der Server nicht an - hier stünde sonst eine Familie ohne Registerliste,
 * also genau der leere Kasten, den der Schnitt verhindern soll. Der Test liest
 * `an_der_box` aus derselben Datei. `wago.pm494`/`wago.pm495` waren solche
 * Familien, bis sie mit dem Laufzeitstand 2026.09.23.3 an die Box gingen (UEMS
 * AP-05 IP-6b).
 */
export const KATALOG_FAMILIEN: readonly string[] = [
  'fronius_solar_api',
  'goe.api_v2',
  'hybrid_1p',
  'hybrid_3p',
  'kaco_http',
  'kaco_http_hybrid',
  'kostal_plenticore',
  'micro',
  'ocpp.1_6',
  'shelly.gen1',
  'shelly.gen2plus',
  'string',
  'sunspec.model_1',
  'sunspec.model_101',
  'sunspec.model_102',
  'sunspec.model_103',
  'sunspec.model_111',
  'sunspec.model_112',
  'sunspec.model_113',
  'sunspec.model_120',
  'sunspec.model_121',
  'sunspec.model_122',
  'sunspec.model_123',
  'sunspec.model_124',
  'sunspec.model_160',
  'sunspec.model_201',
  'sunspec.model_202',
  'sunspec.model_203',
  'sunspec.model_211',
  'sunspec.model_212',
  'sunspec.model_213',
  'wago.pm494',
  'wago.pm495',
];

/**
 * Die Abbildung einer EINZELNEN Anbindungs-Familie auf Katalog-Familien -
 * wörtlich `MeasurementCatalogFamilies.expand` für ein Element, ohne den Schnitt.
 */
function abbilden(bindung: string): string[] {
  if (bindung === 'sunspec' || bindung === 'sunspec_live') {
    return KATALOG_FAMILIEN.filter((f) => f.startsWith('sunspec.model_'));
  }
  if (bindung === 'goe_http_api') return ['goe.api_v2'];
  if (bindung === 'shelly_http') return KATALOG_FAMILIEN.filter((f) => f.startsWith('shelly.'));
  if (bindung.startsWith('ocpp')) return ['ocpp.1_6'];
  return [bindung];
}

/**
 * Der volle Zwilling: eine Menge Anbindungs-Familien → die Katalog-Familien,
 * die sie aufspannen (dedupliziert, in Katalog-Reihenfolge, geschnitten).
 */
export function expandFamilien(bindungen: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const bindung of bindungen) {
    if (!bindung) continue;
    for (const family of abbilden(bindung)) out.add(family);
  }
  // Der Schnitt UND die Ordnung in EINER Zeile: nur was im Katalog steht,
  // überlebt (`retainAll` drüben), und die Reihenfolge ist die des Katalogs
  // statt die der Eingabe - dieselbe Bindung ergibt so immer dieselbe Adresse.
  return KATALOG_FAMILIEN.filter((f) => out.has(f));
}

/**
 * Die Katalog-Familien EINES Geräts - die Ableitung, die die Geräteseite ruft.
 *
 * `soll` ist die gepflegte Familie der Komponente (`SiteComponentRow.family`),
 * `ist` die vom Gerät gemeldete (`EntityLocalSetup.family`). Ein Ladepunkt
 * trägt keine von beiden: er spricht per Konstruktion OCPP, und genau das ist
 * eine Tatsache über das Gerät, keine Annahme.
 *
 * Leeres Ergebnis heisst **„für dieses Gerät kennt VoltPilot keine
 * Registerliste"** - nie „dieses Gerät hat keine Messwerte".
 */
export function geraetFamilien(input: {
  soll?: string | null;
  ist?: string | null;
  ladepunkt?: boolean;
}): string[] {
  const bindung = input.soll ?? input.ist ?? null;
  if (bindung) return expandFamilien([bindung]);
  return input.ladepunkt ? expandFamilien(['ocpp']) : [];
}

/**
 * Kann die Box einen beobachteten Punkt DIESES Geräts heute überhaupt lesen?
 *
 * ⚠ Ehrliche Grenze der Stufe 0 (§2.3 Schicht 3): die Selektion ist je
 * `(device_id, point_key)` gespeichert, und `vp-measurements` pollt jeden Punkt
 * gegen `inverter.connection` - also gegen den PRIMÄREN Wechselrichter; OCPP
 * kommt zusätzlich über den Core. Für jedes andere Gerät wird ein Punkt
 * gegen die falsche Adresse gelesen, solange Stufe 3c (Bindung über den Pin)
 * nicht ausgeliefert ist. Die Fläche SAGT das, statt es zu verschweigen.
 */
export function beobachtenMoeglich(input: {
  geraetId: string | null;
  familien: readonly string[];
}): boolean {
  if (input.geraetId === 'inverter') return true;
  return input.familien.includes('ocpp.1_6');
}

/** Der eine Satz, wenn {@link beobachtenMoeglich} `false` sagt. */
export const BEOBACHTEN_HINWEIS =
  'Ihre Box liest beobachtete Punkte zurzeit nur über den primären Wechselrichter - '
  + 'für dieses Gerät wird Beobachten mit einem der nächsten Box-Stände möglich.';
