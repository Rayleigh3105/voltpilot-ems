package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.BezugsbasisDto;
import com.voltpilot.api.web.dto.FaktorenVorschlagDto;
import java.math.BigDecimal;
import java.sql.Date;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Die statischen Faktoren an einer Bezugsbasis-Fassung (UEMS AP-17 IP-16b, V3, E6 = A). Ein Faktor ist ein Verweis
 * auf ein Objekt, das der Faktoren-Vorschlag ({@link FaktorenVorschlag}, IP-16a) am Stichtag für die Geltung der
 * Kennzahl nennt — nur was er vorschlägt, ist zulässig — oder ein Wortlaut. Wert und Einheit (Fläche) bzw. Kennung und
 * Bezeichnung werden zum Stichtag als Kopie eingefroren: in {@code bezugsbasis_faktor} und als Block {@code faktoren}
 * in der Grundlage, den die Prüfsumme abdeckt. Ohne Faktoren bleibt die Grundlage byte-gleich (leerer Block).
 *
 * <p>Stichtag ist im Entwurf der Bildungstag. Die Neukopie am Freigabetag, falls sich der Wert bis dahin geändert
 * hat, ist ein eigenes Folgepaket. Den Anstoß {@code struktur_geaendert} liest der Struktur-Läufer aus der Tabelle (IP-15,
 * {@link BezugsbasisAnstoss}); ein Wortlaut stößt nie an.
 */
final class BezugsbasisFaktoren {

    /** Die Arten in Vokabular-Reihenfolge ({@code faktor_art}) — zugleich die Sortierung der Liste. */
    static final List<String> ARTEN = List.of("flaeche", "standort", "anlage", "prozess", "kostenstelle", "wortlaut");
    static final String WORTLAUT = "wortlaut";
    static final int WORTLAUT_HOECHSTENS = 500;

    private static final ObjectMapper EXAKT = new ObjectMapper().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .setNodeFactory(JsonNodeFactory.withExactBigDecimals(true));

    private BezugsbasisFaktoren() {}

    /** Eine Kopie zum Stichtag; {@code objektId} {@code null} nur beim Wortlaut. */
    record Kopie(int position, String art, UUID objektId, String kennung, String bezeichnung, String wortlaut,
            Integer wert, String einheit, LocalDate gueltigAb, LocalDate stichtag) {

        Kopie an(int neu) {
            return new Kopie(neu, art, objektId, kennung, bezeichnung, wortlaut, wert, einheit, gueltigAb, stichtag);
        }
    }

