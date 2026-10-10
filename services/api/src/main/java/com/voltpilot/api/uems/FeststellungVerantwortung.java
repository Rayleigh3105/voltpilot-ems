package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementVerantwortungDto.Objekt;
import java.util.List;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-19 (PA4): die Feststellungen in „Wer ist wofür verantwortlich“ — je Feststellung ihr Verantwortlicher
 * (Konto, FS1) und ihr Zustand, gelesen über {@link FeststellungService#liste} mit dem Zaun des Aufrufers. Wer sie
 * festgestellt hat, ist hier nicht „verantwortlich“.
 */
@Component
@Order(20)
public class FeststellungVerantwortung implements VerantwortungQuelle {

    /** Die Art dieser Quelle — ergänzt {@code objekt.art} in {@code openapi.yaml} nach der des internen Audits. */
    static final List<String> ARTEN = List.of("feststellung");

    private final FeststellungService feststellungen;

    public FeststellungVerantwortung(FeststellungService feststellungen) {
        this.feststellungen = feststellungen;
    }

    @Override
    public List<Objekt> objekte() {
        return feststellungen.liste(null).feststellungen().stream()
                .map(f -> new Objekt("feststellung", f.id(), f.kennzeichen(), f.wortlaut(), f.verantwortlich(),
                        f.zustand()))
                .toList();
    }
}
