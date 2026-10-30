package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * Der Block einer Zeile des Stroms {@code geraetesuche} im Kommando-Verlauf (Folgepaket vp-gs-folge-herkunft): eine
 * Suche im Heimnetz oder eine Übernahme aus ihr, gelesen aus dem nur anfügenden {@code geraetesuche_protokoll}. Die
 * Art steht in {@code CommandEntryDto.eventKind}; die Person in {@code CommandEntryDto.urheber}.
 *
 * @param zustand       bei einer Suche das Vokabular der Suche ({@code wartet} … {@code keine_antwort}); sonst null
 * @param grund         der Grund der Box bei abgebrochen/abgelehnt/fehlgeschlagen; sonst null
 * @param dauerMs       die Dauer laut Box; null = nicht gemeldet
 * @param zaehler       Funde je Gruppe zum Zeitpunkt des Ergebnisses; null ohne Ergebnis (nie 0)
 * @param abgebrochenVon wer den Abbruch angefragt hat; null = niemand
 * @param komponente    bei einer Übernahme: der heutige Name der Komponente; null, wenn sie entfernt ist
 * @param fund          bei einer Übernahme: der Schlüssel des Fundes
 * @param gesuchtAm     bei einer Übernahme: wann die Suche ausgelöst wurde
 */
public record GeraetesucheAktivitaetDto(UUID suchId, String zustand, String grund, Integer dauerMs,
        Map<String, Integer> zaehler, ProtokollDto.Urheber abgebrochenVon, String komponente, String fund,
        Instant gesuchtAm) {
}
