package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * Der Stand eines Löschzugs (vp-kunde-loeschen-504): {@code POST …/delete} startet den Lauf (202)
 * und das Portal fragt {@code GET …/loeschlauf}, bis {@code stand} nicht mehr {@code laeuft} ist.
 * {@code fertig} heißt: die Abbau-Transaktion hat committet. {@code gescheitert} trägt in
 * {@code fehler} den ehrlichen Satz (bei einem Rollback ausdrücklich „es wurde nichts gelöscht").
 * {@code bericht} ist der Abschlussbericht - {@code null}, solange der Lauf läuft, nach einem
 * Scheitern, oder wenn er bei einem Absturz nach dem Commit verloren ging (fertig bleibt fertig).
 */
public record KundenbereichLoeschlaufDto(
        UUID laufId,
        UUID tenantId,
        String name,
        String stand,
        Instant gestartetAm,
        Instant beendetAm,
        String fehler,
        TenantOffboardingReportDto bericht) {
}
