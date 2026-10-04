package com.voltpilot.api.mispel;

import com.voltpilot.api.mispel.LadepunktRegeln.Befund;
import com.voltpilot.api.mispel.LadepunktRegeln.Faehigkeit;
import com.voltpilot.api.mispel.LadepunktRegeln.Fahrzeugfenster;
import com.voltpilot.api.mispel.LadepunktRegeln.Z2;
import com.voltpilot.api.mispel.LadepunktRepository.Fassung;
import com.voltpilot.api.mispel.LadepunktRepository.FensterStand;
import com.voltpilot.api.mispel.LadepunktRepository.Komponente;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleQuelleRepository;
import com.voltpilot.api.uems.MessstelleRepository;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleService;
import com.voltpilot.api.uems.UnternehmenRepository;
import com.voltpilot.api.uems.ZaehlerrolleRegeln;
import com.voltpilot.api.uems.ZaehlerrolleRegeln.Knoten;
import com.voltpilot.api.uems.ZaehlerrolleService;
import java.time.Clock;
import java.time.Instant;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Der bidirektionale Ladepunkt (MiSpeL MP-31, Vertrag {@code docs/contracts/v2/mispel-ladepunkt-bidirektional.md}):
 * die Fähigkeit V2H/V2G als Fassungen ab einem Tag, der Zähler Z2 am Ladepunkt aus den Zählerrollen (MP-6) mit
 * Eichstatus und Urteil, die Einordnung nach Anlage 1 mit Befunden, und das Fahrzeugfenster für den Optimierer.
 *
 * <p>Z2 wird nie gespeichert, sondern gelesen: ein Ladepunkt liegt hinter einer Messstelle mit Rolle Z2, wenn er
 * an dem Tag die Komponente ihrer führenden Quelle ist oder die einer Messstelle, die — auch mittelbar —
 * „Unterzähler von“ ihr ist (dieselbe Lesart wie {@link ZaehlerrolleRegeln#befunde}).
 *
 * <p>Keine Steuerung (MP-33), keine Oberfläche (MP-41 nach BK-41).
 */
@Service
public class LadepunktService {

    private final LadepunktRepository ladepunkte;
    private final ZaehlerrolleService zaehlerrollen;
    private final MessstelleRepository messstellen;
    private final MessstelleQuelleRepository quellen;
    private final FoerderwegService foerderwege;
    private final UnternehmenRepository unternehmen;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public LadepunktService(LadepunktRepository ladepunkte, ZaehlerrolleService zaehlerrollen,
            MessstelleRepository messstellen, MessstelleQuelleRepository quellen, FoerderwegService foerderwege,
            UnternehmenRepository unternehmen, TransactionTemplate transaktion) {
        this.ladepunkte = ladepunkte;
        this.zaehlerrollen = zaehlerrollen;
        this.messstellen = messstellen;
        this.quellen = quellen;
        this.foerderwege = foerderwege;
        this.unternehmen = unternehmen;
        this.transaktion = transaktion;
    }

    /** Nur für Tests. */
    public void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    public record Aendern(String nutzbarkeit, Boolean v2h, Boolean v2g, Boolean rueckspeisungBeiEinspeisungUnterbunden,
            java.math.BigDecimal rueckspeiseleistungKw, LocalDate gueltigAb) {}

    /** Eine Fassung mit ihrem abgeleiteten letzten Tag ({@code null} = offen oder aufgehoben). */
    public record FassungAnsicht(Fassung fassung, LocalDate gueltigBis) {}

    /**
     * Der Ladepunkt am Tag. {@code fassung} {@code null} = keine Fassung bis zu dem Tag: der Bestand gilt als
     * unidirektional ({@link Faehigkeit#BESTAND}).
     */
    public record Ansicht(UUID anlage, Komponente komponente, LocalDate am, Fassung fassung, Faehigkeit faehigkeit,
            LocalDate gueltigBis, String einordnung, List<Z2> z2, List<Befund> befunde, FensterStand fahrzeugfenster,
            List<FassungAnsicht> fassungen, LadepunktRepository.SignierterMesswert signierterMesswert,
            FahrerAnsicht fahrer) {}

    /**
     * Die Einstellungen des Fahrers (MP-41a) am Tag: {@code erfasst} {@code false} = nie gesetzt (Zurückspeisen aus);
     * {@code rueckspeisenWirksam} = der Wunsch, nie über der Fähigkeit am Tag; {@code naechsteFahrt} nur, solange sie
     * bevorsteht (Ortszeit); {@code kmJeProzent} aus der Kapazität (≈ {@value #KM_JE_KWH} km je kWh), {@code null}
     * ohne Kapazität.
     */
    public record FahrerAnsicht(boolean erfasst, String rueckspeisen, String rueckspeisenWirksam, BigDecimal reservePct,
            BigDecimal vollzyklenJeTag, List<LadepunktRegeln.Abfahrt> abfahrten, LadepunktRegeln.NaechsteFahrt naechsteFahrt,
            BigDecimal kmJeProzent, Instant geaendertAm, String geaendertVon) {}

    /** Reichweite je kWh wie das Ladeziel im Portal („Etwa {kWh × 6} km“); eine Schätzung, kein Messwert. */
    public static final int KM_JE_KWH = 6;

    // ------------------------------------------------------------------ lesen

    public LocalDate heute() {
        return LocalDate.now(uhr.withZone(zone()));
    }

    /** Ein Ladepunkt der Anlage am Tag {@code am} (fehlend = heute). */
    public Ansicht ansicht(UUID siteId, UUID komponenteId, LocalDate am) {
        Komponente k = finde(siteId, komponenteId);
        LocalDate tag = am != null ? am : heute();
        return ansichten(siteId, List.of(k), ladepunkte.fassungen(k.id()), tag).get(0);
    }

    /** Alle Ladepunkte der Anlage am Tag — die Eingabe für Rechenwerk (MP-32) und Optimierer (MP-33). */
    public List<Ansicht> anlage(UUID siteId, LocalDate am) {
        if (!ladepunkte.anlageSichtbar(siteId)) {
            throw new LadepunktAbgelehnt("anlage_unbekannt", 404, "Anlage nicht gefunden.", Map.of());
        }
        List<Komponente> alle = ladepunkte.derAnlage(siteId);
        if (alle.isEmpty()) {
            return List.of();
        }
        return ansichten(siteId, alle, ladepunkte.fassungenDerAnlage(siteId), am != null ? am : heute());
    }

    // ------------------------------------------------------------------ setzen

    /** Eine neue Fassung der Fähigkeit ab {@code gueltig_ab}; dieselbe Tag-Fassung wird aufgehoben, nie überschrieben. */
    public void faehigkeitSetzen(UUID siteId, UUID komponenteId, Aendern a, String von) {
        Komponente k = finde(siteId, komponenteId);
        if (a == null) {
            throw LadepunktAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        if (a.gueltigAb() == null) {
            throw LadepunktAbgelehnt.anfrage("gueltig_ab", "„gültig ab“ fehlt (ein Tag, JJJJ-MM-TT).");
        }
        Faehigkeit neu = new Faehigkeit(a.nutzbarkeit(), Boolean.TRUE.equals(a.v2h()), Boolean.TRUE.equals(a.v2g()),
                Boolean.TRUE.equals(a.rueckspeisungBeiEinspeisungUnterbunden()), a.rueckspeiseleistungKw());
        LadepunktRegeln.Ablehnung form = LadepunktRegeln.formPruefen(neu);
        if (form != null) {
            throw LadepunktAbgelehnt.aus(form);
        }
        LocalDate ab = a.gueltigAb();
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        transaktion.executeWithoutResult(tx -> {
            List<Fassung> wirksam = wirksam(ladepunkte.fassungen(k.id()));
            Fassung gleicherTag = wirksam.stream().filter(f -> f.gueltigAb().equals(ab)).findFirst().orElse(null);
            List<Fassung> ohne = wirksam.stream().filter(f -> f != gleicherTag).toList();
            Fassung vorher = gleicherTag != null ? gleicherTag : amTag(ohne, ab);
            Faehigkeit alt = vorher == null ? Faehigkeit.BESTAND : vorher.faehigkeit();
            if ((vorher != null || gleicherTag != null) && LadepunktRegeln.gleich(alt, neu)) {
                throw new LadepunktAbgelehnt("faehigkeit_unveraendert", 409, "Ab " + ab + " gilt für diesen "
                        + "Ladepunkt bereits genau diese Fähigkeit.", Map.of("am", ab.toString()));
            }
            if (gleicherTag != null) {
                ladepunkte.aufheben(gleicherTag.id(), jetzt);
            }
            ladepunkte.eintragen(tenant, siteId, k.id(), neu, ab, von);
        });
    }

    /** Ersetzt das Fahrzeugfenster ganz; nur an einem Ladepunkt, der heute oder später bidirektional nutzbar ist. */
    public void fahrzeugfensterSetzen(UUID siteId, UUID komponenteId, Fahrzeugfenster f, String von) {
        Komponente k = finde(siteId, komponenteId);
        LadepunktRegeln.Ablehnung form = LadepunktRegeln.formPruefen(f);
        if (form != null) {
            throw LadepunktAbgelehnt.aus(form);
        }
        LocalDate heute = heute();
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        transaktion.executeWithoutResult(tx -> {
            List<Fassung> wirksam = wirksam(ladepunkte.fassungen(k.id()));
            Fassung jetztGueltig = amTag(wirksam, heute);
            boolean bidirektional = (jetztGueltig != null && jetztGueltig.faehigkeit().bidirektional())
                    || wirksam.stream().anyMatch(x -> x.gueltigAb().isAfter(heute) && x.faehigkeit().bidirektional());
            if (!bidirektional) {
                throw new LadepunktAbgelehnt("ladepunkt_nicht_bidirektional", 422, "Dieser Ladepunkt ist weder heute "
                        + "noch später bidirektional nutzbar; ein Fahrzeugfenster plant nur die Rückspeisung.",
                        Map.of("am", heute.toString(), "fundstelle", LadepunktRegeln.A1_S7_S26));
            }
            ladepunkte.fahrzeugfensterErsetzen(tenant, siteId, k.id(), f, jetzt, von);
        });
    }

    /**
     * Ersetzt die Einstellungen des Fahrers ganz (MP-41a): nur an einem Ladepunkt, der heute oder später
     * bidirektional nutzbar ist, und nie über dem, was eine wirksame Fassung ab heute trägt.
     */
    public void fahrerEinstellungenSetzen(UUID siteId, UUID komponenteId, LadepunktRegeln.FahrerEinstellungen f,
            String von) {
        Komponente k = finde(siteId, komponenteId);
        if (f == null) {
            throw LadepunktAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        ZoneId zone = zone();
        Instant jetzt = uhr.instant();
        LadepunktRegeln.Ablehnung form = LadepunktRegeln.formPruefen(f, LocalDateTime.ofInstant(jetzt, zone));
        if (form != null) {
            throw LadepunktAbgelehnt.aus(form);
        }
        LocalDate heute = heute();
        UUID tenant = TenantContext.get();
        transaktion.executeWithoutResult(tx -> {
            List<Fassung> wirksam = wirksam(ladepunkte.fassungen(k.id()));
            Fassung jetztGueltig = amTag(wirksam, heute);
            List<Faehigkeit> abHeute = new ArrayList<>();
            if (jetztGueltig != null) {
                abHeute.add(jetztGueltig.faehigkeit());
            }
            wirksam.stream().filter(x -> x.gueltigAb().isAfter(heute)).forEach(x -> abHeute.add(x.faehigkeit()));
            if (abHeute.stream().noneMatch(Faehigkeit::bidirektional)) {
                throw new LadepunktAbgelehnt("ladepunkt_nicht_bidirektional", 422, "Dieser Ladepunkt ist weder heute "
                        + "noch später bidirektional nutzbar; zurückspeisen kann hier kein Auto.",
                        Map.of("am", heute.toString(), "fundstelle", LadepunktRegeln.A1_S7_S26));
            }
            if (abHeute.stream().noneMatch(x -> LadepunktRegeln.traegt(x, f.rueckspeisen()))) {
                throw new LadepunktAbgelehnt("rueckspeisen_ueber_faehigkeit", 422, "So kann dieser Ladepunkt nicht "
                        + "zurückspeisen; was er kann, trägt der Installateur im Aufbau ein.",
                        Map.of("am", heute.toString(), "rueckspeisen", f.rueckspeisen(),
                                "fundstelle", LadepunktRegeln.A1_S26_FN21));
            }
            List<LadepunktRegeln.Fenster> anwesenheit = ladepunkte.fahrzeugfenster(k.id())
                    .map(s -> s.fenster().anwesenheit()).orElse(List.of());
            for (LadepunktRegeln.Fenster w : anwesenheit) {
                if (w.abfahrtSocPct() != null && f.reservePct() != null
                        && w.abfahrtSocPct().compareTo(f.reservePct()) < 0) {
                    throw new LadepunktAbgelehnt("fahrer_einstellungen_ungueltig", 400, "Die Reserve liegt über dem "
                            + "Ladestand bei Abfahrt eines Anwesenheitsfensters.", Map.of("grund", "reserve"));
                }
            }
            Instant naechste = f.naechsteFahrt() == null ? null : f.naechsteFahrt().abfahrt().atZone(zone).toInstant();
            ladepunkte.fahrerEinstellungenErsetzen(tenant, siteId, k.id(), f, naechste, jetzt, von);
        });
    }

    private FahrerAnsicht fahrer(UUID komponenteId, Faehigkeit faehigkeit) {
        Optional<FensterStand> fenster = ladepunkte.fahrzeugfenster(komponenteId);
        BigDecimal reserve = fenster.map(s -> s.fenster().mindestSocPct()).orElse(null);
        BigDecimal kapazitaet = fenster.map(s -> s.fenster().kapazitaetKwh()).orElse(null);
        BigDecimal kmJeProzent = kapazitaet == null ? null : kapazitaet.multiply(BigDecimal.valueOf(KM_JE_KWH))
                .divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_UP);
        Optional<LadepunktRepository.FahrerStand> stand = ladepunkte.fahrerEinstellungen(komponenteId);
        if (stand.isEmpty()) {
            return new FahrerAnsicht(false, LadepunktRegeln.RUECKSPEISEN_AUS, LadepunktRegeln.RUECKSPEISEN_AUS, reserve,
                    null, List.of(), null, kmJeProzent, null, null);
        }
        LadepunktRepository.FahrerStand s = stand.get();
        LadepunktRegeln.NaechsteFahrt naechste = s.naechsteFahrt() == null || !s.naechsteFahrt().isAfter(uhr.instant())
                ? null : new LadepunktRegeln.NaechsteFahrt(LocalDateTime.ofInstant(s.naechsteFahrt(), zone()),
                        s.naechsteFahrtSocPct());
        return new FahrerAnsicht(true, s.rueckspeisen(), LadepunktRegeln.rueckspeisenWirksam(s.rueckspeisen(),
                faehigkeit), reserve, s.vollzyklenJeTag(), s.abfahrten(), naechste, kmJeProzent, s.geaendertAm(),
                s.geaendertVon());
    }

    // ---------------------------------------------------------------- Bausteine

    private Komponente finde(UUID siteId, UUID komponenteId) {
        return ladepunkte.finde(siteId, komponenteId).orElseThrow(() -> new LadepunktAbgelehnt("ladepunkt_unbekannt",
                404, "Diese Anlage hat keinen solchen Ladepunkt.", Map.of()));
    }

    private List<Ansicht> ansichten(UUID siteId, List<Komponente> komponenten, List<Fassung> alleFassungen,
            LocalDate tag) {
        Map<UUID, List<Fassung>> jeKomponente = new HashMap<>();
        for (Fassung f : alleFassungen) {
            jeKomponente.computeIfAbsent(f.komponenteId(), x -> new ArrayList<>()).add(f);
        }
        Map<UUID, List<Z2>> z2 = z2(siteId, tag);
        FoerderwegService.Ansicht weg = foerderwege.ansicht(siteId, tag);
        FoerderwegRegeln.Foerderweg foerderweg = weg == null || weg.angaben() == null ? null : weg.angaben().foerderweg();
        List<Ansicht> out = new ArrayList<>();
        for (Komponente k : komponenten) {
            List<Fassung> alle = jeKomponente.getOrDefault(k.id(), List.of());
            List<Fassung> wirksam = wirksam(alle);
            Fassung f = amTag(wirksam, tag);
            Faehigkeit faehigkeit = f == null ? Faehigkeit.BESTAND : f.faehigkeit();
            List<Z2> zaehler = z2.getOrDefault(k.id(), List.of());
            List<FassungAnsicht> historie = new ArrayList<>();
            for (Fassung x : alle) {
                historie.add(new FassungAnsicht(x, x.aufgehoben() ? null : bis(wirksam, x)));
            }
            out.add(new Ansicht(siteId, k, tag, f, faehigkeit, f == null ? null : bis(wirksam, f),
                    LadepunktRegeln.einordnung(faehigkeit), zaehler,
                    LadepunktRegeln.befunde(faehigkeit, zaehler, foerderweg),
                    ladepunkte.fahrzeugfenster(k.id()).orElse(null), List.copyOf(historie),
                    ladepunkte.signierterMesswert(siteId, k.id(), tag.plusDays(1).atStartOfDay(zone()).toInstant())
                            .orElse(null), fahrer(k.id(), faehigkeit)));
        }
        return out;
    }

    /** Je Ladepunkt-Komponente die Zähler Z2 der Anlage am Tag, hinter denen sie liegt (Z2V vor Z2E). */
    private Map<UUID, List<Z2>> z2(UUID siteId, LocalDate tag) {
        ZaehlerrolleService.AnlageStand stand = zaehlerrollen.anlage(siteId, tag);
        Map<UUID, Set<UUID>> direkt = fuehrendeKomponenten(tag);
        Map<UUID, List<Knoten>> kinder = new HashMap<>();
        for (Knoten k : stand.knoten()) {
            if (k.unterzaehlerVon() != null) {
                kinder.computeIfAbsent(k.unterzaehlerVon(), x -> new ArrayList<>()).add(k);
            }
        }
        Map<UUID, List<Z2>> out = new HashMap<>();
        for (Knoten k : stand.knoten()) {
            String rolle = k.angaben() == null ? null : k.angaben().rolle();
            String groesse = ZaehlerrolleRegeln.festlegungsgroesse(rolle, k.richtung());
            if (!ZaehlerrolleRegeln.Z2.equals(rolle) || groesse == null) {
                continue;
            }
            Set<UUID> abgedeckt = new HashSet<>(direkt.getOrDefault(k.id(), Set.of()));
            Deque<Knoten> offen = new ArrayDeque<>(kinder.getOrDefault(k.id(), List.of()));
            Set<UUID> gesehen = new HashSet<>();
            while (!offen.isEmpty()) {
                Knoten d = offen.pop();
                if (gesehen.add(d.id())) {
                    abgedeckt.addAll(direkt.getOrDefault(d.id(), Set.of()));
                    offen.addAll(kinder.getOrDefault(d.id(), List.of()));
                }
            }
            String urteil = ZaehlerrolleRegeln.urteil(rolle,
                    ZaehlerrolleRegeln.befundeZu(k.kennzeichen(), stand.befunde()));
            for (UUID komponente : abgedeckt) {
                out.computeIfAbsent(komponente, x -> new ArrayList<>())
                        .add(new Z2(groesse, k.kennzeichen(), k.angaben(), urteil));
            }
        }
        out.values().forEach(l -> l.sort(Comparator.comparing(Z2::groesse).reversed()));
        return out;
    }

    /** Je Messstelle die Komponenten ihrer führenden Quelle der Hauptgröße am Tag (die Lesart von MP-6). */
    private Map<UUID, Set<UUID>> fuehrendeKomponenten(LocalDate tag) {
        Map<UUID, Messstelle> jeId = messstellen.alle().stream()
                .collect(Collectors.toMap(Messstelle::id, Function.identity(), (x, y) -> x, LinkedHashMap::new));
        ZoneId zone = zone();
        Instant von = tag.atStartOfDay(zone).toInstant();
        Instant bis = tag.plusDays(1).atStartOfDay(zone).toInstant();
        Map<UUID, Set<UUID>> out = new HashMap<>();
        for (MessstelleQuelleRepository.Quelle q : quellen.alle()) {
            Messstelle m = jeId.get(q.messstelleId());
            if (m == null || q.entityId() == null || !"fuehrend".equals(q.rolle())
                    || !m.hauptgroesse().groesse().equals(q.groesse())
                    || !m.hauptgroesse().richtung().equals(q.richtung())) {
                continue;
            }
            if (!q.gueltigAb().isBefore(bis) || (q.gueltigBis() != null && !q.gueltigBis().isAfter(von))) {
                continue;
            }
            out.computeIfAbsent(m.id(), x -> new HashSet<>()).add(q.entityId());
        }
        return out;
    }

    private ZoneId zone() {
        return unternehmen.desKundenbereichs().map(u -> ZoneId.of(u.zeitzone())).orElse(MessstelleService.ZEITZONE);
    }

    private static List<Fassung> wirksam(List<Fassung> alle) {
        return alle.stream().filter(f -> !f.aufgehoben()).toList();
    }

    private static Fassung amTag(List<Fassung> wirksam, LocalDate tag) {
        return wirksam.stream().filter(f -> !f.gueltigAb().isAfter(tag)).max(Comparator.comparing(Fassung::gueltigAb))
                .orElse(null);
    }

    private static LocalDate bis(List<Fassung> wirksam, Fassung f) {
        return wirksam.stream().map(Fassung::gueltigAb).filter(d -> d.isAfter(f.gueltigAb()))
                .min(Comparator.naturalOrder()).map(d -> d.minusDays(1)).orElse(null);
    }
}
