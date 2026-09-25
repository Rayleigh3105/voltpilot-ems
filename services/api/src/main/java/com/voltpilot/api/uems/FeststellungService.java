package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto;
import com.voltpilot.api.web.dto.EnergiemanagementVerantwortungDto;
import com.voltpilot.api.web.dto.FeststellungDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * UEMS AP-19 IP-19: Feststellung und Wirksamkeit (FS1–FS7, W15, §5.4, §5.6) über der Datenhaltung von IP-16.
 *
 * <p>Erfasst mit Quelle (ein durchgeführtes Audit, eigene, von außen mit Wortlaut, ein Beschluss BR-…/Bn einer
 * freigegebenen Managementbewertung — AP-19 IP-23, Muster {@code MassnahmeService}), Wortlaut, Vorgabe, Bezug,
 * „festgestellt von“ (eine Person, auch ohne Konto) und Verantwortlich (Konto) · Einträge nur anhängen, jeder mit
 * Person und Tag — nie ein Satz des Systems (FS2) · offen ändern sich nur Frist und Verantwortlich, mit Begründung ·
 * die Wirksamkeit als Stand Nr. n mit Kopie und Prüfsumme, erlaubt, wenn jede Maßnahme mit Herkunft dieser
 * Feststellung umgesetzt, bewertet oder verworfen ist und mindestens eine umgesetzt oder bewertet (FS4) ·
 * {@code ohne_massnahme} und {@code zurueckgenommen} schließen ohne Maßnahme (FS5) · Vier-Augen nach Einstellung: die
 * zweite Person ist nie die Urheberin und nie der Verantwortliche; wo niemand das erfüllt, sagt das Antwortfeld
 * {@code vieraugen} „Vier-Augen nicht erfüllbar: …“ mit den Personen (FS6, W15). Den Zustand {@code abgeschlossen}
 * setzt der schließende Stand in der Datenbank, nie dieser Dienst; ein Stand wird nie zurückgenommen (FS7).
 *
 * <p>Rechte: Erfassen, Einträge, Frist und Verantwortlich mit {@code energiemanagement.verwalten} am Standort des Bezugs
 * (ohne Standort am Unternehmen; der Interceptor lässt bis hierher, der Dienst prüft genau), die Stände mit
 * {@code energiemanagement.freigeben} am Unternehmen (am Controller).
 */
@Service
public class FeststellungService {

    private static final java.util.regex.Pattern BESCHLUSS = java.util.regex.Pattern.compile(
            "^BR-[0-9]{4}-[0-9]{4,}/B[0-9]{1,3}$");

    static final String VERWALTEN = "energiemanagement.verwalten";
    private static final int WORTLAUT = EnergiemanagementRegeln.STARTWERTE.eintrag_zeichen_hoechstens();
    private static final int BEGRUENDUNG_MIN = EnergiemanagementRegeln.STARTWERTE.begruendung_zeichen_mindestens();
    private static final int BEGRUENDUNG_MAX = EnergiemanagementRegeln.STARTWERTE.begruendung_zeichen_hoechstens();
    private static final Set<String> ZWEITE_ROLLEN = Set.of("kundenadministrator", "energiemanager");
    private static final Set<String> FREIGABE_ROLLEN = Set.of("kundenadministrator", "energiemanager",
            "voltpilot_betrieb");
    private static final List<String> PRUEFEN = List.of("wirksam", "nicht_wirksam");
    private static final List<String> OHNE = List.of("ohne_massnahme", "zurueckgenommen");
    private static final Set<String> ERLEDIGT = Set.of("umgesetzt", "bewertet", "verworfen");
    private static final Set<String> GEWIRKT = Set.of("umgesetzt", "bewertet");

    /** Eine Maßnahme, wie die Kopie des Stands sie festhält (Referenzdatei 1.10 {@code wirksamkeit[].kopie.massnahmen}). */
    public record MassnahmeKopie(String kennzeichen, String zustand, String umgesetztAm) {}

    private final FeststellungRepository repo;
    private final InternesAuditRepository personen;
    private final UnternehmenRepository unternehmen;
    private final RechtPruefung rechte;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private volatile Clock uhr = Clock.systemUTC();

    public FeststellungService(FeststellungRepository repo, InternesAuditRepository personen,
            UnternehmenRepository unternehmen, RechtPruefung rechte, ObjectMapper json, PlatformTransactionManager tm) {
        this.repo = repo;
        this.personen = personen;
        this.unternehmen = unternehmen;
        this.rechte = rechte;
        this.json = json;
        this.tx = new TransactionTemplate(tm);
    }

    /** Nur für Tests: die Uhr, an der „heute“, „nie in der Zukunft“, das Jahr im Kennzeichen und die Frist hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------ Lesen

    /** Die sichtbaren Feststellungen am {@code tag} (Vorgabe heute): offene zuerst, am längsten überfällig oben. */
    public FeststellungDto.Liste liste(LocalDate tag) {
        LocalDate abruf = tag == null ? heute() : tag;
        var alle = repo.feststellungen();
        var leute = leute(alle.stream().map(FeststellungRepository.Feststellung::festgestelltVon).distinct().toList());
        int fristTage = fristTage();
        return new FeststellungDto.Liste(abruf, alle.stream().map(f -> feststellung(f, leute, abruf, fristTage,
                kennzeichen(repo.massnahmen(f.kennzeichen())))).toList());
    }

