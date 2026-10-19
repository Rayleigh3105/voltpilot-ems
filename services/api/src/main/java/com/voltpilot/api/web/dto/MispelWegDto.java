package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.mispel.MispelWegRegeln;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Die Antwort von {@code GET /api/v1/sites/{siteId}/mispel-weg} (MiSpeL MP-55), snake_case wie der Vertrag
 * {@code docs/contracts/v2/mispel-weg.md} § 5.
 */
public final class MispelWegDto {

    private MispelWegDto() {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Tuer(String ziel, String beschriftung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Station(int nr, String schluessel, String titel, String erklaerung, String wer, String zustand,
            String stand, Tuer tuer) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Strecke(String art, String titel, UUID komponenteId, int erledigt, int gesamt, String satz,
            List<Station> stationen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ansicht(UUID siteId, LocalDate heute, String satz, List<Strecke> strecken) {}

    public static Ansicht aus(UUID siteId, LocalDate heute, MispelWegRegeln.Ergebnis e) {
        return new Ansicht(siteId, heute, e.satz(), e.strecken().stream().map(MispelWegDto::strecke).toList());
    }

    private static Strecke strecke(MispelWegRegeln.Strecke s) {
        return new Strecke(s.art(), s.titel(), s.komponenteId(), s.erledigt(), s.gesamt(), s.satz(),
                s.stationen().stream().map(x -> new Station(x.nr(), x.schluessel(), x.titel(), x.erklaerung(), x.wer(),
                        x.zustand(), x.stand(), x.tuer() == null ? null
                                : new Tuer(x.tuer().ziel(), x.tuer().beschriftung()))).toList());
    }
}
