package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.web.dto.UeberwachungDto;
import com.voltpilot.api.zugriff.RechtFehlt;
import com.voltpilot.api.zugriff.RechteMatrixDatei;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * "Vom Wert zur fertigen Regel: drei Taps" (Alerting Scheibe 2, Konzept §6.8): eine Person legt am
 * Menü "..." eines Werts selbst eine Überwachung an - {@code herkunft = 'eigen'}, additiv seit
 * {@code V20261015140000}. Vorgaben nach §9 füllt diese Stelle, wenn das Blatt sie nicht schon
 * mitschickt (Dauer 5 Min für Momentanwerte, Rückkehr 5 % der Schwelle, Erholdauer 5 Min).
 *
 * <p><b>Rechte (Entscheid 5A, §6.6):</b> {@code ueberwachung.eigene} für eine Regel, die NUR die
 * anlegende Person selbst benachrichtigt; {@code ueberwachung.verwalten} für andere Personen oder
 * Rollen als Empfänger. Die Route selbst trägt nur den groben Vorprüf-Gate
 * ({@code @Recht(..., ziel = RechtZiel.DIENST)}); diese Klasse ist die genaue Prüfung
 * ({@code RechtRoutenArchitekturTest.DIENST}), am Standort der Anlage - dieselbe reine Funktion
 * {@code RechteAbleitung.darf} wie {@link UeberwachungSichtPruefungImpl} beim Versand.
 */
@Service
public class UeberwachungAnlegenService {

    private static final List<String> SCHWEREN = List.of("hinweis", "warnung", "dringend");
    private static final long VORGABE_DAUER_S = 300;
    private static final long VORGABE_ERHOLEN_S = 300;
    private static final double VORGABE_RUECKKEHR_PROZENT = 0.05;

    /** 30-Tage-Probelauf (§6.4, §6.8 Entwurf 1): jede EIGENE Überwachung startet damit, nie ab Werk. */
    static final long PROBELAUF_TAGE = ProbelaufService.FENSTER_TAGE;

    private final UeberwachungRepository repo;
    private final WerteKatalog katalog;
    private final ZugriffRepository zugriffe;

    public UeberwachungAnlegenService(UeberwachungRepository repo, WerteKatalog katalog,
            ZugriffRepository zugriffe) {
        this.repo = repo;
        this.katalog = katalog;
        this.zugriffe = zugriffe;
    }

