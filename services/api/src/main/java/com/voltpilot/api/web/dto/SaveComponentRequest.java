package com.voltpilot.api.web.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.Map;

/**
 * Was der Anlege-Assistent speichert (Einheitsmodell Stufe 1, Konzept
 * vp-komponenten-einheit-h2 §4.1): eine Komponente = eine Vorlage + ihre
 * Verbindung + ihre Rolle.
 *
 * <p><b>Der Mandant steht NICHT im Rumpf</b> - er kommt aus dem JWT, und RLS'
 * WITH CHECK sorgt dafür, dass die Zeile in genau diesem Mandanten landet (die
 * Regel jeder {@code /sites/**}-Route).
 *
 * <p><b>{@code templateRef} ist OPAK</b> und wird nie zerlegt: Marke, Modell,
 * Familie und die Kommunikationsart holt der Server AUS der Vorlage. Ein Client
 * kann damit keine widersprüchliche Anbindung schicken - dieselbe Garantie, die
 * die Box mit ihrer eigenen Katalog-Normalisierung gibt.
 *
 * @param connection  die Felder aus dem {@code transport_schema} der Vorlage
 *                    (IP/Port/Serial/Unit-ID …), unverändert durchgereicht
 * @param capacityKwp nur für einen Erzeuger; sonst ignoriert
 * @param intervalS   optionaler Lese-Abstand; leer = die Vorgabe der Box
 * @param acceptMissingChannel die AUSDRÜCKLICHE Zustimmung des Kunden, diese
 *     Komponente OHNE einen Messkanal zu betreiben („Trotzdem fortfahren (nur
 *     Lesen)"). Sie nennt den Kanal, damit sie nicht pauschal gilt: der Server
 *     akzeptiert sie nur, wenn der Verbindungstest GENAU DIESEN Kanal als
 *     fehlend ausgewiesen hat - ein Client kann damit keine Zustimmung zu einem
 *     Kanal behaupten, der nie das Problem war. Absent = die unveränderte
 *     Pflicht „nur ein vollständiger Test speichert".
 * @param geraetesuche der Bezug auf einen Fund der Gerätesuche, wenn das Portal ihn
 *     über „Übernehmen" vorbelegt hat (Folgepaket vp-gs-folge-herkunft). Der Server
 *     prüft ihn gegen Anlage, Mandant und die 30 Tage (DP-3 A), schreibt das Protokoll
 *     und hält die Herkunft an der Komponente fest. Absent = der Weg wie bisher.
 */
public record SaveComponentRequest(
        @NotBlank @Size(max = 200) String templateRef,
        @Positive Integer templateVersion,
        @Size(max = 200) String label,
        @NotBlank @Size(max = 40) String role,
        Map<String, Object> connection,
        @Positive BigDecimal capacityKwp,
        Integer intervalS,
        @Size(max = 200) String note,
        @Size(max = 40) String acceptMissingChannel,
        Integer expectedRevision,
        Instant effectiveAt,
        @Valid GeraetesucheBezug geraetesuche,
        /**
         * Heizstab V1: {@code heating-rod} legt EIN Gerät über die Ausgangsmenge
         * ({@code connection.channels}) eines Shelly an (HeizstabGeraet); fehlt = der bisherige Weg.
         */
        @Size(max = 40) String consumerType) {

    /** Der Weg vor dem Heizstab (V1, Paket 3). */
    public SaveComponentRequest(String templateRef, Integer templateVersion, String label, String role,
            Map<String, Object> connection, BigDecimal capacityKwp, Integer intervalS, String note,
            String acceptMissingChannel, Integer expectedRevision, Instant effectiveAt,
            GeraetesucheBezug geraetesuche) {
        this(templateRef, templateVersion, label, role, connection, capacityKwp, intervalS, note,
                acceptMissingChannel, expectedRevision, effectiveAt, geraetesuche, null);
    }

    /** Der Weg ohne Gerätesuche - jeder Aufrufer vor dem Folgepaket „Herkunft". */
    public SaveComponentRequest(String templateRef, Integer templateVersion, String label, String role,
            Map<String, Object> connection, BigDecimal capacityKwp, Integer intervalS, String note,
            String acceptMissingChannel, Integer expectedRevision, Instant effectiveAt) {
        this(templateRef, templateVersion, label, role, connection, capacityKwp, intervalS, note,
                acceptMissingChannel, expectedRevision, effectiveAt, null);
    }

    /** Der Bequemlichkeits-Konstruktor der Aufrufer VOR dem Override-Weg. */
    public SaveComponentRequest(String templateRef, String label, String role,
            Map<String, Object> connection, BigDecimal capacityKwp, Integer intervalS,
            String note) {
        this(templateRef, null, label, role, connection, capacityKwp, intervalS, note,
                null, null, null, null);
    }
}
