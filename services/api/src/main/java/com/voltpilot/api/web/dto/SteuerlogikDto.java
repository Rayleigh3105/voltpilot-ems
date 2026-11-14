package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Antworten der Plattform-Routen der Steuerlogik ({@code /api/v1/admin/sites/{siteId}/steuerlogik}). */
public final class SteuerlogikDto {

    private SteuerlogikDto() {
    }

    /** Eine Logik als Text (YAML-Schreibform oder kanonisches JSON). */
    public record Text(String text) {}

    /** Die angenommene Fassung und ob der Satz an die Box ging. */
    public record Angenommen(UUID logikId, int fassung, String name, String contentHash, JsonNode bericht,
            UUID box, boolean veroeffentlicht) {}

    /** Das Blatt der Plattform: die Logiken der Anlage und ihr Mitlauf. */
    public record Blatt(UUID box, boolean boxKann, List<Logik> logiken) {}

    /** Eine Logik mit ihren Fassungen (jüngste zuerst), der Quittung der Box und dem gemeldeten Mitlauf. */
    public record Logik(UUID logikId, String name, List<Fassung> fassungen, Quittung quittung, List<Lauf> laeufe) {}

    public record Fassung(int fassung, String zustand, String contentHash, JsonNode bericht, Instant angelegtAm,
            String angelegtVon, Instant stillgelegtAm) {}

    /** Was die Box im Block {@code flows.applied} zur Logik quittiert. */
    public record Quittung(int fassung, String contentHash, String zustand, String detail, Instant gemeldetAm) {}

    /** Der jüngste Block {@code logik} einer Box zu dieser Logik, bereinigt. */
    public record Lauf(UUID box, int fassung, String contentHash, String zustand, Instant seit,
            JsonNode rueckmeldung, Instant gemeldetAm) {}

    /** Das Vergleichsprotokoll eines Tages. */
    public record Protokoll(UUID logikId, String tag, List<Wechsel> wechsel) {}

    public record Wechsel(UUID box, int fassung, Instant laufSeit, long nr, Instant t, String geraet, String was,
            JsonNode neu, JsonNode andere, String lage) {}
}
