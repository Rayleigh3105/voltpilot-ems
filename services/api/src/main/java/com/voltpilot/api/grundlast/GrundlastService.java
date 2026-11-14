package com.voltpilot.api.grundlast;

import com.voltpilot.api.grundlast.GrundlastDto.MonatDto;
import com.voltpilot.api.grundlast.GrundlastDto.NachtDto;
import com.voltpilot.api.grundlast.GrundlastDto.RestDto;
import com.voltpilot.api.grundlast.GrundlastDto.StufeDto;
import com.voltpilot.api.grundlast.GrundlastDto.TeilDto;
import com.voltpilot.api.grundlast.GrundlastRegel.Nacht;
import com.voltpilot.api.grundlast.GrundlastRegel.Status;
import com.voltpilot.api.grundlast.GrundlastRegel.TeilEingabe;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.repo.GrundlastRepository;
import com.voltpilot.api.repo.GrundlastRepository.Verbrauch;
import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.topology.TopologyDeriver;
import com.voltpilot.api.topology.TopologyService;
import com.voltpilot.api.topology.TopologyService.EntityTopologyDto;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Liest die Viertelstunden einer Anlage und wendet {@link GrundlastRegel} an. Der Lesepfad ist der von
 * {@code /history}: unmigriert rein v1, sonst am {@code v2_history_cutover_at} gespleißt (v1 für
 * Viertelstunden davor, v2 ab dort).
 */
@Service
public class GrundlastService {

    /** Die Kachel wertet die letzten so vielen Nächte. */
    static final int KACHEL_NAECHTE = 14;

    /** Die Zeiträume der Route. */
    public enum Zeitraum {
        TAG, WOCHE, MONAT, JAHR, AKTUELL;

