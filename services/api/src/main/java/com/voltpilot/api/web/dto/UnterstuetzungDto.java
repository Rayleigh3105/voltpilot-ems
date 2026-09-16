package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Unterstützungs-Schnittstelle (UEMS AP-03 IP-8) — die Wörter sind die des Rechte-Vertrags
 * ({@code docs/contracts/v2/rechte-vectors.json}: {@code art}, {@code umfang},
 * {@code unterstuetzung_zustand}), die Namen die von {@code docs/contracts/openapi.yaml}.
 * {@code UnterstuetzungSchnittstelleVertragTest} hält beide zusammen.
 */
public final class UnterstuetzungDto {

    private UnterstuetzungDto() {
    }

    /**
     * Eine gewährte Unterstützung, wie die Liste und die Anlage-Antwort sie zeigen.
     *
     * @param id der Griff der Gewährung — die kleinste Kennung ihrer Zeilen; er bleibt, auch nachdem sie endete
     * @param art {@code installateur} | {@code voltpilot} | {@code notfall}
     * @param zustand {@code eingerichtet} | {@code aktiv} | {@code archiviert} (der Vertrag rechnet ihn)
     * @param erinnerung endet sie innerhalb von 7 Tagen (E6)?
     * @param banner der Satz für die Benutzer des Kundenbereichs, solange sie wirkt, sonst {@code null}
     * @param text der Satz danach („Endete am … durch Zeitablauf"), sonst {@code null}
     * @param startpasswort GENAU EINMAL in der Antwort des Gewährens, wenn dafür ein Partner-Konto entstand
     *     (E14) — nie in einer Liste, einem Protokoll, einem Hinweis oder einer E-Mail
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Unterstuetzung(UUID id, String art, String umfang, List<UUID> standorte,
            List<String> standortKennzeichen, Person unterstuetzer, OffsetDateTime gueltigAb, LocalDate gueltigBis,
            OffsetDateTime endet, String zustand, boolean erinnerung, String grund, String banner, String text,
            String startpasswort) {}

    /** Der Körper von {@code POST /api/v1/unterstuetzung} (streng gelesen: ein unbekanntes Feld ist 400). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Gewaehren(String art, String email, List<UUID> standorte, String umfang, OffsetDateTime gueltigAb,
            LocalDate gueltigBis, String grund, UUID anfrageId) {}

    /** Der Körper von {@code PUT /api/v1/unterstuetzung/{id}} — Verlängern ist ein neues Enddatum (§4.6). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verlaengern(LocalDate gueltigBis) {}

    /** Der Körper von {@code DELETE /api/v1/unterstuetzung/{id}} — der Grund ist frei. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Beenden(String grund) {}

    /**
     * Eine Anfrage von VoltPilot.
     *
     * @param zustand {@code offen} | {@code bestaetigt} | {@code abgelehnt} — abgeleitet, nie gespeichert
     * @param unterstuetzung der Griff der gewährten Unterstützung, sonst {@code null}
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anfrage(UUID id, String art, String umfang, List<UUID> standorte, Person angefragtVon,
            OffsetDateTime gueltigAb, LocalDate gueltigBis, String grund, String zustand,
            OffsetDateTime entschiedenAm, UUID unterstuetzung, OffsetDateTime angefragtAm) {}

    /** Der Körper der beiden Plattform-Routen ({@code …/unterstuetzung/anfrage} und {@code …/notfall}). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record PlattformAntrag(List<UUID> standorte, String umfang, OffsetDateTime gueltigAb, LocalDate gueltigBis,
            String grund) {}

    /**
     * Ein Hinweis im Postfach eines Kundenadministrators — heute die Karte im Portal, mit SMTP dieselbe Zeile
     * als E-Mail.
     *
     * @param anlass {@code anfrage} | {@code gewaehrt} | {@code notfall} | {@code erinnerung} |
     *     {@code abgelaufen} | {@code beendet}
     * @param emailVersandtAm {@code null}, solange kein SMTP steht — dann ist das Portal der Weg
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Hinweis(UUID id, String anlass, String text, UUID unterstuetzung, UUID anfrage,
            OffsetDateTime erzeugtAm, OffsetDateTime gelesenAm, OffsetDateTime emailVersandtAm) {}

    /** Eine Person mit ihrer maschinenstabilen Kennung (dem Subject) und ihrem Namen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Person(String kennung, String name) {}
}
