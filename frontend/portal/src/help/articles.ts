import { startArticles } from './content/start';
import { everydayArticles } from './content/alltag';
import { controlArticles } from './content/steuerung';
import { plantArticles } from './content/anlage';
import { problemArticles } from './content/probleme';
import { energiemanagementArticles } from './content/energiemanagement';
import type { HelpArticle, HelpArticleId } from './model';

export const HELP_ARTICLES: HelpArticle[] = [...startArticles, ...energiemanagementArticles, ...everydayArticles, ...controlArticles, ...plantArticles, ...problemArticles];
export const ARTICLE_BY_ID = Object.fromEntries(HELP_ARTICLES.map((article) => [article.id, article])) as Record<HelpArticleId, HelpArticle>;
export function findArticle(id: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((article) => article.id === id);
}