    /**
     * Die Feststellung mit Einträgen, Maßnahmen, Ständen und Verlauf; dazu {@code vieraugen} aus Sicht von {@code wer}
     * (die mögliche Urheberin) bzw. der Urheberin eines offenen Antrags. Außerhalb des Zauns gibt es sie nicht (404).
     */
    public FeststellungDto.FeststellungMitVerlauf feststellung(UUID id, ProtokollAkteur wer) {
        var f = repo.feststellung(id).orElseThrow(FeststellungService::feststellungFehlt);
        var eintraege = repo.eintraege(id);
        var staende = repo.staende(id);
        var ids = new ArrayList<UUID>();
        ids.add(f.festgestelltVon());
        eintraege.forEach(e -> ids.add(e.personId()));
        staende.forEach(s -> ids.add(s.entschiedenVon()));
        var leute = leute(ids.stream().distinct().toList());
        var massnahmen = repo.massnahmen(f.kennzeichen());
        LocalDate heute = heute();
        var antrag = staende.stream().filter(s -> "beantragt".equals(s.status())).findFirst().orElse(null);
        return new FeststellungDto.FeststellungMitVerlauf(
                feststellung(f, leute, heute, fristTage(), kennzeichen(massnahmen)),
                eintraege.stream().map(e -> new FeststellungDto.Eintrag(e.id(), e.art(), e.am(), leute.get(e.personId()),
                        e.wortlaut(), new EnergiemanagementPersonenDto.Eingetragen(e.akteur(), e.zeit()))).toList(),
                massnahmen.stream().map(m -> new FeststellungDto.Massnahme(m.id(), m.kennzeichen(), m.titel(),
                        m.zustand(), m.termin(), m.umgesetztAm(), new EnergiemanagementVerantwortungDto.Person(
                                m.verantwortlichSub(), m.verantwortlichName()))).toList(),
                staende.stream().map(s -> stand(s, leute)).toList(),
                "offen".equals(f.zustand()) ? vierAugen(f, antrag, wer) : new FeststellungDto.VierAugen(repo.vierAugen(),
                        true, List.of(), List.of(), null),
                repo.verlauf(id).stream().map(v -> new EnergiemanagementPersonenDto.Aenderung(v.id(), v.art(),
                        baum(v.alt()), baum(v.neu()), v.begruendung(), v.akteur(), v.zeit())).toList());
    }

    /** Die Stände einer sichtbaren Feststellung — für die Verzeichnis-Quelle. */
    public List<FeststellungDto.Stand> staende(UUID id) {
        var staende = repo.staende(id);
        var leute = leute(staende.stream().map(FeststellungRepository.Stand::entschiedenVon).distinct().toList());
        return staende.stream().map(s -> stand(s, leute)).toList();
    }

    // ------------------------------------------------------------------ Schreiben

    /** Erfassen (FS1): Protokoll {@code feststellung_erfasst}; F-JJJJ-nnnn trägt das Jahr des Anlegens. */
    public UUID erfassen(FeststellungDto.Erfassen e, ProtokollAkteur wer) {
        return tx.execute(t -> repo.erfassen(neu(e), uhr.instant(), wer));
    }

    /**
     * Ein Eintrag (FS2): Kommentar jederzeit, Behebung, Ursache (Aussage) und ähnliche Fälle solange offen — immer mit
     * der Person, die ihn sagt, und dem Tag; die Ursache ist nie ein Satz des Systems.
     */
    public long eintrag(UUID id, FeststellungDto.EintragFesthalten e, ProtokollAkteur wer) {
        return tx.execute(t -> {
            var f = schreibbar(id);
            String art = text(e.art());
            if (art == null || !EnergiemanagementRegeln.VOKABULARE.get("feststellung_eintrag").contains(art)) {
                throw EnergiemanagementAbgelehnt.fachlich("eintrag_art_ungueltig",
                        "Bitte wählen Sie Kommentar, sofortige Behebung, Ursache oder ähnliche Fälle.",
                        Map.of("feld", "art"));
            }
            if (!"kommentar".equals(art) && !"offen".equals(f.zustand())) {
                throw abgeschlossen(f, "Nach dem Abschluss ist nur noch ein Kommentar möglich.");
            }
            String wortlaut = text(e.wortlaut());
            if (wortlaut == null) {
                throw fehlt("wortlaut");
            }
            laenge("wortlaut", wortlaut, WORTLAUT);
            if (e.personId() == null) {
                throw EnergiemanagementAbgelehnt.fachlich("person_fehlt",
                        "Bitte nennen Sie die Person, von der die Aussage stammt.", Map.of("feld", "person_id"));
            }
            person(e.personId(), "person_id");
            LocalDate am = e.am() == null ? heute() : e.am();
            nichtInZukunft(am, "am");
            nichtVorFeststellung(am, f, "am");
            return repo.eintrag(id, art, am, e.personId(), wortlaut, wer);
        });
    }

    /** Die Frist ändern, solange offen — nie vor dem Tag der Feststellung; Begründung Pflicht (§5.6). */
    public void frist(UUID id, FeststellungDto.FristAendern a, ProtokollAkteur wer) {
        tx.executeWithoutResult(t -> {
            var f = schreibbar(id);
            offen(f);
            if (a.frist() == null) {
                throw fehlt("frist");
            }
            fristPruefen(a.frist(), f.festgestelltAm());
            String begruendung = begruendung(a.begruendung());
            if (!a.frist().equals(f.frist())) {
                repo.frist(id, a.frist(), begruendung, wer);
            }
        });
    }

