package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.PersonKurz;
import com.voltpilot.api.web.dto.EnergiemanagementTeilVermerkDto;
import com.voltpilot.api.web.dto.EnergiemanagementTeilVermerkDto.Vermerk;
import com.voltpilot.api.web.dto.EnergiemanagementTeilVermerkDto.Vermerke;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Konzept Nachweisen n1, Runde 2, Entscheid 5: „Trifft bei uns zurzeit nicht zu“ je Teil des Überblicks.
 *
 * <p>Für jeden der 18 Teile (Vertrag energiemanagement 1.3, Vokabular {@code teil}) hält der Kunde fest, dass er bei
 * ihm zurzeit nicht zutrifft: mit einem Satz (Begründung, 10 bis 500 Zeichen) und der Person, die es entschieden hat
 * (eine Person im Energiemanagement, auch ohne Konto), am Tag der Entscheidung, nie in der Zukunft. Höchstens ein
 * geltender Vermerk je Teil; aufgehoben wird er einmal, danach ist er endgültig, und ein neuer Stand ist ein neuer
 * Vermerk. Ein Urteil fällt VoltPilot nicht: welcher Teil zutrifft, entscheidet der Kunde.
 *
 * <p>Rechte: Schreiben {@code energiemanagement.verwalten} am Unternehmen (am Controller); lesen nur, wer
 * unternehmensweit liest (Zaun {@code site_scope}): wer nur Standorte liest, bekommt keinen Vermerk, ohne Hinweis.
 */
@Service
public class EnergiemanagementTeilVermerkService {

    static final List<String> TEILE = EnergiemanagementRegeln.VOKABULARE.get("teil");
    private static final int SATZ_MIN = EnergiemanagementRegeln.STARTWERTE.begruendung_zeichen_mindestens();
    private static final int SATZ_MAX = EnergiemanagementRegeln.STARTWERTE.begruendung_zeichen_hoechstens();

    private final EnergiemanagementTeilVermerkRepository repo;
    private final EnergiemanagementPersonenRepository personen;
    private final UnternehmenRepository unternehmen;
    private final RechtPruefung rechte;
    private final TransactionTemplate tx;
    private volatile Clock uhr = Clock.systemUTC();

    public EnergiemanagementTeilVermerkService(EnergiemanagementTeilVermerkRepository repo,
            EnergiemanagementPersonenRepository personen, UnternehmenRepository unternehmen, RechtPruefung rechte,
            PlatformTransactionManager tm) {
        this.repo = repo;
        this.personen = personen;
        this.unternehmen = unternehmen;
        this.rechte = rechte;
        this.tx = new TransactionTemplate(tm);
    }

    /** Für Tests und die Prüfumgebung: die Uhr, an der „heute“, „nie in der Zukunft“ und das Aufheben hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * Die Vermerke am Abruf: geltende zuerst in der Folge des Vokabulars {@code teil}, dann aufgehobene, die zuletzt
     * aufgehobene zuerst. Wer nicht unternehmensweit liest, bekommt keinen, ohne Hinweis und ohne Anzahl.
     */
    public Vermerke vermerke() {
        OffsetDateTime jetzt = OffsetDateTime.ofInstant(uhr.instant(), zone()).truncatedTo(ChronoUnit.MINUTES);
        if (!rechte.lesbar(RechtZiel.UNTERNEHMEN, null)) {
            return new Vermerke(jetzt, List.of());
        }
        var leute = leute();
        var alle = repo.vermerke();
        var geltend = alle.stream().filter(v -> v.aufgehobenAm() == null)
                .sorted(Comparator.comparingInt(v -> TEILE.indexOf(v.teil())));
        var aufgehoben = alle.stream().filter(v -> v.aufgehobenAm() != null)
                .sorted(Comparator.comparing(EnergiemanagementTeilVermerkRepository.Vermerk::aufgehobenAm)
                        .thenComparing(EnergiemanagementTeilVermerkRepository.Vermerk::angelegtAm).reversed());
        return new Vermerke(jetzt, Stream.concat(geltend, aufgehoben).map(v -> vermerk(v, leute)).toList());
    }

    public Vermerk vermerk(UUID id) {
        return vermerk(repo.vermerk(id).orElseThrow(EnergiemanagementTeilVermerkService::vermerkFehlt), leute());
    }

