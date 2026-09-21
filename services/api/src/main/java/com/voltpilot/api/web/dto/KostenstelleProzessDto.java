package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Kostenstellen- und Prozess-Schnittstelle (UEMS AP-10 IP-7):
 * {@code /api/v1/unternehmen/kostenstellen}, {@code /api/v1/unternehmen/prozesse} und
 * {@code /api/v1/messstellen/{id}/prozesse}. snake_case wie die übrigen UEMS-Schnittstellen; Tage als
 * {@code JJJJ-MM-TT}, {@code gueltig_bis} ist der LETZTE gültige Tag (einschließlich), {@code null} = offen.
 */
public final class KostenstelleProzessDto {
    private KostenstelleProzessDto() {}

    /** {@code POST …/kostenstellen} und {@code POST …/prozesse}; {@code eltern_id} nur beim Prozess. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(String kennzeichen, String name, String elternId, String gueltigAb, String gueltigBis) {}

    /** {@code PUT …/{id}}: nur der Name — Kennzeichen, Beginn und Elternteil bleiben. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Umbenennen(String name) {}

    /** {@code PUT …/{id}/beenden}: der letzte Tag. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Beenden(String gueltigBis) {}

    /**
     * Eine Kostenstelle. {@code angelegt_am} fehlt nur in ihren {@link #stammdaten} (Auswahl-Katalog, Entscheid
     * 21.09.2026, Lesart B) — ganz, nicht als {@code null}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Kostenstelle(UUID id, String kennzeichen, String name, LocalDate gueltigAb, LocalDate gueltigBis,
            @JsonInclude(JsonInclude.Include.NON_NULL) OffsetDateTime angelegtAm) {

        /** Nur die Stammdaten, die ein Konto zum Zuordnen braucht: Kennung, Kennzeichen, Name, Gültigkeit. */
        public Kostenstelle stammdaten() {
            return new Kostenstelle(id, kennzeichen, name, gueltigAb, gueltigBis, null);
        }
    }

    /**
     * Ein Prozess; {@code eltern} ist der übergeordnete Prozess oder {@code null}. {@code angelegt_am} fehlt nur in
     * seinen {@link #stammdaten} (wie an der Kostenstelle).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Prozess(UUID id, String kennzeichen, String name, Verweis eltern, LocalDate gueltigAb,
            LocalDate gueltigBis, @JsonInclude(JsonInclude.Include.NON_NULL) OffsetDateTime angelegtAm) {

        /** Nur die Stammdaten: Kennung, Kennzeichen, Name, Eltern, Gültigkeit. */
        public Prozess stammdaten() {
            return new Prozess(id, kennzeichen, name, eltern, gueltigAb, gueltigBis, null);
        }
    }

    /** Ein Verweis auf ein anderes Objekt: ID und Kennzeichen. */
    public record Verweis(UUID id, String kennzeichen) {}

    /** {@code GET …/kostenstellen?stichtag=}: ohne Stichtag alle, mit nur die an dem Tag bestehenden. */
    public record Kostenstellen(LocalDate stichtag, List<Kostenstelle> kostenstellen) {

        /** Der Auswahl-Katalog: jede Zeile nur mit ihren Stammdaten. */
        public Kostenstellen stammdaten() {
            return new Kostenstellen(stichtag, kostenstellen.stream().map(Kostenstelle::stammdaten).toList());
        }
    }

    /** {@code GET …/prozesse?stichtag=}. */
    public record Prozesse(LocalDate stichtag, List<Prozess> prozesse) {

        /** Der Auswahl-Katalog: jede Zeile nur mit ihren Stammdaten. */
        public Prozesse stammdaten() {
            return new Prozesse(stichtag, prozesse.stream().map(Prozess::stammdaten).toList());
        }
    }

    /** {@code PUT /api/v1/messstellen/{id}/prozesse}: ab diesem Tag gehört die Messstelle zu GENAU diesen Prozessen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record ProzesseSetzen(String gueltigAb, List<String> prozesse, String grund) {}

    /** Ein Intervall Messstelle → Prozess; {@code endet_mit_prozess}: der letzte Tag ist der des Prozesses. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zuordnung(UUID id, Verweis prozess, String name, LocalDate gueltigAb, LocalDate gueltigBis,
            boolean endetMitProzess) {}

    /** Die Prozesse einer Messstelle: alle wirksamen Intervalle, oder mit {@code am} die an dem Tag geltenden. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record MessstelleProzesse(UUID messstelleId, String kennzeichen, LocalDate am, List<Zuordnung> prozesse) {}
}
