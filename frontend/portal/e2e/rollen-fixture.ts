import { setSelbstauskunft } from '../src/rollen';
import { rechteSeed } from '../src/test/rollenFixtures';

/** Standalone-Komponenten laden keine Schale: ihre gestellte /me-Antwort ist explizit. */
export const rollenMoment = rechteSeed(new URLSearchParams(location.search).get('person') ?? 'JW').me;
setSelbstauskunft(rollenMoment);
