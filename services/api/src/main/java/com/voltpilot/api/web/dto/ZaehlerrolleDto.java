package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.uems.ZaehlerrolleRegeln;
import com.voltpilot.api.uems.ZaehlerrolleRepository.Fassung;
import com.voltpilot.api.uems.ZaehlerrolleService;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** Die Antworten von {@code /api/v1/messstellen/{id}/zaehlerrolle} (MiSpeL MP-6), snake_case wie der Vertrag. */
public final class ZaehlerrolleDto {

    private ZaehlerrolleDto() {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Rolle(String rolle, String zaehlpunkt, String messstellenbetreiber, String eichstatus,
            LocalDate eichfristBis, String wertequelle, LocalDate gueltigAb) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FassungDto(UUID id, String rolle, String zaehlpunkt, String messstellenbetreiber, String eichstatus,
            LocalDate eichfristBis, String wertequelle, LocalDate gueltigAb, LocalDate gueltigBis,
            Instant aufgehobenAm, Instant eingetragenAm, String eingetragenVon) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record BefundDto(String code, String schwere, String messstelle, String betroffen, String fundstelle,
            String satz) {}

    /**
     * {@code rolle} {@code null} = am Tag keine Rolle; {@code urteil} ∈ tauglich · nicht_tauglich · nicht_pruefbar ·
     * keine_rolle.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ansicht(UUID messstelleId, String messstelle, LocalDate am, UUID anlage, Rolle rolle,
            String festlegungsgroesse, String urteil, List<BefundDto> befunde, List<FassungDto> fassungen) {}

    public static Ansicht aus(ZaehlerrolleService.Ansicht a) {
        Fassung f = a.aktuell();
        Rolle rolle = f == null ? null : new Rolle(f.angaben().rolle(), f.angaben().zaehlpunkt(),
                f.angaben().messstellenbetreiber(), f.angaben().eichstatus(), f.angaben().eichfristBis(),
                f.angaben().wertequelle(), f.gueltigAb());
        List<BefundDto> befunde = a.befunde().stream().map(ZaehlerrolleDto::befund).toList();
        List<FassungDto> fassungen = a.fassungen().stream().map(x -> {
            Fassung y = x.fassung();
            ZaehlerrolleRegeln.Angaben g = y.angaben();
            return new FassungDto(y.id(), g.rolle(), g.zaehlpunkt(), g.messstellenbetreiber(), g.eichstatus(),
                    g.eichfristBis(), g.wertequelle(), y.gueltigAb(), x.gueltigBis(), y.aufgehobenAm(),
                    y.eingetragenAm(), y.eingetragenVon());
        }).toList();
        return new Ansicht(a.messstelle().id(), a.messstelle().kennzeichen(), a.am(), a.anlage(), rolle,
                a.festlegungsgroesse(), a.urteil(), befunde, fassungen);
    }

    public static BefundDto befund(ZaehlerrolleRegeln.Befund b) {
        return new BefundDto(b.code(), b.schwere(), b.messstelle(), b.betroffen(), b.fundstelle(), b.satz());
    }
}
