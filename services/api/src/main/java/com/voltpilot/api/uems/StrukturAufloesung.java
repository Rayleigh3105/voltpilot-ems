package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Date;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Pfad 2 der Berichte (UEMS AP-12 IP-9, bericht.md B1/B3): WELCHE Quellen eine Strukturänderung trifft — die Objekte,
 * die {@link BerichtRegeln#betroffene(List, java.util.Collection, LocalDate)} mit dem Quellenverzeichnis schneidet. Die
 * Regel {@link BerichtRegeln#struktur} sagt, OB eine Protokollzeile ein Anstoß ist; diese Klasse sagt, WEN er treffen
 * kann. Eine Quelle ist betroffen, wenn sich ihre Zahl oder ihre Zugehörigkeit im Bericht ab {@code gilt_ab} verschiebt —
 * nicht, wenn sich nur etwas daneben bewegt (ein unnötiger Anstoß ist genauso falsch wie ein fehlender):
 *
 * <ul>
 *   <li><b>Zuordnung</b> eines Gebäudes oder Bereichs: die Messstellen seines Unterbaus und die Bezugsgrößen daran —
 *       aber nur, wenn der Standort wechselt. Innerhalb desselben Standorts ändert sich keine Zahl eines Standort- oder
 *       Unternehmensberichts (Q3 zählt über den Standort, der Ort einer Messstelle bleibt ihr eigener).</li>
 *   <li><b>Zuordnung</b> einer Messstelle ({@code ort_zugeordnet}/{@code ort_korrigiert}): die Messstelle selbst.</li>
 *   <li><b>Anlage-Umzug</b>: nichts. Kein Abzug liest {@code anlage_standort}: Messstellen zählen über ihren eigenen Ort
 *       (Q3, {@code BerichtAbzugBildung.messstellenDerGeltung}), der Unternehmensbericht über Orts-, Stellungs- und
 *       Prozess-Zuordnungen. Die Protokollzeilen am Standort, die ein Umzug dazuschreibt ({@code richtung} hinzu/hinaus),
 *       sind ebenfalls nichts. Liest ein Abzug eines Tages die Anlage, gehört sie hierher.</li>
 *   <li><b>Fläche</b>: die Bezugsfläche des Orts und seiner Eltern — Objekt ist der Ort, denn eine Bezugsfläche hat keine
 *       ID einer Bezugsgröße (AP-09 IP-6); B9 nennt sie „BZ-4“ an Halle 2. Heute ist die Fläche kein Kennzahl-Eingang
 *       (AP-11, firstmate 001), also zitiert noch kein Bericht eine — der Weg steht, wenn sie es wird.</li>
 *   <li><b>Verteilung</b> einer Messstelle: die Kostenstellen des alten und des neuen Satzes und die berechneten Messstellen,
 *       deren Formel einen Anteil dieser Messstelle liest — über ihre Formel-Fassungen ab {@code gilt_ab}, auch über eine
 *       Kette von Messstellen (B8: MS-20, 4100, 4200).</li>
 * </ul>
 *
 * <p>Mittelbare Quellen (die Eingänge berechneter Zahlen und Kennzahlen) stehen schon im Quellenverzeichnis; eine Kennzahl
 * muss darum nicht eigens aufgelöst werden. Jede Abfrage nennt den Mandanten — der Läufer liest als Verwaltungsrolle ohne
 * RLS, die Route als App-Rolle.
 */
final class StrukturAufloesung {

    static final String GEBAEUDE = "gebaeude";
    static final String BEREICH = "bereich";
    static final String STANDORT = "standort";
    static final String ANLAGE = "anlage";
    static final String MESSSTELLE = "messstelle";

    /** Die Arten, die ein Urteil bekommen — jede andere Art ist nie ein Anstoß (bericht.md B4, Tabelle der Regel struktur). */
    static final List<String> ORT_ARTEN = List.of("verschoben", "korrigiert", "flaeche_geaendert");
    static final List<String> MESSSTELLE_ARTEN = List.of("ort_zugeordnet", "ort_korrigiert", "verteilung_geaendert");

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ZoneId VORGABE_ZONE = ZoneId.of("Europe/Berlin");

    private StrukturAufloesung() {}

    /**
     * Eine Zeile eines Änderungsprotokolls. {@code giltAbTag} trägt {@code ort_aenderung}, {@code giltAbZeit}
     * {@code messstelle_aenderung} (Mitternacht in der Zone des Unternehmens).
     */
    record Zeile(String protokoll, long id, UUID tenant, String objektArt, UUID objektId, String art, JsonNode alt,
            JsonNode neu, LocalDate giltAbTag, Instant giltAbZeit, boolean rueckwirkend, Instant eingetragen) {

        /** {@code korrektur} der Verteilung (AP-10 IP-8) — nur sie macht eine Verteilung rückwirkend (B4). */
        boolean korrektur() {
            return neu != null && neu.path("korrektur").asBoolean(false);
        }

        LocalDate giltAb(ZoneId zone) {
            return giltAbTag != null ? giltAbTag : giltAbZeit.atZone(zone).toLocalDate();
        }
    }

    static JsonNode json(String text) {
        if (text == null) {
            return null;
        }
        try {
            return JSON.readTree(text);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Änderungsprotokoll nicht lesbar: " + e.getOriginalMessage(), e);
        }
    }

    /** Die Objekte einer Protokollzeile, deren Urteil {@code anstossArt} ist (der Läufer). */
    static Set<UUID> objekte(JdbcTemplate j, Zeile z, String anstossArt, LocalDate giltAb) {
        return switch (anstossArt) {
            case BerichtRegeln.ZUORDNUNG_RUECKWIRKEND -> {
                if (BerichtRegeln.MESSSTELLE_AENDERUNG.equals(z.protokoll())) {
                    yield Set.of(z.objektId());
                }
                boolean ort = GEBAEUDE.equals(z.objektArt()) || BEREICH.equals(z.objektArt());
                yield ort && !standortGleich(z.alt(), z.neu()) ? unterbau(j, z.tenant(), z.objektId(), giltAb) : Set.of();
            }
            case BerichtRegeln.ANLAGE_UMZUG_RUECKWIRKEND -> Set.of();
            case BerichtRegeln.FLAECHE_RUECKWIRKEND -> flaechen(j, z.tenant(), z.objektArt(), z.objektId());
            case BerichtRegeln.VERTEILUNG_RUECKWIRKEND -> verteilung(j, z.tenant(), z.objektId(),
                    kostenstellen(j, z.tenant(), z.alt(), z.neu()), giltAb);
            default -> throw new IllegalArgumentException(anstossArt + " ist keine Strukturänderung");
        };
    }

    /** Die Objekte einer ANGEKÜNDIGTEN Änderung (die Folgen-Karte vor dem Speichern) — ohne Protokollzeile. */
    static Set<UUID> vorschau(JdbcTemplate j, UUID tenant, String anstossArt, String objektArt, UUID objektId,
            LocalDate giltAb) {
        return switch (anstossArt) {
            case BerichtRegeln.ZUORDNUNG_RUECKWIRKEND -> MESSSTELLE.equals(objektArt) ? Set.of(objektId)
                    : unterbau(j, tenant, objektId, giltAb);
            case BerichtRegeln.ANLAGE_UMZUG_RUECKWIRKEND -> Set.of();
            case BerichtRegeln.FLAECHE_RUECKWIRKEND -> flaechen(j, tenant, objektArt, objektId);
            case BerichtRegeln.VERTEILUNG_RUECKWIRKEND -> verteilung(j, tenant, objektId,
                    ids(j, "SELECT DISTINCT kostenstelle_id FROM messstelle_verteilung WHERE tenant_id = ? "
                            + "AND messstelle_id = ? AND aufgehoben_am IS NULL AND (gueltig_bis IS NULL OR gueltig_bis >= ?)",
                            tenant, objektId, Date.valueOf(giltAb)), giltAb);
            default -> throw new IllegalArgumentException(anstossArt + " ist keine Strukturänderung");
        };
    }

    /** Passt das Objekt zur angekündigten Änderung? Fläche und Zuordnung an Orten, Umzug an einer Anlage, Verteilung an einer Messstelle. */
    static boolean passt(String anstossArt, String objektArt) {
        return switch (anstossArt) {
            case BerichtRegeln.ZUORDNUNG_RUECKWIRKEND -> List.of(GEBAEUDE, BEREICH, STANDORT, MESSSTELLE).contains(objektArt);
            case BerichtRegeln.ANLAGE_UMZUG_RUECKWIRKEND -> ANLAGE.equals(objektArt);
            case BerichtRegeln.FLAECHE_RUECKWIRKEND -> List.of(GEBAEUDE, BEREICH, STANDORT).contains(objektArt);
            case BerichtRegeln.VERTEILUNG_RUECKWIRKEND -> MESSSTELLE.equals(objektArt);
            default -> false;
        };
    }

    /**
     * Jede Quelle, die ein Objekt je hatte — ohne Zeitschnitt: der Unterbau eines Orts oder Standorts, die Messstellen einer
     * Anlage (Stellung), eine Messstelle selbst. Daraus zählt die Folgen-Karte „… zitieren Messstellen dieses Orts“.
     */
    static Set<UUID> quellenDesObjekts(JdbcTemplate j, UUID tenant, String objektArt, UUID objektId) {
        return switch (objektArt) {
            case MESSSTELLE -> Set.of(objektId);
            case ANLAGE -> ids(j, "SELECT DISTINCT messstelle_id FROM messstelle_stellung WHERE tenant_id = ? AND site_id = ? "
                    + "AND aufgehoben_am IS NULL", tenant, objektId);
            default -> unterbau(j, tenant, objektId, null);
        };
    }

    /** Ort (Gebäude, Bereich), Standort, Anlage oder Messstelle des Kundenbereichs — {@code null}, wenn er es nicht kennt. */
    static String objektArt(JdbcTemplate j, UUID tenant, UUID id) {
        List<String> art = j.queryForList("SELECT art FROM ort WHERE tenant_id = ? AND id = ? "
                + "UNION ALL SELECT 'standort' FROM standort WHERE tenant_id = ? AND id = ? "
                + "UNION ALL SELECT 'anlage' FROM site WHERE tenant_id = ? AND id = ? "
                + "UNION ALL SELECT 'messstelle' FROM messstelle WHERE tenant_id = ? AND id = ?", String.class,
                tenant, id, tenant, id, tenant, id, tenant, id);
        return art.isEmpty() ? null : art.get(0);
    }

    /** Das Kennzeichen, mit dem die Anlass-Kennung die Änderung nennt; eine Anlage hat keins. */
    static String kennzeichen(JdbcTemplate j, UUID tenant, String objektArt, UUID id) {
        String sql = switch (objektArt) {
            case MESSSTELLE -> "SELECT kennzeichen FROM messstelle WHERE tenant_id = ? AND id = ?";
            case GEBAEUDE, BEREICH -> "SELECT kurzzeichen FROM ort WHERE tenant_id = ? AND id = ?";
            case STANDORT -> "SELECT kurzzeichen FROM standort WHERE tenant_id = ? AND id = ?";
            default -> null;
        };
        return sql == null ? null : j.queryForList(sql, String.class, tenant, id).stream().findFirst().orElse(null);
    }

    /** Die Zone des Kundenbereichs (des Unternehmens) — in ihr stehen „gilt ab“ und „eingetragen“ als Tag. */
    static ZoneId zone(JdbcTemplate j, UUID tenant) {
        return j.queryForList("SELECT zeitzone FROM unternehmen WHERE tenant_id = ? ORDER BY id LIMIT 1", String.class, tenant)
                .stream().findFirst().map(ZoneId::of).orElse(VORGABE_ZONE);
    }

    /** Hängen Ort und Standort vor und nach der Verschiebung am selben Standort ({@code OrtVerschiebenService})? */
    static boolean standortGleich(JsonNode alt, JsonNode neu) {
        return alt != null && neu != null && alt.has(STANDORT + "_id") && neu.has(STANDORT + "_id")
                && Objects.equals(alt.get(STANDORT + "_id").asText(null), neu.get(STANDORT + "_id").asText(null));
    }

    /**
     * Die Messstellen eines Orts oder Standorts samt Unterbau (Gebäude → Bereiche) und die Bezugsgrößen daran;
     * {@code ab} nicht {@code null}: nur Zuordnungen, die an diesem Tag oder später noch gelten.
     */
    static Set<UUID> unterbau(JdbcTemplate j, UUID tenant, UUID wurzel, LocalDate ab) {
        String gilt = ab == null ? "" : " AND (x.gueltig_bis IS NULL OR x.gueltig_bis >= ?)";
        String sql = "WITH RECURSIVE baum (id, tiefe) AS (SELECT CAST(? AS uuid), 0 UNION "
                + "SELECT x.ort_id, b.tiefe + 1 FROM ort_zuordnung x JOIN baum b "
                + "ON x.eltern_ort_id = b.id OR x.eltern_standort_id = b.id "
                + "WHERE x.tenant_id = ? AND x.aufgehoben_am IS NULL AND b.tiefe < 8" + gilt + ") "
                + "SELECT x.messstelle_id FROM messstelle_ort x JOIN baum b ON x.ort_id = b.id OR x.standort_id = b.id "
                + "WHERE x.tenant_id = ? AND x.aufgehoben_am IS NULL" + gilt + " "
                + "UNION SELECT g.id FROM bezugsgroesse g JOIN baum b ON g.ort_id = b.id OR g.standort_id = b.id "
                + "WHERE g.tenant_id = ?";
        List<Object> args = new ArrayList<>(List.of(wurzel, tenant));
        if (ab != null) {
            args.add(Date.valueOf(ab));
        }
        args.add(tenant);
        if (ab != null) {
            args.add(Date.valueOf(ab));
        }
        args.add(tenant);
        return ids(j, sql, args.toArray());
    }

    /**
     * Die Bezugsflächen, die eine Flächenänderung verschiebt: die des Orts selbst und die seiner Eltern bis zum Standort (die
     * Fläche eines Standorts summiert seine Gebäude). Objekt ist der ORT — eine Bezugsfläche hat keine ID einer Bezugsgröße,
     * sie wird aus der Ortsstruktur gelesen ({@link BezugsflaecheLesemodell}). {@code objektArt} braucht die Kette nicht:
     * ein Standort hat keine Zuordnung und ist sein eigenes Ende.
     */
    static Set<UUID> flaechen(JdbcTemplate j, UUID tenant, String objektArt, UUID objektId) {
        return ids(j, "WITH RECURSIVE kette (id, tiefe) AS (SELECT CAST(? AS uuid), 0 UNION "
                + "SELECT coalesce(x.eltern_ort_id, x.eltern_standort_id), k.tiefe + 1 FROM ort_zuordnung x JOIN kette k "
                + "ON x.ort_id = k.id WHERE x.tenant_id = ? AND x.aufgehoben_am IS NULL AND k.tiefe < 8) "
                + "SELECT DISTINCT id FROM kette", objektId, tenant);
    }

    /**
     * Die Kostenstellen eines Satzes und die berechneten Messstellen, deren gültige Formel-Fassung einen Anteil dieser
     * Messstelle liest ({@code eingang_art} verteilung) — und die Messstellen, die jene als Baustein lesen.
     */
    static Set<UUID> verteilung(JdbcTemplate j, UUID tenant, UUID messstelle, Set<UUID> kostenstellen, LocalDate ab) {
        Set<UUID> raus = new LinkedHashSet<>(kostenstellen);
        raus.addAll(ids(j, "WITH RECURSIVE betroffen (id, tiefe) AS ("
                + "SELECT t.messstelle_id, 0 FROM messstelle_formel_term t JOIN messstelle_formel_fassung f "
                + "ON f.id = t.fassung_id AND f.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND t.eingang_art = 'verteilung' "
                + "AND t.quell_messstelle_id = ? AND f.aufgehoben_am IS NULL AND (f.gueltig_bis IS NULL OR f.gueltig_bis >= ?) "
                + "UNION SELECT t.messstelle_id, b.tiefe + 1 FROM messstelle_formel_term t JOIN messstelle_formel_fassung f "
                + "ON f.id = t.fassung_id AND f.tenant_id = t.tenant_id JOIN betroffen b ON t.quell_messstelle_id = b.id "
                + "WHERE t.tenant_id = ? AND t.eingang_art = 'messstelle' AND b.tiefe < 8 AND f.aufgehoben_am IS NULL "
                + "AND (f.gueltig_bis IS NULL OR f.gueltig_bis >= ?)) SELECT DISTINCT id FROM betroffen",
                tenant, messstelle, Date.valueOf(ab), tenant, Date.valueOf(ab)));
        return raus;
    }

    /** Die Kostenstellen des alten und des neuen Satzes einer Protokollzeile {@code verteilung_geaendert} (Kennzeichen). */
    static Set<UUID> kostenstellen(JdbcTemplate j, UUID tenant, JsonNode alt, JsonNode neu) {
        Set<String> kennzeichen = new LinkedHashSet<>();
        for (JsonNode satz : new JsonNode[] {alt, neu}) {
            if (satz != null) {
                satz.path("zeilen").forEach(z -> kennzeichen.add(z.path("kostenstelle").asText()));
            }
        }
        return kennzeichen.isEmpty() ? Set.of() : ids(j, "SELECT id FROM kostenstelle WHERE tenant_id = ? "
                + "AND kennzeichen = ANY (?)", tenant, kennzeichen.toArray(String[]::new));
    }

    private static Set<UUID> ids(JdbcTemplate j, String sql, Object... args) {
        return new LinkedHashSet<>(j.queryForList(sql, UUID.class, args));
    }
}
