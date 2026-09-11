package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.util.List;
import java.util.UUID;

/**
 * Die Messkanäle einer Komponente (UEMS AP-04 IP-9,
 * {@code GET /api/v1/sites/{siteId}/komponenten/{entityId}/messkanaele}).
 *
 * <p>In snake_case wie die Messstellen-Schnittstelle, und in den Wörtern des
 * Messstellen-Vertrags: {@code groesse}, {@code richtung}, {@code einheit} und {@code wertart}
 * sind genau die Eingänge von {@code MessstelleRegeln.passung} für eine spätere
 * Quellenbindung (IP-13). Daneben stehen die Katalogwörter ({@code quantity},
 * {@code direction}), aus denen sie abgebildet sind.
 */
public final class MesskanalDto {
    private MesskanalDto() {}

    /**
     * Alle Kanäle der Komponente. {@code inhaltsstand} ist der Stand des Messpunkt-Katalogs,
     * aus dem Anzeigename, Einheit, Wertart, Größe und Richtung stammen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(UUID siteId, UUID komponente, String inhaltsstand, List<Messkanal> messkanaele) {}

    /**
     * Ein Messkanal: ein Messwert der Komponente, den eine Box liest (heute: eine Zeile der
     * Mess-Selektion). Unbelegtes ist {@code null}, nie geraten.
     *
     * @param kanal       der Kanalname — der {@code point_key} des Katalogs oder des Selbstbaus
     * @param wertart     {@code counter · gauge · state · bitfield · text} aus dem Katalog
     *                    ({@code aggregation_kind}, AP-07 E12); {@code null} für Selbstbau und
     *                    für Katalogpunkte ohne Wertart ({@code event}, {@code none})
     * @param kadenzS     die gewünschte Kadenz der Mess-Selektion (AP-07 E9)
     * @param aktiv       ob die Box den Kanal gerade aufzeichnet (abgewählt bleibt er sichtbar)
     * @param lesendeBox  die Box, die ihn liest
     * @param geraet      das eingebaute Gerät — kommt mit IP-10, bis dahin {@code null}
     * @param speist      welche Messstellen er speist — kommt mit IP-13, bis dahin leer
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Messkanal(
            String kanal,
            String anzeigename,
            String einheit,
            String wertart,
            String groesse,
            String richtung,
            String quantity,
            String direction,
            Integer kadenzS,
            boolean aktiv,
            UUID lesendeBox,
            Object geraet,
            List<Object> speist) {}
}