        /** Groß-/Kleinschreibung egal; {@code null} für ein unbekanntes Wort. */
        public static Zeitraum parse(String raw) {
            if (raw == null) {
                return null;
            }
            try {
                return valueOf(raw.trim().toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
    }

    private final GrundlastRepository repo;
    private final HistoryRepository history;
    private final TopologyService topology;
    private final Clock clock;

    @Autowired
    public GrundlastService(GrundlastRepository repo, HistoryRepository history, TopologyService topology) {
        this(repo, history, topology, Clock.systemUTC());
    }

    GrundlastService(GrundlastRepository repo, HistoryRepository history, TopologyService topology, Clock clock) {
        this.repo = repo;
        this.history = history;
        this.topology = topology;
        this.clock = clock;
    }

    /** Die Nächte {@code [von, bis)} eines Zeitraums als Daten. */
    record Fenster(LocalDate von, LocalDate bis) {
        Fenster vor(Zeitraum z) {
            return switch (z) {
                case TAG -> new Fenster(von.minusDays(1), bis.minusDays(1));
                case WOCHE -> new Fenster(von.minusWeeks(1), bis.minusWeeks(1));
                case MONAT -> new Fenster(von.minusMonths(1), bis.minusMonths(1));
                case JAHR -> new Fenster(von.minusYears(1), bis.minusYears(1));
                case AKTUELL -> new Fenster(von.minusMonths(1), bis.minusMonths(1));
            };
        }
    }

    /** Das Fenster eines Zeitraums. {@code aktuell} endet mit der letzten vergangenen und nachgerechneten Nacht. */
    static Fenster fenster(Zeitraum z, LocalDate at, Instant jetzt) {
        return switch (z) {
            case TAG -> new Fenster(at, at.plusDays(1));
            case WOCHE -> kalender(HistoryRange.WEEK, at);
            case MONAT -> kalender(HistoryRange.MONTH, at);
            case JAHR -> kalender(HistoryRange.YEAR, at);
            case AKTUELL -> {
                LocalDate heute = LocalDate.ofInstant(jetzt, GrundlastRegel.ZONE);
                boolean heuteFertig = !jetzt.isBefore(GrundlastRegel.nachtEnde(heute).plus(GrundlastRegel.NACHZUG));
                LocalDate letzte = heuteFertig ? heute : heute.minusDays(1);
                yield new Fenster(letzte.minusDays(KACHEL_NAECHTE - 1L), letzte.plusDays(1));
            }
        };
    }

    private static Fenster kalender(HistoryRange range, LocalDate at) {
        HistoryRange.Window w = range.window(at);
        return new Fenster(LocalDate.ofInstant(w.from(), GrundlastRegel.ZONE),
                LocalDate.ofInstant(w.to(), GrundlastRegel.ZONE));
    }

    public GrundlastDto grundlast(UUID siteId, Zeitraum z, LocalDate at) {
        Instant jetzt = clock.instant();
        Fenster f = fenster(z, at, jetzt);
        Fenster vor = f.vor(z);
        int mindestens = z == Zeitraum.TAG ? 1 : GrundlastRegel.MIN_NAECHTE;
        Instant cutover = history.v2HistoryCutover(siteId);
        Instant ersteMessung = repo.ersteMessung(siteId);

        // Eine Abfrage für beide Fenster (das davor liegt immer vorne; bei aktuell mit Lücke dazwischen).
        Instant von = GrundlastRegel.nachtBeginn(vor.von());
        Instant bis = GrundlastRegel.nachtBeginn(f.bis());
        NavigableMap<Instant, Double> viertel = nachtViertelstunden(siteId, von, bis, cutover);

        List<Nacht> naechte = GrundlastRegel.naechte(f.von(), f.bis(), viertel, ersteMessung, jetzt);
        List<Nacht> vorNaechte = GrundlastRegel.naechte(vor.von(), vor.bis(), viertel, ersteMessung, jetzt);
        Double typisch = GrundlastRegel.typisch(naechte, mindestens);
        Double vorperiode = GrundlastRegel.typisch(vorNaechte, mindestens);

        Instant fensterVon = GrundlastRegel.nachtBeginn(f.von());
        Instant fensterBis = min(GrundlastRegel.nachtBeginn(f.bis()), jetzt);
        Verbrauch verbrauch = verbrauch(siteId, fensterVon, fensterBis, cutover);

        List<GrundlastRegel.Teil> teile = typisch == null ? List.of() : teile(siteId, naechte, fensterVon, fensterBis);
        GrundlastRegel.Rest rest = GrundlastRegel.rest(typisch, teile);
        GrundlastRegel.Stufe stufe = z == Zeitraum.MONAT ? GrundlastRegel.stufe(naechte) : null;

        return new GrundlastDto(
                z.name().toLowerCase(Locale.ROOT),
                f.von(),
                f.bis().minusDays(1),
                ersteMessung != null,
                watt(typisch),
                GrundlastRegel.gewertet(naechte).size(),
                mindestens,
                (int) naechte.stream().filter(n -> n.status() == Status.LUECKE).count(),
                z == Zeitraum.JAHR ? List.of() : naechte.stream().map(GrundlastService::nachtDto).toList(),
                z == Zeitraum.JAHR ? GrundlastRegel.monate(naechte).stream()
                        .map(m -> new MonatDto(m.monat().toString(), watt(m.w()), m.gewertet())).toList() : List.of(),
                runde(GrundlastRegel.kwhAmTag(typisch), 2),
                runde(GrundlastRegel.anteil(typisch, verbrauch.viertelstunden(), verbrauch.kwh()), 3),
                watt(vorperiode),
                stufe == null ? null : new StufeDto(stufe.seit(), watt(stufe.vorherW()), watt(stufe.nachherW())),
                teile.stream().map(t -> new TeilDto(t.entityId(), t.label(), t.typLabel(), t.unterzaehler(), watt(t.w())))
                        .toList(),
                rest == null ? null : new RestDto(watt(rest.w()),
                        rest.grund() == null ? null : rest.grund().name().toLowerCase(Locale.ROOT)));
    }

    /** Hausverbrauch je Nacht-Viertelstunde, an der Umstellung gespleißt. */
    private NavigableMap<Instant, Double> nachtViertelstunden(UUID siteId, Instant von, Instant bis, Instant cutover) {
        if (cutover == null) {
            return repo.v1NachtViertelstunden(siteId, von, bis);
        }
        NavigableMap<Instant, Double> out = new TreeMap<>(repo.v1NachtViertelstunden(siteId, von, min(bis, cutover)));
        out.putAll(repo.v2NachtViertelstunden(siteId, max(von, cutover), bis));
        return out;
    }

    private Verbrauch verbrauch(UUID siteId, Instant von, Instant bis, Instant cutover) {
        if (cutover == null) {
            return repo.v1Verbrauch(siteId, von, bis);
        }
        return repo.v1Verbrauch(siteId, von, min(bis, cutover)).plus(repo.v2Verbrauch(siteId, max(von, cutover), bis));
    }

    /**
     * Die Teile der Aufteilung: dieselben Mitglieder wie „Verbrauch nach Bereichen“ ({@code BereicheKarte.tsx}
     * {@code bereicheTeile}: Verbraucher- und Ladeknoten ohne das Haus selbst), davon nur die an der Wurzel –
     * ein Teil hinter einer Unterverteilung steckt schon in deren Wert. Erst ab einem Unterzähler, wie die Karte.
     */
    private List<GrundlastRegel.Teil> teile(UUID siteId, List<Nacht> naechte, Instant von, Instant bis) {
        TopologyService.TopologyResponse t = topology.topology(siteId);
        Map<String, EntityTopologyDto> byId = new HashMap<>();
        for (EntityTopologyDto e : t.entities()) {
            byId.put(e.id().toString(), e);
        }
        List<TeilEingabe> roh = new ArrayList<>();
        Set<String> gesehen = new HashSet<>();
        boolean mitUnterzaehler = false;
        for (TopologyDeriver.FlowNode n : t.topology().nodes()) {
            if (!"consumer".equals(n.role()) && !"charging".equals(n.role())) {
                continue;
            }
            for (TopologyDeriver.FlowMember m : n.members()) {
                EntityTopologyDto e = byId.get(m.entityId());
                if (e == null || "house-load".equals(e.entityType()) || m.haengtAn() != null
                        || !gesehen.add(m.entityId())) {
                    continue;
                }
                boolean unterzaehler = "sub-meter".equals(e.entityType());
                mitUnterzaehler |= unterzaehler;
                roh.add(new TeilEingabe(m.entityId(), m.label(), e.typeLabel(), unterzaehler, Map.of()));
            }
        }
        if (!mitUnterzaehler) {
            return List.of();
        }
        Map<String, Map<Instant, Double>> leistung =
                repo.teilLeistung(siteId, roh.stream().map(TeilEingabe::entityId).toList(), von, bis);
        List<TeilEingabe> eingaben = roh.stream()
                .map(r -> new TeilEingabe(r.entityId(), r.label(), r.typLabel(), r.unterzaehler(),
                        leistung.getOrDefault(r.entityId(), Map.of())))
                .toList();
        return GrundlastRegel.teile(naechte, eingaben);
    }

    private static NachtDto nachtDto(Nacht n) {
        return new NachtDto(n.datum(), n.status().name().toLowerCase(Locale.ROOT), watt(n.w()));
    }

    private static Double watt(Double w) {
        return w == null ? null : (double) Math.round(w);
    }

    private static Double runde(Double v, int stellen) {
        if (v == null) {
            return null;
        }
        double f = Math.pow(10, stellen);
        return Math.round(v * f) / f;
    }

    private static Instant min(Instant a, Instant b) {
        return a.isBefore(b) ? a : b;
    }

    private static Instant max(Instant a, Instant b) {
        return a.isAfter(b) ? a : b;
    }
}
