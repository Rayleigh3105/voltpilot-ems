package com.voltpilot.api.kundenbereich;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BerichtCsv;
import com.voltpilot.api.uems.BerichtRegeln;
import com.voltpilot.api.uems.EnergiemanagementVerzeichnisService;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.io.BufferedWriter;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.UncheckedIOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import javax.sql.DataSource;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Vertragsende II: der Gesamtabzug eines Kundenbereichs (UEMS AP-20 IP-17, E10 = A, BT4, RF-08) —
 * {@code GET /api/v1/unternehmen/abzug}, ein ZIP-Strom, beim Abruf gebildet und auf dem Server nicht gespeichert.
 *
 * <p><b>Inhalt je Objektart</b> (Ordner im Archiv): {@code staende/} die freigegebenen Berichtsstände als JSON, je Datei
 * genau der Text, über den ihre gespeicherte Prüfsumme gebildet ist; {@code verzeichnis/} das Verzeichnis des
 * Energiemanagements (JSON und CSV, wie die Route AP-19 IP-8); {@code berichte/}, {@code nachweise/},
 * {@code messreihen/}, {@code protokolle/}, {@code bestand/} je Tabelle eine CSV. Welche Tabellen, liest der Abzug beim
 * Abruf aus dem Katalog der Datenbank ({@link #TABELLEN}) statt aus einer Liste von Hand: jede Tabelle, die die
 * App-Rolle lesen darf und die entweder {@code tenant_id} trägt (dann mit ausdrücklichem Filter auf den Kundenbereich)
 * oder unter erzwungener Zeilensicherheit steht. Eine neue Tabelle ist damit ohne Pflege dabei — nichts fällt still
 * heraus. Ausgelassen werden nur Spalten mit Zugangsdaten ({@link #ZUGANGSDATEN}); das Manifest nennt jede.
 *
 * <p><b>Manifest:</b> {@code manifest.json} nach allen Daten — je Datei Pfad, Objektart, Quelle, Zeilen, Bytes und
 * SHA-256 über die Bytes im Archiv; {@code pruefsummen.sha256} dieselben Summen im Format von {@code sha256sum -c},
 * dazu die des Manifests. Ein abgebrochener Strom hat kein Manifest und ist daran zu erkennen.
 *
 * <p><b>Strom ohne Speicher-Spitze:</b> alles liest EINE nur lesende Transaktion ({@code REPEATABLE READ}, ein
 * Datenstand für alle Dateien), jede Tabelle über einen Cursor ({@link #ZEILEN_JE_ABRUF} Zeilen je Abruf) direkt in den
 * Antwort-Strom — keine Datei, keine Liste, kein Puffer über eine Zeile hinaus.
 *
 * <p><b>Protokoll:</b> {@code kundenbereich_abzug} — der Beginn VOR dem ersten Byte (scheitert er, verlässt keine Datei
 * den Server), der Abschluss mit der SHA-256 des Manifests nach dem letzten. Die Prüfsumme des letzten Abzugs nimmt der
 * Löschnachweis von IP-18 auf. Beides ist Buchführung des Abrufs, kein Schreibweg in die Daten des Kundenbereichs — darum
 * auch im Zustand „beendet".
 */
@Service
public class Gesamtabzug {

    /** Namen von Zugangsdaten ({@link #zugangsdaten}): heute trägt keine Tabelle eines Kundenbereichs eine solche Spalte. */
    static final Pattern ZUGANGSDATEN = Pattern.compile("(?i).*(passw|secret|token|credential|private|psk).*");
    /** Zeilen je Abruf des Cursors: so viel liegt höchstens gleichzeitig im Speicher. */
    static final int ZEILEN_JE_ABRUF = 1_000;
    static final String MANIFEST = "manifest.json";
    static final String PRUEFSUMMEN = "pruefsummen.sha256";
    static final String LIESMICH = "LIESMICH.txt";

    /**
     * Die Tabellen des Kundenbereichs aus dem Katalog: im Schema {@code public}, keine Partition, keine Sicht; nur Spalten,
     * die die App-Rolle lesen darf. {@code mit_mandant} = Spalte {@code tenant_id}; {@code zaun} = Zeilensicherheit an
     * und erzwungen.
     */
    static final String TABELLEN = """
            SELECT c.relname AS tabelle,
                   EXISTS (SELECT 1 FROM pg_attribute m WHERE m.attrelid = c.oid AND m.attname = 'tenant_id'
                           AND NOT m.attisdropped) AS mit_mandant,
                   (c.relrowsecurity AND c.relforcerowsecurity) AS zaun
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
               AND has_any_column_privilege(c.oid, 'SELECT')
             ORDER BY c.relname
            """;
    static final String SPALTEN = """
            SELECT a.attname AS spalte, t.typcategory AS kategorie, t.typname AS typ
              FROM pg_attribute a
              JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_type t ON t.oid = a.atttypid
             WHERE n.nspname = 'public' AND c.relname = ? AND a.attnum > 0 AND NOT a.attisdropped
               AND has_column_privilege(c.oid, a.attnum, 'SELECT')
             ORDER BY a.attnum
            """;

    private final JdbcTemplate jdbc;
    private final JdbcTemplate strom;
    private final TransactionTemplate lesen;
    private final ObjectProvider<EnergiemanagementVerzeichnisService> verzeichnis;
    private final ObjectProvider<KundenbereichEndeRepository> ende;
    private final ObjectMapper json;

    public Gesamtabzug(JdbcTemplate jdbc, @Qualifier("dataSource") DataSource dataSource,
            PlatformTransactionManager transaktionen, ObjectProvider<EnergiemanagementVerzeichnisService> verzeichnis,
            ObjectProvider<KundenbereichEndeRepository> ende, ObjectMapper json) {
        this.jdbc = jdbc;
        this.strom = new JdbcTemplate(dataSource);
        this.strom.setFetchSize(ZEILEN_JE_ABRUF);
        this.lesen = new TransactionTemplate(transaktionen);
        this.lesen.setReadOnly(true);
        this.lesen.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        this.lesen.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.verzeichnis = verzeichnis;
        this.ende = ende;
        this.json = json;
    }

    /** Ein begonnener Abruf: seine Protokollzeile steht schon. */
    public record Abruf(UUID id, UUID kundenbereich, String name, Instant begonnenAm, ProtokollAkteur wer,
            Optional<KundenbereichEnde> beendet) {

        /** Der Dateiname für den Kunden: {@code gesamtabzug-<Tag des Abrufs>.zip}. */
        public String dateiname() {
            return "gesamtabzug-" + begonnenAm.atZone(KundenbereichEnde.ZONE).toLocalDate() + ".zip";
        }
    }

    /** Was abgeschlossen im Protokoll steht. */
    public record Ergebnis(int dateien, long zeilen, long bytes, String manifestSha256) {}

    /** Eine Datei des Archivs, wie das Manifest sie nennt. */
    record Eintrag(String pfad, String objektart, String quelle, String format, long zeilen, long bytes, String sha256,
            String pruefsumme, List<String> ausgelassen) {}

    /**
     * Schritt 1, vor dem ersten Byte: die Protokollzeile „begonnen". Scheitert sie, verlässt keine Datei den Server.
     */
    public Abruf beginnen(UUID kundenbereich, ProtokollAkteur wer) {
        Optional<KundenbereichEnde> beendet = Optional.ofNullable(ende.getIfAvailable())
                .flatMap(r -> r.beendet(kundenbereich));
        String name = jdbc.queryForObject("SELECT name FROM tenant WHERE id = ?", String.class, kundenbereich);
        Map<String, Object> zeile = jdbc.queryForMap("INSERT INTO kundenbereich_abzug "
                + "(tenant_id, akteur_sub, akteur_name, zustand) VALUES (?, ?, ?, ?) RETURNING id, begonnen_am",
                kundenbereich, wer.sub(), wer.name(), beendet.isPresent() ? "beendet" : "aktiv");
        Instant begonnen = ((java.sql.Timestamp) zeile.get("begonnen_am")).toInstant();
        return new Abruf((UUID) zeile.get("id"), kundenbereich, name, begonnen, wer, beendet);
    }

    /**
     * Schritt 2: der Abzug in den Strom — Daten, Hinweis, Manifest, Prüfsummen — und danach der Abschluss im Protokoll.
     * Der Strom wird nicht geschlossen (das tut der Container).
     */
    public Ergebnis schreiben(Abruf abruf, OutputStream out) throws IOException {
        ZipOutputStream zip = new ZipOutputStream(new NichtSchliessen(out), StandardCharsets.UTF_8);
        zip.setLevel(Deflater.BEST_SPEED);
        List<Eintrag> eintraege = new ArrayList<>();
        try {
            lesen.executeWithoutResult(status -> {
                strom.execute("SET LOCAL TimeZone TO 'UTC'");
                try {
                    verzeichnis(abruf, zip, eintraege);
                    staende(abruf, zip, eintraege);
                    for (Map<String, Object> t : strom.queryForList(TABELLEN)) {
                        String tabelle = (String) t.get("tabelle");
                        boolean mitMandant = Boolean.TRUE.equals(t.get("mit_mandant"));
                        if (mitMandant || Boolean.TRUE.equals(t.get("zaun"))) {
                            tabelle(abruf, tabelle, mitMandant, zip, eintraege);
                        }
                    }
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            });
        } catch (UncheckedIOException e) {
            throw e.getCause();
        }
        eintraege.add(datei(zip, LIESMICH, "hinweis", "VoltPilot", "text",
                liesmich(abruf).getBytes(StandardCharsets.UTF_8), 0, null));
        long zeilen = eintraege.stream().mapToLong(Eintrag::zeilen).sum();
        long bytes = eintraege.stream().mapToLong(Eintrag::bytes).sum();
        byte[] manifest = json.writerWithDefaultPrettyPrinter().writeValueAsBytes(manifest(abruf, eintraege, zeilen, bytes));
        String manifestSha = sha256(manifest);
        putDatei(zip, MANIFEST, manifest);
        StringBuilder summen = new StringBuilder();
        for (Eintrag e : eintraege) {
            summen.append(e.sha256()).append("  ").append(e.pfad()).append('\n');
        }
        summen.append(manifestSha).append("  ").append(MANIFEST).append('\n');
        putDatei(zip, PRUEFSUMMEN, summen.toString().getBytes(StandardCharsets.UTF_8));
        zip.finish();
        zip.flush();
        Ergebnis ergebnis = new Ergebnis(eintraege.size() + 1, zeilen, bytes + manifest.length, manifestSha);
        jdbc.update("UPDATE kundenbereich_abzug SET abgeschlossen_am = greatest(now(), begonnen_am), dateien = ?, "
                + "zeilen = ?, bytes = ?, manifest_sha256 = ? WHERE id = ?",
                ergebnis.dateien(), ergebnis.zeilen(), ergebnis.bytes(), ergebnis.manifestSha256(), abruf.id());
        return ergebnis;
    }

    /** Das Verzeichnis des Energiemanagements am Abruf (AP-19 IP-8) — dieselben Zeilen wie die Seite. */
    private void verzeichnis(Abruf abruf, ZipOutputStream zip, List<Eintrag> eintraege) throws IOException {
        EnergiemanagementVerzeichnisService dienst = verzeichnis.getIfAvailable();
        if (dienst == null) {
            return;
        }
        var v = dienst.lesen(null, null, null, null);
        long zeilen = v.gruppen().stream().mapToLong(g -> g.zeilen().size()).sum();
        eintraege.add(datei(zip, "verzeichnis/verzeichnis.json", "verzeichnis", "Verzeichnis des Energiemanagements",
                "json", json.writerWithDefaultPrettyPrinter().writeValueAsBytes(v), zeilen, null));
        eintraege.add(datei(zip, "verzeichnis/verzeichnis.csv", "verzeichnis", "Verzeichnis des Energiemanagements",
                "csv", EnergiemanagementVerzeichnisService.csv(v), zeilen, null));
    }

    /**
     * Die freigegebenen Berichtsstände (AP-12): je Stand der gespeicherte Text als Datei — seine SHA-256 im Manifest ist
     * die gespeicherte Prüfsumme ohne Vorsatz, jede Person kann sie nachrechnen.
     */
    private void staende(Abruf abruf, ZipOutputStream zip, List<Eintrag> eintraege) {
        strom.query("SELECT b.kennung, s.nr, s.abzug, s.pruefsumme FROM bericht_stand s "
                + "JOIN bericht b ON b.id = s.bericht_id AND b.tenant_id = s.tenant_id "
                + "WHERE s.tenant_id = ? ORDER BY b.kennung, s.nr", rs -> {
                    String pfad = "staende/" + dateiname(rs.getString("kennung")) + "-stand-" + rs.getInt("nr") + ".json";
                    try {
                        eintraege.add(datei(zip, pfad, "staende", "Berichtsstand " + rs.getString("kennung") + " Nr. "
                                + rs.getInt("nr"), "json", rs.getString("abzug").getBytes(StandardCharsets.UTF_8), 1,
                                rs.getString("pruefsumme")));
                    } catch (IOException e) {
                        throw new UncheckedIOException(e);
                    }
                }, abruf.kundenbereich());
    }

    /** Eine Tabelle als CSV über den Cursor: Kopfzeile mit den Spaltennamen, dann eine Zeile je Datensatz. */
    private void tabelle(Abruf abruf, String tabelle, boolean mitMandant, ZipOutputStream zip, List<Eintrag> eintraege)
            throws IOException {
        List<String> spalten = new ArrayList<>();
        List<Boolean> text = new ArrayList<>();
        List<String> ausgelassen = new ArrayList<>();
        strom.query(SPALTEN, rs -> {
            String s = rs.getString("spalte");
            if (zugangsdaten(s, rs.getString("kategorie"), rs.getString("typ"))) {
                ausgelassen.add(s);
            } else {
                spalten.add(s);
                text.add("S".equals(rs.getString("kategorie")));
            }
        }, tabelle);
        if (spalten.isEmpty()) {
            return;
        }
        String objektart = objektart(tabelle);
        String pfad = objektart + "/" + tabelle + ".csv";
        String sql = "SELECT " + String.join(", ", spalten.stream().map(Gesamtabzug::name).toList())
                + " FROM public." + name(tabelle) + (mitMandant ? " WHERE tenant_id = ?" : "");
        zip.putNextEntry(eintrag(pfad, abruf));
        Zaehler z = new Zaehler(zip);
        Writer w = new BufferedWriter(new OutputStreamWriter(z, StandardCharsets.UTF_8), 64 * 1024);
        w.write(BerichtCsv.BOM);
        w.write(csvZeile(spalten, null));
        long[] zeilen = {0};
        String[] zelle = new String[spalten.size()];
        Object[] args = mitMandant ? new Object[] {abruf.kundenbereich()} : new Object[0];
        strom.query(sql, (ResultSet rs) -> {
            for (int i = 0; i < zelle.length; i++) {
                zelle[i] = rs.getString(i + 1);
            }
            try {
                w.write(csvZeile(Arrays.asList(zelle), text));
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
            zeilen[0]++;
        }, args);
        w.flush();
        zip.closeEntry();
        eintraege.add(new Eintrag(pfad, objektart, "Tabelle " + tabelle, "csv", zeilen[0], z.bytes, z.sha256(), null,
                List.copyOf(ausgelassen)));
    }

    /**
     * Eine Spalte mit Zugangsdaten: der Name nennt ein Geheimnis UND sie trägt Text oder Bytes — ein Merker wie
     * {@code ocpp_configuration_key.secret} (boolean) ist keins und bleibt drin.
     */
    static boolean zugangsdaten(String spalte, String kategorie, String typ) {
        return ZUGANGSDATEN.matcher(spalte).matches() && ("S".equals(kategorie) || "bytea".equals(typ));
    }

    /**
     * Die Objektart einer Tabelle — der Ordner im Archiv. Protokolle zuerst (auch die der Berichte), dann Berichte,
     * Nachweise des Energiemanagements, Messreihen; alles andere ist Bestand (Orte, Messstellen, Geräte, Einstellungen).
     */
    static String objektart(String tabelle) {
        if (tabelle.endsWith("_aenderung") || tabelle.endsWith("_protokoll") || tabelle.endsWith("_uebergang")
                || tabelle.endsWith("_audit") || tabelle.equals("bericht_abruf") || tabelle.equals("kundenbereich_abzug")) {
            return "protokolle";
        }
        if (tabelle.startsWith("bericht")) {
            return "berichte";
        }
        if (tabelle.startsWith("energiemanagement_") || tabelle.startsWith("internes_audit")
                || tabelle.startsWith("feststellung") || tabelle.startsWith("managementbewertung")) {
            return "nachweise";
        }
        if (tabelle.startsWith("messreihe_") || tabelle.startsWith("telemetry") || tabelle.startsWith("device_measurement_")
                || tabelle.equals("ocpp_meter_sample")) {
            return "messreihen";
        }
        return "bestand";
    }

    private Map<String, Object> manifest(Abruf abruf, List<Eintrag> eintraege, long zeilen, long bytes) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("art", "voltpilot-gesamtabzug");
        m.put("fassung", 1);
        m.put("kundenbereich", Map.of("id", abruf.kundenbereich().toString(), "name", abruf.name()));
        m.put("zustand", abruf.beendet().isPresent() ? "beendet" : "aktiv");
        m.put("beendet_am", abruf.beendet().map(e -> e.beendetAmTag().toString()).orElse(null));
        m.put("loeschung_fruehestens", abruf.beendet().map(e -> e.loeschungFruehestens().toString()).orElse(null));
        m.put("gebildet_am", abruf.begonnenAm().toString());
        m.put("gebildet_fuer", abruf.wer().name());
        m.put("hinweis", "Beim Abruf gebildet, auf dem Server nicht gespeichert. sha256 ist die SHA-256 über die Bytes der "
                + "Datei im Archiv; pruefsumme ist die in VoltPilot gespeicherte Prüfsumme des Berichtsstands.");
        Map<String, Object> csv = new LinkedHashMap<>();
        csv.put("kodierung", "UTF-8 mit BOM");
        csv.put("trenner", BerichtRegeln.CSV_TRENNER);
        csv.put("zeilenende", "CRLF");
        csv.put("zeitpunkte", "UTC");
        csv.put("formelschutz", "Textzellen, die mit = + - @ beginnen, tragen ein vorangestelltes '");
        m.put("csv", csv);
        List<Map<String, Object>> dateien = new ArrayList<>();
        for (Eintrag e : eintraege) {
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("pfad", e.pfad());
            d.put("objektart", e.objektart());
            d.put("quelle", e.quelle());
            d.put("format", e.format());
            d.put("zeilen", e.zeilen());
            d.put("bytes", e.bytes());
            d.put("sha256", e.sha256());
            if (e.pruefsumme() != null) {
                d.put("pruefsumme", e.pruefsumme());
            }
            if (e.ausgelassen() != null && !e.ausgelassen().isEmpty()) {
                d.put("ausgelassen", e.ausgelassen().stream()
                        .map(s -> Map.of("spalte", s, "grund", "Zugangsdaten")).toList());
            }
            dateien.add(d);
        }
        m.put("dateien", dateien);
        m.put("summe", Map.of("dateien", eintraege.size(), "zeilen", zeilen, "bytes", bytes));
        return m;
    }

    private static String liesmich(Abruf abruf) {
        String tag = abruf.begonnenAm().atZone(KundenbereichEnde.ZONE).toLocalDate().toString();
        return String.join("\r\n",
                "Gesamtabzug " + abruf.name(),
                "",
                "Gebildet am " + tag + " für " + abruf.wer().name() + ", beim Abruf, auf dem Server nicht gespeichert.",
                "",
                "staende/      die freigegebenen Berichtsstände, je Datei genau der Text, über den ihre Prüfsumme gebildet ist",
                "verzeichnis/  das Verzeichnis Ihres Energiemanagements (JSON und CSV)",
                "berichte/, nachweise/, messreihen/, protokolle/, bestand/  je Tabelle eine CSV-Datei",
                "",
                "manifest.json nennt jede Datei mit Zeilen, Bytes und SHA-256. pruefsummen.sha256 enthält dieselben",
                "Prüfsummen und die des Manifests; prüfen mit: sha256sum -c pruefsummen.sha256",
                "",
                "CSV: UTF-8 mit BOM, Trenner Semikolon, Zeilenende CRLF, Zeitpunkte in UTC. Textzellen, die mit",
                "= + - @ beginnen, tragen ein vorangestelltes Hochkomma.",
                "",
                "Bewahren Sie den Abzug selbst auf.", "");
    }

    private Eintrag datei(ZipOutputStream zip, String pfad, String objektart, String quelle, String format, byte[] inhalt,
            long zeilen, String pruefsumme) throws IOException {
        putDatei(zip, pfad, inhalt);
        return new Eintrag(pfad, objektart, quelle, format, zeilen, inhalt.length, sha256(inhalt), pruefsumme, List.of());
    }

    private static void putDatei(ZipOutputStream zip, String pfad, byte[] inhalt) throws IOException {
        ZipEntry e = new ZipEntry(pfad);
        zip.putNextEntry(e);
        zip.write(inhalt);
        zip.closeEntry();
    }

    private static ZipEntry eintrag(String pfad, Abruf abruf) {
        ZipEntry e = new ZipEntry(pfad);
        e.setTime(abruf.begonnenAm().toEpochMilli());
        return e;
    }

    /** Eine CSV-Zeile wie die Berichts-CSV: Trenner {@code ;}, Anführung bei Bedarf, Formelschutz nur an Textzellen. */
    static String csvZeile(List<String> zellen, List<Boolean> text) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < zellen.size(); i++) {
            if (i > 0) {
                b.append(BerichtRegeln.CSV_TRENNER);
            }
            String s = zellen.get(i);
            if (s == null) {
                continue;
            }
            if ((text == null || text.get(i)) && !s.isEmpty() && "=+-@".indexOf(s.charAt(0)) >= 0) {
                s = "'" + s;
            }
            if (s.contains(BerichtRegeln.CSV_TRENNER) || s.contains("\"") || s.contains("\n") || s.contains("\r")) {
                b.append('"').append(s.replace("\"", "\"\"")).append('"');
            } else {
                b.append(s);
            }
        }
        return b.append(BerichtCsv.ZEILENENDE).toString();
    }

    private static String name(String bezeichner) {
        return "\"" + bezeichner.replace("\"", "\"\"") + "\"";
    }

    private static String dateiname(String s) {
        return s.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    static String sha256(byte[] inhalt) {
        return HexFormat.of().formatHex(digest().digest(inhalt));
    }

    private static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 fehlt in dieser JVM", e);
        }
    }

    /** Zählt und prüfsummiert, was in einen Eintrag geht; schließt den ZIP-Strom nie. */
    private static final class Zaehler extends FilterOutputStream {
        private final MessageDigest sha = digest();
        private long bytes;

        Zaehler(OutputStream out) {
            super(out);
        }

        @Override
        public void write(int b) throws IOException {
            out.write(b);
            sha.update((byte) b);
            bytes++;
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            out.write(b, off, len);
            sha.update(b, off, len);
            bytes += len;
        }

        @Override
        public void close() {
            // der Eintrag endet mit closeEntry, nicht mit close
        }

        String sha256() {
            return HexFormat.of().formatHex(sha.digest());
        }
    }

    /** Der Antwort-Strom gehört dem Container: {@code finish} schreibt das Verzeichnis des Archivs, {@code close} nie. */
    private static final class NichtSchliessen extends FilterOutputStream {
        NichtSchliessen(OutputStream out) {
            super(out);
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            out.write(b, off, len);
        }

        @Override
        public void close() throws IOException {
            out.flush();
        }
    }
}
