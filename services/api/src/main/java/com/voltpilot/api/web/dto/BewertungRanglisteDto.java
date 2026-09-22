package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** AP-16 IP-9/IP-10: Mengen, Kriterien-Urteil und vollständiger Herkunftsentwurf; keine Einstufung. */
public final class BewertungRanglisteDto {
    private BewertungRanglisteDto() {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Rangliste(LocalDate von, LocalDate bis, UUID umfangId, Integer umfangFassung,
            boolean teilansicht, int monate, KriterienGrundlage kriterien, StandUrteil urteil,
            Nenner nenner, String zugeordnet, String rest, String abdeckungProzent,
            String zustand, List<Anlage> anlagen, List<Einsatz> einsaetze, List<Einsatz> weitereTraeger) {}
    public record KriterienGrundlage(int fassung, JsonNode werte) {}
    public record StandUrteil(String K7, String K8) {}
    public record Nenner(String wert, String einheit, int vorhanden, int gesamt, String anlagen, String zustand) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlage(UUID id, String name, LocalDate ab, String nenner, String zugeordnet,
            String rest, String restAnteilProzent, String zustand) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Einsatz(UUID id, String kennzeichen, String name, UUID prozessId, String traeger,
            String einheit, String menge, String zustand, String ersatz, String ersatzProzent,
            String datenlageProzent, String anteilProzent, String kumuliertZugeordnetProzent,
            String anteilZustand, Integer rang, Urteil urteil, String vorschlag,
            HerkunftEntwurf herkunft, List<Messstelle> messstellen,
            List<ProzessMessstellenDto.Hinweis> prozessSummeHinweise) {}
    public record Urteil(String K1, String K2, String K3, String K5, String K6) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record HerkunftEntwurf(String zeitraum, int kriterienFassung, List<HerkunftEingang> eingaenge,
            HerkunftNenner nenner, Urteil urteil, String vorschlag) {}
    public record HerkunftEingang(String objekt, String von, String bis, String wert,
            Integer version, String zustand) {}
    public record HerkunftNenner(String wert, String anlagen, List<Bilanzwert> bilanzwerte) {}
    public record Bilanzwert(String anlage, LocalDate von, LocalDate bis, String wert,
            int version, String zustand, List<BilanzEingang> eingaenge) {}
    public record BilanzEingang(String objekt, String wert, int version, String zustand) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Messstelle(UUID id, String kennzeichen, UUID anlageId, String einheit, String menge,
            String zustand, String ersatz, String ersatzProzent, MessstelleWerteDto.Werte monatswerte) {}
}
