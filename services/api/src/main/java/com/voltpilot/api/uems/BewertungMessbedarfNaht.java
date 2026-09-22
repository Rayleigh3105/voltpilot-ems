package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Benannte Naht für AP-16 IP-19. IP-13 kennt noch keine gespeicherten Messbedarfe; geplante
 * Messstellen ohne Datenquelle werden unabhängig davon bereits gelesen.
 */
@Component
public class BewertungMessbedarfNaht {
    public record Bedarf(UUID einsatzId, UUID anlageId, String kennzeichen, String ort) {}

    public List<Bedarf> offene(LocalDate von, LocalDate bis) {
        return List.of();
    }
}
