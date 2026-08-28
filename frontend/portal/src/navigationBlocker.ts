export type NavigationBlocker = (targetHref: string) => void;

interface ActiveBlocker {
  block: NavigationBlocker;
  currentHref: string;
  historyIndex: number;
}

let activeBlocker: ActiveBlocker | null = null;
let lastKnownHistoryIndex = -1;

const HISTORY_STATE_KEY = '__vpNavigation';

type NavigationState = {
  index: number;
  href: string;
};

function navigationState(): NavigationState | null {
  const value = window.history.state?.[HISTORY_STATE_KEY];
  return value && Number.isInteger(value.index) && typeof value.href === 'string'
    ? value as NavigationState
    : null;
}

function writeNavigationState(index: number): number {
  const state = window.history.state;
  const base = state && typeof state === 'object' ? state : {};
  window.history.replaceState({
    ...base,
    [HISTORY_STATE_KEY]: { index, href: window.location.href },
  }, '', window.location.href);
  lastKnownHistoryIndex = index;
  return index;
}

export function recordCurrentNavigation(): number {
  const current = navigationState();
  return current
    ? writeNavigationState(current.index)
    : writeNavigationState(lastKnownHistoryIndex + 1);
}

export function recordNewNavigation(): number {
  const current = navigationState();
  if (current?.href === window.location.href) {
    lastKnownHistoryIndex = current.index;
    return current.index;
  }
  return writeNavigationState(lastKnownHistoryIndex + 1);
}

export function registerNavigationBlocker(block: NavigationBlocker): () => void {
  const registration = {
    block,
    currentHref: window.location.href,
    historyIndex: recordCurrentNavigation(),
  };
  activeBlocker = registration;
  return () => {
    if (activeBlocker === registration) activeBlocker = null;
  };
}

export function requestNavigation(targetHref: string, restoreCurrentLocation = false): boolean {
  const registration = activeBlocker;
  if (!registration || targetHref === registration.currentHref) return false;
  if (restoreCurrentLocation && window.location.href !== registration.currentHref) {
    const target = navigationState();
    const offset = target?.href === window.location.href
      ? registration.historyIndex - target.index
      : -1;
    if (offset !== 0) window.history.go(offset);
  }
  registration.block(targetHref);
  return true;
}
