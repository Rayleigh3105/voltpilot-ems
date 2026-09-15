package com.voltpilot.api.uems;

import com.voltpilot.api.uems.OrtsbaumAbleitung.ArchivErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.LoeschErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ElternArt;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ObjektArt;
import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtAmStichtag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtArt;
import com.voltpilot.api.uems.OrtsbaumAbleitung.StandAm;
import com.voltpilot.api.uems.OrtsbaumAbleitung.WiederherstellErgebnis;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Was man HEUTE mit einem Knoten des Ortsbaums tun kann (UEMS AP-02 IP-15, Z1–Z3, E1) — die
 * Fakten, aus denen das Portal sein Menü baut, BEVOR jemand einen Knopf drückt: kein Knopf,
 * der da ist und dann 409 sagt.
 *
 * <p>Ohne Spring, ohne Uhr. Jedes Urteil ist {@link OrtsbaumAbleitung} ({@code archivieren},
 * {@code wiederherstellen}, {@code loeschen}) auf DEMSELBEN Baum, auf dem die Schreibrouten
 * urteilen ({@link StandortService#baum(StandortLesemodell.Zeilen, List)}: Orte nach
 * Kurzzeichen, Messstellen aus {@link OrtsbaumMessstellen}); Sätze und Sperrgründe sind die der
 * Ablehnung, die dieselbe Route antworten würde.
 *
 * <p><b>Eine Ergänzung außerhalb des Vertrags:</b> E1 zählt Messstelle, Anlage, Fläche und
 * Kinder als Historie. Eine Bezugsgröße (AP-09) kann ebenfalls an einem Gebäude oder Bereich
 * hängen, und ihr Fremdschlüssel lässt das Löschen ohnehin nicht zu — sie steht darum als
 * {@code hat_bezugsgroessen} in der Liste, statt dass „Löschen“ angeboten wird und dann scheitert.
 */
public final class OrtAktionen {

    /** Der Grund außerhalb des Vertrags (siehe oben). */
    public static final String HAT_BEZUGSGROESSEN = "hat_bezugsgroessen";
    /** AP-11 IP-5: eine Kennzahl mit diesem Ort als Geltungsbereich hält ihn (FK {@code kennzahl_ort_fk}). */
    public static final String HAT_KENNZAHLEN = "hat_kennzahlen";

    /**
     * Je Knoten genau die Aktionen, die zu seinem Zustand gehören: ein Knoten im Baum kann
     * archiviert und gelöscht werden, ein archivierter wiederhergestellt und gelöscht, der
     * Standort archiviert (gelöscht wird er nie, §4.1). {@code null} = gehört nicht dazu. {@code verschieben}
     * (IP-12) nur an einem Gebäude oder Bereich, der heute im Baum steht.
     */
    public record Aktionen(Archivieren archivieren, Wiederherstellen wiederherstellen, Loeschen loeschen,
            Verschieben verschieben) {}

    /**
     * IP-12 (V1/V2): wohin der Knoten HEUTE ziehen kann — jeder Knoten, der heute im Baum steht
     * ({@link OrtsbaumAbleitung#standAm}: bestehend, nicht archiviert), dessen Art der Vertrag als
     * Elternknoten erlaubt ({@link OrtsbaumAbleitung#ERLAUBTE_ELTERN}: nie ein Bereich), OHNE den
     * bisherigen Elternknoten (§5.10). Standorte zuerst, dann Gebäude mit ihrem Standort. Ob der Tag
     * geht, urteilt die Vorschau. {@code erlaubt} = es gibt ein Ziel; sonst sagt {@code text}, warum nicht.
     */
    public record Verschieben(boolean erlaubt, String text, List<Ziel> ziele) {}

    /** Ein Ziel: {@code art} standort · gebaeude; {@code standortName} nur beim Gebäude. */
    public record Ziel(UUID id, String art, String kurzzeichen, String name, String standortName) {}

    /**
     * {@code erlaubt}: sonst {@code text} = der Satz mit Grund und Weg (Z1) und {@code gruende} = die
     * Sperrgründe der 409-Antwort, je mit {@code weg}. Erlaubt: {@code letzterTag} = der letzte Tag
     * der Zuordnung (Vortag von heute) und {@code mitarchiviert} = die leeren Kinder, die mitgehen (Z2).
     */
    public record Archivieren(
            boolean erlaubt,
            String text,
            List<Map<String, Object>> gruende,
            LocalDate letzterTag,
            List<Mitarchiviert> mitarchiviert) {}

    public record Mitarchiviert(UUID id, String art, String kurzzeichen, String name) {}

    /**
     * {@code grund} = {@code nicht_archiviert} · {@code eltern_archiviert} · {@code name_belegt}; beim
     * belegten Namen öffnet der Dialog trotzdem — Umbenennen im selben Dialog (§4.2).
     */
    public record Wiederherstellen(boolean erlaubt, String grund, String text, LocalDate ab) {}

    /** {@code gruende} in der festen Reihenfolge des Vertrags, {@code text} nur, wenn gesperrt. */
    public record Loeschen(boolean erlaubt, List<String> gruende, String text) {}

    private final StandortService.Baum baum;
    private final LocalDate heute;
    private final Set<UUID> mitBezugsgroesse;
    private final Set<UUID> mitKennzahl;
    private StandAm stand;

    /**
     * @param heute der Tag in der Zeitzone des Standorts
     * @param mitBezugsgroesse die Orte, an denen eine Bezugsgröße hängt (auch eine archivierte)
     */
    public OrtAktionen(StandortService.Baum baum, LocalDate heute, Set<UUID> mitBezugsgroesse) {
        this(baum, heute, mitBezugsgroesse, Set.of());
    }

    /** @param mitKennzahl die Orte, die Geltungsbereich einer Kennzahl sind (auch einer archivierten) */
    public OrtAktionen(StandortService.Baum baum, LocalDate heute, Set<UUID> mitBezugsgroesse, Set<UUID> mitKennzahl) {
        this.baum = baum;
        this.heute = heute;
        this.mitBezugsgroesse = Set.copyOf(mitBezugsgroesse);
        this.mitKennzahl = Set.copyOf(mitKennzahl);
    }

    /** Ein Gebäude oder Bereich, der heute im Baum steht. */
    public Aktionen imBaum(OrtRepository.Ort o) {
        return new Aktionen(archivieren(o.kurzzeichen()), null, loeschen(baum, o, mitBezugsgroesse, mitKennzahl),
                verschieben(o));
    }

    /** Ein archiviertes Gebäude oder ein archivierter Bereich (Grabstein, Z3). */
    public Aktionen archiviert(OrtRepository.Ort o) {
        WiederherstellErgebnis w = OrtsbaumAbleitung.wiederherstellen(baum.baum(), o.kurzzeichen(), heute, null);
        String grund = w.grund() == null ? null : w.grund().name().toLowerCase(Locale.ROOT);
        return new Aktionen(null, new Wiederherstellen(w.erlaubt(), grund, w.text(), heute),
                loeschen(baum, o, mitBezugsgroesse, mitKennzahl), null);
    }

    /** Der Standort selbst: nur Archivieren. */
    public Aktionen standort(String kurzzeichen) {
        return new Aktionen(archivieren(kurzzeichen), null, null, null);
    }

    private Verschieben verschieben(OrtRepository.Ort o) {
        if (stand == null) {
            stand = OrtsbaumAbleitung.standAm(baum.baum(), heute);
        }
        OrtAmStichtag selbst = stand.orte().stream()
                .filter(x -> x.kennzeichen().equals(o.kurzzeichen())).findFirst().orElse(null);
        if (selbst == null) {
            return null;
        }
        List<ElternArt> erlaubt = OrtsbaumAbleitung.ERLAUBTE_ELTERN.get(ObjektArt.valueOf(o.art().toUpperCase(Locale.ROOT)));
        List<Ziel> standorte = new ArrayList<>();
        List<Ziel> gebaeude = new ArrayList<>();
        for (OrtAmStichtag k : stand.orte()) {
            if (k.kennzeichen().equals(o.kurzzeichen()) || k.kennzeichen().equals(selbst.eltern())) {
                continue;
            }
            OrtsbaumAbleitung.Ort knoten = baum.baum().ort(k.kennzeichen()).orElse(null);
            if (knoten == null || !erlaubt.contains(ElternArt.valueOf(knoten.art().name()))) {
                continue;
            }
            if (knoten.art() == OrtArt.STANDORT) {
                standorte.add(new Ziel(baum.standorte().get(k.kennzeichen()), OrtArt.STANDORT.code(),
                        k.kennzeichen(), knoten.name(), null));
            } else {
                OrtRepository.Ort g = baum.ort(k.kennzeichen());
                gebaeude.add(new Ziel(g.id(), g.art(), g.kurzzeichen(), g.name(),
                        baum.baum().ort(k.standort()).map(OrtsbaumAbleitung.Ort::name).orElse(null)));
            }
        }
        List<Ziel> ziele = new ArrayList<>(standorte);
        ziele.addAll(gebaeude);
        String text = ziele.isEmpty()
                ? o.name() + " kann nicht verschoben werden: es gibt " + ("bereich".equals(o.art())
                        ? "kein anderes Gebäude und keinen anderen Standort." : "keinen anderen Standort.")
                : null;
        return new Verschieben(!ziele.isEmpty(), text, List.copyOf(ziele));
    }

    private Archivieren archivieren(String kz) {
        ArchivErgebnis e = OrtsbaumAbleitung.archivieren(baum.baum(), kz, heute);
        if (!e.erlaubt()) {
            return new Archivieren(false, e.text(),
                    e.gruende().stream().map(g -> StandortService.grund(g, baum)).toList(), null, List.of());
        }
        List<Mitarchiviert> mit = e.archiviert().stream()
                .filter(a -> !a.kennzeichen().equals(kz))
                .map(a -> baum.ort(a.kennzeichen()))
                .filter(Objects::nonNull)
                .map(x -> new Mitarchiviert(x.id(), x.art(), x.kurzzeichen(), x.name()))
                .toList();
        return new Archivieren(true, null, List.of(), heute.minusDays(1), mit);
    }

    /**
     * E1 für einen Ort — dieselbe Antwort, die {@code DELETE /api/v1/orte/{id}} gibt: die Gründe des
     * Vertrags und, außerhalb davon, {@link #HAT_BEZUGSGROESSEN} und {@link #HAT_KENNZAHLEN}.
     */
    static Loeschen loeschen(StandortService.Baum baum, OrtRepository.Ort o, Set<UUID> mitBezugsgroesse) {
        return loeschen(baum, o, mitBezugsgroesse, Set.of());
    }

    static Loeschen loeschen(StandortService.Baum baum, OrtRepository.Ort o, Set<UUID> mitBezugsgroesse,
            Set<UUID> mitKennzahl) {
        LoeschErgebnis e = OrtsbaumAbleitung.loeschen(baum.baum(), o.kurzzeichen());
        List<String> gruende = new ArrayList<>();
        e.gruende().forEach(g -> gruende.add(g.name().toLowerCase(Locale.ROOT)));
        if (mitBezugsgroesse.contains(o.id())) {
            gruende.add(HAT_BEZUGSGROESSEN);
        }
        if (mitKennzahl.contains(o.id())) {
            gruende.add(HAT_KENNZAHLEN);
        }
        return new Loeschen(gruende.isEmpty(), List.copyOf(gruende),
                gruende.isEmpty() ? null : loeschenSatz(o.name(), gruende));
    }

    /**
     * „Löschen geht nicht: Halle 1 hat Historie (Messstellen, Fläche und Bereiche). Gelöscht wird nur,
     * was nie etwas getragen hat — alles andere wird archiviert.“ Ohne Gründe (die Datenbank hat
     * widersprochen): ohne Klammer.
     */
    static String loeschenSatz(String name, List<String> gruende) {
        List<String> worte = gruende.stream().map(OrtAktionen::wort).filter(Objects::nonNull).toList();
        String historie = worte.isEmpty() ? "" : " (" + aufzaehlung(worte) + ")";
        return "Löschen geht nicht: " + name + " hat Historie" + historie + ". Gelöscht wird nur, was nie "
                + "etwas getragen hat — alles andere wird archiviert.";
    }

    private static String wort(String grund) {
        return switch (grund) {
            case "hat_messstellen" -> "Messstellen";
            case "hat_anlagen" -> "Anlagen";
            case "hat_flaeche" -> "Fläche";
            case "hat_kinder" -> "Bereiche";
            case HAT_BEZUGSGROESSEN -> "Bezugsgrößen";
            case HAT_KENNZAHLEN -> "Kennzahlen";
            default -> null;
        };
    }

    private static String aufzaehlung(List<String> worte) {
        if (worte.size() == 1) {
            return worte.get(0);
        }
        return String.join(", ", worte.subList(0, worte.size() - 1)) + " und " + worte.get(worte.size() - 1);
    }
}