    public UeberwachungDto anlegen(UeberwachungDto.Anlegen anfrage, Benutzer aufrufer, Instant jetzt) {
        WerteKatalog.Eintrag eintrag = katalog.eintrag(anfrage.wertart());
        if (eintrag == null) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "unbekannte Wertart '" + anfrage.wertart() + "'");
        }
        WerteLeser.Bezug bezug = bezugAus(eintrag, anfrage.bezug());
        String bedingungsart = anfrage.bedingung() == null ? null : anfrage.bedingung().path("art").asText(null);
        if (bedingungsart == null || !eintrag.bedingungen().contains(bedingungsart)) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "Bedingungsart '" + bedingungsart + "' passt nicht zu '" + anfrage.wertart() + "'");
        }
        if (!SCHWEREN.contains(anfrage.schwere())) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "unbekannte Schwere '" + anfrage.schwere() + "'");
        }
        UUID anlageId = switch (bezug.art()) {
            case "anlage" -> bezug.id();
            case "komponente" -> repo.anlageDerKomponente(bezug.id());
            default -> null;
        };
        if (anlageId == null) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND);
        }
        UUID standortId = repo.standortHeute(anlageId);

        List<UeberwachungDto.EmpfaengerEintrag> empfaenger = anfrage.empfaenger() == null || anfrage.empfaenger().isEmpty()
                ? List.of(new UeberwachungDto.EmpfaengerEintrag(aufrufer.kennung(), null))
                : anfrage.empfaenger();
        boolean nurIchSelbst = empfaenger.size() == 1 && aufrufer.kennung().equals(empfaenger.get(0).person())
                && empfaenger.get(0).rolle() == null;
        String benoetigtesRecht = nurIchSelbst ? "ueberwachung.eigene" : "ueberwachung.verwalten";

        Kundenbereich kundenbereich = kundenbereich(jetzt);
        Ziel ziel = standortId == null ? Ziel.unternehmen() : zielFuerStandort(repo.standortKurzzeichen(standortId));
        RechteAbleitung.DarfErgebnis darf = RechteAbleitung.darf(RechteMatrixDatei.matrix(), aufrufer, kundenbereich,
                benoetigtesRecht, ziel, jetzt);
        if (!darf.darf()) {
            throw new RechtFehlt(benoetigtesRecht, darf);
        }

        ObjectNode bedingung = vorgabenAnwenden((ObjectNode) anfrage.bedingung());
        String bezugJson = bezugJson(bezug);
        String empfaengerJson = empfaengerJson(empfaenger);
        Instant probelaufBis = jetzt.plus(Duration.ofDays(PROBELAUF_TAGE));
        UUID id = repo.erstelleEigen(standortId, anfrage.name(), anfrage.wertart(), bezugJson,
                bedingung.toString(), anfrage.schwere(), empfaengerJson, aufrufer.kennung(), probelaufBis);
        return new UeberwachungDto(id.toString(), anfrage.name(), anfrage.wertart(), anfrage.schwere(), "eigen",
                true, probelaufBis);
    }

    /**
     * "Jetzt scharf schalten" (§6.8 Entwurf 1): beendet den Probelauf einer eigenen Regel vor
     * Ablauf der 30 Tage. Dasselbe Rechte-Muster wie {@link #anlegen} - {@code ueberwachung.eigene},
     * wenn die Regel nur die anlegende Person selbst benachrichtigt, sonst {@code ueberwachung.verwalten}.
     */
    public UeberwachungDto scharfSchalten(UUID id, Benutzer aufrufer, Instant jetzt) {
        UeberwachungZeile regel = repo.einzelneRegel(id)
                .orElseThrow(() -> new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND));
        boolean nurIchSelbst = istNurIchSelbst(regel.empfaenger(), aufrufer.kennung());
        String benoetigtesRecht = nurIchSelbst ? "ueberwachung.eigene" : "ueberwachung.verwalten";

        Kundenbereich kundenbereich = kundenbereich(jetzt);
        Ziel ziel = regel.standortId() == null ? Ziel.unternehmen()
                : zielFuerStandort(repo.standortKurzzeichen(regel.standortId()));
        RechteAbleitung.DarfErgebnis darf = RechteAbleitung.darf(RechteMatrixDatei.matrix(), aufrufer, kundenbereich,
                benoetigtesRecht, ziel, jetzt);
        if (!darf.darf()) {
            throw new RechtFehlt(benoetigtesRecht, darf);
        }

        repo.scharfSchalten(id);
        return new UeberwachungDto(id.toString(), regel.name(), regel.wertart(), regel.schwere(), regel.herkunft(),
                true, null);
    }

    private static boolean istNurIchSelbst(com.fasterxml.jackson.databind.JsonNode empfaenger, String eigeneKennung) {
        if (empfaenger == null || !empfaenger.isArray() || empfaenger.size() != 1) {
            return false;
        }
        com.fasterxml.jackson.databind.JsonNode einziger = empfaenger.get(0);
        return einziger.has("person") && eigeneKennung.equals(einziger.path("person").asText())
                && !einziger.has("rolle");
    }

    /** Package-sichtbar: {@link ProbelaufService} braucht dieselbe Bezug-Auflösung für die Vorschau. */
    static WerteLeser.Bezug bezugAus(WerteKatalog.Eintrag eintrag, UeberwachungDto.BezugEintrag b) {
        if (b == null) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, "Bezug fehlt");
        }
        if ("anlage".equals(eintrag.bezug()) && b.anlage() != null) {
            return WerteLeser.Bezug.anlage(uuid(b.anlage()));
        }
        if ("komponente".equals(eintrag.bezug()) && b.komponente() != null) {
            if (b.kanal() == null || b.kanal().isBlank()) {
                throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, "kanal fehlt");
            }
            return WerteLeser.Bezug.komponente(uuid(b.komponente()), b.kanal());
        }
        throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                "Bezug passt nicht zur Wertart '" + eintrag.wertart() + "'");
    }

    private static UUID uuid(String text) {
        try {
            return UUID.fromString(text);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, "ungültige Kennung");
        }
    }

    /**
     * Vorgaben nach §9: Dauer 5 Min, Rückkehr 5 % der Schwelle, Erholdauer 5 Min - im Satz nennbar,
     * änderbar. Package-sichtbar: {@link ProbelaufService} wendet dieselben Vorgaben auf die
     * Vorschau an.
     */
    static ObjectNode vorgabenAnwenden(ObjectNode bedingung) {
        if (!bedingung.has("dauer_s")) {
            bedingung.put("dauer_s", VORGABE_DAUER_S);
        }
        if (!bedingung.has("erholen_s")) {
            bedingung.put("erholen_s", VORGABE_ERHOLEN_S);
        }
        if (bedingung.has("schwelle") && !bedingung.has("rueckkehr")) {
            String art = bedingung.path("art").asText("");
            double schwelle = bedingung.path("schwelle").asDouble();
            double rueckkehr = "unter".equals(art) ? schwelle * (1 + VORGABE_RUECKKEHR_PROZENT)
                    : schwelle * (1 - VORGABE_RUECKKEHR_PROZENT);
            bedingung.put("rueckkehr", rueckkehr);
        }
        return bedingung;
    }

    // Jackson statt Zeichenketten-Verkettung: eine Kundeneingabe (Kanalname, Rollenwort, Person)
    // mit einem Anführungszeichen darf nie als JSON-Struktur ausbrechen können.
    private static final ObjectMapper JSON = new ObjectMapper();

    private static String bezugJson(WerteLeser.Bezug bezug) {
        ObjectNode n = JSON.createObjectNode();
        switch (bezug.art()) {
            case "anlage" -> n.put("anlage", bezug.id().toString());
            case "komponente" -> {
                n.put("komponente", bezug.id().toString());
                n.put("kanal", bezug.parameter());
            }
            default -> throw new IllegalStateException("unbekannter Bezug " + bezug.art());
        }
        return n.toString();
    }

    private static String empfaengerJson(List<UeberwachungDto.EmpfaengerEintrag> empfaenger) {
        ArrayNode arr = JSON.createArrayNode();
        for (UeberwachungDto.EmpfaengerEintrag e : empfaenger) {
            ObjectNode n = JSON.createObjectNode();
            if (e.person() != null) {
                n.put("person", e.person());
            } else if (e.rolle() != null) {
                n.put("rolle", e.rolle());
            } else {
                continue;
            }
            arr.add(n);
        }
        return arr.toString();
    }

    private static Ziel zielFuerStandort(String kurzzeichen) {
        return kurzzeichen == null ? Ziel.unternehmen() : Ziel.standort(kurzzeichen);
    }

    /** Derselbe Aufbau wie {@link UeberwachungSichtPruefungImpl#kundenbereich} - der Kundenbereich des Aufrufers. */
    private Kundenbereich kundenbereich(Instant jetzt) {
        ZugriffRepository.KundenbereichKopf kopf = zugriffe.kundenbereichKopf();
        List<Standort> standorte = zugriffe.standorte().stream()
                .map(s -> new Standort(s.kurzzeichen(), s.name())).toList();
        List<Person> kundenadministratoren = zugriffe.wirksamImKundenbereich(Rolle.KUNDENADMINISTRATOR, jetzt)
                .stream().map(m -> new Person(m.zeile().benutzerSub(), m.name())).toList();
        return new Kundenbereich(kopf.name(), standorte, kundenadministratoren);
    }
}