    /** Den Verantwortlichen ändern, solange offen — ein aktives Konto; Begründung Pflicht (§5.6). */
    public void verantwortlich(UUID id, FeststellungDto.VerantwortlichAendern a, ProtokollAkteur wer) {
        tx.executeWithoutResult(t -> {
            var f = schreibbar(id);
            offen(f);
            var konto = konto(a.verantwortlich());
            String begruendung = begruendung(a.begruendung());
            if (!konto.sub().equals(f.verantwortlichSub())) {
                repo.verantwortlich(id, konto.sub(), name(konto), konto.konto(), begruendung, wer);
            }
        });
    }

    /** Wirksamkeit festhalten ohne Vier-Augen (FS4): {@code wirksam} schließt ab, {@code nicht_wirksam} hält offen. */
    public int wirksamkeit(UUID id, FeststellungDto.StandFesthalten s, ProtokollAkteur wer) {
        return festhalten(id, s, PRUEFEN, wer);
    }

    /** Abschließen ohne Maßnahme ohne Vier-Augen (FS5): {@code ohne_massnahme} oder {@code zurueckgenommen}. */
    public int abschliessen(UUID id, FeststellungDto.StandFesthalten s, ProtokollAkteur wer) {
        return festhalten(id, s, OHNE, wer);
    }

    /**
     * Vier-Augen (FS6): die Urheberin beantragt einen Stand mit einem der vier Ergebnisse; ohne Vier-Augen 409
     * {@code vieraugen_aus}; gibt es niemanden, der zweite Person sein kann, 409 {@code vieraugen_nicht_erfuellbar} mit
     * dem Satz und den Personen — kein Antrag, über den niemand entscheiden könnte.
     */
    public int beantragen(UUID id, FeststellungDto.StandFesthalten s, ProtokollAkteur wer) {
        return tx.execute(t -> {
            var f = repo.sperren(id).orElseThrow(FeststellungService::feststellungFehlt);
            if (!repo.vierAugen()) {
                throw EnergiemanagementAbgelehnt.konflikt("vieraugen_aus",
                        "Ohne Vier-Augen-Freigabe halten Sie die Wirksamkeit direkt fest.", Map.of());
            }
            var entwurf = entwurf(f, s, EnergiemanagementRegeln.VOKABULARE.get("wirksamkeit_ergebnis"));
            var va = vierAugen(f, null, wer);
            if (!va.erfuellbar()) {
                Map<String, Object> fakten = new LinkedHashMap<>();
                fakten.put("satz", va.satz());
                fakten.put("berechtigte", va.berechtigte().stream().map(EnergiemanagementVerantwortungDto.Person::name)
                        .toList());
                throw EnergiemanagementAbgelehnt.konflikt("vieraugen_nicht_erfuellbar",
                        va.satz() == null ? "Vier-Augen nicht erfüllbar." : va.satz(), fakten);
            }
            return repo.stand(id, new FeststellungRepository.NeuerStand(entwurf.ergebnis(), entwurf.begruendung(),
                    entwurf.entschiedenVon(), entwurf.am(), entwurf.kopie(), entwurf.pruefsumme(), true,
                    freigabeRolle(wer), uhr.instant()), wer);
        });
    }

    /** Vier-Augen: die zweite Person bestätigt den offenen Antrag — nie die Urheberin, nie der Verantwortliche. */
    public void freigeben(UUID id, ProtokollAkteur wer) {
        tx.executeWithoutResult(t -> {
            var f = repo.sperren(id).orElseThrow(FeststellungService::feststellungFehlt);
            var antrag = antrag(id);
            zweitePerson(f, antrag, wer);
            repo.bestaetigen(id, antrag, uhr.instant(), wer);
        });
    }

    /** Vier-Augen: die zweite Person lehnt den offenen Antrag mit Begründung ab; der Stand behält seine Nr. */
    public void ablehnen(UUID id, FeststellungDto.Ablehnen a, ProtokollAkteur wer) {
        String begruendung = begruendung(a == null ? null : a.begruendung());
        tx.executeWithoutResult(t -> {
            var f = repo.sperren(id).orElseThrow(FeststellungService::feststellungFehlt);
            var antrag = antrag(id);
            zweitePerson(f, antrag, wer);
            repo.ablehnen(id, antrag, begruendung, uhr.instant(), wer);
        });
    }

    // ------------------------------------------------------------------ Kopie (FS4)

