package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Quellenbindung (UEMS AP-04 IP-13, {@code /api/v1/messstellen/{id}/quellen}) —
 * in snake_case wie die Messstellen-Schnittstelle und in den Wörtern des Messstellen-Vertrags
 * ({@code docs/contracts/v2/messstelle.md} §5).
 */
public final class MessstelleQuelleDto {
    private MessstelleQuelleDto() {}

    /** Ein abgelesener Zählerstand. {@code einheit} darf fehlen — dann gibt es einen Hinweis. */
    public record Stand(Double wert, String einheit) {}

    /** Welche Größe der Messstelle: fehlt sie, die Hauptgröße; sonst Größe + Richtung einer Nebengröße. */
    public record GroesseWahl(String groesse, String richtung) {}

    /**
     * {@code POST …/quellen}. {@code gueltig_ab} auf die Minute mit Versatz (E2), fehlend = jetzt;
     * die Vergangenheit ist erlaubt und wird „rückwirkend“ markiert, die Zukunft „angekündigt“.
     * {@code zweck} nur und immer bei {@code vergleich}. {@code endstand_vorgaenger} nur, wenn die
     * neue offene führende Quelle die laufende beendet (Regel 2). {@code anteil} (AP-08 IP-7):
     * {@code positiv} | {@code negativ} liest nur diesen Teil eines Vorzeichen-Werts, fehlend = der
     * ganze Wert.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Binden(
            GroesseWahl groesse,
            UUID komponente,
            String kanal,
            String rolle,
            String zweck,
            OffsetDateTime gueltigAb,
            OffsetDateTime gueltigBis,
            Stand anfangsstand,
            Stand endstandVorgaenger,
            String grund,
            String anteil) {

        /** Eine Bindung ohne Anteil — die Form von vor AP-08 IP-7. */
        public Binden(GroesseWahl groesse, UUID komponente, String kanal, String rolle, String zweck,
                OffsetDateTime gueltigAb, OffsetDateTime gueltigBis, Stand anfangsstand, Stand endstandVorgaenger,
                String grund) {
            this(groesse, komponente, kanal, rolle, zweck, gueltigAb, gueltigBis, anfangsstand, endstandVorgaenger,
                    grund, null);
        }
    }

    /** {@code PUT …/quellen/{qid}/beenden}: das Ende auf die Minute (fehlend = jetzt), optional der Endstand. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Beenden(OffsetDateTime gueltigBis, Stand endstand, String grund) {}

    /** Das Gerät des Messkanals: der Einbau, der die Komponente zu Beginn der Quelle speist. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Geraet(UUID id, String geraet, String einbau) {}

    /**
     * Eine Quellenbindung. {@code status} gegen „jetzt“ (geplant · gilt · beendet);
     * {@code rueckwirkend} sagt, ob der Beginn beim Eintragen schon vorbei war, {@code herkunft}
     * woher sie stammt: {@code null} = von Hand gebunden, {@code bestandsuebernahme} = aus der
     * Vorschlagsliste des Standorts übernommen (IP-16, E6). {@code anteil}: {@code null} = der ganze
     * Wert, sonst der Teil eines Vorzeichen-Werts, den die Bindung liest (AP-08 IP-7).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Quelle(
            UUID id,
            UUID messstelleId,
            String groesse,
            String richtung,
            String rolle,
            String zweck,
            UUID komponente,
            String komponenteName,
            UUID anlage,
            String kanal,
            String kanalWertart,
            String herleitung,
            Geraet geraet,
            OffsetDateTime gueltigAb,
            OffsetDateTime gueltigBis,
            String status,
            Stand anfangsstand,
            Stand endstand,
            boolean rueckwirkend,
            String herkunft,
            OffsetDateTime eingetragenAm,
            String eingetragenVon,
            String anteil) {}

    /**
     * Wie weit das eingetragene „gültig ab“ bzw. „gültig bis“ von jetzt entfernt ist (E2), auf die
     * Minute: {@code art} rueckwirkend · ab_jetzt · angekuendigt; {@code abzeichen} nur rückwirkend
     * („rückwirkend (25 min)“).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Rueckwirkung(String art, long minuten, String abzeichen) {}

    /**
     * Die Antwort auf Binden und Beenden. {@code beendet}: die laufende führende Quelle, die die
     * neue genau zu ihrem Beginn beendet hat (Regel 2) — sonst {@code null}. {@code hinweise}
     * verhindern nichts ({@code ablesestand_pruefen}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorgang(Quelle quelle, Quelle beendet, Rueckwirkung rueckwirkung, List<String> hinweise) {}

    /** Ein Abschnitt des Zeitstrahl der führenden Quellen; {@code quelle == null} ist eine sichtbare Lücke. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Abschnitt(OffsetDateTime von, OffsetDateTime bis, UUID quelle) {}

    /**
     * Eine Größe der Messstelle zum Stichtag: ihre führende Quelle (oder {@code null} — „keine
     * Quelle“, nie 0), die laufenden Vergleichsquellen und der Zeitstrahl ihrer führenden Quellen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GroesseAmStichtag(
            String groesse,
            String richtung,
            String einheit,
            String wertart,
            boolean hauptgroesse,
            String lebenszyklus,
            Quelle fuehrend,
            List<Quelle> vergleich,
            List<Abschnitt> zeitstrahl) {}

    /** {@code GET …/quellen?stichtag=}: je Größe der Stand zum Stichtag, dazu die ganze Historie. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(
            UUID messstelleId,
            String kennzeichen,
            OffsetDateTime stichtag,
            List<GroesseAmStichtag> groessen,
            List<Quelle> quellen) {}
}
