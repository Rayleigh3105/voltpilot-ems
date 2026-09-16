package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Netzanschluss-Schnittstelle (UEMS AP-10 IP-6): {@code /api/v1/standorte/{id}/netzanschluesse}
 * und {@code …/netzanschluesse/{id}/anlagen}. snake_case wie die übrigen UEMS-Schnittstellen und die
 * Vektor-Datei des Vertrags; Tage als {@code JJJJ-MM-TT}, {@code gueltig_bis} ist der LETZTE gültige Tag
 * (einschließlich), {@code null} = offen.
 */
public final class NetzanschlussDto {
    private NetzanschlussDto() {}

    /**
     * {@code POST …/netzanschluesse} und {@code PUT …/netzanschluesse/{id}} (die ganze Menge — ein fehlendes
     * Feld ist leer). Beim Anlegen heißt {@code kennzeichen = null}: automatisch vergeben ({@code NA-0001}).
     * Die Leistungen als Zahl oder Dezimaltext.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anschluss(String kennzeichen, String name, String malo, String netzbetreiber, BigDecimal anschlussKva,
            BigDecimal vereinbartKw, String messung, String gueltigAb, String gueltigBis) {}

    /** {@code POST …/netzanschluesse/{id}/anlagen}: ab diesem Tag hängt die Anlage an diesem Netzanschluss. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Binden(String anlageId, String gueltigAb, String grund) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorschlag(UUID anlageId, String anlageName, LocalDate bindungAb, String kennzeichen, String name) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Uebernehmen(String kennzeichen, String name, String malo, String netzbetreiber,
            BigDecimal anschlussKva, BigDecimal vereinbartKw, String messung, String gueltigAb,
            String gueltigBis, String bindungAb, String grund) {}

    /** Ein Verweis auf den Standort: ID und Kurzzeichen. */
    public record Standort(UUID id, String kurzzeichen) {}

    /** Die Anlage einer Bindung; {@code name} ist {@code null}, wenn die Anlage gelöscht ist. */
    public record Anlage(UUID id, String name) {}

    /** Ein Intervall Anlage ↔ Netzanschluss. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bindung(UUID id, Anlage anlage, LocalDate gueltigAb, LocalDate gueltigBis) {}

    /**
     * Ein Netzanschluss. {@code hinweise} sind die des Vertrags ({@code vereinbart_ueber_anschluss}) — sie
     * halten nichts an. {@code anlagen}: die wirksamen Bindungen (mit {@code stichtag} nur die an dem Tag).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Netzanschluss(UUID id, String kennzeichen, String name, Standort standort, String malo,
            String netzbetreiber, BigDecimal anschlussKva, BigDecimal vereinbartKw, String messung, LocalDate gueltigAb,
            LocalDate gueltigBis, List<String> hinweise, List<Bindung> anlagen, OffsetDateTime angelegtAm) {}

    /**
     * {@code GET …/netzanschluesse?stichtag=}: ohne Stichtag alle, mit nur die an dem Tag bestehenden.
     * {@code kennzeichen_vorschlag} ist das nächste automatische Kennzeichen — vergeben wird es erst beim Anlegen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Netzanschluesse(Standort standort, LocalDate stichtag, String kennzeichenVorschlag,
            List<Netzanschluss> netzanschluesse) {}
}
