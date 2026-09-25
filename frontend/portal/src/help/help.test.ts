import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HELP_ARTICLES, findArticle } from './articles';
import { HELP_CATEGORIES, helpHref } from './model';
import { HELP_FOR_SUB, helpForRoute, helpForSetupStep } from './context';
import { HELP_FIGURES, figureUrl } from './figures';
import { searchHelp } from './search';
import { anlageRoute, hashForRoute, pageRoute, parseRoute } from '../nav';
import { canonicalShellRoute } from '../betriebsart';

describe('help handbook integrity', () => {
  it('ships the full handbook with unique slugs, sections and valid related articles', () => {
    expect(HELP_ARTICLES).toHaveLength(26);
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
});

describe('help search', () => {
  it('prioritizes the task title and searches paragraphs, not just metadata', () => {
    expect(searchHelp(HELP_ARTICLES, 'Fahrplan')[0].id).toBe('fahrplan');
    expect(searchHelp(HELP_ARTICLES, 'Ausschaltbare Phantomfunktion')).toEqual([]);
    // Nur im Absatz, nicht in Titel oder Stichworten: die Suche liest den Text.
    expect(searchHelp(HELP_ARTICLES, 'Viertelstunde').some((a) => a.id === 'prognosen')).toBe(true);
    expect(searchHelp(HELP_ARTICLES, 'Seriennummer des Wechselrichters').some((a) => a.id === 'box-verbinden')).toBe(true);
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
