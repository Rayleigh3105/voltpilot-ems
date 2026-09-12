package com.voltpilot.writer;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Der NACHSCHLAG der Herkunft je Messwert — <b>ZUR MESSZEIT, nie zur Verarbeitungszeit</b>
 * (UEMS AP-07 IP-7, Vertrag {@code docs/contracts/v2/messwert-herkunft.md} §3).
 *
 * <p>Er holt die FAKTEN, die {@link MesswertHerkunft#stelleFest} braucht: die Komponente aus der
 * Auswahl, das Gerät samt Einbau aus der Gerät-Historie (AP-04), die Einstellungs-Fassung aus der
 * Zustellung des Mess-Plans, die Wertart aus Katalog bzw. Vorlage und die Rolle aus Quellenbindung
 * (AP-04) und Zuständigkeit der Datenquelle (AP-06). Ein gepufferter Wert, der Stunden später
 * eintrifft, sieht damit das Gerät, die Fassung und die Zuständigkeit, die <b>damals</b> galten.
 *
 * <h2>Gecacht wird die ZEITLEISTE, nicht die Antwort</h2>
 *
 * Ein Cache auf „Antwort zur Messzeit“ träfe nie (jeder Wert hat eine andere Messzeit). Darum
 * liegt je Komponente, Datenquelle und Messkanal die GANZE Zeitleiste im Speicher, und die
 * Messzeit wird IM SPEICHER aufgelöst. Die Zahl der Abfragen wächst damit mit der Zahl der
 * Komponenten, nicht mit der Zahl der Werte: ein Umschlag mit 200 Werten derselben Komponente
 * fragt genauso oft wie einer mit 2. Jede Leseform zählt in
 * {@code voltpilot_writer_herkunft_nachschlag_total{nachschlag,ergebnis}} — {@code ergebnis} ist
 * {@code abfrage} (SQL) oder {@code treffer} (aus dem Cache); der Nachweis der Abfragezahl ist
 * genau diese Metrik.
 *
 * <h2>⚠ Ein Fehler im Nachschlag darf NIE einen Messwert kosten</h2>
 *
 * Jeder Nachschlag läuft in einem EIGENEN SAVEPOINT innerhalb der Schreib-Transaktion (dasselbe
 * Muster wie {@link MessreiheEreignisRepository#spiegeln}). Schlägt er fehl, wird nur er
 * zurückgerollt, geloggt und gezählt ({@code ergebnis="fehler"}), und {@link #beurteilen} gibt
 * {@code null} zurück: der Wert geht dann den BESTANDSWEG und wird ohne Herkunftsspalten
 * gespeichert. Ein Wert ohne nachgeschlagene Herkunft ist richtig — ein verlorener Wert wäre
 * Datenverlust beim Kunden.
 */
@Component
public class HerkunftNachschlag {

    private static final Logger log = LoggerFactory.getLogger(HerkunftNachschlag.class);

    static final String METRIK = "voltpilot.writer.herkunft.nachschlag";

    /** Wie lange eine Zeitleiste im Speicher gilt; danach wird sie neu gelesen. */
    static final long CACHE_TTL_MS = 60_000L;

    /** Wie viele Zeitleisten höchstens im Speicher liegen (LRU je Writer-Instanz). */
    static final int CACHE_EINTRAEGE = 4_096;

    /**
     * Die Wertarten des Herkunftsvertrags (AP-07 E12, {@code messwert-herkunft.schema.json}).
     * Der Katalog kennt zusätzlich {@code event} und {@code none} — beide sind KEINE Wertart, und
     * {@code value_kind} wird deshalb nie aus {@code aggregation_kind} abgeschrieben (IP-6).
     * Zwilling: {@code services/api/.../measurement/MesskanalAbbildung.WERTARTEN}.
     */
    static final Set<String> WERTARTEN = Set.of("counter", "gauge", "state", "bitfield", "text");

    private final JdbcTemplate jdbc;
    private final TransactionTemplate savepoint;
    private final MeterRegistry meters;
    private final Map<String, Eintrag> cache;

    public HerkunftNachschlag(JdbcTemplate jdbc, PlatformTransactionManager transactions,
            MeterRegistry meters) {
        this.jdbc = jdbc;
        this.meters = meters;
        this.savepoint = new TransactionTemplate(transactions);
        this.savepoint.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
        this.cache = Collections.synchronizedMap(new LinkedHashMap<>(256, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Eintrag> eldest) {
                return size() > CACHE_EINTRAEGE;
            }
        });
    }

    private record Eintrag(Object wert, long gueltigBis) {}

    // ------------------------------------------------------------------ Ergebnisformen

    /**
     * Die Reihe eines Messwerts (E2): Komponente + Datenquelle + deren Lesetakt.
     *
     * @param entityId {@code null}, wenn die Auswahl die Komponente nicht EINDEUTIG nennt
     * @param dataSourceId {@code null}, wenn die Komponente an keiner Datenquelle hängt — dann ist
     *     der Wert ein Bestandswert und dieses Paket rührt ihn nicht an
     */
    public record Reihe(UUID entityId, UUID dataSourceId, long kadenzS) {
        boolean uems() {
            return entityId != null && dataSourceId != null;
        }
    }

    /** Das Urteil samt der Schlüssel, die der Schreibweg und die Ereignisse brauchen. */
    public record Urteil(MesswertHerkunft.Ergebnis ergebnis, UUID entityId, UUID geraetId,
            UUID dataSourceId, UUID messstelleId, String zustaendigeBox) {}

    /** Was der Schreibweg je Wert hereingibt. */
    public record Eingang(MeasurementRawEvent event, Reihe reihe, String pointKey, String template,
            Instant messzeit, Object raw, Object decoded, String qualitaet, String aggregationKind,
            MesswertHerkunft.VorherigerUmschlag vorherigerUmschlag,
            List<MesswertHerkunft.Gespeichert> gespeichert) {}

    private record Einbauzeile(Instant ab, Instant bis, UUID geraetId, String kennzeichen,
            String einbau, String seriennummer) {}

    private record Zeitraum(Instant ab, Instant bis, UUID id, String wort) {}

    private record Fassungszeile(Instant ab, long fassung) {}

    // ------------------------------------------------------------------ Die Reihe

    /**
     * Komponente, Datenquelle und Lesetakt zu {@code (Box, Messkanal)} — EIN gecachter Nachschlag
     * je Messkanal, unabhängig von der Zahl der Werte.
     *
     * <p>Die Komponente folgt nur, wo sie EINDEUTIG folgt (dieselbe Regel wie der Bestands-Nachtrag
     * von IP-6): zu {@code (device_id, point_key)} steht GENAU EINE Auswahlzeile, und die nennt
     * eine Komponente. Zwei baugleiche Geräte hinter einer Box oder eine Zeile mit
     * {@code entity_id IS NULL} lassen offen, für welche Komponente gelesen wurde — dann bleibt
     * die Reihe leer, nie geraten.
     */
    public Reihe reihe(MeasurementRawEvent event, String pointKey, String template) {
        String schluessel = "reihe|" + event.tenant_id() + "|" + event.device_id() + "|" + pointKey;
        try {
            return savepoint.execute(status -> reiheLesen(schluessel, event, pointKey, template));
        } catch (RuntimeException ex) {
            zaehlen("reihe", "fehler");
            log.error("Nachschlag der Reihe für Box {} / {} fehlgeschlagen; auf den Savepoint "
                    + "zurückgerollt, der Wert geht den Bestandsweg", event.device_id(), pointKey, ex);
            return new Reihe(null, null, 0L);
        }
    }

    private Reihe reiheLesen(String schluessel, MeasurementRawEvent event, String pointKey,
            String template) {
        return holen(schluessel, "reihe", () -> jdbc.query(
                "WITH a AS (SELECT count(*) AS n, count(entity_id) AS ne, "
                        + "(array_agg(entity_id))[1] AS eid FROM device_measurement_selection "
                        + "WHERE device_id=? AND point_key IN (?,?)) "
                        + "SELECT CASE WHEN a.n=1 AND a.ne=1 THEN a.eid END AS entity_id, "
                        + "mp.data_source_id, ds.kadenz_s FROM a "
                        + "LEFT JOIN measurement_point mp ON a.n=1 AND a.ne=1 AND mp.id=a.eid "
                        + "LEFT JOIN data_source ds ON ds.id=mp.data_source_id",
                (rs, n) -> new Reihe(uuid(rs, "entity_id"), uuid(rs, "data_source_id"),
                        rs.getObject("kadenz_s") == null ? 0L : rs.getLong("kadenz_s")),
                event.device_id(), pointKey, template).stream().findFirst()
                .orElse(new Reihe(null, null, 0L)));
    }

    // ------------------------------------------------------------------ Das Urteil

    /**
     * Schlägt die Herkunft ZUR MESSZEIT nach und stellt das Urteil des Vertrags fest.
     * Gibt {@code null} zurück, wenn ein Nachschlag scheitert — der Wert geht dann den
     * Bestandsweg, er geht NIE verloren.
     */
    public Urteil beurteilen(Eingang e) {
        try {
            return savepoint.execute(status -> urteilen(e));
        } catch (RuntimeException ex) {
            zaehlen("beurteilen", "fehler");
            log.error("Herkunfts-Nachschlag für Komponente {} / {} zur Messzeit {} fehlgeschlagen; "
                            + "auf den Savepoint zurückgerollt, der Wert wird ohne Herkunft "
                            + "gespeichert", e.reihe().entityId(), e.pointKey(), e.messzeit(), ex);
            return null;
        }
    }

    private Urteil urteilen(Eingang e) {
        MeasurementRawEvent ev = e.event();
        UUID entityId = e.reihe().entityId();
        String box = ev.device_id().toString();

        Einbauzeile einbau = einbauZurMesszeit(ev.tenant_id(), entityId, e.messzeit());
        Long fassung = fassungZurMesszeit(ev, e.pointKey(), e.template(), e.messzeit());
        Zeitraum zustaendig = zustaendigZurMesszeit(ev.tenant_id(), e.reihe().dataSourceId(),
                e.messzeit());
        Zeitraum bindung = bindungZurMesszeit(ev.tenant_id(), entityId, e.pointKey(), e.template(),
                e.messzeit());
        String zustaendigeBox = zustaendig == null ? null : zustaendig.id().toString();
        Instant unassignedZuletzt = box.equals(zustaendigeBox) ? null
                : unassignedReaderZuletzt(ev.tenant_id(), ev.device_id(), e.reihe().dataSourceId());

        MesswertHerkunft.Fakten fakten = new MesswertHerkunft.Fakten(
                entityId.toString(),
                null,
                wertart(e.aggregationKind()),
                e.reihe().kadenzS(),
                einbau == null ? null
                        : new MesswertHerkunft.Einbau(einbau.kennzeichen(), einbau.einbau(),
                                einbau.seriennummer()),
                fassung == null ? null : Math.toIntExact(fassung),
                e.reihe().dataSourceId().toString(),
                zustaendigeBox,
                bindung == null
                        ? new MesswertHerkunft.Quellenbindung(MesswertHerkunft.Bindung.KEINE, null)
                        : new MesswertHerkunft.Quellenbindung(
                                MesswertHerkunft.Bindung.vonCode(bindung.wort()),
                                bindung.id().toString()),
                e.gespeichert() == null ? List.of() : e.gespeichert(),
                e.vorherigerUmschlag(),
                unassignedZuletzt);

        // Die Box liefert weder Komponente noch Fassung (measurements.raw 1.0) - beide kommen
        // ausdrücklich aus dem Nachschlag; der Umschlag trägt sie deshalb als `null`.
        MesswertHerkunft.Lieferung lieferung = new MesswertHerkunft.Lieferung(
                ev.tenant_id().toString(),
                new MesswertHerkunft.Box(box, null),
                new MesswertHerkunft.Umschlag(ev.sequence(), ev.observed_at(),
                        ev.catalog_version(), null),
                new MesswertHerkunft.Messung(null, e.pointKey(), e.messzeit(), e.raw(),
                        e.decoded(), e.qualitaet()),
                ev.ingested_at());

        MesswertHerkunft.Ergebnis ergebnis =
                MesswertHerkunft.stelleFest(new MesswertHerkunft.Eingang(lieferung, fakten));
        return new Urteil(ergebnis, entityId, einbau == null ? null : einbau.geraetId(),
                e.reihe().dataSourceId(), bindung == null ? null : bindung.id(), zustaendigeBox);
    }

    /**
     * Die Werte, die für dieselbe Reihe und Messzeit schon liegen — die EINZIGE Abfrage, die je
     * Wert entstehen kann, und sie entsteht nur, wenn der Einfügeversuch wirklich abgewiesen wurde
     * (E3). Der Normalfall „neuer Wert“ fragt gar nicht.
     */
    public List<MesswertHerkunft.Gespeichert> gespeichertZurMesszeit(MeasurementRawEvent event,
            UUID entityId, String pointKey, Instant messzeit) {
        try {
            List<MesswertHerkunft.Gespeichert> rows = savepoint.execute(status -> {
                zaehlen("konflikt", "abfrage");
                return jdbc.query("SELECT device_id, role, raw_numeric, raw_text, decoded_numeric, "
                                + "decoded_text, quality, edge_sequence FROM device_measurement_sample "
                                + "WHERE tenant_id=? AND entity_id=? AND point_key=? AND time=?",
                        HerkunftNachschlag::gespeichert,
                        event.tenant_id(), entityId, pointKey, Timestamp.from(messzeit));
            });
            return rows == null ? List.of() : rows;
        } catch (RuntimeException ex) {
            zaehlen("konflikt", "fehler");
            log.error("Nachschlag der schon gespeicherten Werte für {} / {} zur Messzeit {} "
                    + "fehlgeschlagen", entityId, pointKey, messzeit, ex);
            return List.of();
        }
    }

    private static MesswertHerkunft.Gespeichert gespeichert(ResultSet rs, int n) throws SQLException {
        String rolle = rs.getString("role");
        return new MesswertHerkunft.Gespeichert(
                rs.getObject("device_id", UUID.class).toString(),
                // `role IS NULL` = eine Zeile, die IP-6 in die Reihe gehoben hat, ohne Rolle
                // nachzuschlagen. Sie liegt in der ZUSTÄNDIGEN Spur (der partielle Index deckt
                // sie), darum ist Beobachtung die ehrliche Lesart - nie Spiegel.
                rolle == null ? MesswertHerkunft.Rolle.BEOBACHTUNG
                        : MesswertHerkunft.Rolle.vonCode(rolle),
                wert(rs.getBigDecimal("raw_numeric"), rs.getString("raw_text")),
                wert(rs.getBigDecimal("decoded_numeric"), rs.getString("decoded_text")),
                rs.getString("quality"),
                rs.getLong("edge_sequence"));
    }

    private static Object wert(BigDecimal zahl, String text) {
        return zahl != null ? zahl : text;
    }

    // ------------------------------------------------------------------ Die Zeitleisten

    /** Der Einbau, der die Komponente ZUR MESSZEIT speiste (AP-04 Gerät-Historie). */
    private Einbauzeile einbauZurMesszeit(UUID tenant, UUID entityId, Instant messzeit) {
        List<Einbauzeile> zeilen = holen("einbau|" + tenant + "|" + entityId, "einbau",
                () -> jdbc.query("SELECT k.gueltig_ab, k.gueltig_bis, g.id, g.kennzeichen, "
                                + "g.einbau_kennzeichen, g.seriennummer FROM geraet_komponente k "
                                + "JOIN geraet g ON g.id=k.geraet_id AND g.tenant_id=k.tenant_id "
                                + "WHERE k.entity_id=? ORDER BY k.gueltig_ab",
                        (rs, n) -> new Einbauzeile(rs.getTimestamp(1).toInstant(),
                                instant(rs.getTimestamp(2)), rs.getObject(3, UUID.class),
                                rs.getString(4), rs.getString(5), rs.getString(6)),
                        entityId));
        for (Einbauzeile z : zeilen) {
            if (laeuft(z.ab(), z.bis(), messzeit)) {
                return z;
            }
        }
        return null;
    }

    /**
     * Die Zuständigkeit der Datenquelle ZUR MESSZEIT (AP-06) — die Auflösung der bisherigen
     * Nachlieferungs-Sperre (W8): geprüft wird, wer DAMALS las, nicht wer heute liest.
     */
    private Zeitraum zustaendigZurMesszeit(UUID tenant, UUID dataSourceId, Instant messzeit) {
        List<Zeitraum> zeilen = holen("zustaendig|" + tenant + "|" + dataSourceId, "zustaendigkeit",
                () -> jdbc.query("SELECT effective_from, effective_to, device_id "
                                + "FROM data_source_assignment WHERE data_source_id=? "
                                + "ORDER BY effective_from",
                        (rs, n) -> new Zeitraum(rs.getTimestamp(1).toInstant(),
                                instant(rs.getTimestamp(2)), rs.getObject(3, UUID.class), null),
                        dataSourceId));
        for (Zeitraum z : zeilen) {
            if (laeuft(z.ab(), z.bis(), messzeit)) {
                return z;
            }
        }
        return null;
    }

    /** Die Quellenbindung des Messkanals ZUR MESSZEIT (AP-04): führend oder Vergleich. */
    private Zeitraum bindungZurMesszeit(UUID tenant, UUID entityId, String pointKey,
            String template, Instant messzeit) {
        List<Zeitraum> zeilen = holen("bindung|" + tenant + "|" + entityId + "|" + pointKey,
                "bindung",
                () -> jdbc.query("SELECT gueltig_ab, gueltig_bis, messstelle_id, rolle "
                                + "FROM messstelle_quelle WHERE entity_id=? AND kanal IN (?,?) "
                                + "ORDER BY gueltig_ab",
                        (rs, n) -> new Zeitraum(rs.getTimestamp(1).toInstant(),
                                instant(rs.getTimestamp(2)), rs.getObject(3, UUID.class),
                                rs.getString(4)),
                        entityId, pointKey, template));
        for (Zeitraum z : zeilen) {
            if (laeuft(z.ab(), z.bis(), messzeit)) {
                return z;
            }
        }
        return null;
    }

    /**
     * Die Einstellungs-Fassung ZUR MESSZEIT. {@code measurements.raw} 1.0 trägt kein
     * {@code applied_revision} (der Draht-Vertrag bleibt unberührt), also ist es IMMER die zur
     * Messzeit angewendete Fassung der Zustellung — der {@code applied_at}-Zweig des Vertrags
     * ({@code FassungQuelle.ZUSTELLUNG}).
     */
    private Long fassungZurMesszeit(MeasurementRawEvent event, String pointKey, String template,
            Instant messzeit) {
        List<Fassungszeile> zeilen = holen(
                "fassung|" + event.tenant_id() + "|" + event.device_id() + "|" + pointKey, "fassung",
                () -> jdbc.query("SELECT applied_at, desired_revision FROM ("
                                + "SELECT applied_at, desired_revision FROM "
                                + "device_measurement_selection_event WHERE device_id=? "
                                + "AND point_key IN (?,?) AND applied_at IS NOT NULL "
                                // `first_sample` ist die Marke des ERSTEN Werts, keine
                                // Zustellung - sie trägt die Fassung, die schon galt, mit
                                // der Messzeit dieses Werts. Als Fassungs-Eintrag gelesen
                                // würde sie eine spätere Fassung wieder zurückdrehen.
                                + "AND event_kind <> 'first_sample' "
                                + "UNION ALL SELECT applied_at, desired_revision FROM "
                                + "device_measurement_selection WHERE device_id=? "
                                + "AND point_key IN (?,?) AND applied_at IS NOT NULL) z "
                                + "ORDER BY applied_at, desired_revision",
                        (rs, n) -> new Fassungszeile(rs.getTimestamp(1).toInstant(), rs.getLong(2)),
                        event.device_id(), pointKey, template,
                        event.device_id(), pointKey, template));
        Long fassung = null;
        for (Fassungszeile z : zeilen) {
            if (!z.ab().isAfter(messzeit)) {
                fassung = z.fassung();
            }
        }
        return fassung;
    }

    /**
     * Wann zuletzt ein {@code unassigned_reader} dieser Box und Datenquelle angehängt wurde
     * (Eingangszeit) — der Drosselschlüssel „höchstens einmal je Stunde“ des Vertrags.
     */
    private Instant unassignedReaderZuletzt(UUID tenant, UUID device, UUID dataSourceId) {
        return holen("unassigned|" + tenant + "|" + device + "|" + dataSourceId, "unassigned",
                () -> {
                    // ⚠ Kein Optional hier: `max(...)` liefert IMMER eine Zeile, und ihr Wert ist
                    // beim ersten Mal NULL - `findFirst()` über ein null-Element wirft.
                    List<Instant> zeilen = jdbc.query(
                            "SELECT max(eingang) FROM messreihe_ereignis WHERE tenant_id=? "
                                    + "AND art='unassigned_reader' AND device_id=? "
                                    + "AND data_source_id=?",
                            (rs, n) -> instant(rs.getTimestamp(1)), tenant, device, dataSourceId);
                    return zeilen.isEmpty() ? null : zeilen.get(0);
                });
    }

    /** Merkt den gerade angehängten {@code unassigned_reader}, damit die Stunde sofort zählt. */
    void unassignedReaderGemerkt(UUID tenant, UUID device, UUID dataSourceId, Instant eingang) {
        legen("unassigned|" + tenant + "|" + device + "|" + dataSourceId, eingang);
    }

    /** Die Wertart des Vertrags — {@code event} und {@code none} des Katalogs sind keine (E12). */
    static String wertart(String aggregationKind) {
        return aggregationKind != null && WERTARTEN.contains(aggregationKind) ? aggregationKind : null;
    }

    // ------------------------------------------------------------------ Cache

    @SuppressWarnings("unchecked")
    private <T> T holen(String schluessel, String nachschlag, java.util.function.Supplier<T> lesen) {
        Eintrag eintrag = cache.get(schluessel);
        long jetzt = System.currentTimeMillis();
        if (eintrag != null && eintrag.gueltigBis() > jetzt) {
            zaehlen(nachschlag, "treffer");
            return (T) eintrag.wert();
        }
        zaehlen(nachschlag, "abfrage");
        T wert = lesen.get();
        cache.put(schluessel, new Eintrag(wert, jetzt + CACHE_TTL_MS));
        return wert;
    }

    private void legen(String schluessel, Object wert) {
        cache.put(schluessel, new Eintrag(wert, System.currentTimeMillis() + CACHE_TTL_MS));
    }

    /** Nur für Tests: die Zeitleisten neu lesen lassen. */
    void vergessen() {
        cache.clear();
    }

    private void zaehlen(String nachschlag, String ergebnis) {
        Counter.builder(METRIK)
                .description("Herkunfts-Nachschläge des Writers, je Leseform und Ergebnis")
                .tag("nachschlag", nachschlag)
                .tag("ergebnis", ergebnis)
                .register(meters)
                .increment();
    }

    // ------------------------------------------------------------------ Kleinkram

    /** Halboffen auf die Minute: {@code [ab, bis)} — so stehen alle Zeiträume der Verträge. */
    private static boolean laeuft(Instant ab, Instant bis, Instant zeitpunkt) {
        return !zeitpunkt.isBefore(ab) && (bis == null || zeitpunkt.isBefore(bis));
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }

    private static UUID uuid(ResultSet rs, String spalte) throws SQLException {
        return rs.getObject(spalte, UUID.class);
    }
}
