package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.AufgabeBeenden;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.AufgabeZuordnen;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.PersonAendern;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.PersonAnlegen;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.PersonKurz;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * UEMS AP-19 IP-6: Personen im Energiemanagement und Aufgaben (PA1–PA3, PA5, §5.6).
 *
 * <p>Wer im System handelt, hat ein Konto; wer außerhalb entscheidet, prüft oder teilnimmt, ist eine Person — auch
 * ohne Konto (die Leitung ohne Login). Eine Aufgabe ist eine datierte Zuordnung Aufgabe × Person × gilt ab/bis mit
 * „entschieden von“ (Pflicht außer bei der Leitung des Unternehmens), nur anhängen; beendet wird sie einmal, eine
 * Übergabe ist eine neue Zuordnung. Die Leitung ist, wer am Tag die Aufgabe „Leitung des Unternehmens“ trägt (PA3).
 * Eine Person wird nie gelöscht — „bis“ beendet sie (PA5). Das Recht prüft der Interceptor an der Route
 * ({@code energiemanagement.verwalten}, Unternehmen); Aufgaben sieht nur, wer unternehmensweit liest.
 */
@Service
public class EnergiemanagementPersonenService {

    static final String LEITUNG = "unternehmensleitung";
    static final String WEITERE = "weitere";
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern BESCHLUSS = Pattern.compile("^BR-[0-9]{4}-[0-9]{4,}/B[0-9]{1,3}$");

    private final EnergiemanagementPersonenRepository repo;
    private final UnternehmenRepository unternehmen;
    private final RechtPruefung rechte;
    private final ObjectMapper json;
    private final TransactionTemplate tx;

    public EnergiemanagementPersonenService(EnergiemanagementPersonenRepository repo,
            UnternehmenRepository unternehmen, RechtPruefung rechte, ObjectMapper json, PlatformTransactionManager tm) {
        this.repo = repo;
        this.unternehmen = unternehmen;
        this.rechte = rechte;
        this.json = json;
        this.tx = new TransactionTemplate(tm);
    }

    // ------------------------------------------------------------------ Personen

    public EnergiemanagementPersonenDto.Personen personen() {
        return new EnergiemanagementPersonenDto.Personen(repo.personen().stream().map(this::person).toList());
    }

    public EnergiemanagementPersonenDto.PersonMitVerlauf person(UUID id) {
        var p = repo.person(id).orElseThrow(EnergiemanagementAbgelehnt::personFehlt);
        return new EnergiemanagementPersonenDto.PersonMitVerlauf(person(p), repo.verlauf("person", id).stream()
                .map(a -> new EnergiemanagementPersonenDto.Aenderung(a.id(), a.art(), baum(a.alt()), baum(a.neu()),
                        a.begruendung(), a.akteur(), a.zeit()))
                .toList());
    }

    /** Erfasst eine Person, auch ohne Konto (PA1); Protokoll {@code person_erfasst}. */
    public UUID anlegen(PersonAnlegen a, ProtokollAkteur wer) {
        var stand = stand(a.name(), a.funktion(), a.kuerzel(), a.organisation(), a.kontoSub(), a.seit());
        return eindeutig(() -> tx.execute(s -> {
            frei(stand, null);
            return repo.personAnlegen(new EnergiemanagementPersonenRepository.NeuePerson(stand.name(),
                    stand.funktion(), stand.kuerzel(), stand.organisation(), stand.kontoSub(), stand.seit()), wer);
        }));
    }