    /**
     * Vermerkt „trifft zurzeit nicht zu“ für einen Teil. 400 bei unbekanntem Teil oder einem Satz außerhalb von 10 bis
     * 500 Zeichen; „entschieden von“ Pflicht (422 {@code entschieden_von_fehlt}), unbekannt 404, nach ihrem „bis“ 422
     * {@code person_beendet}; der Tag nie in der Zukunft (422 {@code tag_in_zukunft}); ein geltender Vermerk für den Teil
     * 409 {@code vermerk_besteht}.
     */
    public UUID anlegen(EnergiemanagementTeilVermerkDto.Anlegen a, ProtokollAkteur wer) {
        String teil = text(a.teil());
        if (teil == null || !TEILE.contains(teil)) {
            throw EnergiemanagementAbgelehnt.anfrage("teil");
        }
        String satz = a.satz() == null ? "" : a.satz().strip();
        if (satz.length() < SATZ_MIN || satz.length() > SATZ_MAX) {
            throw new EnergiemanagementAbgelehnt(400, "anfrage_ungueltig", "Bitte begründen Sie in einem Satz mit "
                    + SATZ_MIN + " bis " + SATZ_MAX + " Zeichen.", Map.of("feld", "satz", "min", SATZ_MIN,
                            "max", SATZ_MAX));
        }
        if (a.entschiedenVon() == null) {
            throw EnergiemanagementAbgelehnt.fachlich("entschieden_von_fehlt",
                    "Bitte nennen Sie, wer entschieden hat.", Map.of("feld", "entschieden_von"));
        }
        LocalDate heute = heute();
        LocalDate am = a.entschiedenAm() == null ? heute : a.entschiedenAm();
        if (am.isAfter(heute)) {
            throw EnergiemanagementAbgelehnt.fachlich("tag_in_zukunft", "Bitte wählen Sie einen Tag bis heute.",
                    Map.of("feld", "entschieden_am", "heute", heute.toString()));
        }
        try {
            return tx.execute(s -> {
                var person = personen.personSperren(a.entschiedenVon())
                        .orElseThrow(EnergiemanagementAbgelehnt::personFehlt);
                if (person.bis() != null && person.bis().isBefore(am)) {
                    throw EnergiemanagementAbgelehnt.fachlich("person_beendet",
                            "Diese Person ist ab diesem Tag nicht mehr im Energiemanagement.",
                            Map.of("feld", "entschieden_von", "bis", person.bis().toString()));
                }
                repo.geltend(teil).ifPresent(v -> {
                    throw besteht(teil);
                });
                return repo.anlegen(teil, satz, a.entschiedenVon(), am, uhr.instant(), wer);
            });
        } catch (DataIntegrityViolationException e) {
            // Zwei gleichzeitige Anfragen: der eindeutige Index entscheidet, die Antwort bleibt dieselbe wie oben.
            if (String.valueOf(e.getMostSpecificCause().getMessage()).contains("energiemanagement_teil_vermerk_geltend_uq")) {
                throw besteht(teil);
            }
            throw e;
        }
    }

    /** Hebt einen geltenden Vermerk einmal auf, jetzt; unbekannt 404, schon aufgehoben 409 {@code vermerk_aufgehoben}. */
    public void aufheben(UUID id, ProtokollAkteur wer) {
        tx.executeWithoutResult(s -> {
            var v = repo.sperren(id).orElseThrow(EnergiemanagementTeilVermerkService::vermerkFehlt);
            if (v.aufgehobenAm() != null) {
                throw EnergiemanagementAbgelehnt.konflikt("vermerk_aufgehoben",
                        "Dieser Vermerk ist bereits aufgehoben.", Map.of("aufgehoben_am", v.aufgehobenAm().toString()));
            }
            repo.aufheben(id, uhr.instant(), wer);
        });
    }

    /** Die Zeitzone des Unternehmens: an ihr hängen „heute“, der Stichtag und der Tag des Aufhebens. */
    ZoneId zone() {
        return ZoneId.of(unternehmen.desKundenbereichs().map(UnternehmenRepository.Unternehmen::zeitzone)
                .orElse("Europe/Berlin"));
    }

    /** Für die Verzeichnis-Quelle: der Tag eines Zeitpunkts in der Zeitzone des Unternehmens. */
    LocalDate tag(Instant am) {
        return am == null ? null : LocalDate.ofInstant(am, zone());
    }

    public static EnergiemanagementAbgelehnt vermerkFehlt() {
        return new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Diesen Vermerk gibt es nicht.", null);
    }

    private static EnergiemanagementAbgelehnt besteht(String teil) {
        return EnergiemanagementAbgelehnt.konflikt("vermerk_besteht",
                "Für diesen Teil gilt schon ein Vermerk. Heben Sie ihn zuerst auf.", Map.of("teil", teil));
    }

    private Map<UUID, PersonKurz> leute() {
        return personen.personen().stream().collect(Collectors.toMap(EnergiemanagementPersonenRepository.Person::id,
                p -> new PersonKurz(p.id(), p.name(), p.funktion(), p.kuerzel(), p.kontoSub() != null)));
    }

    private static Vermerk vermerk(EnergiemanagementTeilVermerkRepository.Vermerk v, Map<UUID, PersonKurz> leute) {
        return new Vermerk(v.id(), v.teil(), EnergiemanagementRegeln.WOERTER.get("teil").get(v.teil()), v.satz(),
                leute.get(v.entschiedenVon()), v.entschiedenAm(),
                new EnergiemanagementPersonenDto.Eingetragen(v.akteur(), v.angelegtAm()),
                v.aufgehobenAm() == null ? null
                        : new EnergiemanagementPersonenDto.Eingetragen(v.aufgehobenVon(), v.aufgehobenAm()));
    }

    private LocalDate heute() {
        return LocalDate.ofInstant(uhr.instant(), zone());
    }

    private static String text(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