    /**
     * Die Kopie des Stands (Vertrag {@code energiemanagement.md} §6, Referenzdatei 1.10): {@code feststellung}
     * (Kennzeichen), {@code wortlaut}, {@code eintraege} (Anzahl), {@code massnahmen} mit Zustand und Umsetzungstag,
     * {@code aufgabe} (die am Tag laufende Zuordnung der Aufgabe im Bezug; ohne Aufgabe im Bezug {@code null}) und
     * {@code am} (der Tag des Stands). Die Prüfsumme bildet {@link EnergiemanagementRegeln#pruefsumme}.
     */
    public static JsonNode kopie(String feststellung, String wortlaut, int eintraege, List<MassnahmeKopie> massnahmen,
            String bezugAufgabe, FeststellungRepository.Zuordnung zuordnung, String am) {
        JsonNodeFactory n = JsonNodeFactory.instance;
        ObjectNode k = n.objectNode();
        k.put("feststellung", feststellung);
        k.put("wortlaut", wortlaut);
        k.put("eintraege", eintraege);
        ArrayNode m = k.putArray("massnahmen");
        for (var x : massnahmen) {
            ObjectNode e = m.addObject();
            e.put("kennzeichen", x.kennzeichen());
            e.put("zustand", x.zustand());
            e.put("umgesetzt_am", x.umgesetztAm());
        }
        if (bezugAufgabe == null) {
            k.putNull("aufgabe");
        } else {
            ObjectNode a = k.putObject("aufgabe");
            a.put("aufgabe", bezugAufgabe);
            a.put("person", zuordnung == null ? null : zuordnung.person());
            a.put("vertretung", zuordnung == null ? null : zuordnung.vertretung());
            a.put("gilt_ab", zuordnung == null ? null : zuordnung.giltAb().toString());
            a.put("entschieden_von", zuordnung == null ? null : zuordnung.entschiedenVon());
        }
        k.put("am", am);
        return k;
    }

    // ------------------------------------------------------------------ Vier-Augen (FS6, W15)

    /**
     * Wer zweite Person sein kann: die Berechtigten (KA/EM am Unternehmen) ohne die Urheberin und ohne den
     * Verantwortlichen. Urheberin ist die eines offenen Antrags, sonst {@code wer}, wenn berechtigt; ist sie noch offen,
     * genügt irgendein Paar. Niemand → {@code erfuellbar = false} und der Satz aus §5.8 mit allen Berechtigten.
     */
    FeststellungDto.VierAugen vierAugen(FeststellungRepository.Feststellung f, FeststellungRepository.Stand antrag,
            ProtokollAkteur wer) {
        if (!repo.vierAugen()) {
            return new FeststellungDto.VierAugen(false, true, List.of(), List.of(), null);
        }
        var berechtigte = repo.berechtigte(uhr.instant()).stream()
                .map(b -> new EnergiemanagementVerantwortungDto.Person(b.sub(), b.name())).toList();
        var subs = berechtigte.stream().map(EnergiemanagementVerantwortungDto.Person::sub).collect(Collectors.toSet());
        String urheberin = antrag != null ? antrag.freigabe().sub()
                : wer != null && subs.contains(wer.sub()) ? wer.sub() : null;
        List<EnergiemanagementVerantwortungDto.Person> zweite = urheberin == null && berechtigte.size() < 2 ? List.of()
                : berechtigte.stream().filter(p -> !p.sub().equals(urheberin) && !p.sub().equals(f.verantwortlichSub()))
                        .toList();
        boolean erfuellbar = !zweite.isEmpty();
        String satz = erfuellbar || berechtigte.isEmpty() ? null : (String) EnergiemanagementRegeln.satz(
                "vieraugen_nicht_erfuellbar", Map.of("personen", aufzaehlung(berechtigte.stream()
                        .map(EnergiemanagementVerantwortungDto.Person::name).toList()),
                        "beteiligt", berechtigte.size() == 2 ? "beide" : "alle")).get("satz");
        return new FeststellungDto.VierAugen(true, erfuellbar, berechtigte, zweite, satz);
    }

    /** „A“, „A und B“, „A, B und C“. */
    static String aufzaehlung(List<String> namen) {
        if (namen.size() <= 1) {
            return String.join("", namen);
        }
        return String.join(", ", namen.subList(0, namen.size() - 1)) + " und " + namen.get(namen.size() - 1);
    }

    // ------------------------------------------------------------------ Prüfungen

    private record Entwurf(String ergebnis, String begruendung, UUID entschiedenVon, LocalDate am, String kopie,
            String pruefsumme) {}

    private int festhalten(UUID id, FeststellungDto.StandFesthalten s, List<String> erlaubt, ProtokollAkteur wer) {
        return tx.execute(t -> {
            var f = repo.sperren(id).orElseThrow(FeststellungService::feststellungFehlt);
            if (repo.vierAugen()) {
                throw EnergiemanagementAbgelehnt.konflikt("vieraugen_beantragen",
                        "Mit Vier-Augen-Freigabe beantragen Sie den Stand; eine zweite Person gibt ihn frei.", Map.of());
            }
            var e = entwurf(f, s, erlaubt);
            return repo.stand(id, new FeststellungRepository.NeuerStand(e.ergebnis(), e.begruendung(),
                    e.entschiedenVon(), e.am(), e.kopie(), e.pruefsumme(), false, freigabeRolle(wer), uhr.instant()),
                    wer);
        });
    }

