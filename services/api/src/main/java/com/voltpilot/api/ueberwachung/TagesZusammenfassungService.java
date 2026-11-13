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
    /** Kunden-Alarmierung P4: so steht eine Meldung da, die die Beruhigung nicht einzeln geschickt hat (§6.5). */
    static final String BERUHIGT_WORT = "nicht einzeln gemeldet (gleiche Meldung kurz davor)";

    private final UeberwachungRepository repo;
    private final ZustellwegRepository zustellwege;
    private final RuhezeitRepository ruhezeitRepo;
    private final VersandRepository versandRepo;
    private BenachrichtigungAusgang ausgang = BenachrichtigungAusgang.STUMM;
    private static final java.util.Map<String, String> SCHWERE_WORT = java.util.Map.of("hinweis", "Hinweis",
            "warnung", "Warnung", "dringend", "Dringend");
    private MeldungsText texte = new WerteKatalog().meldungsText();
    private UeberwachungsService dienst;
    private String basisUrl = "http://localhost:5173";
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
    void setTexte(WerteKatalog katalog, UeberwachungsService dienst,
            @org.springframework.beans.factory.annotation.Value(
                    "${voltpilot.versand.bestaetigung-basis-url:http://localhost:5173}") String basisUrl) {
        this.texte = katalog.meldungsText();
        this.dienst = dienst;
        this.basisUrl = basisUrl;
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
        // Kunden-Alarmierung P4 (§6.5): was die Beruhigung bei dieser Person heute zurückhielt, steht hier - auch wenn
        // es inzwischen erledigt ist und darum nicht mehr unter den offenen Meldungen.
        java.util.Set<UUID> beruhigt = new java.util.HashSet<>(versandRepo.beruhigteSeit(benutzerSub, tagBeginn));
        List<AlarmZeile> offeneUndHinweise = repo.fuerZusammenfassung(tagBeginn);
        java.util.Set<UUID> schonDa = new java.util.HashSet<>(offeneUndHinweise.stream().map(AlarmZeile::id).toList());
        List<AlarmZeile> alarme = java.util.stream.Stream.concat(offeneUndHinweise.stream(),
                        beruhigt.stream().filter(id -> !schonDa.contains(id)).map(repo::alarm)
                                .flatMap(Optional::stream))
                .filter(a -> sicht.sichtbar(a.id(), benutzerSub, jetzt))
                .sorted(java.util.Comparator.comparing(AlarmZeile::ausgeloestAm).reversed())
                .toList();
        if (alarme.isEmpty()) {
            return false; // "nie leer" (§6.4 Nr. 6)
        }
        long offen = alarme.stream().filter(a -> !"erledigt".equals(a.zustand())).count();
        long erledigt = alarme.size() - offen;
        String betreff = String.format(Locale.GERMANY, "VoltPilot heute: %d offen, %d erledigt", offen, erledigt);
        // Kunden-Alarmierung P1: je Meldung ihr Titel, die Zeit in Ortszeit und ein Wort statt Rohwerten.
        StringBuilder text = new StringBuilder("Ihre Meldungen heute:\n\n");
        for (AlarmZeile a : alarme) {
            MeldungsText.Eingabe eingabe = dienst != null ? dienst.textEingabe(a)
                    : UeberwachungsService.textEingabeNurRepo(repo, a);
            text.append("- ").append(MeldungsText.zeit(a.ausgeloestAm(), jetzt)).append(" · ")
                    .append(texte.titel(eingabe, jetzt)).append(" · ").append(SCHWERE_WORT.getOrDefault(a.schwere(),
                            "Hinweis")).append(" · ").append("erledigt".equals(a.zustand()) ? "erledigt" : "offen")
                    .append(beruhigt.contains(a.id()) ? " · " + BERUHIGT_WORT : "")
                    .append(" (").append(a.kennzeichen()).append(")\n");
        }
        text.append("\nAlle Meldungen: ").append(basisUrl.replaceAll("/+$", "")).append("/#/meldungen\n");
        ausgang.email("zusammenfassung", rueckblickId.get(), benutzerSub, "zusammenfassung", betreff,
                text.toString());
        return true;
    }

    private ZoneId zoneFuer(String benutzerSub) {
        return ruhezeitRepo.eigene(benutzerSub).map(RuhezeitRepository.RuhezeitPerson::zeitzone).map(ZoneId::of)
                .orElse(STANDARD_ZEITZONE);
    }
}