    /**
     * Prüft die gewählten Faktoren gegen den Vorschlag am {@code stichtag} und liefert die Kopien, sortiert nach Art
     * (Vokabular) und Kennung, mit Position ab 1. Der Vorschlag wird nur gelesen, wenn ein Verweis gewählt ist.
     */
    static List<Kopie> pruefen(List<BezugsbasisDto.FaktorWahl> gewaehlt, LocalDate stichtag,
            Supplier<FaktorenVorschlagDto.Vorschlag> vorschlag) {
        if (gewaehlt == null || gewaehlt.isEmpty()) {
            return List.of();
        }
        Map<String, FaktorenVorschlagDto.Faktor> kandidaten = null;
        List<Kopie> aus = new ArrayList<>();
        Set<String> gesehen = new HashSet<>();
        for (BezugsbasisDto.FaktorWahl w : gewaehlt) {
            if (w == null || w.art() == null) {
                throw BezugsbasisAbgelehnt.anfrage("faktoren");
            }
            if (!ARTEN.contains(w.art())) {
                throw BezugsbasisAbgelehnt.fachlich("faktor_unbekannt", "Diese Art von statischem Faktor gibt es nicht.",
                        Map.of("art", w.art(), "arten", ARTEN));
            }
            if (WORTLAUT.equals(w.art())) {
                String text = w.wortlaut() == null ? "" : w.wortlaut().strip();
                if (w.objektId() != null || text.isEmpty() || text.length() > WORTLAUT_HOECHSTENS) {
                    throw BezugsbasisAbgelehnt.anfrage("faktoren");
                }
                if (!gesehen.add(WORTLAUT + ":" + text)) {
                    throw doppelt(w.art());
                }
                aus.add(new Kopie(0, WORTLAUT, null, null, null, text, null, null, null, stichtag));
                continue;
            }
            if (w.objektId() == null || w.wortlaut() != null) {
                throw BezugsbasisAbgelehnt.anfrage("faktoren");
            }
            if (kandidaten == null) {
                kandidaten = new HashMap<>();
                for (FaktorenVorschlagDto.Faktor k : vorschlag.get().faktoren()) {
                    kandidaten.put(k.art() + ":" + k.objektId(), k);
                }
            }
            FaktorenVorschlagDto.Faktor k = kandidaten.get(w.art() + ":" + w.objektId());
            if (k == null) {
                throw BezugsbasisAbgelehnt.fachlich("faktor_unbekannt", "Diesen statischen Faktor nennt die Struktur der "
                        + "Geltung am " + OrtsbaumAbleitung.datumText(stichtag) + " nicht.", Map.of("art", w.art(),
                                "objekt_id", w.objektId().toString(), "stichtag", stichtag.toString()));
            }
            if (!gesehen.add(w.art() + ":" + w.objektId())) {
                throw doppelt(w.art());
            }
            aus.add(new Kopie(0, k.art(), k.objektId(), k.kennung(), k.bezeichnung(), null, k.wert(), k.einheit(),
                    k.gueltigAb(), stichtag));
        }
        aus.sort(Comparator.comparingInt((Kopie c) -> ARTEN.indexOf(c.art()))
                .thenComparing(c -> Objects.toString(c.kennung() != null ? c.kennung() : c.bezeichnung(),
                        Objects.toString(c.wortlaut(), "")))
                .thenComparing(c -> Objects.toString(c.objektId(), "")));
        List<Kopie> nummeriert = new ArrayList<>();
        for (int i = 0; i < aus.size(); i++) {
            nummeriert.add(aus.get(i).an(i + 1));
        }
        return List.copyOf(nummeriert);
    }

    /** Die Grundlage mit dem Faktoren-Block; ohne Faktoren genau dieselbe (dieselben Bytes, dieselbe Prüfsumme). */
    static BezugsbasisGrundlage.Ergebnis inGrundlage(BezugsbasisGrundlage.Ergebnis g, List<Kopie> kopien) {
        if (kopien.isEmpty() || g.text() == null) {
            return g;
        }
        ObjectNode grundlage;
        try {
            grundlage = (ObjectNode) EXAKT.readTree(g.text());
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
            throw new IllegalStateException(x);
        }
        ArrayNode block = grundlage.putArray("faktoren");
        for (Kopie c : kopien) {
            ObjectNode f = block.addObject();
            f.put("position", c.position());
            f.put("art", c.art());
            f.put("kopie_am", c.stichtag().toString());
            if (c.wortlaut() != null) {
                f.put("wortlaut", c.wortlaut());
                continue;
            }
            if (c.kennung() != null) {
                f.put("objekt", c.kennung());
            }
            f.put("bezeichnung", c.bezeichnung());
            if (c.wert() != null) {
                f.put("wert", c.wert());
                f.put("einheit", c.einheit());
            }
            if (c.gueltigAb() != null) {
                f.put("gueltig_ab", c.gueltigAb().toString());
            }
        }
        return g.mitText(BezugsbasisGrundlage.kanonisch(grundlage));
    }

    /** Schreibt die Kopien an die Fassung; die bisherigen des offenen Entwurfs werden aufgehoben (nur im Entwurf). */
    static void speichern(JdbcTemplate jdbc, UUID tenant, UUID fassungId, List<Kopie> kopien) {
        jdbc.update("UPDATE bezugsbasis_faktor SET aufgehoben_am = now() WHERE fassung_id = ? AND aufgehoben_am IS NULL",
                fassungId);
        for (Kopie c : kopien) {
            jdbc.update("INSERT INTO bezugsbasis_faktor (tenant_id, fassung_id, position, art, verweis, wortlaut, wert, "
                    + "einheit, wert_gueltig_ab, kopie_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", tenant, fassungId,
                    c.position(), c.art(), c.objektId(), c.wortlaut(), c.wert() == null ? null : new BigDecimal(c.wert()),
                    c.einheit(), c.gueltigAb() == null ? null : Date.valueOf(c.gueltigAb()), Date.valueOf(c.stichtag()));
        }
    }

