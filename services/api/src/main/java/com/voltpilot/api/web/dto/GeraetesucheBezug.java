package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.UUID;

/**
 * Welcher Fund welcher Gerätesuche eine Komponente vorbelegt hat - der Haken im Anlege-Weg, den das Portal bei
 * „Übernehmen" mitsendet (Folgepaket vp-gs-folge-herkunft).
 *
 * <p>Er ist eine BEHAUPTUNG des Portals, kein Fakt: der Server glaubt ihn erst, wenn Suche und Fund in DIESER Anlage
 * und in den letzten 30 Tagen liegen ({@code GeraetesucheHerkunft#pruefen}). Mandant und Anlage stehen nie im Bezug,
 * sie kommen aus Token und Pfad.
 *
 * @param suchId die {@code such_id} der Suche
 * @param fund   der {@code schluessel} des Fundes ({@code <erkenner>:<Seriennummer oder ip:port>})
 */
public record GeraetesucheBezug(@NotNull UUID suchId, @NotBlank @Size(max = 200) String fund) {
}
