package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.mispel.LadepunktRegeln;
import com.voltpilot.api.mispel.LadepunktRepository;
import com.voltpilot.api.mispel.LadepunktService;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Antworten von {@code /api/v1/sites/{siteId}/ladepunkte/…} (MiSpeL MP-31), snake_case wie der Vertrag
 * {@code docs/contracts/v2/mispel-ladepunkt-bidirektional.md}.
 */
public final class LadepunktBidirektionalDto {

    private LadepunktBidirektionalDto() {}

    /** {@code erfasst} {@code false} = keine Fassung bis zum Tag; der Bestand gilt als unidirektional. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FaehigkeitDto(boolean erfasst, String nutzbarkeit, boolean v2h, boolean v2g,
            boolean rueckspeisungBeiEinspeisungUnterbunden, BigDecimal rueckspeiseleistungKw, LocalDate gueltigAb,
            LocalDate gueltigBis) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Z2Dto(String groesse, String messstelle, String zaehlpunkt, String messstellenbetreiber,
            String eichstatus, LocalDate eichfristBis, String wertequelle, String urteil) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record BefundDto(String code, String schwere, String messstelle, String fundstelle, String satz) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FensterDto(int wochentag, String ankunft, String abfahrt, BigDecimal abfahrtSocPct) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FahrzeugfensterDto(BigDecimal mindestSocPct, BigDecimal kapazitaetKwh, List<FensterDto> anwesenheit,
            Instant geaendertAm, String geaendertVon) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FassungDto(UUID id, String nutzbarkeit, boolean v2h, boolean v2g,
            boolean rueckspeisungBeiEinspeisungUnterbunden, BigDecimal rueckspeiseleistungKw, LocalDate gueltigAb,
            LocalDate gueltigBis, Instant aufgehobenAm, Instant eingetragenAm, String eingetragenVon) {}

    /**
     * {@code einordnung} ∈ sonstiger_verbrauch · ladepunkt_der_festlegung · alternative_zur_ausschliesslichkeit;
     * {@code fahrzeugfenster} {@code null} = nie gesetzt.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ansicht(UUID anlage, UUID komponente, String name, String typ, String chargePointId, LocalDate am,
            FaehigkeitDto faehigkeit, String einordnung, String einordnungFundstelle, List<Z2Dto> z2,
            List<BefundDto> befunde, FahrzeugfensterDto fahrzeugfenster, List<FassungDto> fassungen,
            SignierterMesswertDto signierterMesswert) {}

    /**
     * MiSpeL MP-38: die letzte signierte Ablesung (OCMF) bis zum Ende des Tages; {@code eichstatus}
     * {@code eichrechtskonform} nur bei gültiger Signatur, sonst {@code null} (Gerätewert ohne Eichstatus).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record SignierterMesswertDto(java.time.Instant gemessenAm, String zeit, String anlass, String wert,
            String einheit, String obis, String zaehlerkennung, String signaturstatus, String pruefgrund,
            String schluesselQuelle, String schluesselSha256, String eichstatus) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(UUID anlage, LocalDate am, List<Ansicht> ladepunkte) {}

    public static Liste liste(UUID anlage, LocalDate am, List<LadepunktService.Ansicht> alle) {
        return new Liste(anlage, am, alle.stream().map(LadepunktBidirektionalDto::aus).toList());
    }

    public static Ansicht aus(LadepunktService.Ansicht a) {
        LadepunktRegeln.Faehigkeit f = a.faehigkeit();
        LadepunktRepository.Fassung fassung = a.fassung();
        FaehigkeitDto faehigkeit = new FaehigkeitDto(fassung != null, f.nutzbarkeit(), f.v2h(), f.v2g(),
                f.rueckspeisungBeiEinspeisungUnterbunden(), f.rueckspeiseleistungKw(),
                fassung == null ? null : fassung.gueltigAb(), a.gueltigBis());
        List<Z2Dto> z2 = a.z2().stream().map(z -> new Z2Dto(z.groesse(), z.kennzeichen(), z.angaben().zaehlpunkt(),
                z.angaben().messstellenbetreiber(), z.angaben().eichstatus(), z.angaben().eichfristBis(),
                z.angaben().wertequelle(), z.urteil())).toList();
        List<BefundDto> befunde = a.befunde().stream()
                .map(b -> new BefundDto(b.code(), b.schwere(), b.messstelle(), b.fundstelle(), b.satz())).toList();
        LadepunktRepository.FensterStand stand = a.fahrzeugfenster();
        FahrzeugfensterDto fenster = stand == null ? null : new FahrzeugfensterDto(stand.fenster().mindestSocPct(),
                stand.fenster().kapazitaetKwh(), stand.fenster().anwesenheit().stream()
                        .map(w -> new FensterDto(w.wochentag(), hhmm(w.ankunft()), hhmm(w.abfahrt()),
                                w.abfahrtSocPct()))
                        .toList(),
                stand.geaendertAm(), stand.geaendertVon());
        List<FassungDto> fassungen = a.fassungen().stream().map(x -> {
            LadepunktRepository.Fassung y = x.fassung();
            LadepunktRegeln.Faehigkeit g = y.faehigkeit();
            return new FassungDto(y.id(), g.nutzbarkeit(), g.v2h(), g.v2g(), g.rueckspeisungBeiEinspeisungUnterbunden(),
                    g.rueckspeiseleistungKw(), y.gueltigAb(), x.gueltigBis(), y.aufgehobenAm(), y.eingetragenAm(),
                    y.eingetragenVon());
        }).toList();
        LadepunktRepository.Komponente k = a.komponente();
        String name = k.label() != null ? k.label() : k.chargePointId();
        return new Ansicht(a.anlage(), k.id(), name, k.typ(), k.chargePointId(), a.am(), faehigkeit, a.einordnung(),
                LadepunktRegeln.einordnungFundstelle(a.einordnung()), z2, befunde, fenster, fassungen,
                signiert(a.signierterMesswert()));
    }

    private static SignierterMesswertDto signiert(LadepunktRepository.SignierterMesswert s) {
        return s == null ? null : new SignierterMesswertDto(s.gemessenAm(), s.zeit(), s.anlass(), s.wert(), s.einheit(),
                s.obis(), s.zaehlerkennung(), s.signaturstatus(), s.pruefgrund(), s.schluesselQuelle(),
                s.schluesselSha256(), LadepunktRegeln.eichstatusSigniert(s.signaturstatus()));
    }

    /** Uhrzeit wie in der Anfrage: {@code HH:MM}. */
    private static String hhmm(LocalTime t) {
        return String.format("%02d:%02d", t.getHour(), t.getMinute());
    }
}
