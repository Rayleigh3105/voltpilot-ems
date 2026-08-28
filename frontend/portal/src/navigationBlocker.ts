export type NavigationBlocker = (targetHref: string) => void;

interface ActiveBlocker {
  block: NavigationBlocker;
  currentHref: string;
}

let activeBlocker: ActiveBlocker | null = null;

export function registerNavigationBlocker(block: NavigationBlocker): () => void {
  const registration = {
    block,
    currentHref: window.location.href,
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
    window.history.replaceState(window.history.state, '', registration.currentHref);
  }
  registration.block(targetHref);
  return true;
}
