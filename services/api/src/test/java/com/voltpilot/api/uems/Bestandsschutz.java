package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Der Bestandsschutz-Vergleich der Migrationstests: der Inhalt jeder Tabelle des Schemas als
 * Fingerabdruck, und ein Vergleich, der genau die Zusage prüft — <b>der Bestand ist unberührt</b>
 * — und nicht die schärfere, falsche „am Schema hat sich nichts getan".
 *
 * <p>Warum es ihn gibt: die Tests nehmen den ersten Fingerabdruck auf IHRER Migrationsfassung und
 * migrieren danach bis zum neuesten Stand, weil der Lauf den Code von heute braucht. Jede SPÄTERE
 * Migration, die eine Tabelle anlegt, erschien darum als Unterschied, und jedes Paket musste sie
 * in allen älteren Tests mit Namen ausnehmen. Der Vergleich hier nimmt sie nicht aus, sondern
 * prüft sie: eine neue Tabelle darf da sein, solange sie LEER ist.
 *
 * <ul>
 *   <li>eine Tabelle von vorher, deren Inhalt sich geändert hat (Zeile geändert, hinzugefügt,
 *       gelöscht — oder eine neue Spalte, die in einer bestehenden Zeile einen Wert trägt)
 *       → Abweichung;</li>
 *   <li>eine Tabelle von vorher, die nachher fehlt → Abweichung;</li>
 *   <li>eine Tabelle, die erst nachher da ist und Zeilen hat → Abweichung;</li>
 *   <li>eine Tabelle, die erst nachher da ist und leer ist → KEINE Abweichung;</li>
 *   <li>eine Spalte, die erst nachher da ist und in jeder Zeile NULL ist → KEINE Abweichung —
 *       dieselbe Unterscheidung eine Ebene tiefer;</li>
 *   <li>die Katalog-Metadaten ({@link #KATALOG_METADATEN}) werden JE Laufzeitstand gemessen: ein
 *       bestehender Stand muss zeichengleich bleiben, ein angehängter Stand ist KEINE Abweichung.</li>
 * </ul>
 *
 * <p>Darum ist der Wert einer Zeile ihr JSON-Objekt OHNE die Spalten, die SQL-NULL sind
 * ({@link #ZEILE}), nicht {@code t::text}: dort hinge an jeder Zeile ein Komma mehr, sobald eine
 * spätere Migration eine leere Spalte anhängt. Ein Wert, der NULL wird, oder ein NULL, das einen
 * Wert bekommt, ändert das Objekt weiterhin.
 */
final class Bestandsschutz {

    /** Der Wert einer Tabelle ohne Zeilen — ein md5 besteht nur aus Hex-Ziffern, kann es also nie sein. */
    static final String LEER = "leer";

    /**
     * Die Metadaten des Messpunkt-Katalogs wachsen mit jedem Laufzeitstand um genau dessen Zeilen — jeder
     * Stand bringt seine EIGENE Metadaten-Migration mit (Katalog-README „Inhaltsstand und Laufzeitstand“,
     * {@code package_edge_runtime.py}). Gemessen wird darum je Stand ein Wert unter
     * {@code measurement_catalog_point_metadata@<stand>}: eine geänderte Zeile eines bestehenden Stands
     * bleibt eine Abweichung, ein neuer Stand nicht — sonst bräche jede Laufzeithebung jeden Vergleich.
     */
    static final String KATALOG_METADATEN = "measurement_catalog_point_metadata";

    /**
     * Eine Zeile {@code t} als Text: die Spalten mit Wert als jsonb-Objekt (Schlüssel sortiert,
     * also unabhängig von der Spaltenreihenfolge). Nur die OBERSTE Ebene wird gefiltert — ein
     * {@code null} innerhalb eines jsonb-Werts bleibt stehen.
     */
    private static final String ZEILE = "(SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) "
            + "FROM jsonb_each(to_jsonb(t)) e WHERE e.value <> 'null'::jsonb)::text";

    private Bestandsschutz() {
    }

    /**
     * Der Inhalt jeder Tabelle des Schemas {@code public} als ein Wert je Tabelle — ändert sich
     * irgendwo eine Zeile, ändert sich ihr Wert. Das Migrations-Protokoll ist immer ausgenommen.
     *
     * @param ausnahmen {@code LIKE}-Muster der Tabellen, die das Paket selbst bearbeitet; sie
     *                  gelten auch für später hinzukommende Tabellen
     */
    static Map<String, String> fingerabdruck(JdbcTemplate db, List<String> ausnahmen) {
        StringBuilder sql = new StringBuilder("SELECT table_name FROM information_schema.tables "
                + "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
                + "AND table_name <> 'flyway_schema_history'");
        ausnahmen.forEach(a -> sql.append(" AND table_name NOT LIKE ?"));
        sql.append(" ORDER BY table_name");
        Map<String, String> aus = new LinkedHashMap<>();
        for (String tabelle : db.queryForList(sql.toString(), String.class, ausnahmen.toArray())) {
            if (KATALOG_METADATEN.equals(tabelle)) {
                List<String> staende = db.queryForList("SELECT DISTINCT catalog_version FROM " + tabelle
                        + " ORDER BY 1", String.class);
                if (staende.isEmpty()) {
                    aus.put(tabelle, LEER);
                }
                staende.forEach(stand -> aus.put(tabelle + "@" + stand,
                        inhalt(db, tabelle, "t.catalog_version = ?", stand)));
                continue;
            }
            aus.put(tabelle, inhalt(db, tabelle, null));
        }
        return aus;
    }

    /**
     * Der Inhalt EINER Tabelle als ein Wert, in derselben Zeilenform wie {@link #fingerabdruck} —
     * für die Tests, die nur eine Tabelle oder einen Ausschnitt messen (etwa die pünktlichen
     * Rohwerte). Eine überall leere Spalte, die eine spätere Migration anhängt, ändert ihn nicht.
     *
     * @param bedingung {@code WHERE}-Bedingung über den Alias {@code t}, oder {@code null} für alle Zeilen
     */
    static String inhalt(JdbcTemplate db, String tabelle, String bedingung, Object... args) {
        return db.queryForObject("SELECT coalesce(md5(string_agg(z, '|' ORDER BY z)), '" + LEER + "') FROM (SELECT "
                + ZEILE + " AS z FROM " + tabelle + " t" + (bedingung == null ? "" : " WHERE " + bedingung)
                + ") s", String.class, args);
    }

    /**
     * Wie {@link #inhalt} über alle Zeilen, aber ohne die genannten Spalten — für eine neue Spalte, die eine Migration
     * mit einer Vorgabe in JEDE bestehende Zeile schreibt ({@code NOT NULL DEFAULT}). Der Test nennt sie mit Namen und
     * prüft ihren Wert eigens; alles andere an der Zeile bleibt gemessen.
     */
    static String inhaltOhne(JdbcTemplate db, String tabelle, String... spalten) {
        return db.queryForObject("SELECT coalesce(md5(string_agg(z, '|' ORDER BY z)), '" + LEER + "') FROM (SELECT "
                + ZEILE.replace("to_jsonb(t)", "(to_jsonb(t) - ?::text[])") + " AS z FROM " + tabelle + " t) s",
                String.class, (Object) spalten);
    }

    /** Was sich am Bestand geändert hat, je Tabelle ein Satz — leer heißt: der Bestand ist unberührt. */
    static List<String> abweichungen(Map<String, String> vorher, Map<String, String> nachher) {
        List<String> aus = new ArrayList<>();
        vorher.forEach((tabelle, wert) -> {
            if (!nachher.containsKey(tabelle)) {
                aus.add(tabelle + ": bestehende Tabelle fehlt");
            } else if (!nachher.get(tabelle).equals(wert)) {
                aus.add(tabelle + ": bestehender Inhalt geändert");
            }
        });
        nachher.forEach((tabelle, wert) -> {
            if (!vorher.containsKey(tabelle) && !LEER.equals(wert)
                    && !tabelle.startsWith(KATALOG_METADATEN + "@")) {
                aus.add(tabelle + ": neue Tabelle mit Inhalt");
            }
        });
        return aus;
    }

    /**
     * Die Mutationsprobe auf der echten Datenbank: beißt der Vergleich noch — und lässt er das
     * Schema wachsen? Jeder Fall läuft in einer eigenen Transaktion, die zurückgerollt wird; der
     * Bestand des Tests bleibt stehen.
     *
     * @param tabelle   eine gemessene Bestands-Tabelle mit Zeilen
     * @param aenderung ein {@code UPDATE}, das mindestens eine bestehende Zeile dieser Tabelle ändert
     */
    static void mutationsprobe(JdbcTemplate db, List<String> ausnahmen, String tabelle, String aenderung) {
        TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(db.getDataSource()));
        tx.executeWithoutResult(status -> {
            status.setRollbackOnly();
            Map<String, String> vorher = fingerabdruck(db, ausnahmen);
            assertThat(vorher.get(tabelle)).as("die Probe braucht Zeilen in " + tabelle).isNotEqualTo(LEER);
            assertThat(db.update(aenderung)).as("die Änderung trifft eine bestehende Zeile").isPositive();
            assertThat(abweichungen(vorher, fingerabdruck(db, ausnahmen))).as("geänderte Bestandszeile")
                    .containsExactly(tabelle + ": bestehender Inhalt geändert");
        });
        tx.executeWithoutResult(status -> {
            status.setRollbackOnly();
            Map<String, String> vorher = fingerabdruck(db, ausnahmen);
            db.execute("ALTER TABLE " + tabelle + " ADD COLUMN bestandsschutz_probe integer");
            assertThat(abweichungen(vorher, fingerabdruck(db, ausnahmen))).as("neue leere Spalte").isEmpty();
            db.update("UPDATE " + tabelle + " SET bestandsschutz_probe = 1");
            assertThat(abweichungen(vorher, fingerabdruck(db, ausnahmen))).as("neue Spalte mit Wert")
                    .containsExactly(tabelle + ": bestehender Inhalt geändert");
        });
        tx.executeWithoutResult(status -> {
            status.setRollbackOnly();
            Map<String, String> vorher = fingerabdruck(db, ausnahmen);
            db.execute("CREATE TABLE bestandsschutz_probe (x integer)");
            assertThat(abweichungen(vorher, fingerabdruck(db, ausnahmen))).as("neue leere Tabelle").isEmpty();
            db.update("INSERT INTO bestandsschutz_probe VALUES (1)");
            assertThat(abweichungen(vorher, fingerabdruck(db, ausnahmen))).as("neue Tabelle mit Inhalt")
                    .containsExactly("bestandsschutz_probe: neue Tabelle mit Inhalt");
        });
        // Die Katalog-Metadaten je Laufzeitstand, auf der echten Tabelle (UEMS AP-05 IP-6b): ein neuer Stand
        // ist keine Abweichung, eine Zeile mehr an einem bestehenden Stand schon.
        tx.executeWithoutResult(status -> {
            status.setRollbackOnly();
            Map<String, String> vorher = fingerabdruck(db, ausnahmen);
            String bestehend = vorher.keySet().stream().filter(k -> k.startsWith(KATALOG_METADATEN + "@"))
                    .findFirst().orElse(null);
            if (bestehend == null) {
                return; // die Metadaten sind ausgenommen oder leer — dann gibt es nichts zu proben
            }
            db.update("INSERT INTO " + KATALOG_METADATEN + " (catalog_version, point_key, aggregation_kind, "
                    + "long_term_cadence_s) VALUES ('9999.12.31.9', 'bestandsschutz.probe', 'gauge', NULL)");
            assertThat(abweichungen(vorher, fingerabdruck(db, ausnahmen))).as("neuer Laufzeitstand").isEmpty();
            db.update("INSERT INTO " + KATALOG_METADATEN + " (catalog_version, point_key, aggregation_kind, "
                    + "long_term_cadence_s) VALUES (?, 'bestandsschutz.probe', 'gauge', NULL)",
                    bestehend.substring(KATALOG_METADATEN.length() + 1));
            assertThat(abweichungen(vorher, fingerabdruck(db, ausnahmen))).as("Zeile an einem bestehenden Stand")
                    .containsExactly(bestehend + ": bestehender Inhalt geändert");
        });
    }

    /**
     * Dieselbe Probe für einen eigenen Ausschnitt aus {@link #inhalt}: eine geänderte Zeile und
     * eine neue Spalte mit Wert ändern ihn, eine neue leere Spalte nicht. Zurückgerollt wie oben.
     *
     * @param finger    misst den Ausschnitt; sein Ergebnis wird mit {@code equals} verglichen
     * @param aenderung ein {@code UPDATE}, das mindestens eine gemessene Zeile von {@code tabelle} ändert
     */
    static void inhaltsprobe(JdbcTemplate db, Supplier<?> finger, String tabelle, String aenderung) {
        TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(db.getDataSource()));
        tx.executeWithoutResult(status -> {
            status.setRollbackOnly();
            Object vorher = finger.get();
            assertThat(db.update(aenderung)).as("die Änderung trifft eine bestehende Zeile").isPositive();
            assertThat(finger.get()).as("geänderte Zeile").isNotEqualTo(vorher);
        });
        tx.executeWithoutResult(status -> {
            status.setRollbackOnly();
            Object vorher = finger.get();
            db.execute("ALTER TABLE " + tabelle + " ADD COLUMN bestandsschutz_probe integer");
            assertThat(finger.get()).as("neue leere Spalte").isEqualTo(vorher);
            db.update("UPDATE " + tabelle + " SET bestandsschutz_probe = 1");
            assertThat(finger.get()).as("neue Spalte mit Wert").isNotEqualTo(vorher);
        });
    }
}