    /**
     * Ändert den Stand der Person; ein anderes Konto (verknüpfen, wechseln, lösen) braucht eine Begründung und steht
     * mit alt und neu im Verlauf. {@code bis} beendet die Person endgültig — nur ohne Zuordnung, die sie danach noch
     * trägt (409 {@code aufgaben_laufen}).
     */
    public void aendern(UUID id, PersonAendern a, ProtokollAkteur wer) {
        var stand = stand(a.name(), a.funktion(), a.kuerzel(), a.organisation(), a.kontoSub(), a.seit());
        eindeutig(() -> tx.execute(s -> {
            var alt = repo.personSperren(id).orElseThrow(EnergiemanagementAbgelehnt::personFehlt);
            if ("beendet".equals(alt.zustand())) {
                throw EnergiemanagementAbgelehnt.konflikt("person_beendet",
                        "Diese Person ist beendet; ihr Stand ändert sich nicht mehr.", Map.of("bis", alt.bis().toString()));
            }
            boolean kontoNeu = !Objects.equals(alt.kontoSub(), stand.kontoSub());
            String begruendung = text(a.begruendung());
            if (kontoNeu || a.bis() != null) {
                begruendung = begruendung(a.begruendung());
            } else if (begruendung != null) {
                begruendung = begruendung(begruendung);
            }
            if (a.bis() != null && stand.seit() != null && a.bis().isBefore(stand.seit())) {
                throw EnergiemanagementAbgelehnt.fachlich("zeitraum_ungueltig",
                        "Bitte wählen Sie ein „bis“ ab dem „seit“.", Map.of("seit", stand.seit().toString()));
            }
            if (a.bis() != null) {
                var laufend = repo.laufendNach(id, a.bis());
                if (!laufend.isEmpty()) {
                    throw EnergiemanagementAbgelehnt.konflikt("aufgaben_laufen",
                            "Diese Person trägt nach diesem Tag noch Aufgaben. Bitte beenden oder übergeben Sie "
                                    + "sie zuerst.",
                            Map.of("zuordnungen", laufend.stream().map(z -> z.id().toString()).toList()));
                }
            }
            frei(stand, id);
            boolean geaendert = kontoNeu || !Objects.equals(alt.name(), stand.name())
                    || !Objects.equals(alt.funktion(), stand.funktion())
                    || !Objects.equals(alt.kuerzel(), stand.kuerzel())
                    || !Objects.equals(alt.organisation(), stand.organisation())
                    || !Objects.equals(alt.seit(), stand.seit());
            if (geaendert) {
                repo.personAendern(id, stand, begruendung, wer);
            }
            if (a.bis() != null) {
                repo.personBeenden(id, a.bis(), begruendung, wer);
            }
            return id;
        }));
    }

    // ------------------------------------------------------------------ Aufgaben

    /**
     * Die Aufgaben am {@code tag} (Vorgabe heute): je Wort des Vokabulars die laufenden Zuordnungen — der letzte Tag
     * zählt mit —, ohne Person der Satz „… — keine Person festgelegt.“ (außer „weitere“); die Leitung (PA3); alle
     * Zuordnungen. Wer nicht unternehmensweit liest, bekommt keine Zeile — ohne Hinweis, ohne Anzahl, und nie den Satz.
     */
    public EnergiemanagementPersonenDto.Aufgaben aufgaben(LocalDate tag) {
        LocalDate am = tag == null ? heute() : tag;
        if (!rechte.lesbar(RechtZiel.UNTERNEHMEN, null)) {
            return new EnergiemanagementPersonenDto.Aufgaben(am, List.of(), List.of(), List.of());
        }
        Map<UUID, EnergiemanagementPersonenRepository.Person> personen = repo.personen().stream()
                .collect(Collectors.toMap(EnergiemanagementPersonenRepository.Person::id, Function.identity()));
        var alle = repo.zuordnungen();
        var laufend = alle.stream().filter(z -> laeuft(z, am)).toList();
        var aufgaben = new ArrayList<EnergiemanagementPersonenDto.Aufgabe>();
        for (String aufgabe : EnergiemanagementRegeln.VOKABULARE.get("aufgabe")) {
            var diese = laufend.stream().filter(z -> z.aufgabe().equals(aufgabe))
                    .map(z -> zuordnung(z, personen)).toList();
            String wort = wort(aufgabe);
            String satz = diese.isEmpty() && !WEITERE.equals(aufgabe)
                    ? (String) EnergiemanagementRegeln.satz("aufgabe_ohne_person", Map.of("aufgabe", wort)).get("satz")
                    : null;
            aufgaben.add(new EnergiemanagementPersonenDto.Aufgabe(aufgabe, wort, diese, satz));
        }
        var leitung = laufend.stream().filter(z -> LEITUNG.equals(z.aufgabe()))
                .map(EnergiemanagementPersonenRepository.Zuordnung::personId).distinct()
                .map(id -> kurz(personen.get(id))).toList();
        return new EnergiemanagementPersonenDto.Aufgaben(am, leitung, aufgaben,
                alle.stream().map(z -> zuordnung(z, personen)).toList());
    }

