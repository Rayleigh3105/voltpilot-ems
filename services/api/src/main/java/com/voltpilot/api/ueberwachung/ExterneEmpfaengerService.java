package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.ueberwachung.ExterneEmpfaengerRepository.ExternerEmpfaenger;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.versand.BenachrichtigungAusgang;
import com.voltpilot.api.versand.BestaetigungsToken;
import com.voltpilot.api.zugriff.RechtFehlt;
import com.voltpilot.api.zugriff.RechteMatrixDatei;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Freie externe E-Mail-Empfänger je Überwachung (Alerting Scheibe 6, Konzept §7 Scheibe 6,
 * Entscheid 11B): eine verwaltende Person (Recht {@code ueberwachung.verwalten} AM STANDORT der
 * Regel - dieselbe Prüfung wie {@link UeberwachungAnlegenService}) trägt eine Adresse ein, die
 * NUR mit Bestätigung über einen Link wirksam wird (derselbe Mechanismus wie der E-Mail-Zustellweg,
 * Scheibe 0); externe Inhalte bleiben knapp (keine Messwerte/Detaildaten) und tragen IMMER einen
 * Abbestellen-Link.
 */
@Service
public class ExterneEmpfaengerService {

    /** Wie {@code ZustellwegService#TOKEN_GUELTIGKEIT} - lang genug für ein Postfach, kurz genug gegen einen verlorenen Link. */
    static final Duration TOKEN_GUELTIGKEIT = Duration.ofDays(2);

    private final ExterneEmpfaengerRepository repo;
    private final UeberwachungRepository ueberwachungen;
    private final ZugriffRepository zugriffe;
    private final BenachrichtigungAusgang ausgang;
    private final String basisUrl;
    private volatile Clock uhr = Clock.systemUTC();

    public ExterneEmpfaengerService(ExterneEmpfaengerRepository repo, UeberwachungRepository ueberwachungen,
            ZugriffRepository zugriffe, BenachrichtigungAusgang ausgang,
            @Value("${voltpilot.versand.bestaetigung-basis-url:http://localhost:5173}") String basisUrl) {
        this.repo = repo;
        this.ueberwachungen = ueberwachungen;
        this.zugriffe = zugriffe;
        this.ausgang = ausgang;
        this.basisUrl = basisUrl;
    }

    /** Nur für Tests: die Uhr, nach der der Bestätigungs-Token abläuft. */
    public void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    public List<ExternerEmpfaenger> eigene(UUID ueberwachungId, Benutzer aufrufer, Instant jetzt) {
        pruefeVerwalten(regelOderNichtGefunden(ueberwachungId), aufrufer, jetzt);
        return repo.eigene(ueberwachungId);
    }

    /**
     * Trägt eine neue Adresse ein und reiht sofort die Bestätigungs-Anfrage ein - knapp (keine
     * Meldungsinhalte, es ist ja noch keine Bestätigung da): nur, wer das eingetragen hat und wie
     * man es rückgängig macht, falls unerwartet.
     */
    public ExternerEmpfaenger hinzufuegen(UUID ueberwachungId, String email, Benutzer aufrufer, Instant jetzt) {
        UeberwachungZeile regel = regelOderNichtGefunden(ueberwachungId);
        pruefeVerwalten(regel, aufrufer, jetzt);
        String bestaetigungToken = BestaetigungsToken.erzeugen();
        String abbestellenToken = BestaetigungsToken.erzeugen();
        var angelegt = repo.anlegen(ueberwachungId, email, bestaetigungToken, jetzt.plus(TOKEN_GUELTIGKEIT),
                abbestellenToken, aufrufer.kennung());
        String bestaetigenLink = basisUrl + "/#/ueberwachungen/externe-empfaenger/bestaetigen?token="
                + bestaetigungToken;
        ausgang.emailExtern(angelegt.id(), "extern_anfrage:" + angelegt.id(), "externe_empfaenger_bestaetigung",
                "VoltPilot: Bitte bestätigen Sie den Empfang von Meldungen",
                "Für die Überwachung \"" + regel.name() + "\" bei VoltPilot wurde diese Adresse als Empfänger "
                        + "eingetragen.\n\nBitte bestätigen Sie, dass Sie diese Meldungen erhalten möchten:\n\n"
                        + bestaetigenLink + "\n\nDer Link ist zwei Tage gültig. Haben Sie das nicht erwartet, "
                        + "ignorieren Sie diese Mail - es passiert nichts.",
                email);
        return new ExternerEmpfaenger(angelegt.id(), email, false, true, jetzt);
    }

