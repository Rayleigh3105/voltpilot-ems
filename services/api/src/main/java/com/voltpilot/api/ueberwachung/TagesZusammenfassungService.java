package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.ruhezeit.RuhezeitRepository;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.AlarmZeile;
import com.voltpilot.api.versand.BenachrichtigungAusgang;
import com.voltpilot.api.versand.UeberwachungSichtPruefung;
import com.voltpilot.api.versand.VersandRepository;
import com.voltpilot.api.versand.ZustellwegRepository;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Tages-Zusammenfassung (Alerting Scheibe 3, Konzept §6.4 Nr. 6): eine E-Mail je Person und Tag,
 * Vorgabezeit 07:00 Ortszeit, mit aktiven Meldungen und Hinweisen des Tages - "nur wenn es etwas
 * gibt, nie leer".
 *
 * <p>Läuft wie {@link ErinnerungsService} im selben Takt des {@link UeberwachungsLaeufer} je
 * Kundenbereich; die Fälligkeit prüft ein 10-Minuten-Fenster um die gewünschte Uhrzeit (der Takt
 * selbst läuft alle 15 s - ein Fenster fängt einen übersprungenen Takt ab, die Dedup-Zeile
 * {@code taeglicher_rueckblick} verhindert trotzdem jede Doppelung).
 */
@Service
public class TagesZusammenfassungService {

    private static final Duration FENSTER = Duration.ofMinutes(10);
    private static final ZoneId STANDARD_ZEITZONE = ZoneId.of("Europe/Berlin");

    private final UeberwachungRepository repo;
    private final ZustellwegRepository zustellwege;
    private final RuhezeitRepository ruhezeitRepo;
    private final VersandRepository versandRepo;
    private BenachrichtigungAusgang ausgang = BenachrichtigungAusgang.STUMM;
    private UeberwachungSichtPruefung sicht = UeberwachungSichtPruefung.IMMER_SICHTBAR;

    public TagesZusammenfassungService(UeberwachungRepository repo, ZustellwegRepository zustellwege,
            RuhezeitRepository ruhezeitRepo, VersandRepository versandRepo) {
        this.repo = repo;
        this.zustellwege = zustellwege;
        this.ruhezeitRepo = ruhezeitRepo;
        this.versandRepo = versandRepo;
    }

    @Autowired(required = false)
    void setAusgang(BenachrichtigungAusgang ausgang) {
        this.ausgang = ausgang == null ? BenachrichtigungAusgang.STUMM : ausgang;
    }

    @Autowired(required = false)
    void setSicht(UeberwachungSichtPruefung sicht) {
        this.sicht = sicht == null ? UeberwachungSichtPruefung.IMMER_SICHTBAR : sicht;
    }

    public int lauf(Instant jetzt) {
        int n = 0;
        for (ZustellwegRepository.ZusammenfassungsZeile person : zustellwege.personenMitZusammenfassungAktiv()) {
            ZoneId zone = zoneFuer(person.benutzerSub());
            Instant lokalerBeginn = jetzt.atZone(zone).toLocalDate().atStartOfDay(zone).toInstant();
            long seitBeginnS = person.uhrzeit().toSecondOfDay();
            long jetztImTagS = jetzt.atZone(zone).toLocalTime().toSecondOfDay();
            if (jetztImTagS < seitBeginnS || jetztImTagS >= seitBeginnS + FENSTER.toSeconds()) {
                continue; // nicht in ihrem Fenster
            }
            if (sendeFuer(person.benutzerSub(), zone, jetzt.atZone(zone).toLocalDate(), lokalerBeginn, jetzt)) {
                n++;
            }
        }
        return n;
    }

    private boolean sendeFuer(String benutzerSub, ZoneId zone, LocalDate tag, Instant tagBeginn, Instant jetzt) {
        Optional<UUID> rueckblickId = versandRepo.rueckblickNeuAnlegen(benutzerSub, tag);
        if (rueckblickId.isEmpty()) {
            return false; // heute schon geschickt
        }
        List<AlarmZeile> alarme = repo.fuerZusammenfassung(tagBeginn).stream()
                .filter(a -> sicht.sichtbar(a.id(), benutzerSub, jetzt))
                .toList();
        if (alarme.isEmpty()) {
            return false; // "nie leer" (§6.4 Nr. 6)
        }
        long offen = alarme.stream().filter(a -> !"erledigt".equals(a.zustand())).count();
        long erledigt = alarme.size() - offen;
        String betreff = String.format(Locale.GERMANY, "VoltPilot heute: %d offen, %d erledigt", offen, erledigt);
        StringBuilder text = new StringBuilder("Ihre Meldungen heute:\n\n");
        for (AlarmZeile a : alarme) {
            text.append("- ").append(a.kennzeichen()).append(" · ").append(a.schwere()).append(" · ")
                    .append(a.zustand()).append('\n');
        }
        ausgang.email("zusammenfassung", rueckblickId.get(), benutzerSub, "zusammenfassung", betreff,
                text.toString());
        return true;
    }

    private ZoneId zoneFuer(String benutzerSub) {
        return ruhezeitRepo.eigene(benutzerSub).map(RuhezeitRepository.RuhezeitPerson::zeitzone).map(ZoneId::of)
                .orElse(STANDARD_ZEITZONE);
    }
}
