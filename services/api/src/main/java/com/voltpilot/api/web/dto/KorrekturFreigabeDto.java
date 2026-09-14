package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;

/**
 * Die Formen der Vier-Augen-Schnittstelle (UEMS AP-08 IP-15, E8): {@code /api/v1/unternehmen/vieraugen}
 * und {@code /api/v1/korrekturen/{kennung}/freigeben|zuruecknehmen}. snake_case wie die übrigen
 * UEMS-Schnittstellen; Zeitpunkte mit Versatz.
 */
public final class KorrekturFreigabeDto {
    private KorrekturFreigabeDto() {}

    /** {@code PUT …/vieraugen}: „Freigabe durch eine zweite Person“ an ({@code true}) oder aus. */
    public record VierAugenSetzen(Boolean vieraugen) {}

    /** Die Einstellung: {@code vorgabe} = nie eingestellt — dann gilt die Vorgabe aus. */
    public record VierAugen(boolean vieraugen, boolean vorgabe) {}

    /** {@code POST …/freigeben}: die Begründung ist Pflicht (10 bis 500 Zeichen). */
    public record Freigeben(String begruendung) {}

    /** {@code POST …/zuruecknehmen}: der Grund ist Pflicht (10 bis 500 Zeichen). */
    public record Zuruecknehmen(String grund) {}

    /** Wer eine Fassung schrieb — dieselbe Form wie im Änderungsprotokoll. */
    public record Urheber(String name, String rolle, String art) {}

    /**
     * Die Entscheidung mit ihrem Protokoll — die vier Angaben aus E8: {@code ersteller} (Fassung 1),
     * {@code entschieden_von}, {@code entschieden_am} und {@code begruendung} (die neue Fassung).
     * {@code vieraugen}: die Einstellung, unter der freigegeben wurde ({@code null} beim Zurücknehmen);
     * {@code von_ersteller}: Ersteller und Entscheider sind dieselbe Person („freigegeben von der
     * Erstellerin“, nur bei Vier-Augen aus möglich).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Entscheidung(String kennung, String status, int fassung, Urheber ersteller, Urheber entschiedenVon,
            OffsetDateTime entschiedenAm, String begruendung, Boolean vieraugen, boolean vonErsteller) {}
}