    /** FS4/FS5: offen, kein offener Antrag, Ergebnis, Begründung, „entschieden von“, Tag; die Kopie mit Prüfsumme. */
    private Entwurf entwurf(FeststellungRepository.Feststellung f, FeststellungDto.StandFesthalten s,
            List<String> erlaubt) {
        offen(f);
        if (repo.staende(f.id()).stream().anyMatch(x -> "beantragt".equals(x.status()))) {
            throw EnergiemanagementAbgelehnt.konflikt("wirksamkeit_beantragt",
                    "Ein Stand wartet auf die zweite Person; erst danach entsteht ein neuer.", Map.of());
        }
        String ergebnis = text(s.ergebnis());
        if (ergebnis == null || !erlaubt.contains(ergebnis)) {
            throw EnergiemanagementAbgelehnt.fachlich("ergebnis_ungueltig", "Bitte wählen Sie "
                    + String.join(" oder ", erlaubt) + ".", Map.of("feld", "ergebnis", "erlaubt", erlaubt));
        }
        String begruendung = begruendung(s.begruendung());
        if (s.entschiedenVon() == null) {
            throw EnergiemanagementAbgelehnt.fachlich("entschieden_von_fehlt",
                    "Bitte nennen Sie, wer die Wirksamkeit geprüft hat.", Map.of("feld", "entschieden_von"));
        }
        person(s.entschiedenVon(), "entschieden_von");
        LocalDate am = s.am() == null ? heute() : s.am();
        nichtInZukunft(am, "am");
        nichtVorFeststellung(am, f, "am");
        var massnahmen = repo.massnahmen(f.kennzeichen());
        if (PRUEFEN.contains(ergebnis) && (massnahmen.isEmpty()
                || !massnahmen.stream().allMatch(m -> ERLEDIGT.contains(m.zustand()))
                || massnahmen.stream().noneMatch(m -> GEWIRKT.contains(m.zustand())))) {
            throw EnergiemanagementAbgelehnt.konflikt("wirksamkeit_noch_nicht",
                    EnergiemanagementRegeln.SAETZE.get("wirksamkeit_noch_nicht"), Map.of("massnahmen", massnahmen.stream()
                            .filter(m -> !ERLEDIGT.contains(m.zustand()))
                            .map(FeststellungRepository.Massnahme::kennzeichen).toList()));
        }
        var zuordnung = f.bezugAufgabe() == null ? null : repo.zuordnung(f.bezugAufgabe(), am).orElse(null);
        JsonNode kopie = kopie(f.kennzeichen(), f.wortlaut(), repo.eintraege(f.id()).size(), massnahmen.stream()
                .map(m -> new MassnahmeKopie(m.kennzeichen(), m.zustand(),
                        m.umgesetztAm() == null ? null : m.umgesetztAm().toString())).toList(),
                f.bezugAufgabe(), zuordnung, am.toString());
        Map<String, Object> summe = EnergiemanagementRegeln.pruefsumme(kopie);
        return new Entwurf(ergebnis, begruendung, s.entschiedenVon(), am, (String) summe.get("kanonisch"),
                (String) summe.get("pruefsumme"));
    }

    private FeststellungRepository.Stand antrag(UUID id) {
        return repo.staende(id).stream().filter(s -> "beantragt".equals(s.status())).findFirst()
                .orElseThrow(() -> EnergiemanagementAbgelehnt.konflikt("kein_antrag",
                        "An dieser Feststellung wartet kein Antrag auf die zweite Person.", Map.of()));
    }

    /** FS6: nie die Urheberin, nie der Verantwortliche der Feststellung, Rolle KA oder EM. */
    private static void zweitePerson(FeststellungRepository.Feststellung f, FeststellungRepository.Stand antrag,
            ProtokollAkteur wer) {
        if (Objects.equals(wer.sub(), antrag.freigabe().sub())) {
            throw EnergiemanagementAbgelehnt.fachlich("vieraugen_urheber",
                    "Bei Vier-Augen-Freigabe entscheidet eine zweite Person — nicht, wer den Stand beantragt hat.",
                    Map.of("stand", antrag.nr()));
        }
        if (Objects.equals(wer.sub(), f.verantwortlichSub())) {
            throw EnergiemanagementAbgelehnt.fachlich("vieraugen_verantwortlich",
                    "Über die Wirksamkeit entscheidet nie, wer für die Feststellung verantwortlich ist.",
                    Map.of("stand", antrag.nr()));
        }
        if (wer.sub() == null || !ZWEITE_ROLLEN.contains(wer.rolle())) {
            throw new EnergiemanagementAbgelehnt(403, "vieraugen_rolle",
                    "Die zweite Person ist Kundenadministrator oder Energiemanager.", Map.of("stand", antrag.nr()));
        }
    }