    /**
     * Die Leitung am Tag (PA3): die Personen mit laufender Aufgabe „Leitung des Unternehmens“ — leer heißt, Freigaben
     * mit Leitungs-Pflicht (DK3) und die Freigabe einer Managementbewertung (MG4) sind gesperrt.
     */
    public List<UUID> leitungAm(LocalDate tag) {
        return repo.zuordnungen().stream().filter(z -> LEITUNG.equals(z.aufgabe()) && laeuft(z, tag))
                .map(EnergiemanagementPersonenRepository.Zuordnung::personId).distinct().toList();
    }

    /** Ordnet eine Aufgabe zu (PA2); Protokoll {@code aufgabe_zugeordnet}. */
    public UUID zuordnen(AufgabeZuordnen a, ProtokollAkteur wer) {
        String aufgabe = text(a.aufgabe());
        if (aufgabe == null || !EnergiemanagementRegeln.VOKABULARE.get("aufgabe").contains(aufgabe)) {
            throw EnergiemanagementAbgelehnt.fachlich("aufgabe_unbekannt", "Bitte wählen Sie eine Aufgabe aus der Liste.",
                    Map.of("aufgaben", EnergiemanagementRegeln.VOKABULARE.get("aufgabe")));
        }
        String wortlaut = text(a.aufgabeWortlaut());
        if (WEITERE.equals(aufgabe)) {
            if (wortlaut == null) {
                throw EnergiemanagementAbgelehnt.fachlich("wortlaut_fehlt",
                        "Bitte beschreiben Sie die weitere Aufgabe in einem Wortlaut.", null);
            }
            laenge("aufgabe_wortlaut", wortlaut, 200);
        } else if (wortlaut != null) {
            throw ungueltig("aufgabe_wortlaut", "Einen Wortlaut trägt nur eine weitere Aufgabe.");
        }
        if (a.personId() == null) {
            throw EnergiemanagementAbgelehnt.fachlich("person_fehlt", "Bitte wählen Sie eine Person.", null);
        }
        if (a.giltAb() == null) {
            throw EnergiemanagementAbgelehnt.fachlich("gilt_ab_fehlt", "Bitte nennen Sie, ab wann die Zuordnung gilt.",
                    null);
        }
        if (a.entschiedenVon() == null && !LEITUNG.equals(aufgabe)) {
            throw EnergiemanagementAbgelehnt.fachlich("entschieden_von_fehlt",
                    "Bitte nennen Sie, wer die Zuordnung entschieden hat.", Map.of("feld", "entschieden_von"));
        }
        if (a.personId().equals(a.vertretungPersonId())) {
            throw EnergiemanagementAbgelehnt.fachlich("vertretung_gleich_person",
                    "Die Vertretung ist eine andere Person.", Map.of("feld", "vertretung_person_id"));
        }
        String begruendung = begruendung(a.begruendung());
        var beleg = beleg(a.beleg());
        String beschluss = text(a.beschlussKennung());
        if (beschluss != null && !BESCHLUSS.matcher(beschluss).matches()) {
            throw EnergiemanagementAbgelehnt.fachlich("beschluss_ungueltig",
                    "Bitte nennen Sie den Beschluss als BR-JJJJ-nnnn/Bn.", Map.of("feld", "beschluss_kennung"));
        }
        return tx.execute(s -> {
            var person = repo.personSperren(a.personId())
                    .orElseThrow(() -> unbekannt("person_id"));
            imZeitraum(person, a.giltAb(), "person_id");
            if (a.vertretungPersonId() != null) {
                imZeitraum(repo.person(a.vertretungPersonId()).orElseThrow(() -> unbekannt("vertretung_person_id")),
                        a.giltAb(), "vertretung_person_id");
            }
            if (a.entschiedenVon() != null && repo.person(a.entschiedenVon()).isEmpty()) {
                throw unbekannt("entschieden_von");
            }
            repo.beschlussPruefen(beschluss);
            if (repo.ueberschneidet(aufgabe, wortlaut, a.personId(), a.giltAb())) {
                throw EnergiemanagementAbgelehnt.konflikt("zuordnung_laeuft_bereits",
                        "Diese Person trägt diese Aufgabe in diesem Zeitraum bereits.", null);
            }
            return repo.zuordnen(new EnergiemanagementPersonenRepository.NeueZuordnung(aufgabe, wortlaut,
                    a.personId(), a.giltAb(), a.vertretungPersonId(), a.entschiedenVon(), begruendung,
                    beleg.bezeichnung(), beleg.ablage(), beleg.kennung(), beleg.adresse(), beleg.sha256(), beschluss),
                    wer);
        });
    }