    public boolean entfernen(UUID ueberwachungId, UUID id, Benutzer aufrufer, Instant jetzt) {
        pruefeVerwalten(regelOderNichtGefunden(ueberwachungId), aufrufer, jetzt);
        return repo.entfernen(id, ueberwachungId);
    }

    /** {@code true}, wenn der Token gültig war und die Adresse jetzt bestätigt ist. */
    public boolean bestaetigen(String token) {
        return repo.bestaetigen(token, uhr.instant());
    }

    /** "Abbestellen" (Entscheid 11B) - immer ohne Anmeldung, immer idempotent. */
    public boolean abbestellen(String token) {
        return repo.abbestellen(token, uhr.instant());
    }

    /**
     * Je Alarm-Auslösung an alle bestätigten, aktiven externen Empfänger DIESER Regel - knapp
     * (keine Messwerte/Detaildaten, nur ein Link ins Portal) und mit Abbestellen-Link in JEDER Mail
     * (Entscheid 11B). Läuft ohne Sicht-/Ruhezeit-Prüfung ({@link BenachrichtigungAusgang#emailExtern}).
     */
    public void benachrichtigen(UUID ueberwachungId, UUID alarmId, String regelName, String schwere, Instant jetzt) {
        for (ExterneEmpfaengerRepository.VersandZeile zeile : repo.fuerVersand(ueberwachungId)) {
            String abbestellenLink = basisUrl + "/#/ueberwachungen/externe-empfaenger/abbestellen?token="
                    + zeile.abbestellenToken();
            String betreff = "VoltPilot: " + schwereWort(schwere) + " bei \"" + regelName + "\"";
            String inhalt = "Eine Überwachung, über die Sie informiert werden, hat ausgelöst: \"" + regelName
                    + "\".\n\nDetails im Portal: " + basisUrl + "/#/meldungen\n\nDiese Meldungen abbestellen: "
                    + abbestellenLink;
            ausgang.emailExtern(alarmId, "extern:" + zeile.id(), "ausgeloest", betreff, inhalt, zeile.email());
        }
    }

    private static String schwereWort(String schwere) {
        return switch (schwere) {
            case "dringend" -> "Dringend";
            case "warnung" -> "Warnung";
            default -> "Hinweis";
        };
    }

    private UeberwachungZeile regelOderNichtGefunden(UUID id) {
        return ueberwachungen.einzelneRegel(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    /** Dasselbe Rechte-Muster wie {@link UeberwachungAnlegenService#anlegen} - IMMER {@code ueberwachung.verwalten},
     * weil ein externer Empfänger nie "nur ich selbst" ist. */
    private void pruefeVerwalten(UeberwachungZeile regel, Benutzer aufrufer, Instant jetzt) {
        Kundenbereich kundenbereich = kundenbereich(jetzt);
        Ziel ziel = regel.standortId() == null ? Ziel.unternehmen()
                : zielFuerStandort(ueberwachungen.standortKurzzeichen(regel.standortId()));
        RechteAbleitung.DarfErgebnis darf = RechteAbleitung.darf(RechteMatrixDatei.matrix(), aufrufer, kundenbereich,
                "ueberwachung.verwalten", ziel, jetzt);
        if (!darf.darf()) {
            throw new RechtFehlt("ueberwachung.verwalten", darf);
        }
    }

    private static Ziel zielFuerStandort(String kurzzeichen) {
        return kurzzeichen == null ? Ziel.unternehmen() : Ziel.standort(kurzzeichen);
    }

    /** Derselbe Aufbau wie {@link UeberwachungSichtPruefungImpl#kundenbereich}/{@link UeberwachungAnlegenService#kundenbereich}. */
    private Kundenbereich kundenbereich(Instant jetzt) {
        ZugriffRepository.KundenbereichKopf kopf = zugriffe.kundenbereichKopf();
        List<Standort> standorte = zugriffe.standorte().stream()
                .map(s -> new Standort(s.kurzzeichen(), s.name())).toList();
        List<Person> kundenadministratoren = zugriffe.wirksamImKundenbereich(Rolle.KUNDENADMINISTRATOR, jetzt)
                .stream().map(m -> new Person(m.zeile().benutzerSub(), m.name())).toList();
        return new Kundenbereich(kopf.name(), standorte, kundenadministratoren);
    }
}