    private FeststellungRepository.Neu neu(FeststellungDto.Erfassen e) {
        var q = e.quelle();
        String art = q == null ? null : text(q.art());
        if (art == null || !EnergiemanagementRegeln.VOKABULARE.get("feststellung_quelle").contains(art)) {
            throw EnergiemanagementAbgelehnt.fachlich("quelle_ungueltig",
                    "Bitte nennen Sie die Quelle: ein internes Audit, eine eigene Feststellung, einen Hinweis von außen "
                            + "oder eine Managementbewertung.", Map.of("feld", "quelle.art"));
        }
        UUID audit = null;
        String kennung = null;
        String quelleWortlaut = null;
        InternesAuditRepository.Audit au = null;
        switch (art) {
            case "internes_audit" -> {
                if (q.auditId() == null) {
                    throw fehlt("quelle.audit_id");
                }
                au = personen.audit(q.auditId()).orElseThrow(() -> EnergiemanagementAbgelehnt.fachlich("audit_unbekannt",
                        "Dieses Audit gibt es in Ihrem Kundenbereich nicht.", Map.of("feld", "quelle.audit_id")));
                if (!"durchgefuehrt".equals(au.zustand())) {
                    throw EnergiemanagementAbgelehnt.konflikt("audit_nicht_durchgefuehrt",
                            "Eine Feststellung aus einem Audit entsteht am durchgeführten, noch nicht abgeschlossenen "
                                    + "Audit.", Map.of("zustand", au.zustand()));
                }
                audit = au.id();
                nurQuelle(q, "audit_id");
            }
            case "extern" -> {
                quelleWortlaut = text(q.wortlaut());
                if (quelleWortlaut == null) {
                    throw fehlt("quelle.wortlaut");
                }
                laenge("quelle.wortlaut", quelleWortlaut, BEGRUENDUNG_MAX);
                nurQuelle(q, "wortlaut");
            }
            case "managementbewertung" -> {
                // AP-19 IP-23: der Beschluss BR-…/Bn einer freigegebenen Managementbewertung — sonst unbekannt.
                kennung = text(q.kennung());
                if (kennung == null || !BESCHLUSS.matcher(kennung).matches()
                        || !repo.beschlussImStand(kennung).orElse(false)) {
                    throw EnergiemanagementAbgelehnt.fachlich("quelle_unbekannt", (kennung == null
                            ? "Diese Managementbewertung" : kennung) + " gibt es in Ihrem Kundenbereich nicht.",
                            Map.of("feld", "quelle.kennung"));
                }
                if (q.auditId() != null || text(q.wortlaut()) != null) {
                    throw ungueltig("quelle", "Bitte nennen Sie zur Quelle nur ihren eigenen Verweis.");
                }
            }
            default -> nurQuelle(q, "");
        }
        String wortlaut = text(e.wortlaut());
        if (wortlaut == null) {
            throw fehlt("wortlaut");
        }
        laenge("wortlaut", wortlaut, WORTLAUT);
        var v = e.vorgabe();
        UUID vorgabeDokument = v == null ? null : v.dokumentId();
        Integer vorgabeFassung = v == null ? null : v.fassung();
        String vorgabeWortlaut = v == null ? null : text(v.wortlaut());
        if (vorgabeDokument == null && vorgabeWortlaut == null) {
            throw EnergiemanagementAbgelehnt.fachlich("vorgabe_fehlt",
                    "Bitte nennen Sie, was nicht erfüllt ist: eine Dokument-Fassung oder die Anforderung im Wortlaut.",
                    Map.of("feld", "vorgabe"));
        }
        if ((vorgabeDokument == null) != (vorgabeFassung == null)) {
            throw ungueltig("vorgabe.fassung", "Bitte nennen Sie das Dokument mit seiner Fassung.");
        }
        if (vorgabeDokument != null && !repo.fassungVorhanden(vorgabeDokument, vorgabeFassung)) {
            throw EnergiemanagementAbgelehnt.fachlich("vorgabe_unbekannt",
                    "Diese Fassung gibt es in Ihrem Kundenbereich nicht.", Map.of("feld", "vorgabe.dokument_id"));
        }
        if (vorgabeWortlaut != null) {
            laenge("vorgabe.wortlaut", vorgabeWortlaut, WORTLAUT);
        }
        var b = e.bezug();
        UUID standort = b == null ? null : b.standortId();
        if (standort != null) {
            rechte.pruefen(VERWALTEN, RechtZiel.STANDORT, standort, () -> standortUnbekannt());
            if (personen.standorte(List.of(standort)) != 1) {
                throw standortUnbekannt();
            }
        } else {
            rechte.pruefen(VERWALTEN, RechtZiel.UNTERNEHMEN, null, FeststellungService::feststellungFehlt);
        }
        String aufgabe = b == null ? null : text(b.aufgabe());
        if (aufgabe != null && !EnergiemanagementRegeln.VOKABULARE.get("aufgabe").contains(aufgabe)) {
            throw EnergiemanagementAbgelehnt.fachlich("aufgabe_unbekannt", "Diese Aufgabe gibt es nicht.",
                    Map.of("feld", "bezug.aufgabe"));
        }
        UUID dokument = b == null ? null : b.dokumentId();
        if (dokument != null && !repo.dokumentVorhanden(dokument)) {
            throw EnergiemanagementAbgelehnt.fachlich("dokument_unbekannt",
                    "Dieses Dokument gibt es in Ihrem Kundenbereich nicht.", Map.of("feld", "bezug.dokument_id"));
        }
        List<String> objekte = new ArrayList<>();
        for (String o : b == null || b.objekte() == null ? List.<String>of() : b.objekte()) {
            String x = text(o);
            if (x == null || x.length() > 60 || !x.equals(o) || objekte.contains(x)) {
                throw ungueltig("bezug.objekte", "Bitte nennen Sie jedes Kennzeichen einmal, ohne Leerraum, höchstens "
                        + "60 Zeichen.");
            }
            objekte.add(x);
        }
        if (e.festgestelltVon() == null) {
            throw EnergiemanagementAbgelehnt.fachlich("festgestellt_von_fehlt",
                    "Bitte nennen Sie, wer die Feststellung getroffen hat.", Map.of("feld", "festgestellt_von"));
        }
        person(e.festgestelltVon(), "festgestellt_von");
        LocalDate am = e.festgestelltAm() == null ? heute() : e.festgestelltAm();
        nichtInZukunft(am, "festgestellt_am");
        if (au != null && au.durchgefuehrtAm() != null && am.isBefore(au.durchgefuehrtAm())) {
            throw EnergiemanagementAbgelehnt.fachlich("tag_vor_durchfuehrung",
                    "Bitte wählen Sie einen Tag ab der Durchführung des Audits.",
                    Map.of("feld", "festgestellt_am", "durchgefuehrt_am", au.durchgefuehrtAm().toString()));
        }
        var konto = konto(e.verantwortlich());
        if (e.frist() != null) {
            fristPruefen(e.frist(), am);
        }
        return new FeststellungRepository.Neu(art, audit, kennung, quelleWortlaut, wortlaut, vorgabeDokument,
                vorgabeFassung, vorgabeWortlaut, standort, aufgabe, dokument, List.copyOf(objekte), e.festgestelltVon(),
                am, konto.sub(), name(konto), konto.konto(), e.frist());
    }