    /** Beendet eine Zuordnung einmal (der letzte Tag zählt mit); Protokoll {@code aufgabe_beendet}. */
    public void beenden(UUID id, AufgabeBeenden a, ProtokollAkteur wer) {
        tx.executeWithoutResult(s -> {
            var z = repo.zuordnungSperren(id).orElseThrow(EnergiemanagementAbgelehnt::zuordnungFehlt);
            if ("beendet".equals(z.zustand())) {
                throw EnergiemanagementAbgelehnt.konflikt("aufgabe_beendet", "Diese Zuordnung ist bereits beendet.",
                        Map.of("gilt_bis", z.giltBis().toString()));
            }
            if (a.giltBis() == null) {
                throw EnergiemanagementAbgelehnt.fachlich("gilt_bis_fehlt",
                        "Bitte nennen Sie den letzten Tag der Zuordnung.", null);
            }
            if (a.giltBis().isBefore(z.giltAb())) {
                throw EnergiemanagementAbgelehnt.fachlich("zeitraum_ungueltig",
                        "Bitte wählen Sie einen letzten Tag ab dem Beginn.", Map.of("gilt_ab", z.giltAb().toString()));
            }
            repo.beenden(id, a.giltBis(), begruendung(a.begruendung()), wer);
        });
    }

    public EnergiemanagementPersonenDto.Zuordnung zuordnung(UUID id) {
        Map<UUID, EnergiemanagementPersonenRepository.Person> personen = repo.personen().stream()
                .collect(Collectors.toMap(EnergiemanagementPersonenRepository.Person::id, Function.identity()));
        return zuordnung(repo.zuordnung(id).orElseThrow(EnergiemanagementAbgelehnt::zuordnungFehlt), personen);
    }

    // ------------------------------------------------------------------ Hilfen

    private static boolean laeuft(EnergiemanagementPersonenRepository.Zuordnung z, LocalDate tag) {
        return !z.giltAb().isAfter(tag) && (z.giltBis() == null || !z.giltBis().isBefore(tag));
    }

    private static String wort(String aufgabe) {
        return EnergiemanagementRegeln.WOERTER.get("aufgabe").get(aufgabe);
    }

    private EnergiemanagementPersonenDto.Person person(EnergiemanagementPersonenRepository.Person p) {
        var konto = p.kontoSub() == null ? null
                : new EnergiemanagementPersonenDto.Konto(p.kontoSub(), p.kontoName(), p.kontoZustand());
        return new EnergiemanagementPersonenDto.Person(p.id(), p.name(), p.funktion(), p.kuerzel(), p.organisation(),
                konto, p.seit(), p.bis(), p.zustand(), p.beendetBegruendung(),
                new EnergiemanagementPersonenDto.Eingetragen(p.akteur(), p.angelegtAm()));
    }

