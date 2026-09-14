import type { AnlagenSub, Route } from '../nav';
import type { HelpArticleId } from './model';

export const HELP_FOR_SUB: Record<AnlagenSub, HelpArticleId> = {
  fahrplan: 'fahrplan', messwerte: 'messwerte', erloese: 'erloese', marktpreise: 'marktpreise',
  prognose: 'prognosen', wetter: 'prognosen', technik: 'einstellungen', modell: 'anlagenmodell',
  steuerung: 'betriebsmodelle', lastspitzen: 'lastspitzen', ladevorgaenge: 'ladevorgaenge',
  befehle: 'geraete', geraet: 'geraete', box: 'geraete',
};

export function helpForRoute(route: Route): HelpArticleId | null {
  if (route.page === 'anlagen') return route.sub ? HELP_FOR_SUB[route.sub] : 'cockpit';
  if (route.page === 'portfolio-messwerte') return 'messwerte';
  if (route.page === 'portfolio-erloese') return 'erloese';
  if (route.page === 'portfolio' || route.page === 'uebersicht' || route.page === 'standort') return 'portfolio';
  return null;
}

export function helpForSetupStep(step: number): HelpArticleId {
  return step <= 2 ? 'anlage-anlegen' : step === 4 ? 'betriebsmodelle' : 'box-verbinden';
}
