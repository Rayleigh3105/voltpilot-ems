import manifest from './screenshots.generated.json';

export interface HelpFigure {
  title: string;
  file: string;
  width: number;
  height: number;
  alt: string;
  callouts: { x: number; y: number; text: string }[];
}
// URL imports only; image bytes are fetched when the figure enters the viewport.
const imageUrls = import.meta.glob('./assets/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export const HELP_FIGURES = manifest as Record<string, HelpFigure>;
export function figureUrl(figure: HelpFigure): string | undefined {
  return imageUrls[`./assets/${figure.file}`];
}
