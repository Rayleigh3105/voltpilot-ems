package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.uems.EnergiezielService;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.KennzahlRepository;
import com.voltpilot.api.uems.KennzahlService;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.uems.VerbesserungAbgelehnt;
import com.voltpilot.api.web.dto.UeberwachungDto;
import com.voltpilot.api.zugriff.RechtFehlt;
import com.voltpilot.api.zugriff.RechteMatrixDatei;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
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
    /** "ab_werk"/"vorschlag" bleiben serverseitige Vorgaben - nie über diese Route setzbar (Alerting
     * Scheibe 6, Entscheid 10A: "steuerung" ist der einzige WEITERE Wert, den der Client wählen darf). */
    private static final List<String> CLIENT_HERKUNFT = List.of("eigen", "steuerung");
    private static final long VORGABE_DAUER_S = 300;
    private static final long VORGABE_ERHOLEN_S = 300;
    private static final double VORGABE_RUECKKEHR_PROZENT = 0.05;

    /** 30-Tage-Probelauf (§6.4, §6.8 Entwurf 1): jede EIGENE Überwachung startet damit, nie ab Werk. */
    static final long PROBELAUF_TAGE = ProbelaufService.FENSTER_TAGE;

    private final UeberwachungRepository repo;
    private final WerteKatalog katalog;
    private final ZugriffRepository zugriffe;
    private final KennzahlRepository messstellenOrte;
    private final KennzahlService kennzahlen;
    private final EnergiezielService energieziele;
    /** UEMS EZ-11: prüft „nur mit Anlagensteuerung“; ohne Spring (reine Tests) {@code null} - dann keine Prüfung. */
    private ErzeugerWerteLeser erzeugerLeser;

    @Autowired(required = false)
    void setErzeugerLeser(ErzeugerWerteLeser erzeugerLeser) {
        this.erzeugerLeser = erzeugerLeser;
    }

    public UeberwachungAnlegenService(UeberwachungRepository repo, WerteKatalog katalog,
            ZugriffRepository zugriffe, KennzahlRepository messstellenOrte, KennzahlService kennzahlen,
            EnergiezielService energieziele) {
        this.repo = repo;
        this.katalog = katalog;
        this.zugriffe = zugriffe;
        this.messstellenOrte = messstellenOrte;
        this.kennzahlen = kennzahlen;
        this.energieziele = energieziele;
    }

    public UeberwachungDto anlegen(UeberwachungDto.Anlegen anfrage, Benutzer aufrufer, Instant jetzt) {
        WerteKatalog.Eintrag eintrag = katalog.eintrag(anfrage.wertart());
        if (eintrag == null) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "unbekannte Wertart '" + anfrage.wertart() + "'");
        }
        String bedingungsart = anfrage.bedingung() == null ? null : anfrage.bedingung().path("art").asText(null);
        if (bedingungsart == null || !eintrag.bedingungen().contains(bedingungsart)) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "Bedingungsart '" + bedingungsart + "' passt nicht zu '" + anfrage.wertart() + "'");
        }
        if (!SCHWEREN.contains(anfrage.schwere())) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "unbekannte Schwere '" + anfrage.schwere() + "'");
        }
        String herkunft = anfrage.herkunft() == null || anfrage.herkunft().isBlank() ? "eigen" : anfrage.herkunft();
        if (!CLIENT_HERKUNFT.contains(herkunft)) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "unbekannte Herkunft '" + herkunft + "'");
        }

        boolean auswahl = anfrage.bezug() != null && anfrage.bezug().alle() != null;
        UUID standortId;
        String bezugJson;
        if (auswahl) {
            if (!"anlage".equals(eintrag.bezug())) {
                throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                        "Auswahl passt nicht zur Wertart '" + eintrag.wertart() + "'");
            }
            if (!"anlage".equals(anfrage.bezug().alle()) && !"box".equals(anfrage.bezug().alle())) {
                throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                        "unbekannte Auswahl '" + anfrage.bezug().alle() + "'");
            }
            standortId = anfrage.bezug().standort() == null ? null : uuid(anfrage.bezug().standort());
            bezugJson = auswahlBezugJson(anfrage.bezug());
        } else {
            WerteLeser.Bezug bezug = bezugAus(eintrag, anfrage.bezug());
            standortId = standortDesBezugs(bezug, jetzt);
            bezugJson = bezugJson(bezug);
            if (eintrag.vorlage() != null && eintrag.vorlage().nurMitAnlagensteuerung() && erzeugerLeser != null
                    && !erzeugerLeser.hatAnlagensteuerung(bezug.id())) {
                throw new ResponseStatusException(org.springframework.http.HttpStatus.CONFLICT,
                        "Die Vorlage '" + eintrag.wertart() + "' gilt nur für Anlagen mit Anlagensteuerung");
            }
        }

        List<UeberwachungDto.EmpfaengerEintrag> empfaenger = anfrage.empfaenger() == null || anfrage.empfaenger().isEmpty()
                ? List.of(new UeberwachungDto.EmpfaengerEintrag(aufrufer.kennung(), null))
                : anfrage.empfaenger();
        boolean nurIchSelbst = !auswahl && empfaenger.size() == 1 && aufrufer.kennung().equals(empfaenger.get(0).person())
                && empfaenger.get(0).rolle() == null;
        // Eine Auswahl ("alle Anlagen des Standorts X"/"alle Boxen") betrifft immer mehr als den
        // eigenen Bezug und braucht darum IMMER ueberwachung.verwalten (§6.4 "Gilt für", §6.6
        // Entscheid 5A) - "nur ich selbst" gibt es bei einer Auswahl nicht.
        String benoetigtesRecht = nurIchSelbst ? "ueberwachung.eigene" : "ueberwachung.verwalten";

        Kundenbereich kundenbereich = kundenbereich(jetzt);
        Ziel ziel = standortId == null ? Ziel.unternehmen() : zielFuerStandort(repo.standortKurzzeichen(standortId));
        RechteAbleitung.DarfErgebnis darf = RechteAbleitung.darf(RechteMatrixDatei.matrix(), aufrufer, kundenbereich,
                benoetigtesRecht, ziel, jetzt);
        if (!darf.darf()) {
            throw new RechtFehlt(benoetigtesRecht, darf);
        }

        ObjectNode bedingung = vorgabenAnwenden(vorlageAnwenden(eintrag, (ObjectNode) anfrage.bedingung()));
        String empfaengerJson = empfaengerJson(empfaenger);
        // Eine Alarm-Vorlage (EZ-11) ist ab dem Anlegen scharf: ihre Werte haben keine Rückschau, die ein
        // Probelauf nachspielen könnte (EW-9 A „alle Zustellwege sofort“) - 30 Tage stumm wären 30 Tage ohne Alarm.
        Instant probelaufBis = eintrag.vorlage() != null ? null : jetzt.plus(Duration.ofDays(PROBELAUF_TAGE));
        String name = anfrage.name() == null && eintrag.vorlage() != null ? eintrag.name() : anfrage.name();
        UUID id = repo.erstelleSelbstAngelegt(standortId, name, anfrage.wertart(), bezugJson,
                bedingung.toString(), anfrage.schwere(), empfaengerJson, herkunft, aufrufer.kennung(), probelaufBis);
        return new UeberwachungDto(id.toString(), name, anfrage.wertart(), anfrage.schwere(), herkunft,
                true, probelaufBis, bezugJson);
    }

    /**
     * Die Vorbelegung einer Alarm-Vorlage (EZ-11): Ziel-Zustand, Dauer, Erholdauer und die eigenen Schwellen der
     * Vorlage, soweit die Anfrage sie nicht selbst mitbringt - jede Schwelle bleibt je Anlage änderbar. Ohne
     * Vorlage unverändert.
     */
    static ObjectNode vorlageAnwenden(WerteKatalog.Eintrag eintrag, ObjectNode bedingung) {
        WerteKatalog.Vorlage v = eintrag.vorlage();
        if (v == null) {
            return bedingung;
        }
        if (!bedingung.has("ziel")) {
            ArrayNode ziel = bedingung.putArray("ziel");
            v.ziel().forEach(ziel::add);
        }
        if (!bedingung.has("dauer_s")) {
            bedingung.put("dauer_s", v.dauerS());
        }
        if (!bedingung.has("erholen_s")) {
            bedingung.put("erholen_s", v.erholenS());
        }
        v.schwellen().forEach((name, vorgabe) -> {
            if (!bedingung.has(name)) {
                bedingung.put(name, vorgabe);
            }
            if (!bedingung.path(name).isNumber() || bedingung.path(name).asDouble() < 0) {
                throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                        "Schwelle '" + name + "' muss eine Zahl ab 0 sein");
            }
        });
        if (bedingung.path("dauer_s").asLong(0) < 0 || bedingung.path("erholen_s").asLong(0) < 0) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "Dauer und Erholdauer dürfen nicht negativ sein");
        }
        return bedingung;
    }

    /** {@code {"standort":"<id>","alle":"anlage"}} oder {@code {"alle":"box"}} (§6.4 "Gilt für", §6.7 Skizze). */
    private static String auswahlBezugJson(UeberwachungDto.BezugEintrag b) {
        ObjectNode n = JSON.createObjectNode();
        if (b.standort() != null) {
            n.put("standort", uuid(b.standort()).toString());
        }
        n.put("alle", b.alle());
        return n.toString();
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
                true, null, regel.bezug().toString());
    }

    /**
     * Löschen (Abnahme-Befund aus Produktion: "wie kann ich diese denn wieder löschen?") - Soft-Delete,
     * der Verlauf bleibt erhalten (Entscheid 3B). Dasselbe Rechte-Muster wie {@link #anlegen}/
     * {@link #scharfSchalten} - {@code ueberwachung.eigene}, wenn die Regel nur die anlegende Person
     * selbst benachrichtigt, sonst {@code ueberwachung.verwalten}. Nur eine selbst angelegte/aus der
     * Steuerung umgewandelte Regel ({@link #CLIENT_HERKUNFT}) ist über diese Route löschbar - eine
     * ab-Werk-Regel bliebe sonst dauerhaft weg: {@code seedAbWerk} sät sie nur EINMAL je Wertart und
     * Anlage ({@code uq_ueberwachung_ab_werk} prüft nicht auf gelöscht).
     */
    public void loeschen(UUID id, Benutzer aufrufer, Instant jetzt) {
        UeberwachungZeile regel = repo.einzelneRegel(id)
                .orElseThrow(() -> new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND));
        if (!CLIENT_HERKUNFT.contains(regel.herkunft())) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "eine ab-Werk-Überwachung lässt sich über diese Route nicht löschen");
        }
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

        for (UeberwachungRepository.AlarmZeile alarm : repo.offeneAlarmeDerRegel(id)) {
            repo.alarmSchliessenRegelGeloescht(alarm.id(), jetzt);
            repo.alarmVerlauf(alarm.id(), "geloescht", aufrufer.kennung(),
                    "Überwachung gelöscht von " + aufrufer.kennung(), null);
            repo.alarmVerlauf(alarm.id(), "erledigt", null, "erledigt (Überwachung gelöscht)", null);
        }
        repo.loeschen(id, aufrufer.kennung(), jetzt);
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
        if ("messstelle".equals(eintrag.bezug()) && b.messstelle() != null) {
            return WerteLeser.Bezug.messstelle(uuid(b.messstelle()));
        }
        if ("kennzahl".equals(eintrag.bezug()) && b.kennzahl() != null) {
            return WerteLeser.Bezug.kennzahl(uuid(b.kennzahl()));
        }
        if ("energieziel".equals(eintrag.bezug()) && b.energieziel() != null) {
            return WerteLeser.Bezug.energieziel(uuid(b.energieziel()));
        }
        throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                "Bezug passt nicht zur Wertart '" + eintrag.wertart() + "'");
    }

    /**
     * Der Standort EINES Bezugs (nicht einer Auswahl) für die Rechte-Prüfung (Entscheid 5A, §6.6):
     * Anlage/Komponente wie bisher über ihre Anlage; Messstelle/Kennzahl/Energieziel (Scheibe 5)
     * haben kein Anlage-Zwischenglied - ihr eigener, schon vorhandener Standort-Resolver gilt
     * (derselbe wie {@code kennzahl.standort_definieren}/{@code kennzahl.unternehmen_definieren},
     * §6.6 Entscheid 5A: eine Kennzahl ohne Standort ist Unternehmen-weit, kein 404).
     */
    private UUID standortDesBezugs(WerteLeser.Bezug bezug, Instant jetzt) {
        return switch (bezug.art()) {
            case "anlage" -> repo.standortHeute(bezug.id());
            case "komponente" -> {
                UUID anlageId = repo.anlageDerKomponente(bezug.id());
                if (anlageId == null) {
                    throw new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND);
                }
                yield repo.standortHeute(anlageId);
            }
            case "messstelle" -> messstellenOrte.standortVonMessstelle(bezug.id(), heute(jetzt)).orElse(null);
            case "kennzahl" -> kennzahlStandortOderAbgelehnt(bezug.id());
            case "energieziel" -> energielzielStandortOderAbgelehnt(bezug.id());
            default -> throw new IllegalStateException("unbekannter Bezug " + bezug.art());
        };
    }

    private UUID kennzahlStandortOderAbgelehnt(UUID id) {
        try {
            return kennzahlen.eine(id).standortId();
        } catch (KennzahlAbgelehnt e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.valueOf(e.status()), e.getMessage());
        }
    }

    private UUID energielzielStandortOderAbgelehnt(UUID id) {
        try {
            return energieziele.eines(id).standortId();
        } catch (VerbesserungAbgelehnt e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.valueOf(e.status()), e.getMessage());
        }
    }

    private static LocalDate heute(Instant jetzt) {
        return jetzt.atZone(com.voltpilot.api.history.HistoryRange.ZONE).toLocalDate();
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
            case "messstelle" -> n.put("messstelle", bezug.id().toString());
            case "kennzahl" -> n.put("kennzahl", bezug.id().toString());
            case "energieziel" -> n.put("energieziel", bezug.id().toString());
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
