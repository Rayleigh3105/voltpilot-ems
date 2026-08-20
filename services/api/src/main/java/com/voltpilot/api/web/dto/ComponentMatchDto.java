package com.voltpilot.api.web.dto;

import java.util.UUID;

/**
 * Die verwaiste Komponente, die der Anlege-Assistent bei diesem Gerät ÜBERNEHMEN
 * würde - der Vorschlag VOR dem Klick (Alias-Kontinuität, Live-Fall Herzogau
 * 20.08.2026).
 *
 * <p>Er beantwortet genau eine Frage: „Gibt es diese Komponente schon, und wie
 * heißt sie?". Die ENTSCHEIDUNG bleibt beim Server ({@code ComponentTakeover}) -
 * das Portal formuliert nur den Satz; einen zweiten Fingerabdruck in TypeScript
 * gäbe es dafür nie (er würde von der Server-Regel abdriften).
 *
 * <p>{@code label} darf {@code null} sein - dann trägt die Zeile keinen vom
 * Menschen vergebenen Namen und die Oberfläche leitet ihn wie überall aus
 * Marke + Modell ab, statt einen zu erfinden.
 */
public record ComponentMatchDto(UUID entityId, String label, String role, String brand,
        String model, boolean orphaned) {}
