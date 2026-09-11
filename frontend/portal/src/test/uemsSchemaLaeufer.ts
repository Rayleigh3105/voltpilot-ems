/**
 * Ein kleiner Läufer über die Teilmenge von JSON-Schema draft 2020-12, die die
 * UEMS-Vektor-Schemas unter `docs/contracts/v2/` benutzen: `type`, `required`,
 * `properties`, `additionalProperties` (false oder Schema), `items`, `enum`,
 * `const`, `pattern`, `minItems`, `minLength`, `maxLength`, `minimum`,
 * `maximum`, `anyOf` und `$ref` auf `#/$defs/…`. Das Projekt hat keine
 * Schema-Bibliothek; der Läufer ersetzt keine — er hält eine Datei an genau den
 * Regeln fest, die ihr Schema aufschreibt, und sagt bei jedem Verstoß den Pfad.
 *
 * Der Java-Zwilling ist `services/api .../uems/UemsSchemaLaeufer` (Testquelle).
 */

type Json = any;

const typVon = (v: Json): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v === 'object' ? 'object' : typeof v;
};

const passt = (v: Json, t: string): boolean => (t === 'number' ? typeof v === 'number' : typVon(v) === t);

/**
 * Alle Verstöße von `daten` gegen `teilschema` (Vorgabe: die Wurzel), je mit
 * Pfad; `$ref` wird gegen `wurzel` aufgelöst. Leer heißt: hält.
 */
export function schemaVerstoesse(daten: Json, wurzel: Json, teilschema: Json = wurzel): string[] {
  const pruefe = (wert: Json, s: Json, pfad: string): string[] => {
    if (s.$ref) {
      const ziel = (s.$ref as string)
        .slice(2)
        .split('/')
        .reduce((o: Json, t: string) => (o == null ? o : o[t.replace(/~1/g, '/').replace(/~0/g, '~')]), wurzel);
      if (!ziel) return [`${pfad}: unbekannter Schema-Verweis ${s.$ref}`];
      return pruefe(wert, ziel, pfad);
    }
    const fehler: string[] = [];
    if (s.anyOf && !(s.anyOf as Json[]).some((zweig) => pruefe(wert, zweig, pfad).length === 0)) {
      fehler.push(`${pfad}: ${JSON.stringify(wert)} passt zu keinem Zweig von anyOf`);
    }
    if (s.type) {
      const typen: string[] = Array.isArray(s.type) ? s.type : [s.type];
      if (!typen.some((t) => passt(wert, t))) return [...fehler, `${pfad}: Typ ${typVon(wert)} passt nicht zu ${typen.join('|')}`];
    }
    if ('const' in s && JSON.stringify(wert) !== JSON.stringify(s.const)) {
      fehler.push(`${pfad}: ${JSON.stringify(wert)} ist nicht ${JSON.stringify(s.const)}`);
    }
    if (s.enum && wert !== null && !s.enum.includes(wert)) {
      fehler.push(`${pfad}: ${JSON.stringify(wert)} steht nicht im Vokabular`);
    }
    if (typeof wert === 'string') {
      if (s.pattern && !new RegExp(s.pattern, 'u').test(wert)) {
        fehler.push(`${pfad}: „${wert}“ passt nicht zum Muster ${s.pattern}`);
      }
      if (s.minLength != null && wert.length < s.minLength) fehler.push(`${pfad}: zu kurz`);
      if (s.maxLength != null && wert.length > s.maxLength) fehler.push(`${pfad}: zu lang`);
    }
    if (typeof wert === 'number') {
      if (s.minimum != null && wert < s.minimum) fehler.push(`${pfad}: unter dem Mindestwert`);
      if (s.maximum != null && wert > s.maximum) fehler.push(`${pfad}: über dem Höchstwert`);
    }
    if (Array.isArray(wert)) {
      if (s.minItems != null && wert.length < s.minItems) fehler.push(`${pfad}: zu wenige Einträge`);
      if (s.items) wert.forEach((v, i) => fehler.push(...pruefe(v, s.items, `${pfad}[${i}]`)));
    }
    if (wert !== null && typeof wert === 'object' && !Array.isArray(wert)) {
      for (const p of s.required ?? []) {
        if (!(p in wert)) fehler.push(`${pfad}: Pflichtfeld ${p} fehlt`);
      }
      const props = s.properties ?? {};
      const zusatz = s.additionalProperties;
      for (const [k, v] of Object.entries(wert)) {
        if (k in props) fehler.push(...pruefe(v, props[k], `${pfad}.${k}`));
        else if (zusatz && typeof zusatz === 'object') fehler.push(...pruefe(v, zusatz, `${pfad}.${k}`));
        else if (zusatz === false) fehler.push(`${pfad}: unbekanntes Feld ${k}`);
      }
    }
    return fehler;
  };
  return pruefe(daten, teilschema, '$');
}
