package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.mispel.FoerderwegRegeln;
import com.voltpilot.api.mispel.FoerderwegRepository.Fassung;
import com.voltpilot.api.mispel.FoerderwegService;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** Die Antwort von {@code /api/v1/sites/{siteId}/foerderweg} (MiSpeL MP-5), snake_case wie der Vertrag. */
public final class FoerderwegDto {

    private FoerderwegDto() {}

    /** {@code moeglich}: der Förderweg lässt Netzladen zu; {@code heute}: die Einstellung an der Anlage heute. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Netzladen(Boolean moeglich, boolean heute) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FassungDto(UUID id, String foerderweg, String formelsatz, boolean einverstaendnis,
            LocalDate gueltigAb, LocalDate gueltigBis, Instant aufgehobenAm, Instant eingetragenAm,
            String eingetragenVon, String awRegel, String direktvermarkter, Boolean bilanzkreisGesondert) {}

    /**
     * {@code quelle} ∈ fassung · bestand · unbekannt (vor der ersten Fassung einer Anlage, die schon eine hat);
     * bei „unbekannt“ sind {@code foerderweg}, {@code begriff} und {@code rechtsgrundlage} {@code null}.
     * {@code awRegel} (MP-12b): die AW-Differenzierung der Fassung ({@code null} = keine eingetragen, im Bestand immer).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ansicht(UUID siteId, LocalDate am, String quelle, String foerderweg, String begriff,
            String rechtsgrundlage, String formelsatz, LocalDate formelsatzGebundenBis, Boolean einverstaendnis,
            LocalDate gueltigAb, Netzladen netzladen, List<FassungDto> fassungen, String awRegel,
            Vormerkung vormerkung, String direktvermarkter, Boolean bilanzkreisGesondert) {}

    /**
     * Die vorgemerkte Fassung (Vertrag 1.2, § 5): sie gilt ab {@code gueltigAb}, dem nächsten Monatsersten; {@code null}
     * = keine. Immer relativ zu heute, gleich welcher Tag {@code am} gelesen wird.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vormerkung(UUID id, String foerderweg, String begriff, String rechtsgrundlage, String formelsatz,
            boolean einverstaendnis, LocalDate gueltigAb, String awRegel, String direktvermarkter,
            Boolean bilanzkreisGesondert) {}

    public static Ansicht aus(FoerderwegService.Ansicht a) {
        FoerderwegRegeln.Angaben g = a.angaben();
        Fassung f = a.fassung();
        String quelle = f != null ? "fassung" : g != null ? "bestand" : "unbekannt";
        List<FassungDto> fassungen = a.fassungen().stream().map(x -> {
            Fassung y = x.fassung();
            return new FassungDto(y.id(), y.angaben().foerderweg().wert(), y.angaben().formelsatz(),
                    y.angaben().einverstaendnis(), y.gueltigAb(), x.gueltigBis(), y.aufgehobenAm(),
                    y.eingetragenAm(), y.eingetragenVon(), y.angaben().awRegel(), y.angaben().direktvermarkter(),
                    y.angaben().bilanzkreisGesondert());
        }).toList();
        return new Ansicht(a.siteId(), a.am(), quelle, g == null ? null : g.foerderweg().wert(),
                g == null ? null : g.foerderweg().begriff(), g == null ? null : g.foerderweg().rechtsgrundlage(),
                g == null ? null : g.formelsatz(), g == null ? null : a.formelsatzGebundenBis(),
                f == null ? null : f.angaben().einverstaendnis(), f == null ? null : f.gueltigAb(),
                new Netzladen(g == null ? null : g.foerderweg().netzladenMoeglich(), a.netzladenHeute()), fassungen,
                g == null ? null : g.awRegel(), vormerkung(a.vormerkung()), g == null ? null : g.direktvermarkter(),
                g == null ? null : g.bilanzkreisGesondert());
    }

    private static Vormerkung vormerkung(Fassung v) {
        if (v == null) {
            return null;
        }
        FoerderwegRegeln.Angaben g = v.angaben();
        return new Vormerkung(v.id(), g.foerderweg().wert(), g.foerderweg().begriff(), g.foerderweg().rechtsgrundlage(),
                g.formelsatz(), g.einverstaendnis(), v.gueltigAb(), g.awRegel(), g.direktvermarkter(),
                g.bilanzkreisGesondert());
    }
}
