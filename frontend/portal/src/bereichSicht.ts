/**
 * Welche UEMS-Bereiche die Person sieht - und welche Reiter sie tragen (AP-17 Bewertung, AP-18 Ziele und
 * Maßnahmen, AP-19 Energiemanagement).
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 09.10.2026): die Schale (`App.tsx`) fragt beim ersten
 * Bild nur „gibt es den Bereich?“, die Reiter-Leiste (`PortfolioTabs`) nur nach den Wörtern der Reiter.
 * `bewertung.ts`, `energieziele.ts` und `energiemanagementPortal.ts` zogen dafür ihre ganzen Bilder samt
 * `energiemanagement.ts`, `uemsBericht.ts` und `uemsKennzahl.ts` ins Einstiegs-Bündel. Die drei Module reichen
 * Fragen und Reiter unter ihren alten Namen (`darfAnsehen`, `REITER`, `UEBERBLICK`) unverändert weiter.
 */
import type { Selbstauskunft } from './api';
import {
  UEMS_ABWEICHUNGEN,
  UEMS_DOKUMENTE,
  UEMS_ENERGIEZIELE,
  UEMS_MANAGEMENTBEWERTUNG,
  UEMS_MASSNAHMEN,
  UEMS_WIEDERVORLAGE,
} from './glossarEinstieg';
import type { EnergiemanagementReiter, VerbesserungReiter } from './nav';

// ------------------------------------------------------------------ Rechte (aus `/me`, entschieden wird an der Route)

type Rechte = Pick<Selbstauskunft, 'standorte' | 'unternehmen_rechte'>;

const hat = (s: Rechte | null | undefined, recht: string) =>
  !!s && (s.unternehmen_rechte.includes(recht) || s.standorte.some((st) => st.rechte.includes(recht)));

/** Sieht die Person Energieeinsätze (an irgendeinem Standort oder am Unternehmen)? Unbekannt ist nein. */
export const darfEnergieeinsaetzeSehen = (s: Rechte | null | undefined): boolean => hat(s, 'energieeinsatz.ansehen');

/** `verbesserung.ansehen` am Unternehmen oder an einem Standort — sonst gibt es den Bereich nicht. */
export const darfVerbesserungSehen = (s: Rechte | null | undefined) => hat(s, 'verbesserung.ansehen');

/** `energiemanagement.ansehen` am Unternehmen oder an einem Standort — sonst gibt es den Bereich nicht. */
export const darfEnergiemanagementSehen = (s: Rechte | null | undefined) => hat(s, 'energiemanagement.ansehen');

// ------------------------------------------------------------------ Reiter

/** Die Reiter von „Ziele und Maßnahmen“. */
export const VERBESSERUNG_REITER: readonly { key: VerbesserungReiter; label: string }[] = [
  { key: 'energieziele', label: UEMS_ENERGIEZIELE },
  { key: 'massnahmen', label: UEMS_MASSNAHMEN },
  { key: 'abweichungen', label: UEMS_ABWEICHUNGEN },
];

/** Der erste Reiter von Nachweisen (Konzept n1, Entscheid 2). */
export const UEBERBLICK = 'Überblick';

/**
 * Die Reiter in der Ordnung des Konzepts Nachweisen n1 (§6.2, Entscheid 2): der Überblick zuerst, das Verzeichnis eine
 * Ebene darunter (kein Reiter), dann Dokumente, Audits, Feststellungen, Managementbewertung und Aufgaben; die Berichte
 * reiht die Gruppe „Nachweisen“ gleich hinter den Überblick (`PortfolioTabs`). Die Wiedervorlage steht in der Übersicht.
 */
export const ENERGIEMANAGEMENT_REITER: readonly { key: Exclude<EnergiemanagementReiter, 'zuschnitt' | 'verantwortung' | 'verzeichnis'>; label: string }[] = [
  { key: 'ueberblick', label: UEBERBLICK },
  { key: 'wiedervorlage', label: UEMS_WIEDERVORLAGE },
  { key: 'dokumente', label: UEMS_DOKUMENTE },
  // §6.3 nennt den Reiter „Audits“ (das Auditprogramm, IA4); darin heißt jedes „internes Audit“.
  // Konzept Nachweisen n1, Entscheid 17: die Feststellungen stehen im Reiter „Audits“; `…/feststellungen` öffnet ihn dort.
  { key: 'audits', label: 'Audits' },
  { key: 'managementbewertung', label: UEMS_MANAGEMENTBEWERTUNG },
  // §6.3 nennt den Reiter „Aufgaben“; die Überschrift darin ist das Glossar-Wort „Aufgaben im Energiemanagement“.
  { key: 'aufgaben', label: 'Aufgaben' },
];
