package com.voltpilot.api.uems;

import com.voltpilot.api.zugriff.ZugriffBuehnenUhr;
import jakarta.annotation.PostConstruct;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/**
 * Die Bühnen-Uhr der Prüfumgebung Ahrenberg (UEMS AP-20 IP-13, E5, PD1, PD2): die Welt der Referenzdatei 1.10 läuft
 * vom 01.10.2026 bis zum 30.04.2029, und die Leser des Energiemanagements zeigen nur, was bis „heute“ geschah — das
 * Verzeichnis lässt jede Zeile nach dem Stichtag weg. Beim Anlegen stellt diese Komponente die Uhren, die
 * {@code UemsEnergiemanagementAbnahmeTest} stellt, und die der Zuweisungen auf {@code voltpilot.pruefumgebung.buehnen-uhr}
 * — und lässt sie von dort in echter Zeit weiterlaufen.
 *
 * <p>Eine Zeitachse für alles: {@link KennzahlService} misst die Sichtbarkeit an den Zuweisungen zu SEINEM „jetzt“;
 * liefen Leser und Zuweisungen auf verschiedenen Uhren, wäre eine echte Frist auf der Bühne längst abgelaufen. Die Frist
 * des Einsicht-Kontos zählt deshalb auf der Bühne (letzter Tag = Bühnen-Heute + Tage) und endet nach genauso vielen
 * echten Tagen.
 *
 * <p>Nur mit dem Profil {@code local} UND gesetzter Eigenschaft — Produktion setzt beides nie.
 */
@Component
@Profile("local")
@ConditionalOnProperty(name = "voltpilot.pruefumgebung.buehnen-uhr")
class PruefumgebungUhr {
    private static final Logger LOG = LoggerFactory.getLogger(PruefumgebungUhr.class);

    private final Instant buehne;
    private final EnergiemanagementDokumentService dokumente;
    private final InternesAuditService audits;
    private final FeststellungService feststellungen;
    private final KennzahlService kennzahlen;
    private final BerichtService berichte;
    private final EnergiemanagementVerzeichnisService verzeichnis;
    private final EnergiemanagementWiedervorlageService wiedervorlage;
    private final ZugriffBuehnenUhr zugriffe;

    PruefumgebungUhr(@Value("${voltpilot.pruefumgebung.buehnen-uhr}") String buehne,
            EnergiemanagementDokumentService dokumente, InternesAuditService audits,
            FeststellungService feststellungen, KennzahlService kennzahlen, BerichtService berichte,
            EnergiemanagementVerzeichnisService verzeichnis, EnergiemanagementWiedervorlageService wiedervorlage,
            ZugriffBuehnenUhr zugriffe) {
        this.buehne = Instant.parse(buehne);
        this.dokumente = dokumente;
        this.audits = audits;
        this.feststellungen = feststellungen;
        this.kennzahlen = kennzahlen;
        this.berichte = berichte;
        this.verzeichnis = verzeichnis;
        this.wiedervorlage = wiedervorlage;
        this.zugriffe = zugriffe;
    }

    /**
     * Ab jetzt steht die Bühne auf dem eingestellten Augenblick und läuft in echter Zeit weiter. Kein Start-Lauf
     * (kein Läufer im Sinn von {@code UemsLaeuferMelder}): nur Uhren, keine Arbeit, keine Datenbank.
     */
    @PostConstruct
    void stellen() {
        stellen(Clock.offset(Clock.systemUTC(), Duration.between(Instant.now(), buehne)));
        LOG.warn("Prüfumgebung: Energiemanagement und Zuweisungen laufen ab {} (Bühnen-Uhr, nur Profil local)", buehne);
    }

    /** Die Uhren der Abnahme und die der Zuweisungen — auch für den Aufbau der Welt. */
    void stellen(Clock uhr) {
        dokumente.uhrStellen(uhr);
        audits.uhrStellen(uhr);
        feststellungen.uhrStellen(uhr);
        kennzahlen.uhrStellen(uhr);
        berichte.uhrStellen(uhr);
        verzeichnis.uhrStellen(uhr);
        wiedervorlage.uhrStellen(uhr);
        zugriffe.stellen(uhr);
    }
}