    /** Die Quelle trägt genau ihren Verweis (FS1, CHECK {@code feststellung_quelle_chk}). */
    private static void nurQuelle(FeststellungDto.Quelle q, String eigenes) {
        if ((q.auditId() != null && !eigenes.equals("audit_id")) || (text(q.kennung()) != null)
                || (text(q.wortlaut()) != null && !eigenes.equals("wortlaut"))) {
            throw ungueltig("quelle", "Bitte nennen Sie zur Quelle nur ihren eigenen Verweis.");
        }
    }

    /** Die Feststellung im Zaun (sonst 404) und {@code energiemanagement.verwalten} am Standort ihres Bezugs. */
    private FeststellungRepository.Feststellung schreibbar(UUID id) {
        var f = repo.sperren(id).orElseThrow(FeststellungService::feststellungFehlt);
        if (f.standortId() == null) {
            rechte.pruefen(VERWALTEN, RechtZiel.UNTERNEHMEN, null, FeststellungService::feststellungFehlt);
        } else {
            rechte.pruefen(VERWALTEN, RechtZiel.STANDORT, f.standortId(), FeststellungService::feststellungFehlt);
        }
        return f;
    }

    private InternesAuditRepository.Konto konto(String sub) {
        String s = text(sub);
        if (s == null) {
            throw EnergiemanagementAbgelehnt.fachlich("verantwortlich_fehlt",
                    "Bitte nennen Sie eine verantwortliche Person mit Konto.", Map.of("feld", "verantwortlich"));
        }
        return personen.konto(s).orElseThrow(() -> EnergiemanagementAbgelehnt.fachlich("konto_unbekannt",
                "Bitte wählen Sie ein Konto aus Ihrem Kundenbereich.", Map.of("feld", "verantwortlich")));
    }

    private static String name(InternesAuditRepository.Konto k) {
        return k.name() == null || k.name().isBlank() ? k.sub() : k.name();
    }

    private void person(UUID id, String feld) {
        if (personen.personen(List.of(id)).isEmpty()) {
            throw EnergiemanagementAbgelehnt.fachlich("person_unbekannt",
                    "Bitte wählen Sie eine Person im Energiemanagement Ihres Kundenbereichs.", Map.of("feld", feld));
        }
    }

    private static void offen(FeststellungRepository.Feststellung f) {
        if (!"offen".equals(f.zustand())) {
            throw abgeschlossen(f, "Diese Feststellung ist abgeschlossen; ein Stand wird nie zurückgenommen.");
        }
    }

    private static EnergiemanagementAbgelehnt abgeschlossen(FeststellungRepository.Feststellung f, String satz) {
        return EnergiemanagementAbgelehnt.konflikt("feststellung_abgeschlossen", satz,
                Map.of("kennzeichen", f.kennzeichen()));
    }

    private static void fristPruefen(LocalDate frist, LocalDate festgestelltAm) {
        if (frist.isBefore(festgestelltAm)) {
            throw EnergiemanagementAbgelehnt.fachlich("frist_ungueltig",
                    "Die Frist liegt nicht vor dem Tag der Feststellung.",
                    Map.of("feld", "frist", "festgestellt_am", festgestelltAm.toString()));
        }
    }

    private void nichtInZukunft(LocalDate tag, String feld) {
        LocalDate heute = heute();
        if (tag.isAfter(heute)) {
            throw EnergiemanagementAbgelehnt.fachlich("tag_in_zukunft", "Bitte wählen Sie einen Tag bis heute.",
                    Map.of("feld", feld, "heute", heute.toString()));
        }
    }

    private static void nichtVorFeststellung(LocalDate tag, FeststellungRepository.Feststellung f, String feld) {
        if (tag.isBefore(f.festgestelltAm())) {
            throw EnergiemanagementAbgelehnt.fachlich("tag_vor_feststellung",
                    "Bitte wählen Sie einen Tag ab der Feststellung.",
                    Map.of("feld", feld, "festgestellt_am", f.festgestelltAm().toString()));
        }
    }

    // ------------------------------------------------------------------ Darstellung

