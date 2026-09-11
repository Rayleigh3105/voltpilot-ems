package com.voltpilot.api.uems;

import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtAmStichtag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.StandAm;
import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.Zeilen;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
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
            Integer messstellenZahl) {}

    /** Ein Gebäude zum Stichtag mit den Bereichen, die an dem Tag an ihm hängen. */
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
            List<Bereich> bereiche) {}

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
            DirektAmStandort direktAmStandort) {}

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
        Map<String, Integer> zahl = messstellenJeOrt(messstellen, stichtag);
        Optional<StandortAmStichtag> standort = StandortLesemodell.standort(z, standortId, stichtag);
        if (standort.isEmpty()) {
            return Optional.empty();
        }
        if (!VORHANDEN.equals(standort.get().bestand())) {
            return Optional.of(new OrtsbaumAmStichtag(stichtag, standort.get(), null, List.of(),
                    List.of(), null));
        }
        StandAm stand = OrtsbaumAbleitung.standAm(StandortLesemodell.baum(z), stichtag);
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
                        bereicheUnter(z, amTag, o.id().toString(), stichtag, zahl)));
            } else if (st.equals(a.eltern())) {
                direkt.add(bereich(z, o, a, stichtag, zahl));
            }
        }
        OrtAmStichtag s = amTag.get(st);
        List<UUID> ohne = s.gebaeudeOhneFlaeche() == null ? List.of()
                : s.gebaeudeOhneFlaeche().stream().map(UUID::fromString).toList();
        return Optional.of(new OrtsbaumAmStichtag(stichtag, standort.get(), s.summeGebaeudeM2(), ohne,
                List.copyOf(gebaeude),
                new DirektAmStandort(List.copyOf(direkt), zahl(zahl, standort.get().kurzzeichen()))));
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
            LocalDate stichtag, Map<String, Integer> zahl) {
        List<Bereich> out = new ArrayList<>();
        for (OrtRepository.Ort o : z.orte()) {
            OrtAmStichtag a = amTag.get(o.id().toString());
            if (a != null && "bereich".equals(o.art()) && gebaeude.equals(a.eltern())) {
                out.add(bereich(z, o, a, stichtag, zahl));
            }
        }
        return List.copyOf(out);
    }

    private static Bereich bereich(Zeilen z, OrtRepository.Ort o, OrtAmStichtag a, LocalDate stichtag,
            Map<String, Integer> zahl) {
        OrtZuordnungRepository.Zuordnung iv = intervallAm(z, o.id(), stichtag);
        return new Bereich(o.id(), o.kurzzeichen(), o.name(), o.nutzung(), o.notiz(), o.zustand(),
                iv.gueltigAb(), iv.gueltigBis(), a.flaecheM2(), quelle(a), zahl(zahl, o.kurzzeichen()));
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
