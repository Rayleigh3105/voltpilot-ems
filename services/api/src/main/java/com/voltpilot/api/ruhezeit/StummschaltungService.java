package com.voltpilot.api.ruhezeit;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.ueberwachung.UeberwachungRepository;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.zugriff.RechtFehlt;
import com.voltpilot.api.zugriff.RechteMatrixDatei;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Stummschalten (Alerting Scheibe 3, Konzept §6.4): eine Regel, eine Anlage oder ein ganzer Standort,
 * EINMALIG mit Ende-Pflicht ("Wartung bis 17 Uhr"). Betrifft ALLE Empfänger der getroffenen
 * Regel(n) - deshalb immer {@code ueberwachung.verwalten} (nie {@code ueberwachung.eigene}; die
 * Rechte-Matrix nennt das ausdrücklich bei diesem Recht), geprüft an der Geltung des STANDORTS der
 * Auswahl - dasselbe Muster wie {@code UeberwachungAnlegenService} (die Route selbst trägt nur das
 * grobe Vorprüf-Gate, {@code RechtZiel.DIENST}; diese Klasse ist die genaue Prüfung,
 * {@code RechtRoutenArchitekturTest.DIENST}).
 */
@Service
public class StummschaltungService {

    private static final String RECHT = "ueberwachung.verwalten";
    private static final ObjectMapper JSON = new ObjectMapper();

    private final RuhezeitRepository repo;
    private final UeberwachungRepository ueberwachung;
    private final ZugriffRepository zugriffe;

    public StummschaltungService(RuhezeitRepository repo, UeberwachungRepository ueberwachung,
            ZugriffRepository zugriffe) {
        this.repo = repo;
        this.ueberwachung = ueberwachung;
        this.zugriffe = zugriffe;
    }

    public List<RuhezeitRepository.StummZeile> aktive(Instant jetzt) {
        return repo.aktive(jetzt);
    }

    /**
     * @param art "regel" | "anlage" | "standort"
     * @param id  die Kennung des Ziels dieser Art
     */
    public UUID anlegen(String art, UUID id, Instant bis, String grund, Benutzer aufrufer, Instant jetzt) {
        if (bis == null || !bis.isAfter(jetzt)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Stummschalten: 'bis' muss in der Zukunft liegen");
        }
        UUID standortId = switch (art) {
            case "regel" -> {
                UeberwachungZeile regel = ueberwachung.einzelneRegel(id)
                        .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
                yield regel.standortId();
            }
            case "standort" -> id;
            case "anlage" -> ueberwachung.standortHeute(id);
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "unbekannte Auswahlart '" + art + "'");
        };

        Ziel ziel = standortId == null ? Ziel.unternehmen() : zielFuerStandort(ueberwachung.standortKurzzeichen(standortId));
        RechteAbleitung.DarfErgebnis darf = RechteAbleitung.darf(RechteMatrixDatei.matrix(), aufrufer,
                kundenbereich(jetzt), RECHT, ziel, jetzt);
        if (!darf.darf()) {
            throw new RechtFehlt(RECHT, darf);
        }

        ObjectNode auswahl = JSON.createObjectNode();
        auswahl.put(art, id.toString());
        return repo.anlegen(auswahl.toString(), standortId, jetzt, bis, grund, aufrufer.kennung());
    }

    private static Ziel zielFuerStandort(String kurzzeichen) {
        return kurzzeichen == null ? Ziel.unternehmen() : Ziel.standort(kurzzeichen);
    }

    /** Derselbe Aufbau wie {@code UeberwachungAnlegenService#kundenbereich}. */
    private Kundenbereich kundenbereich(Instant jetzt) {
        ZugriffRepository.KundenbereichKopf kopf = zugriffe.kundenbereichKopf();
        List<Standort> standorte = zugriffe.standorte().stream()
                .map(s -> new Standort(s.kurzzeichen(), s.name())).toList();
        List<Person> kundenadministratoren = zugriffe.wirksamImKundenbereich(Rolle.KUNDENADMINISTRATOR, jetzt)
                .stream().map(m -> new Person(m.zeile().benutzerSub(), m.name())).toList();
        return new Kundenbereich(kopf.name(), standorte, kundenadministratoren);
    }
}
