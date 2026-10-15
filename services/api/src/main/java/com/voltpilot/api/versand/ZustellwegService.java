package com.voltpilot.api.versand;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * „So erreichen wir Sie“ (§6.6): jede Person legt ihren Zustellweg E-Mail einmal selbst an und
 * bestätigt ihn über einen Link - bis dahin bekommt sie Meldungen nur im Portal. Der Benutzer-Spiegel
 * ist ungeprüft und veraltet still, darum wird hier NIE eine Adresse übernommen, die nicht diesen
 * eigenen Bestätigungsweg durchlaufen hat.
 */
@Service
public class ZustellwegService {

    /** Token-Gültigkeit: lang genug für ein E-Mail-Postfach, kurz genug gegen einen verlorenen Link. */
    static final Duration TOKEN_GUELTIGKEIT = Duration.ofDays(2);

    private final ZustellwegRepository zustellwege;
    private final VersandRepository ausgang;
    private final String basisUrl;
    private volatile Clock uhr = Clock.systemUTC();

    public ZustellwegService(ZustellwegRepository zustellwege, VersandRepository ausgang,
            @Value("${voltpilot.versand.bestaetigung-basis-url:http://localhost:5173}") String basisUrl) {
        this.zustellwege = zustellwege;
        this.ausgang = ausgang;
        this.basisUrl = basisUrl;
    }

    /** Nur für Tests: die Uhr, nach der der Token abläuft. */
    public void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    public Optional<ZustellwegRepository.Zustellweg> eigener(String benutzerSub) {
        return zustellwege.eigener(benutzerSub);
    }

    /**
     * Legt den eigenen Zustellweg an/ändert ihn und reiht sofort die Bestätigungs-Mail ein - mit dem
     * Ziel direkt in der Ausgangszeile (die Adresse ist ja noch unbestätigt, der Zusteller kann sie
     * nicht aus einem bestätigten Zustellweg lesen, weil es noch keinen gibt).
     */
    public void anfordern(String benutzerSub, String ziel) {
        Instant jetzt = uhr.instant();
        String token = BestaetigungsToken.erzeugen();
        UUID id = zustellwege.anlegenOderErneuern(benutzerSub, ziel, token, jetzt.plus(TOKEN_GUELTIGKEIT));
        String link = basisUrl + "/#/zustellweg/bestaetigen?token=" + token;
        ausgang.emailMitZiel("zustellweg_bestaetigung", id, benutzerSub, "bestaetigung", "VoltPilot: Adresse bestätigen",
                "Bitte bestätigen Sie diese E-Mail-Adresse für Meldungen von VoltPilot:\n\n" + link
                        + "\n\nDer Link ist zwei Tage gültig. Haben Sie das nicht angefordert, ignorieren Sie diese Mail.",
                ziel);
    }

    /** {@code true}, wenn der Token gültig war und die Adresse jetzt bestätigt ist. */
    public boolean bestaetigen(String token) {
        return zustellwege.bestaetigen(token, uhr.instant());
    }
}