    /** Die Faktoren der Fassung: Zeilen aus der Tabelle, Kennung und Bezeichnung aus der eingefrorenen Grundlage. */
    static List<BezugsbasisDto.Faktor> lesen(JdbcTemplate jdbc, UUID fassungId, JsonNode grundlage) {
        Map<Integer, JsonNode> block = new LinkedHashMap<>();
        for (JsonNode f : grundlage.path("faktoren")) {
            block.put(f.path("position").asInt(), f);
        }
        return jdbc.query("SELECT position, art, verweis, wortlaut, wert, einheit, wert_gueltig_ab, kopie_am "
                + "FROM bezugsbasis_faktor WHERE fassung_id = ? AND aufgehoben_am IS NULL ORDER BY position", (rs, i) -> {
                    int position = rs.getInt("position");
                    JsonNode g = block.getOrDefault(position, EXAKT.createObjectNode());
                    Date ab = rs.getDate("wert_gueltig_ab");
                    Date am = rs.getDate("kopie_am");
                    BigDecimal wert = rs.getBigDecimal("wert");
                    String art = rs.getString("art");
                    String kennung = g.hasNonNull("objekt") ? g.get("objekt").asText() : null;
                    String bezeichnung = g.hasNonNull("bezeichnung") ? g.get("bezeichnung").asText() : null;
                    String wortlaut = rs.getString("wortlaut");
                    LocalDate stichtag = am == null ? null : am.toLocalDate();
                    return new BezugsbasisDto.Faktor(position, art, rs.getObject("verweis", UUID.class), kennung,
                            bezeichnung, wortlaut, wert == null ? null : wert.stripTrailingZeros().toPlainString(),
                            rs.getString("einheit"), ab == null ? null : ab.toLocalDate(), stichtag,
                            WORTLAUT.equals(art), satz(art, kennung, bezeichnung, wortlaut, wert, rs.getString("einheit"),
                                    stichtag));
                }, fassungId);
    }

    /**
     * Der Kundensatz (§5.8, Wort „statischer Faktor“ aus {@code glossar.ts}): „Statischer Faktor: Fläche G-2 3 100 m²
     * (Stand 12.11.2026)“; ein Wortlaut „Statischer Faktor: Zweischichtbetrieb (Wortlaut, ohne Anstoß)“.
     */
    static String satz(String art, String kennung, String bezeichnung, String wortlaut, BigDecimal wert, String einheit,
            LocalDate stichtag) {
        if (WORTLAUT.equals(art)) {
            return "Statischer Faktor: " + wortlaut + " (Wortlaut, ohne Anstoß)";
        }
        String wort = switch (art) {
            case "flaeche" -> "Fläche";
            case "standort" -> "Standort";
            case "anlage" -> "Anlage";
            case "prozess" -> "Prozess";
            default -> "Kostenstelle";
        };
        StringBuilder s = new StringBuilder("Statischer Faktor: ").append(wort);
        if (kennung != null) {
            s.append(' ').append(kennung);
        }
        if (bezeichnung != null && !"flaeche".equals(art)) {
            s.append(' ').append(bezeichnung);
        }
        if (wert != null) {
            // m2Text setzt Tausender-Abstand und Einheit schmal-geschützt (U+00A0) wie jeder Flächen-Satz.
            s.append(' ').append(OrtsbaumAbleitung.m2Text(wert.intValueExact()));
        }
        return s.append(" (Stand ").append(stichtag == null ? "unbekannt" : OrtsbaumAbleitung.datumText(stichtag))
                .append(')').toString();
    }

    private static BezugsbasisAbgelehnt doppelt(String art) {
        return BezugsbasisAbgelehnt.fachlich("faktor_doppelt", "Jeder statische Faktor steht nur einmal an der Fassung.",
                Map.of("art", art));
    }
}
