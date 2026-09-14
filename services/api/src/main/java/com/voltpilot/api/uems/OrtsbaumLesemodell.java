package com.voltpilot.api.uems;

import com.voltpilot.api.uems.OrtsbaumAbleitung.Bestand;
import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtAmStichtag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.StandAm;
import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.Zeilen;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Das ORTSBAUM-LESEMODELL eines Standorts (UEMS AP-02 IP-5):
 * {@code GET /api/v1/standorte/{id}/orte?stichtag=} — die Gebäude mit ihren
 * Bereichen, die Bereiche „direkt am Standort“, je Knoten die Fläche mit ihrer
 * Quelle, so wie sie am Stichtag galten.
 *
 * <p>Ohne Spring, ohne Uhr — dieselbe Ableitung wie {@link StandortLesemodell}
 * (IP-3): die Zeilen werden mit {@link StandortLesemodell#baum} zum Baum des
 * Vertrags, {@link OrtsbaumAbleitung#standAm} entscheidet, wer am Stichtag wo
 * hängt und welche Fläche gilt; hier wird nur einsortiert. Ein Knoten, den es
 * am Stichtag nicht gab, fehlt; einer, der heute archiviert ist, es an dem Tag
 * aber gab, steht normal da und trägt {@code zustand = archiviert} (§4.4) — die
 * Fläche graut ihn aus.
 *
 * <p><b>Messstellen-Zahl</b> (AP-04 IP-7): je Knoten die Messstellen, deren Ort am
 * Stichtag GENAU dieser Knoten ist — am Gebäude nur die am Gebäude selbst, nicht die seiner
 * Bereiche; „direkt am Standort“ die am Standort selbst. 0, wenn keine dort hängt. Ohne
 * Messstellen-Quelle ({@link #ortsbaum(Zeilen, UUID, LocalDate)}, keine
 * {@link OrtsbaumMessstellen}-Bean) bleibt sie {@code null} — nie 0, denn „keine Messstelle“
 * wäre dann eine Behauptung, die niemand geprüft hat.
 */
public final class OrtsbaumLesemodell {

    private static final String VORHANDEN = "vorhanden";

    private OrtsbaumLesemodell() {}

    /**
     * Ein Bereich zum Stichtag. {@code gueltigAb}/{@code gueltigBis} ist die
     * Zuordnung, die an dem Tag gilt ({@code gueltigBis} einschließlich).
     * {@code flaecheQuelle}: {@code eigen} oder {@code null} — ein Bereich erbt
     * nie die Fläche seines Gebäudes.
     */
    public record Bereich(
            UUID id,
            String kurzzeichen,
            String name,
            List<String> nutzung,
            String notiz,
            String zustand,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            Integer flaecheM2,
            String flaecheQuelle,
            Integer messstellenZahl,
            OrtAktionen.Aktionen aktionen) {}

    /**
     * Ein Gebäude zum Stichtag mit den Bereichen, die an dem Tag an ihm hängen. {@code aktionen}
     * (IP-15, an Gebäude UND Bereich): was man heute mit dem Knoten tun kann — nur ohne Stichtag,
     * sonst {@code null} („Stand am …“ ändert nichts).
     */
    public record Gebaeude(
            UUID id,
            String kurzzeichen,
            String name,
            List<String> nutzung,
            Integer baujahr,
            String notiz,
            String zustand,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            Integer flaecheM2,
            String flaecheQuelle,
            Integer messstellenZahl,
            List<Bereich> bereiche,
            OrtAktionen.Aktionen aktionen) {}

    /** Was am Stichtag ohne Gebäude am Standort hängt (AP-00 E3: Gebäude sind optional). */
    public record DirektAmStandort(List<Bereich> bereiche, Integer messstellenZahl) {}

    /**
     * {@code standort} ist dieselbe Zeile wie {@code GET /api/v1/standorte/{id}}.
     * {@code summeGebaeudeM2}: die Summe der Gebäudeflächen am Stichtag — nur,
     * wenn jedes Gebäude eine hat ({@code null} sonst; §4.1: Hinweis neben der
     * eigenen Fläche). {@code gebaeudeOhneFlaeche}: die Gebäude, denen sie fehlt.
     * Gab es den Standort am Stichtag nicht, sind die zeitgültigen Teile leer:
     * keine Gebäude, {@code direktAmStandort} {@code null}. Additiv vorgesehen:
     * {@code teilansicht} (AP-03 IP-10).
     */
    public record OrtsbaumAmStichtag(
            LocalDate stichtag,
            StandortAmStichtag standort,
            Integer summeGebaeudeM2,
            List<UUID> gebaeudeOhneFlaeche,
            List<Gebaeude> gebaeude,
            DirektAmStandort direktAmStandort,
            List<ArchivierterOrt> archiviert,
            OrtAktionen.Aktionen aktionen) {}

    /**
     * Der Grabstein (IP-15, Z3): ein Gebäude oder Bereich dieses Standorts, das am Stichtag
     * archiviert war. Im Baum fehlt es (§4.4) — hier steht es mit dem Tag, an dem es archiviert
     * wurde ({@code archiviertAm} = Tag nach dem Ende seines letzten Intervalls vor dem Stichtag),
     * und dem Knoten, an dem es zuletzt hing. Nichts mit Historie verschwindet aus der Sicht.
     * {@code aktionen}: Wiederherstellen und Löschen — nur ohne Stichtag.
     */
    public record ArchivierterOrt(
            UUID id,
            String art,
            String kurzzeichen,
            String name,
            List<String> nutzung,
            LocalDate archiviertAm,
            UUID elternId,
            String elternArt,
            OrtAktionen.Aktionen aktionen) {}

    /** Der Ortsbaum eines Standorts zum Stichtag — ohne Messstellen-Quelle ({@code messstellenZahl} null). */
    public static Optional<OrtsbaumAmStichtag> ortsbaum(Zeilen z, UUID standortId, LocalDate stichtag) {
        return ortsbaum(z, standortId, stichtag, null);
    }

    /**
     * Der Ortsbaum eines Standorts zum Stichtag — leer, wenn es ihn im Mandanten nicht gibt (404).
     * {@code messstellen}: die Messstellen mit ihren Ort-Intervallen (Eltern = Kurzzeichen bzw.
     * „U“, wie {@link OrtsbaumMessstellen} sie liefert); {@code null} = unbekannt.
     */
    public static Optional<OrtsbaumAmStichtag> ortsbaum(
            Zeilen z, UUID standortId, LocalDate stichtag, List<OrtsbaumAbleitung.Messstelle> messstellen) {
        return ortsbaum(z, standortId, stichtag, messstellen, null);
    }

    /**
     * Wie oben, dazu je Knoten die {@code aktionen} von heute (IP-15); {@code aktionen} {@code null} =
     * keine (mit Stichtag).
     */
    public static Optional<OrtsbaumAmStichtag> ortsbaum(Zeilen z, UUID standortId, LocalDate stichtag,
            List<OrtsbaumAbleitung.Messstelle> messstellen, OrtAktionen aktionen) {
        Map<String, Integer> zahl = messstellenJeOrt(messstellen, stichtag);
        Optional<StandortAmStichtag> standort = StandortLesemodell.standort(z, standortId, stichtag);
        if (standort.isEmpty()) {
            return Optional.empty();
        }
        if (!VORHANDEN.equals(standort.get().bestand())) {
            return Optional.of(new OrtsbaumAmStichtag(stichtag, standort.get(), null, List.of(),
                    List.of(), null, List.of(), null));
        }
        StandAm stand = OrtsbaumAbleitung.standAm(StandortLesemodell.baum(z, stichtag), stichtag);
        Map<String, OrtAmStichtag> amTag = new HashMap<>();
        stand.orte().forEach(o -> amTag.put(o.kennzeichen(), o));
        String st = standortId.toString();

        List<Gebaeude> gebaeude = new ArrayList<>();
        List<Bereich> direkt = new ArrayList<>();
        for (OrtRepository.Ort o : z.orte()) {
            OrtAmStichtag a = amTag.get(o.id().toString());
            if (a == null || !st.equals(a.standort())) {
                continue;
            }
            if ("gebaeude".equals(o.art())) {
                OrtZuordnungRepository.Zuordnung iv = intervallAm(z, o.id(), stichtag);
                gebaeude.add(new Gebaeude(o.id(), o.kurzzeichen(), o.name(), o.nutzung(), o.baujahr(),
                        o.notiz(), o.zustand(), iv.gueltigAb(), iv.gueltigBis(), a.flaecheM2(),
                        quelle(a), zahl(zahl, o.kurzzeichen()),
                        bereicheUnter(z, amTag, o.id().toString(), stichtag, zahl, aktionen),
                        aktionen == null ? null : aktionen.imBaum(o)));
            } else if (st.equals(a.eltern())) {
                direkt.add(bereich(z, o, a, stichtag, zahl, aktionen));
            }
        }
        OrtAmStichtag s = amTag.get(st);
        List<UUID> ohne = s.gebaeudeOhneFlaeche() == null ? List.of()
                : s.gebaeudeOhneFlaeche().stream().map(UUID::fromString).toList();
        return Optional.of(new OrtsbaumAmStichtag(stichtag, standort.get(), s.summeGebaeudeM2(), ohne,
                List.copyOf(gebaeude),
                new DirektAmStandort(List.copyOf(direkt), zahl(zahl, standort.get().kurzzeichen())),
                archiviert(z, stand, amTag, standortId, ZoneId.of(standort.get().zeitzone()), stichtag, aktionen),
                aktionen == null ? null : aktionen.standort(standort.get().kurzzeichen())));
    }

    /**
     * Die Grabsteine dieses Standorts am Stichtag (Z3). Archiviert heißt: der Vertrag nennt den Ort
     * am Stichtag {@code archiviert} ({@link OrtsbaumAbleitung#standAm}) — oder er wurde am Tag
     * seines Anlegens archiviert, dann ist sein einziges Intervall aufgehoben (es belegte keinen Tag)
     * und der Tag kommt aus {@code archiviert_am}. Zu welchem Standort er gehört, sagt sein letztes
     * Intervall: direkt, oder über das Gebäude an dessen letztem gemeinsamen Tag.
     */
    private static List<ArchivierterOrt> archiviert(Zeilen z, StandAm stand, Map<String, OrtAmStichtag> amTag,
            UUID standortId, ZoneId zone, LocalDate stichtag, OrtAktionen aktionen) {
        Set<String> amTagArchiviert = new HashSet<>();
        stand.nichtGezeigt().stream()
                .filter(n -> n.grund() == Bestand.ARCHIVIERT)
                .forEach(n -> amTagArchiviert.add(n.kennzeichen()));
        List<ArchivierterOrt> out = new ArrayList<>();
        for (OrtRepository.Ort o : z.orte()) {
            if (amTag.containsKey(o.id().toString())) {
                continue;
            }
            List<OrtZuordnungRepository.Zuordnung> eigene = z.ortZuordnungen().stream()
                    .filter(iv -> iv.ortId().equals(o.id()))
                    .sorted(Comparator.comparing(OrtZuordnungRepository.Zuordnung::gueltigAb))
                    .toList();
            Optional<OrtZuordnungRepository.Zuordnung> beendet = eigene.stream()
                    .filter(iv -> !iv.aufgehoben() && iv.gueltigBis() != null && iv.gueltigBis().isBefore(stichtag))
                    .max(Comparator.comparing(OrtZuordnungRepository.Zuordnung::gueltigBis));
            OrtZuordnungRepository.Zuordnung letzte;
            LocalDate am;
            if (amTagArchiviert.contains(o.id().toString()) && beendet.isPresent()) {
                letzte = beendet.get();
                am = letzte.gueltigBis().plusDays(1);
            } else if (o.archiviertAm() != null && !eigene.isEmpty()
                    && eigene.stream().allMatch(OrtZuordnungRepository.Zuordnung::aufgehoben)
                    && !o.archiviertAm().atZone(zone).toLocalDate().isAfter(stichtag)) {
                letzte = eigene.get(eigene.size() - 1);
                am = o.archiviertAm().atZone(zone).toLocalDate();
            } else {
                continue;
            }
            if (!standortId.equals(standortVon(z, letzte))) {
                continue;
            }
            out.add(new ArchivierterOrt(o.id(), o.art(), o.kurzzeichen(), o.name(), o.nutzung(), am,
                    letzte.eltern(), letzte.elternStandortId() != null ? "standort" : "gebaeude",
                    aktionen == null ? null : aktionen.archiviert(o)));
        }
        return List.copyOf(out);
    }

    /** Der Standort, an dem ein Intervall hing — direkt, oder über das Gebäude an seinem letzten Tag. */
    private static UUID standortVon(Zeilen z, OrtZuordnungRepository.Zuordnung iv) {
        if (iv.elternStandortId() != null) {
            return iv.elternStandortId();
        }
        LocalDate tag = iv.gueltigBis() != null ? iv.gueltigBis() : iv.gueltigAb();
        List<OrtZuordnungRepository.Zuordnung> gebaeude = z.ortZuordnungen().stream()
                .filter(g -> g.ortId().equals(iv.elternOrtId()) && g.elternStandortId() != null)
                .sorted(Comparator.comparing(OrtZuordnungRepository.Zuordnung::gueltigAb))
                .toList();
        return gebaeude.stream()
                .filter(g -> !g.aufgehoben() && !g.gueltigAb().isAfter(tag)
                        && (g.gueltigBis() == null || !tag.isAfter(g.gueltigBis())))
                .map(OrtZuordnungRepository.Zuordnung::elternStandortId)
                .findFirst()
                .orElseGet(() -> gebaeude.isEmpty() ? null : gebaeude.get(gebaeude.size() - 1).elternStandortId());
    }

    /**
     * Je Kurzzeichen die Zahl der Messstellen, deren Ort am Stichtag dieser Knoten ist (eine
     * aufgehobene Zuordnung zählt nicht); {@code null} ohne Messstellen-Quelle.
     */
    private static Map<String, Integer> messstellenJeOrt(
            List<OrtsbaumAbleitung.Messstelle> messstellen, LocalDate stichtag) {
        if (messstellen == null) {
            return null;
        }
        Map<String, Integer> out = new HashMap<>();
        for (OrtsbaumAbleitung.Messstelle m : messstellen) {
            m.zuordnungen().stream()
                    .filter(i -> !i.aufgehoben() && i.eltern() != null && !i.ab().isAfter(stichtag)
                            && (i.bis() == null || !stichtag.isAfter(i.bis())))
                    .findFirst()
                    .ifPresent(i -> out.merge(i.eltern(), 1, Integer::sum));
        }
        return out;
    }

    private static Integer zahl(Map<String, Integer> zahl, String kurzzeichen) {
        return zahl == null ? null : zahl.getOrDefault(kurzzeichen, 0);
    }

    private static List<Bereich> bereicheUnter(Zeilen z, Map<String, OrtAmStichtag> amTag, String gebaeude,
            LocalDate stichtag, Map<String, Integer> zahl, OrtAktionen aktionen) {
        List<Bereich> out = new ArrayList<>();
        for (OrtRepository.Ort o : z.orte()) {
            OrtAmStichtag a = amTag.get(o.id().toString());
            if (a != null && "bereich".equals(o.art()) && gebaeude.equals(a.eltern())) {
                out.add(bereich(z, o, a, stichtag, zahl, aktionen));
            }
        }
        return List.copyOf(out);
    }

    private static Bereich bereich(Zeilen z, OrtRepository.Ort o, OrtAmStichtag a, LocalDate stichtag,
            Map<String, Integer> zahl, OrtAktionen aktionen) {
        OrtZuordnungRepository.Zuordnung iv = intervallAm(z, o.id(), stichtag);
        return new Bereich(o.id(), o.kurzzeichen(), o.name(), o.nutzung(), o.notiz(), o.zustand(),
                iv.gueltigAb(), iv.gueltigBis(), a.flaecheM2(), quelle(a), zahl(zahl, o.kurzzeichen()),
                aktionen == null ? null : aktionen.imBaum(o));
    }

    /**
     * Die Zeile der Zuordnung, die am Tag gilt — nur für „gültig ab/bis“ der
     * Antwort; WO der Knoten hängt, hat {@link OrtsbaumAbleitung#standAm} schon
     * entschieden (er ist nur dann im Baum, wenn es sie gibt).
     */
    private static OrtZuordnungRepository.Zuordnung intervallAm(Zeilen z, UUID ort, LocalDate tag) {
        return z.ortZuordnungen().stream()
                .filter(iv -> !iv.aufgehoben() && iv.ortId().equals(ort)
                        && !iv.gueltigAb().isAfter(tag)
                        && (iv.gueltigBis() == null || !tag.isAfter(iv.gueltigBis())))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("Ort " + ort + " ohne Zuordnung am " + tag));
    }

    private static String quelle(OrtAmStichtag a) {
        return a.flaecheQuelle() == null ? null : a.flaecheQuelle().name().toLowerCase(Locale.ROOT);
    }
}
