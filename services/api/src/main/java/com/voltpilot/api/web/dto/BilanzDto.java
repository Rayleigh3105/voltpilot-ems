package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Bilanz je Anlage (UEMS AP-10 IP-9): {@code GET /api/v1/sites/{id}/bilanz?periode=&am=} und
 * {@code POST /api/v1/sites/{id}/bilanz/rest}. snake_case wie {@code MessstelleFormelDto}. Jede Zahl
 * kommt aus {@code BilanzAbleitung} — die Route rechnet und formatiert nichts selbst. Beträge sind
 * ungerundet; {@code null} heißt unbekannt, nie 0.
 */
public final class BilanzDto {

    private BilanzDto() {}

    /**
     * Die Bilanz einer Anlage in EINER Periode ({@code tag} · {@code monat} · {@code jahr}, die {@code am}
     * enthält; {@code von}/{@code bis} sind Tage, der letzte gehört dazu, Zeitzone des Standorts).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bilanz(
            Anlage anlage,
            String periode,
            LocalDate am,
            LocalDate von,
            LocalDate bis,
            String zeitzone,
            List<Hauptzaehler> hauptzaehler) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlage(UUID id, String name) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record MessstelleRef(UUID id, String kennzeichen, String name) {}

    /**
     * Die Bilanz EINES Hauptzählers Bezug. {@code rest_messstelle} ist die bestätigte Rest-Messstelle
     * (E18) oder {@code null}; dann steht — solange er heute Hauptzähler der Anlage ist — ein
     * {@code vorschlag} „Rest anlegen“ da. Der Rest selbst steht IMMER als Zeile in {@code abschnitte}.
     * {@code stellung_geaendert}: in der Periode gelten verschiedene Terme — dann rechnet jeder
     * Abschnitt Tag für Tag, und es gibt keine Zahl über die ganze Periode (auch nicht als gespeicherter
     * Periodenwert, AP-10 IP-10: {@code terme_wechseln}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Hauptzaehler(
            MessstelleRef messstelle,
            MessstelleRef restMessstelle,
            Vorschlag vorschlag,
            boolean stellungGeaendert,
            List<Abschnitt> abschnitte,
            Live live) {}

    /** E18: „Rest anlegen“ — ein Klick bestätigt; Kennzeichen automatisch, {@code name} vorbelegt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorschlag(String aktion, UUID hauptzaehlerId, String name) {}

    /**
     * Tage mit denselben Termen aus der Stellung (E3). {@code raster} ist die Periode, wenn der Abschnitt
     * sie ganz trägt, sonst {@code tag}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Abschnitt(
            LocalDate von,
            LocalDate bis,
            String raster,
            List<Term> terme,
            List<String> ausserhalb,
            List<Werte> werte) {}

    /** Ein Term des Rests an diesen Tagen: Messstelle, Bilanz-Rolle ({@code zufluss} · {@code abfluss} · {@code zugeordnet}), Anteil. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Term(String messstelle, UUID messstelleId, String name, String rolle, String anteil) {}

    /** Die Zeilen einer Periode (oder eines Tages): Zufluss, Abfluss, zugeordnet, Rest und ihre Eingänge. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Werte(
            LocalDate von,
            LocalDate bis,
            Summe zufluss,
            Summe abfluss,
            Summe zugeordnet,
            Rest rest,
            List<Eingang> eingaenge) {}

    /** Die Summe einer Rolle ({@code BilanzAbleitung.summe}): „mindestens …“ und „x von y“ ({@code mit_werten} von {@code gesamt}). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Summe(
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            int mitWerten,
            int gesamt,
            List<String> fehlend,
            List<String> kennzeichen,
            String anzeige) {}

    /** Der Rest ({@code MessstelleFormelRegeln.periodenwert("rest", …)}): fest Wirkenergie · Bezug (E1). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Rest(
            BigDecimal menge,
            String groesse,
            String richtung,
            String einheit,
            String zustand,
            Integer abdeckungProzent,
            List<String> fehlend,
            List<String> kennzeichen,
            String kundensatz) {}

    /** Ein Eingang mit dem, was AP-08 an seinem Periodenwert sagt; {@code grund} aus dem Lese-Modell „Werte je Messstelle“. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eingang(
            String messstelle,
            String rolle,
            String anteil,
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            int version,
            List<String> kennzeichen,
            String grund) {}

    /**
     * Der Rest JETZT (F18, PR-688-Weg): Wirkleistung in kW. {@code wert} ist {@code null}, sobald EIN
     * Term fehlt oder veraltet ist — {@code fehlende} nennt ihn, nie eine Teilsumme, nie 0.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Live(
            Double wert,
            String einheit,
            boolean unvollstaendig,
            List<Fehlender> fehlende,
            OffsetDateTime stand) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fehlender(String term, String grund) {}

    /** Die Anfrage „Rest anlegen“; {@code name} optional (vorbelegt „&lt;Anlage&gt; nicht zugeordnet“). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RestAnlegen(UUID hauptzaehlerId, String name) {}

    /** {@code neu = false}: der Hauptzähler hatte schon einen Rest — es ist nichts entstanden. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RestAngelegt(boolean neu, MessstelleRef hauptzaehler, MessstelleDto.Messstelle messstelle) {}
}
