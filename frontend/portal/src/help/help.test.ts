import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { HELP_ARTICLES, findArticle } from './articles';
import { HELP_CATEGORIES, helpHref } from './model';
import { HELP_FOR_SUB, helpForRoute, helpForSetupStep } from './context';
import { HELP_FIGURES, figureUrl } from './figures';
import { searchHelp } from './search';
import { anlageRoute, auditRoute, dokumentRoute, energiemanagementRoute, hashForRoute, managementbewertungRoute, pageRoute, parseRoute, personRoute } from '../nav';
import { canonicalShellRoute } from '../betriebsart';

describe('help handbook integrity', () => {
  it('ships the full handbook with unique slugs, sections and valid related articles', () => {
    expect(HELP_ARTICLES).toHaveLength(30);
    expect(new Set(HELP_ARTICLES.map((a) => a.id)).size).toBe(HELP_ARTICLES.length);
    for (const article of HELP_ARTICLES) {
      expect(HELP_CATEGORIES.some((c) => c.id === article.category)).toBe(true);
      expect(article.sections.length).toBeGreaterThanOrEqual(3);
      expect(new Set(article.sections.map((s) => s.id)).size).toBe(article.sections.length);
      expect(article.related.every((id) => id !== article.id && findArticle(id))).toBe(true);
    }
  });

  it('every referenced screenshot exists and its callouts lie inside the captured image', () => {
    for (const id of new Set(HELP_ARTICLES.flatMap((a) => a.sections.flatMap((s) => s.figure ? [s.figure] : [])))) {
      const figure = HELP_FIGURES[id];
      expect(figure, id).toBeDefined();
      expect(figureUrl(figure), id).toBeTruthy();
      const png = readFileSync(fileURLToPath(new URL('./assets/' + figure.file, import.meta.url)));
      expect(png.readUInt32BE(16)).toBe(figure.width);
      expect(png.readUInt32BE(20)).toBe(figure.height);
      expect(figure.callouts.length).toBeGreaterThanOrEqual(3);
      for (const point of figure.callouts) {
        expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(100);
        expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(100);
        expect(point.text.length).toBeGreaterThan(15);
      }
    }
  });

  it('all customer subpages and onboarding steps point to existing articles', () => {
    for (const [sub, article] of Object.entries(HELP_FOR_SUB)) {
      expect(findArticle(article)).toBeDefined();
      expect(helpForRoute(parseRoute('#/anlage/example/' + sub))).toBeTruthy();
    }
    for (const step of [1, 2, 3, 4, 5]) expect(findArticle(helpForSetupStep(step))).toBeDefined();
    expect(helpForRoute(anlageRoute('example'))).toBe('cockpit');
    expect(helpForRoute(pageRoute('mandanten'))).toBeNull();
  });

  it('der Energiemanagement-Bereich führt auf seinen Artikel, auf jedem Reiter und jeder Seite darin (AP-20 IP-22)', () => {
    for (const route of [
      energiemanagementRoute(), energiemanagementRoute('aufgaben'), energiemanagementRoute('managementbewertung'),
      personRoute('p-1'), auditRoute('a-1'), managementbewertungRoute('MB-2028'), dokumentRoute('d-1'),
    ]) {
      expect(helpForRoute(route), hashForRoute(route)).toBe('energiemanagement');
    }
    expect(findArticle('energiemanagement')?.category).toBe('verstehen');
  });
});

describe('help search', () => {
  it('prioritizes the task title and searches paragraphs, not just metadata', () => {
    expect(searchHelp(HELP_ARTICLES, 'Fahrplan')[0].id).toBe('fahrplan');
    expect(searchHelp(HELP_ARTICLES, 'Ausschaltbare Phantomfunktion')).toEqual([]);
    // Nur im Absatz, nicht in Titel oder Stichworten: die Suche liest den Text.
    expect(searchHelp(HELP_ARTICLES, 'Viertelstunde').some((a) => a.id === 'prognosen')).toBe(true);
    expect(searchHelp(HELP_ARTICLES, 'Seriennummer des Wechselrichters').some((a) => a.id === 'box-verbinden')).toBe(true);
    // AP-20 IP-22: über den Titel, die Suchwörter und einen Satz im Absatz.
    expect(searchHelp(HELP_ARTICLES, 'Energiemanagement festhält')[0].id).toBe('energiemanagement');
    expect(searchHelp(HELP_ARTICLES, 'Gesamtabzug')[0].id).toBe('energiemanagement');
    expect(searchHelp(HELP_ARTICLES, 'rechtliche Anforderungen').some((a) => a.id === 'energiemanagement')).toBe(true);
  });
  it('supports German alternatives and requires every query word', () => {
    expect(searchHelp(HELP_ARTICLES, 'Erlöse')).toEqual(searchHelp(HELP_ARTICLES, 'Erloese'));
    for (const query of ['Akku', 'Batterie', 'Speicher']) expect(searchHelp(HELP_ARTICLES, query).some((a) => a.id === 'speicher')).toBe(true);
    expect(searchHelp(HELP_ARTICLES, '    ')).toEqual([]);
    expect(searchHelp(HELP_ARTICLES, 'Fahrplan unbekannteswort')).toEqual([]);
  });
});

