import { createContext, useContext } from 'react';
import type { MessenSchritt } from './messenAssistent';

/**
 * Der EINE Einstieg in den Assistenten „Messen & Auswerten“ (AP-01 E5 = A): die Karte „Funktionen“, die
 * Leerzustände der Messwelt und der Satz „Daten kommen an“ öffnen denselben Assistenten, den `App.tsx` an genau
 * einer Stelle rendert (nachgeladen, erst beim ersten Öffnen). Ein Ort, ein Zustand — keine Fläche hält einen
 * eigenen Assistenten.
 *
 * Bewusst klein und ohne Laufzeit-Import aus `messenAssistent.ts`: dieses Modul liegt im Einstiegs-Bündel.
 */
export interface MessenZiel {
  /** Der Standort, aus dessen Zeile geöffnet wird; ohne: der des Entwurfs (sonst Schritt 1 ohne Vorwahl). */
  standortId?: string | null;
  /** Die Stelle, auf die der Einstieg zeigt; gilt nur, wo die Funktion schon besteht (`startSchritt`). */
  schritt?: MessenSchritt;
}

export interface MessenEinstiegWirt {
  oeffnen: (ziel: MessenZiel) => void;
  /** Zählt jedes Schließen — wer Funktionen zeigt, liest danach nach. */
  runde: number;
  /** Zeitpunkt des Avatar-Eintrags „Funktionen“: die Karte rückt dann einmal in den Blick. */
  karteGezeigtAm: number | null;
}

export const MessenEinstiegKontext = createContext<MessenEinstiegWirt | null>(null);

/** `null` außerhalb der App-Schale (Bühnen, Einzeltests): dort bleibt jeder Einstieg der bisherige Hinweis. */
export function useMessenEinstieg(): MessenEinstiegWirt | null {
  return useContext(MessenEinstiegKontext);
}

/** Der Knopf der Leerzustände der Messwelt (Messstellen-Liste). */
export const MESSEN_EINRICHTEN = 'Messen & Auswerten einrichten';
/** Der Knopf am Satz „Daten kommen an – noch keiner Messreihe zugeordnet“: Schritt 2 der Anlage. */
export const ZUORDNUNG_KNOPF = 'Im Messen-Assistenten zuordnen';
/** Der Eintrag im Avatar-Menü (Konzept §5.2: „Avatar-Menü → Funktionen“). */
export const FUNKTIONEN_EINTRAG = 'Funktionen';
