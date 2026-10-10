package com.voltpilot.api.zugriff;

import java.time.Clock;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/**
 * Die Bühnen-Uhr der Prüfumgebung Ahrenberg für die Zuweisungen (UEMS AP-20 IP-13) — gestellt von
 * {@code uems.PruefumgebungUhr}, damit „wirksam“ und „sichtbar“ auf derselben Zeitachse gemessen werden wie die Welt.
 * Nur mit dem Profil {@code local} UND {@code voltpilot.pruefumgebung.buehnen-uhr}; Produktion setzt beides nie.
 */
@Component
@Profile("local")
@ConditionalOnProperty(name = "voltpilot.pruefumgebung.buehnen-uhr")
public class ZugriffBuehnenUhr {
    private final ZugriffKontextLader lader;

    ZugriffBuehnenUhr(ZugriffKontextLader lader) {
        this.lader = lader;
    }

    public void stellen(Clock uhr) {
        lader.uhrStellen(uhr);
    }
}