describe('global help routing', () => {
  it('round-trips articles without changing Anlage routes or consuming section parameters', () => {
    for (const article of HELP_ARTICLES) {
      const route = parseRoute(helpHref(article.id, article.sections[0].id));
      expect(route).toEqual({ page: 'hilfe', siteId: null, sub: null, helpArticle: article.id });
      expect(hashForRoute(route)).toBe(helpHref(article.id));
    }
    expect(parseRoute('#/hilfe')).toEqual(pageRoute('hilfe'));
    expect(hashForRoute(anlageRoute('a', 'fahrplan'))).toBe('#/anlage/a/fahrplan');
  });
  it('keeps invalid help links in help for recovery, including malformed encoding', () => {
    for (const input of ['#/hilfe/unbekannt', '#/hilfe/%E0%A4%A', '#/hilfe/fahrplan/extra']) {
      const route = parseRoute(input);
      expect(route.page).toBe('hilfe');
      expect(findArticle(route.helpArticle!)).toBeUndefined();
    }
    expect(findArticle('__proto__')).toBeUndefined();
  });
  it('never redirects a help deep link to onboarding, a sole site or the portfolio', () => {
    for (const isAdmin of [false, true]) for (const siteCount of [0, 1, 3]) {
      expect(canonicalShellRoute({
        shell: { isAdmin, loaded: true, tenantReady: true, betriebsart: siteCount > 1 ? 'betreiber' : 'endkunde', siteCount },
        route: parseRoute(helpHref('fahrplan')), siteIds: Array.from({ length: siteCount }, (_, i) => String(i)),
      })).toBeNull();
    }
  });
});

/**
 * MiSpeL MP-50 (BK-50 = A): die Gruppe 07 „MiSpeL“ mit der Themenseite „MiSpeL verstehen“ nach der Attrappe des
 * Bedienkonzepts (Abschnitt 3.1). Die Sätze mit Rechtsaussage tragen im Quelltext `// MP-61: Rechtsprüfung`.
 */
