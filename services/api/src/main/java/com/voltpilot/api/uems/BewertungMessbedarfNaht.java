package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * IP-19-Naht: offene Messbedarfe erscheinen unabhängig von einer Messstellenmenge unter geplant.
 */
@Component
public class BewertungMessbedarfNaht {
    public record Bedarf(UUID einsatzId, UUID anlageId, String kennzeichen, String ort) {}

    private final MessbedarfRepository repository;

    public BewertungMessbedarfNaht(MessbedarfRepository repository) {
        this.repository = repository;
    }

    public List<Bedarf> offene(LocalDate von, LocalDate bis) {
        return repository.offene().stream()
                .map(b -> new Bedarf(b.einsatzId(), null, b.kennzeichen(), b.ort()))
                .toList();
    }
}
