import { findArticle } from './articles';
import { HelpArticleView } from './HelpArticleView';
import type { HelpArticleId } from './model';
import './Help.css';

export default function HelpReader({ articleId, onArticle }: { articleId: HelpArticleId; onArticle: (id: HelpArticleId) => void }) {
  const article = findArticle(articleId);
  return article ? <HelpArticleView article={article} onArticle={onArticle} /> : <p>Dieser Artikel ist nicht verfügbar. Öffnen Sie das Hilfe-Center, um eine passende Erklärung zu finden.</p>;
}