describe('MiSpeL MP-50 · Themenseite „MiSpeL verstehen“', () => {
  const artikel = findArticle('mispel-verstehen')!;
  // Pfade über das Arbeitsverzeichnis: Vite schreibt `new URL('…', import.meta.url)` mit festem Pfad zu einer Asset-URL um.
  const lies = (pfad: string) => readFileSync(join(process.cwd(), 'src', pfad), 'utf8');
  const quelle = lies('help/content/mispel.ts');
  const texte = [
    artikel.summary, artikel.prerequisite ?? '', artikel.asOf ?? '',
    ...artikel.sections.flatMap((s) => [
      ...s.paragraphs, s.note ?? '', ...(s.cards ?? []).flatMap((c) => [c.subtitle, ...c.items, c.status.text]),
      ...(s.points ?? []).flatMap((p) => [p.title ?? '', ...p.text]),
    ]),
  ];

  it('steht als einziger Artikel in der siebten Gruppe „MiSpeL“', () => {
    expect(HELP_CATEGORIES[6]).toMatchObject({ id: 'mispel', title: 'MiSpeL', description: 'Sonne und Netz in einem Speicher.' });
    expect(HELP_ARTICLES.filter((a) => a.category === 'mispel').map((a) => a.id)).toEqual(['mispel-verstehen']);
    expect(artikel).toMatchObject({
      title: 'MiSpeL verstehen', headline: 'Sonne und Netz in einem Speicher', eyebrow: 'MiSpeL · Speicher und Ladepunkte im Mischbetrieb',
    });
    expect(artikel.prerequisite).toMatch(/^Anlagen mit Speicher oder rückspeisefähigem Ladepunkt/);
    expect(artikel.asOf).toMatch(/^Stand Oktober 2026: /);
  });

  it('hat die Abschnitte der Attrappe in ihrer Reihenfolge, die Bilder als eigene Zeichnungen', () => {
    expect(artikel.sections.map((s) => s.title)).toEqual([
      'Vorher und nachher', 'Drei Farben für vier Wege', 'Ein Tag im Mischbetrieb', 'Zwei Wege – welcher passt?', 'Was sich für Sie ändert',
      'Lohnt es sich für mich?', 'Und das Auto?',
    ]);
    expect(artikel.sections.flatMap((s) => s.diagram ? [s.diagram] : [])).toEqual(['mispel-vorher-nachher', 'mispel-wege', 'mispel-tag']);
    expect(artikel.sections.some((s) => s.figure)).toBe(false);
  });

  it('ist über die Suche nach „MiSpeL“ und „Netzladen“ erreichbar', () => {
    expect(searchHelp(HELP_ARTICLES, 'MiSpeL')[0].id).toBe('mispel-verstehen');
    expect(searchHelp(HELP_ARTICLES, 'Netzladen').map((a) => a.id)).toContain('mispel-verstehen');
    // Nur in einer Karte, nicht in Titel, Suchwörtern oder Absatz: die Suche liest Karten und Punkte mit.
    expect(searchHelp(HELP_ARTICLES, 'Daumenregel').map((a) => a.id)).toContain('mispel-verstehen');
  });

  it('„Lohnt es sich für mich?“ verweist nur auf den Rechner, ohne Betrag', () => {
    const lohnt = artikel.sections.find((s) => s.id === 'lohnt-es-sich')!;
    const text = [...lohnt.paragraphs, lohnt.note ?? ''].join(' ');
    expect(text).toContain('Vorteilsrechner „Was bringt MiSpeL meiner Anlage?“');
    expect(text).not.toMatch(/€|\d/);
  });

  it('behauptet nicht, was nicht gilt: keine geltenden Regeln seit dem 01.10., Pauschaloption gesperrt, Zurückspeisen aus', () => {
    const alles = texte.join(' ');
    expect(alles).not.toMatch(/seit (dem )?0?1\.10\.|gilt seit|gelten seit|in Kraft/);
    expect(artikel.asOf).toContain('wirksam werden sie zwei Wochen nach der Veröffentlichung im Amtsblatt');
    const pauschal = artikel.sections.flatMap((s) => s.cards ?? []).find((c) => c.title === 'Pauschaloption')!;
    expect(pauschal.status).toEqual({ tone: 'warn', text: 'noch nicht anwendbar · wartet auf die Genehmigung der EU-Kommission' });
    expect(alles).toContain('Eingeschaltet ist es noch nicht');
  });

  it('markiert die 15 Sätze mit Rechtsaussage der Attrappe für die Rechtsprüfung (MP-61)', () => {
    const zeilen = quelle.split('\n');
    const markiert = (satz: string) => {
      const i = zeilen.findIndex((z) => z.includes(satz));
      return i > 0 && zeilen[i - 1].trim() === '// MP-61: Rechtsprüfung';
    };
    for (const satz of [
      'Die Bundesnetzagentur hat die Regeln am 01.10.2026 beschlossen; wirksam werden sie zwei Wochen nach der Veröffentlichung im Amtsblatt.',
      'Netzstrom laden kostet die Förderung für den Strom aus dem Speicher – für das ganze Kalenderjahr',
      'Netzstrom laden ist erlaubt – die Förderung des Sonnenstroms bleibt',
      'Marktprämie wie bisher',
      'Marktprämie bleibt',
      'Umlagen entfallen auf diese Menge',
      'Auf die rote Menge entfällt nach heutiger Rechtslage auch das Netzentgelt; das kann sich mit der Reform der Netzentgelte ändern.',
      'Zwei geeichte Zähler: am Netzanschluss und am Speicher – in einfachen Fällen genügt einer',
      'möglich · bis 30.09.2027 nur mit Einverständnis von Netz- und Messstellenbetreiber',
      'Für Solaranlagen bis 30 kWp – typisch Haushalte',
      'Bis 500 kWh je kWp und Jahr Marktprämie; darüber ein Zwischenbereich, danach entfallen Umlagen',
      'noch nicht anwendbar · wartet auf die Genehmigung der EU-Kommission',
      'Beide Wege setzen die Direktvermarktung voraus.',
      'Ein Ladepunkt, der zurückspeisen kann, zählt wie ein Speicher. Der Strom, mit dem Sie fahren, bleibt voll belastet.',
      'Mit fester Einspeisevergütung geht es nicht.',
    ]) expect(markiert(satz), satz).toBe(true);
    // Keine Markierung ohne Satz darunter.
    zeilen.forEach((z, i) => { if (z.trim() === '// MP-61: Rechtsprüfung') expect(zeilen[i + 1], `Zeile ${i + 2}`).toMatch(/'/); });
  });

  it('malt in den Farben der MiSpeL-Karte: gleiche Namen, gleiche Werte', () => {
    const variablen = (datei: string) => Object.fromEntries(
      [...lies(datei).matchAll(/(--mi-[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
    );
    const karte = variablen('components/erloese/MispelKarte.css');
    const hilfe = variablen('help/HelpMispel.css');
    expect(Object.keys(karte).length).toBeGreaterThanOrEqual(8);
    for (const [name, wert] of Object.entries(karte)) expect(hilfe[name], name).toBe(wert);
  });
});