    private FeststellungDto.Feststellung feststellung(FeststellungRepository.Feststellung f,
            Map<UUID, EnergiemanagementPersonenDto.PersonKurz> leute, LocalDate abruf, int fristTage,
            List<String> massnahmen) {
        Map<String, Object> lage = EnergiemanagementRegeln.ueberpruefung(new EnergiemanagementRegeln.UeberpruefungEingang(
                "feststellung", null, null, null, null, null, f.festgestelltAm().toString(), f.frist().toString(),
                fristTage, f.zustand(), abruf.toString()));
        var frist = new FeststellungDto.Frist(abruf, tagOderNull(lage.get("faellig_am")), (Integer) lage.get("tage"),
                (String) lage.get("satz"), (String) lage.get("grund"));
        return new FeststellungDto.Feststellung(f.id(), f.kennzeichen(),
                new FeststellungDto.QuelleAus(f.quelleArt(), f.auditId(),
                        f.auditId() != null ? f.auditKennzeichen() : f.quelleKennung(), f.quelleWortlaut()),
                f.wortlaut(), new FeststellungDto.VorgabeAus(f.vorgabeDokumentId(), f.vorgabeDokument(),
                        f.vorgabeFassung(), f.vorgabeWortlaut()),
                new FeststellungDto.BezugAus(f.standortId(), f.bezugAufgabe(), f.bezugDokumentId(), f.bezugDokument(),
                        f.bezugObjekte()),
                leute.get(f.festgestelltVon()), f.festgestelltAm(),
                new EnergiemanagementVerantwortungDto.Person(f.verantwortlichSub(), f.verantwortlichName()), f.frist(),
                f.zustand(), frist, f.ergebnis(), f.eintraege(), massnahmen,
                new EnergiemanagementPersonenDto.Eingetragen(f.akteur(), f.angelegtAm()));
    }

    private FeststellungDto.Stand stand(FeststellungRepository.Stand s,
            Map<UUID, EnergiemanagementPersonenDto.PersonKurz> leute) {
        return new FeststellungDto.Stand(s.nr(), s.ergebnis(), s.begruendung(), s.am(), leute.get(s.entschiedenVon()),
                baum(s.kopie()), s.pruefsumme(), s.vieraugen(), s.status(),
                new EnergiemanagementPersonenDto.Eingetragen(s.freigabe(), s.freigabeAm()),
                s.entscheidung() == null ? null
                        : new EnergiemanagementPersonenDto.Eingetragen(s.entscheidung(), s.entschiedenAm()),
                s.ablehnung());
    }

    private Map<UUID, EnergiemanagementPersonenDto.PersonKurz> leute(List<UUID> ids) {
        return personen.personen(ids.stream().filter(Objects::nonNull).toList()).stream().collect(Collectors.toMap(
                InternesAuditRepository.Person::id, p -> new EnergiemanagementPersonenDto.PersonKurz(p.id(), p.name(),
                        p.funktion(), p.kuerzel(), p.kontoSub() != null), (x, y) -> x, LinkedHashMap::new));
    }

    private static List<String> kennzeichen(List<FeststellungRepository.Massnahme> massnahmen) {
        return massnahmen.stream().map(FeststellungRepository.Massnahme::kennzeichen).toList();
    }

    private int fristTage() {
        return repo.fristTage().orElse(EnergiemanagementRegeln.STARTWERTE.feststellung_frist_tage());
    }

    private static String freigabeRolle(ProtokollAkteur wer) {
        return FREIGABE_ROLLEN.contains(wer.rolle()) ? wer.rolle() : null;
    }

    private LocalDate heute() {
        ZoneId zone = ZoneId.of(unternehmen.desKundenbereichs().map(UnternehmenRepository.Unternehmen::zeitzone)
                .orElse("Europe/Berlin"));
        return LocalDate.ofInstant(uhr.instant(), zone);
    }

    private static LocalDate tagOderNull(Object tag) {
        return tag == null ? null : LocalDate.parse(tag.toString());
    }

    private JsonNode baum(String s) {
        try {
            return s == null ? null : json.readTree(s);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Ungültiger Schnappschuss", e);
        }
    }

    private static String begruendung(String text) {
        String b = text == null ? "" : text.strip();
        if (b.length() < BEGRUENDUNG_MIN || b.length() > BEGRUENDUNG_MAX) {
            throw EnergiemanagementAbgelehnt.fachlich("begruendung_fehlt", "Bitte begründen Sie mit " + BEGRUENDUNG_MIN
                    + " bis " + BEGRUENDUNG_MAX + " Zeichen.", Map.of("min", BEGRUENDUNG_MIN, "max", BEGRUENDUNG_MAX));
        }
        return b;
    }

    private static void laenge(String feld, String wert, int max) {
        if (wert.length() > max) {
            throw ungueltig(feld, "Bitte kürzen Sie auf höchstens " + max + " Zeichen.");
        }
    }

    private static EnergiemanagementAbgelehnt fehlt(String feld) {
        return EnergiemanagementAbgelehnt.fachlich("angabe_fehlt", "Bitte füllen Sie dieses Feld aus.",
                Map.of("feld", feld));
    }

    private static EnergiemanagementAbgelehnt ungueltig(String feld, String satz) {
        return EnergiemanagementAbgelehnt.fachlich("angabe_ungueltig", satz, Map.of("feld", feld));
    }

    private static EnergiemanagementAbgelehnt standortUnbekannt() {
        return EnergiemanagementAbgelehnt.fachlich("standort_unbekannt",
                "Bitte wählen Sie einen Standort Ihres Kundenbereichs.", Map.of("feld", "bezug.standort_id"));
    }

    static EnergiemanagementAbgelehnt feststellungFehlt() {
        return new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Diese Feststellung gibt es nicht.", null);
    }

    private static String text(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
