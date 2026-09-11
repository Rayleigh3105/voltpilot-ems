package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
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
 * {@code direction}), aus denen sie abgebildet sind, und das Gerät, das die Komponente gerade
 * speist (IP-10).
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
     * @param geraet      das Gerät, das die Komponente JETZT speist ({@link GeraetEinbau});
     *                    {@code null} ohne laufende Speisung — nie geraten
     * @param speist      welche Messstellen er zum Stichtag (sonst jetzt) speist ({@link Speist},
     *                    IP-13) — leer, wenn keine Quellenbindung läuft
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
            GeraetEinbau geraet,
            List<Speist> speist) {}

    /**
     * Eine Quellenbindung, die den Kanal zum Stichtag liest (UEMS AP-04 IP-13) — genug für
     * „speist MS-06 (führend)“: die Messstelle, die Größe, an der die Quelle hängt, und die Rolle.
     *
     * @param messstelle das Kennzeichen der Messstelle (MS-06)
     * @param rolle      {@code fuehrend} oder {@code vergleich}
     * @param zweck      nur bei {@code vergleich} (Plausibilität · Ersatz bei Ausfall · Abrechnungszähler)
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Speist(
            UUID messstelleId,
            String messstelle,
            String groesse,
            String richtung,
            String rolle,
            String zweck,
            OffsetDateTime gueltigAb,
            OffsetDateTime gueltigBis) {}

    /**
     * Das eingebaute Gerät eines Messkanals (UEMS AP-04 IP-10) — in der Form von
     * {@code geraet_einbau} des Herkunftsvertrags ({@code messwert-herkunft.schema.json},
     * Angabe 10), damit der Nachschlag je Wert (AP-07) und diese Fläche dasselbe sagen; dazu
     * die Zeilen-Kennung für {@code GET /api/v1/geraete/{id}}.
     *
     * @param id           der Einbau ({@code geraet.id})
     * @param geraet       das Gerät, das über einen Wechsel an seiner Stelle bleibt (GR-4)
     * @param einbau       das konkret eingebaute Gerät (Z-5a) — ohne Wechsel dasselbe wie
     *                     {@code geraet}. Die Tabelle hält es {@code NOT NULL}; fehlte es,
     *                     stünde hier {@code null}, nie ein geratenes
     * @param seriennummer die Seriennummer des Einbaus; {@code null} = nicht erhoben
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GeraetEinbau(UUID id, String geraet, String einbau, String seriennummer) {}
}
