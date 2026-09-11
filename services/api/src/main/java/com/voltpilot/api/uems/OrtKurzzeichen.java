package com.voltpilot.api.uems;

import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtArt;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Die KURZZEICHEN der Ortsstruktur (AP-02 E8 = A): ST-1 …, G-1 …, B-1 … automatisch,
 * änderbar, eindeutig je Kundenbereich über Standorte UND Orte, nie wiederverwendet.
 * EIN Baustein für den Standort (IP-4) und für Gebäude/Bereiche (IP-5).
 *
 * <p>Die Datenbank hält die Regel selbst (V20260911210000): {@code uems_ort_kurzzeichen}
 * vergibt unter der Zeilensperre des Zählers — in der Transaktion des Schreibers; scheitert
 * sie, rückt auch der Zähler nicht vor —, und jede Vergabe und Umbenennung belegt das
 * Kurzzeichen für immer ({@code ort_kurzzeichen}). Hier steht nur, was der Schreibweg dazu
 * sagt: die Form der Anfrage (400) und die Ablehnung mit Verweis (409), bevor die
 * Datenbank ablehnt. Unter RLS: die Belegung eines fremden Mandanten ist nicht da.
 */
@Component
public class OrtKurzzeichen {

    /** Dieselbe Form wie die CHECKs von {@code standort}, {@code ort} und der Belegung. */
    static final int HOECHSTENS = 24;

    private final JdbcTemplate jdbc;

    public OrtKurzzeichen(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Wer das Kurzzeichen trägt ({@code frueher = false}) oder trug. {@code heute}/{@code name}
     * sind {@code null} für einen gelöschten Ort (E1) — sein Kurzzeichen bleibt trotzdem belegt.
     */
    public record Verweis(String objektArt, UUID id, String kurzzeichen, String heute, String name,
            boolean archiviert, boolean frueher) {

        /** Die Fakten der Ablehnung (snake_case wie die übrigen Fakten der Schnittstelle). */
        Map<String, Object> alsFakten() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("objekt_art", objektArt);
            m.put("id", id);
            m.put("kurzzeichen", kurzzeichen);
            m.put("heute", heute);
            m.put("name", name);
            m.put("archiviert", archiviert);
            m.put("frueher", frueher);
            return m;
        }
    }

    /** Das nächste automatische Kurzzeichen der Art — der Zähler rückt in DIESER Transaktion vor. */
    public String vergeben(UUID tenant, OrtArt art) {
        return jdbc.queryForObject("SELECT uems_ort_kurzzeichen(?, ?)", String.class, tenant, art.code());
    }

    /** Das Kurzzeichen, das {@link #vergeben} jetzt vergäbe — ohne den Zähler zu bewegen. */
    public String vorschlag(UUID tenant, OrtArt art) {
        return jdbc.queryForObject("SELECT uems_ort_kurzzeichen_vorschlag(?, ?)", String.class,
                tenant, art.code());
    }

    /**
     * Das Kurzzeichen aus der Anfrage in seiner gespeicherten Form: ohne Randleerzeichen,
     * 1–24 Zeichen. {@code null} oder leer bleibt {@code null} („automatisch vergeben").
     */
    public static String form(String roh, String feld) {
        if (roh == null || roh.isBlank()) {
            return null;
        }
        String k = roh.strip();
        if (k.length() > HOECHSTENS) {
            throw OrtAbgelehnt.anfrage(feld, "Das Kurzzeichen hat höchstens " + HOECHSTENS + " Zeichen.");
        }
        return k;
    }

    /** Der Träger des Kurzzeichens — ohne Groß-/Kleinschreibung, nie {@code ausser} selbst. */
    public Optional<Verweis> belegtVon(String kandidat, UUID ausser) {
        List<Verweis> treffer = jdbc.query("SELECT k.objekt_art, k.objekt_id, k.kurzzeichen, "
                + "coalesce(s.kurzzeichen, o.kurzzeichen) AS heute, coalesce(s.name, o.name) AS name, "
                + "coalesce(s.archiviert_am, o.archiviert_am) IS NOT NULL AS archiviert "
                + "FROM ort_kurzzeichen k "
                + "LEFT JOIN standort s ON k.objekt_art = 'standort' AND s.id = k.objekt_id "
                + "LEFT JOIN ort o ON k.objekt_art <> 'standort' AND o.id = k.objekt_id "
                + "WHERE lower(k.kurzzeichen) = lower(?) AND k.objekt_id IS DISTINCT FROM ?::uuid",
                (rs, n) -> {
                    String heute = rs.getString("heute");
                    String belegt = rs.getString("kurzzeichen");
                    return new Verweis(rs.getString("objekt_art"), rs.getObject("objekt_id", UUID.class),
                            belegt, heute, rs.getString("name"), rs.getBoolean("archiviert"),
                            heute != null && !heute.equalsIgnoreCase(belegt));
                },
                kandidat, ausser);
        return treffer.stream().findFirst();
    }

    /** 409 {@code kurzzeichen_belegt} mit Verweis, wenn ein anderer Ort es trägt oder trug. */
    public void pruefeFrei(String kandidat, UUID ausser) {
        belegtVon(kandidat, ausser).ifPresent(v -> {
            throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.KURZZEICHEN_BELEGT, satz(v),
                    Map.of("verweis", v.alsFakten()));
        });
    }

    private static String satz(Verweis v) {
        String traeger = v.name() == null ? "ein gelöschter Ort"
                : v.frueher() ? v.name() + ", heute " + v.heute()
                : v.archiviert() ? v.name() + ", archiviert" : v.name();
        return v.kurzzeichen() + " ist bereits vergeben (" + traeger + "). Kurzzeichen sind je "
                + "Unternehmen eindeutig — auch archivierte und frühere bleiben belegt.";
    }
}
