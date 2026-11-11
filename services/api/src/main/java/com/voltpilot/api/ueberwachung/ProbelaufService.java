package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.ProbelaufDto;
import com.voltpilot.api.web.dto.UeberwachungDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * "Probelauf statt Raten" (Alerting Scheibe 2, Konzept §6.1 Nr. 9, §6.4, §6.8 Entwurf 1): BEVOR
 * eine Person "Überwachung starten" tippt, zeigt das Blatt, was die Regel in den letzten 30 Tagen
 * gemeldet HÄTTE - derselbe Zustandsautomat wie am Live-Takt ({@link ProbelaufSimulation}), über
 * eine fertige historische Reihe ({@link ProbelaufRepository}, 15-Minuten-Rollup).
 *
 * <p>Nur die beiden Leserarten, die diese Scheibe wirklich anbietet ({@code anlagenfluss},
 * {@code messreihe}), haben eine Rückschau; {@code zustand}/{@code ereignis} (Scheibe 1) liefern
 * eine leere Reihe - kein Rollup dafür, und keine Fläche dieser Scheibe bietet dafür ohnehin ein
 * eigenes "Überwachen" an.
 */
@Service
public class ProbelaufService {

    static final long FENSTER_TAGE = 30;

    private final WerteKatalog katalog;
    private final UeberwachungRepository repo;
    private final ProbelaufRepository historie;
    private final Geltungsbereich geltungsbereich;

    public ProbelaufService(WerteKatalog katalog, UeberwachungRepository repo, ProbelaufRepository historie,
            Geltungsbereich geltungsbereich) {
        this.katalog = katalog;
        this.repo = repo;
        this.historie = historie;
        this.geltungsbereich = geltungsbereich;
    }

    public ProbelaufDto vorschau(UeberwachungDto.Anlegen entwurf, Instant jetzt) {
        WerteKatalog.Eintrag eintrag = katalog.eintrag(entwurf.wertart());
        if (eintrag == null) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "unbekannte Wertart '" + entwurf.wertart() + "'");
        }
        WerteLeser.Bezug bezug = UeberwachungAnlegenService.bezugAus(eintrag, entwurf.bezug());
        // telemetry_v2_rollup_15m trägt nur den Mandanten-Zaun (keine site_scope-Policy, anders als
        // site/device/measurement_point, AGENTS.md "Die Messdaten selbst tragen nur den Mandanten-
        // Zaun") - bei Bezug `anlage` prüft darum HIER der Standort-Zaun, bevor die Rückschau
        // überhaupt liest. Bei Bezug `komponente` übernimmt das schon `anlageDerKomponente`
        // (measurement_point IST site_scope-gezäunt) - eine unsichtbare Komponente liefert dort
        // bereits null.
        if ("anlage".equals(bezug.art())) {
            geltungsbereich.requireSite(bezug.id());
        }
        if (entwurf.bedingung() == null || !(entwurf.bedingung() instanceof ObjectNode)) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, "Bedingung fehlt");
        }
        ObjectNode bedingung = UeberwachungAnlegenService.vorgabenAnwenden((ObjectNode) entwurf.bedingung().deepCopy());

        Instant von = jetzt.minus(Duration.ofDays(FENSTER_TAGE));
        List<ProbelaufSimulation.Punkt> reihe = reiheFuer(eintrag, bezug, von, jetzt);
        ProbelaufSimulation.Ergebnis ergebnis = ProbelaufSimulation.simulieren(reihe, bedingung);
        return new ProbelaufDto(FENSTER_TAGE, ergebnis.ausgeloest(), ergebnis.zuletzt(), ergebnis.gesamtdauerS());
    }

    private List<ProbelaufSimulation.Punkt> reiheFuer(WerteKatalog.Eintrag eintrag, WerteLeser.Bezug bezug,
            Instant von, Instant bis) {
        return switch (eintrag.leser().art()) {
            case "anlagenfluss" -> historie.anlagenfluss(bezug.id(), eintrag.leser().feld(), von, bis);
            case "messreihe" -> {
                UUID anlageId = repo.anlageDerKomponente(bezug.id());
                yield anlageId == null ? List.of()
                        : historie.messreihe(anlageId, bezug.id().toString(), bezug.parameter(), von, bis);
            }
            default -> List.of();
        };
    }
}