    private static PersonKurz kurz(EnergiemanagementPersonenRepository.Person p) {
        return p == null ? null : new PersonKurz(p.id(), p.name(), p.funktion(), p.kuerzel(), p.kontoSub() != null);
    }

    private static EnergiemanagementPersonenDto.Zuordnung zuordnung(EnergiemanagementPersonenRepository.Zuordnung z,
            Map<UUID, EnergiemanagementPersonenRepository.Person> personen) {
        var beleg = z.belegAblage() == null ? null : new EnergiemanagementPersonenDto.Beleg(z.belegBezeichnung(),
                z.belegAblage(), z.belegKennung(), z.belegAdresse(), z.belegSha256());
        String wort = WEITERE.equals(z.aufgabe()) ? z.aufgabeWortlaut() : wort(z.aufgabe());
        return new EnergiemanagementPersonenDto.Zuordnung(z.id(), z.aufgabe(), wort, z.aufgabeWortlaut(),
                kurz(personen.get(z.personId())), z.vertretungPersonId() == null ? null
                        : kurz(personen.get(z.vertretungPersonId())), z.giltAb(), z.giltBis(), z.zustand(),
                z.entschiedenVon() == null ? null : kurz(personen.get(z.entschiedenVon())), z.begruendung(), beleg,
                z.beschlussKennung(), z.beendetBegruendung(),
                new EnergiemanagementPersonenDto.Eingetragen(z.akteur(), z.angelegtAm()));
    }

    private EnergiemanagementPersonenRepository.Stand stand(String name, String funktion, String kuerzel,
            String organisation, String kontoSub, LocalDate seit) {
        String n = text(name);
        if (n == null) {
            throw EnergiemanagementAbgelehnt.fachlich("name_fehlt", "Bitte geben Sie einen Namen an.",
                    Map.of("feld", "name"));
        }
        laenge("name", n, 200);
        String f = text(funktion);
        if (f == null) {
            throw EnergiemanagementAbgelehnt.fachlich("funktion_fehlt", "Bitte geben Sie eine Funktion an.",
                    Map.of("feld", "funktion"));
        }
        laenge("funktion", f, 200);
        String k = text(kuerzel);
        if (k != null) {
            laenge("kuerzel", k, 10);
        }
        String o = text(organisation);
        if (o != null) {
            laenge("organisation", o, 200);
        }
        return new EnergiemanagementPersonenRepository.Stand(n, f, k, o, text(kontoSub), seit);
    }

    /** Kürzel und Konto gehören höchstens einer Person; das Konto gibt es im Kundenbereich. */
    private void frei(EnergiemanagementPersonenRepository.Stand s, UUID ausser) {
        if (s.kontoSub() != null && !repo.kontoVorhanden(s.kontoSub())) {
            throw EnergiemanagementAbgelehnt.fachlich("konto_unbekannt",
                    "Bitte wählen Sie ein Konto aus Ihrem Kundenbereich.", Map.of("feld", "konto_sub"));
        }
        if (s.kontoSub() != null && repo.kontoVergeben(s.kontoSub(), ausser)) {
            throw kontoVergeben();
        }
        if (s.kuerzel() != null && repo.kuerzelVergeben(s.kuerzel(), ausser)) {
            throw kuerzelVergeben();
        }
    }

    private static void imZeitraum(EnergiemanagementPersonenRepository.Person p, LocalDate ab, String feld) {
        if (p.bis() != null && p.bis().isBefore(ab)) {
            throw EnergiemanagementAbgelehnt.fachlich("person_beendet",
                    "Diese Person ist ab diesem Tag nicht mehr im Energiemanagement.",
                    Map.of("feld", feld, "bis", p.bis().toString()));
        }
    }

