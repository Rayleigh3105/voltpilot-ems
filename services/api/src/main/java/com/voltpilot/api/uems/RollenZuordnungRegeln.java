package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.Map;

/** Reiner Vertragszwilling; H-1 hängt ihn noch in keinen Laufzeitpfad. */
public final class RollenZuordnungRegeln {
    private RollenZuordnungRegeln() {}
    public static final Map<String, String> ROLLEN = Map.of("pv", "PV-Produktion", "consumer", "Verbrauch", "grid", "Netz", "keine", "keine Rolle");
    public static final List<String> GRUENDE = List.of("kein_wert", "veraltet", "kein_geraet", "archiviert", "unvollstaendig");
    public static final List<String> PROTOKOLL = List.of("rolle_gesetzt", "rolle_entzogen");
    public static final int FRISCHE_SEKUNDEN = 300;
    public record Quelle(String entity_id, String point_key, String quell_messstelle_id) {}
    public record Stand(Double wert, String stand, String grund) {}
    public record Zuordnung(String anlage, String rolle, String geraet, Quelle quelle, List<Quelle> enthaelt, Stand zustand) {}
    public record RolleUrteil(boolean erlaubt, boolean zuordnen, String wort, String gesetz) {}
    public record NetzUrteil(boolean erlaubt, String code, Integer status) {}
    public record Ergebnis(boolean zuordnung_vorhanden, Double wert, boolean unvollstaendig,
            String stand, int beitragend, int gesamt, List<Quelle> gezaehlt, String fehler) {}

    public static RolleUrteil rolle(String r) {
        boolean erlaubt = r != null && ROLLEN.containsKey(r);
        return new RolleUrteil(erlaubt, erlaubt && !"keine".equals(r), erlaubt ? ROLLEN.get(r) : null,
                !erlaubt ? null : "keine".equals(r) ? "keine" : "grid".equals(r) ? "einzelwert" : "summe");
    }
    private static boolean gefuellt(String s) { return s != null && !s.isBlank(); }
    public static boolean wertGueltig(Quelle q) {
        return (gefuellt(q.entity_id()) && gefuellt(q.point_key()) && q.quell_messstelle_id() == null)
                || (q.entity_id() == null && q.point_key() == null && gefuellt(q.quell_messstelle_id()));
    }
    private static boolean enthaelt(Zuordnung z, Quelle q) { return z.enthaelt().contains(q); }
    private static IllegalArgumentException ungueltig() { return new IllegalArgumentException("eingang_ungueltig"); }

    /** Genau 300 s bleiben frisch. Quellen-Gründe gehen vor; ein fehlender Stand liefert keine Zahl. */
    public static Stand frische(String jetzt, Stand s) {
        if (s.grund() != null) {
            if (!GRUENDE.contains(s.grund())) throw ungueltig();
            return new Stand(null, s.stand(), s.grund());
        }
        if (s.wert() == null || !Double.isFinite(s.wert()) || s.stand() == null) {
            return new Stand(null, s.stand(), "kein_wert");
        }
        try {
            Instant now = Instant.parse(jetzt), stand = Instant.parse(s.stand());
            if (stand.isAfter(now)) return new Stand(null, s.stand(), "kein_wert");
            return stand.isBefore(now.minusSeconds(FRISCHE_SEKUNDEN))
                    ? new Stand(null, s.stand(), "veraltet") : s;
        } catch (DateTimeParseException ex) {
            return new Stand(null, s.stand(), "kein_wert");
        }
    }
    private record Auswahl(List<Zuordnung> alle, List<Zuordnung> gezaehlt) {}

    /** Vollständige Herkunft vor Frische prüfen: eine stumme Summe fällt nie auf ihr Blatt zurück. */
    private static Auswahl auswahl(String anlage, String r, List<Zuordnung> zuordnungen) {
        if (!rolle(r).zuordnen()) throw ungueltig();
        List<Zuordnung> alle = zuordnungen.stream().filter(z -> z.anlage().equals(anlage) && z.rolle().equals(r)).toList();
        List<Zuordnung> eindeutig = new ArrayList<>();
        for (Zuordnung z : alle) {
            if (!wertGueltig(z.quelle()) || z.enthaelt().stream().anyMatch(q -> !wertGueltig(q))
                    || enthaelt(z, z.quelle()) || (z.quelle().quell_messstelle_id() == null && !z.enthaelt().isEmpty())) throw ungueltig();
            Zuordnung schon = eindeutig.stream().filter(x -> x.quelle().equals(z.quelle())).findFirst().orElse(null);
            if (schon == null) eindeutig.add(z);
            else if (!schon.zustand().equals(z.zustand()) || !new HashSet<>(schon.enthaelt()).equals(new HashSet<>(z.enthaelt()))) throw ungueltig();
        }
        List<Zuordnung> gezaehlt = eindeutig.stream()
                .filter(z -> eindeutig.stream().noneMatch(x -> x != z && enthaelt(x, z.quelle()))).toList();
        if (!alle.isEmpty() && gezaehlt.isEmpty()) throw ungueltig();
        for (int i = 0; i < gezaehlt.size(); i++) {
            for (int j = i + 1; j < gezaehlt.size(); j++) {
                Zuordnung b = gezaehlt.get(j);
                if (!"grid".equals(r) && gezaehlt.get(i).enthaelt().stream().anyMatch(q -> enthaelt(b, q))) {
                    throw new IllegalArgumentException("ueberlappende_summenwerte");
                }
            }
        }
        return new Auswahl(alle, gezaehlt);
    }
    public static NetzUrteil netz(String anlage, List<Zuordnung> z) {
        boolean erlaubt = auswahl(anlage, "grid", z).gezaehlt().size() <= 1;
        return new NetzUrteil(erlaubt, erlaubt ? null : "netz_mehrfach", erlaubt ? null : 409);
    }
    public static Ergebnis zaehlung(String anlage, String r, String jetzt, List<Zuordnung> z) {
        Auswahl a = auswahl(anlage, r, z);
        int gesamt = (int) a.alle().stream().map(Zuordnung::geraet).distinct().count();
        if ("grid".equals(r) && a.gezaehlt().size() > 1) {
            return new Ergebnis(true, null, true, null, 0, gesamt, List.of(), "netz_mehrfach");
        }
        Double summe = null;
        String stand = null;
        Set<String> lieferndeGeraete = new HashSet<>();
        for (Zuordnung q : a.gezaehlt()) {
            Stand s = frische(jetzt, q.zustand());
            if (s.wert() == null) continue;
            summe = (summe == null ? 0 : summe) + s.wert();
            if (stand == null || Instant.parse(s.stand()).isAfter(Instant.parse(stand))) stand = s.stand();
            a.alle().stream().filter(x -> q.quelle().equals(x.quelle()) || enthaelt(q, x.quelle()))
                    .map(Zuordnung::geraet).forEach(lieferndeGeraete::add);
        }
        return new Ergebnis(!a.alle().isEmpty(), summe, lieferndeGeraete.size() < gesamt, stand,
                lieferndeGeraete.size(), gesamt, a.gezaehlt().stream().map(Zuordnung::quelle).toList(), null);
    }
    /** Ersetzen protokolliert alt/neu an EINEM rolle_gesetzt; unverändert ist idempotent. */
    public static List<String> aenderung(Quelle alt, Quelle neu) {
        if ((alt != null && !wertGueltig(alt)) || (neu != null && !wertGueltig(neu))) throw ungueltig();
        return Objects.equals(alt, neu) ? List.of() : List.of(neu == null ? "rolle_entzogen" : "rolle_gesetzt");
    }
}
