import { normalizeTerm } from '../glossar';
import { HELP_CATEGORIES, type HelpArticle } from './model';

/** AND between words, stable ranking: title > synonyms > summary > body. */
export function searchHelp(articles: HelpArticle[], query: string): HelpArticle[] {
  const tokens = normalizeTerm(query).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  return articles.map((article, order) => {
    const title = normalizeTerm(article.title);
    const keywords = normalizeTerm(article.keywords.join(' '));
    const summary = normalizeTerm(article.summary);
    const body = normalizeTerm([
      HELP_CATEGORIES.find((c) => c.id === article.category)?.title, article.prerequisite,
      ...article.sections.flatMap((s) => [s.title, ...s.paragraphs, ...(s.steps ?? []), s.note ?? '']),
    ].join(' '));
    if (!tokens.every((t) => `${title} ${keywords} ${summary} ${body}`.includes(t))) return null;
    const score = tokens.reduce((n, t) => n + (title.includes(t) ? 8 : keywords.includes(t) ? 5 : summary.includes(t) ? 3 : 1), 0);
    return { article, order, score };
  }).filter((v): v is NonNullable<typeof v> => v !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order).map((v) => v.article);
}