    private static EnergiemanagementPersonenDto.Beleg beleg(EnergiemanagementPersonenDto.Beleg b) {
        if (b == null) {
            return new EnergiemanagementPersonenDto.Beleg(null, null, null, null, null);
        }
        var n = new EnergiemanagementPersonenDto.Beleg(text(b.bezeichnung()), text(b.ablage()), text(b.kennung()),
                text(b.adresse()), text(b.sha256()));
        boolean irgendwas = n.bezeichnung() != null || n.kennung() != null || n.adresse() != null
                || n.sha256() != null;
        if (n.ablage() == null && irgendwas) {
            throw EnergiemanagementAbgelehnt.fachlich("beleg_ungueltig",
                    "Bitte nennen Sie, wo das Original liegt (Ablage).", Map.of("feld", "beleg.ablage"));
        }
        if (n.ablage() != null) {
            laenge("beleg.ablage", n.ablage(), 200);
            if (n.bezeichnung() != null) laenge("beleg.bezeichnung", n.bezeichnung(), 200);
            if (n.kennung() != null) laenge("beleg.kennung", n.kennung(), 200);
            if (n.adresse() != null) laenge("beleg.adresse", n.adresse(), 2000);
            if (n.sha256() != null && !SHA256.matcher(n.sha256()).matches()) {
                throw EnergiemanagementAbgelehnt.fachlich("beleg_ungueltig",
                        "Die Prüfsumme ist 64 Zeichen 0–9 und a–f.", Map.of("feld", "beleg.sha256"));
            }
        }
        return n;
    }

    private static String begruendung(String text) {
        String b = text == null ? "" : text.strip();
        if (b.length() < 10 || b.length() > 500) {
            throw EnergiemanagementAbgelehnt.fachlich("begruendung_fehlt", "Bitte begründen Sie mit 10 bis 500 Zeichen.",
                    Map.of("min", 10, "max", 500));
        }
        return b;
    }

    private static void laenge(String feld, String wert, int max) {
        if (wert.length() > max) {
            throw ungueltig(feld, "Bitte kürzen Sie auf höchstens " + max + " Zeichen.");
        }
    }

    private static EnergiemanagementAbgelehnt ungueltig(String feld, String satz) {
        return EnergiemanagementAbgelehnt.fachlich("angabe_ungueltig", satz, Map.of("feld", feld));
    }

    private static EnergiemanagementAbgelehnt unbekannt(String feld) {
        return EnergiemanagementAbgelehnt.fachlich("person_unbekannt",
                "Bitte wählen Sie eine Person im Energiemanagement Ihres Kundenbereichs.", Map.of("feld", feld));
    }

    private static EnergiemanagementAbgelehnt kontoVergeben() {
        return EnergiemanagementAbgelehnt.konflikt("konto_vergeben",
                "Dieses Konto gehört schon zu einer anderen Person.", Map.of("feld", "konto_sub"));
    }

    private static EnergiemanagementAbgelehnt kuerzelVergeben() {
        return EnergiemanagementAbgelehnt.konflikt("kuerzel_vergeben",
                "Dieses Kürzel trägt schon eine andere Person.", Map.of("feld", "kuerzel"));
    }

    /** Zwei gleichzeitige Anfragen: der eindeutige Index entscheidet, die Antwort bleibt dieselbe wie oben. */
    private static <T> T eindeutig(java.util.function.Supplier<T> schritt) {
        try {
            return schritt.get();
        } catch (DataIntegrityViolationException e) {
            String grund = String.valueOf(e.getMostSpecificCause().getMessage());
            if (grund.contains("energiemanagement_person_konto_uq")) throw kontoVergeben();
            if (grund.contains("energiemanagement_person_kuerzel_uq")) throw kuerzelVergeben();
            throw e;
        }
    }

    private static String text(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    private LocalDate heute() {
        return LocalDate.now(ZoneId.of(unternehmen.desKundenbereichs().map(UnternehmenRepository.Unternehmen::zeitzone)
                .orElse("Europe/Berlin")));
    }

    private JsonNode baum(String s) {
        try {
            return s == null ? null : json.readTree(s);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Ungültiger Protokoll-Schnappschuss", e);
        }
    }
}
