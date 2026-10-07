package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Connection;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Demo-Füllung Verbessern (Konzept Verbessern v1 §4.8, §11.1 PR 6, Entscheid 16) - der letzte Schritt des Rundgangs
 * ({@link DemoRundgangAufbau}), nach dem Bühnen-Bestand bis März 2029 (Auswerten a4). Für {@code rundgang} zeigt
 * Verbessern danach die Referenzwelt {@code docs/contracts/v2/uems-referenzunternehmen.json}: Verantwortliche, Anker,
 * Energieziel, Verläufe, Bewertungen, die drei Auffälligkeiten der Referenz beantwortet und März 2029 offen.
 *
 * <p>Eine frisch gebaute Welt ({@link AhrenbergWelt}) trägt alles außer März 2029 schon selbst; dann schreibt dieser
 * Schritt nur den Vermerk für März 2029. Einen alten Bestand (Welt vor PR 6) gleicht er an - idempotent, ein zweiter
 * Lauf schreibt nichts:
 * <ol>
 *   <li><b>Demo-Korrektur</b> (Captain-Entscheid 07.10.2026, Option A): genau vier Zeilen sind durch die Schutz-Trigger
 *       eingefroren und wichen von der Referenz ab - AW-2026-0001 (Kennzahl, Bezugsbasis, Verantwortlicher, Standort),
 *       M-2028-0001 (Verantwortlicher, Energieziel, Energieeinsatz, Begründung), M-2028-0002 (Herkunft EE-3, Begründung)
 *       und M-2029-0001 (Begründung, Wortlaut). Sie werden als Eigentümer in EINER Transaktion mit
 *       {@code session_replication_role = replica} korrigiert, nur solange sie abweichen. Für alles andere bleiben die
 *       Schutz-Trigger scharf.</li>
 *   <li>Was solange geplant änderbar ist (M-2029-0002 Titel, Termin, Wortlaut; M-2029-0003 Wortlaut): ein einfaches
 *       Update wie „Ändern“, ohne Zeile im Verlauf - die Referenz kennt keine Änderung.</li>
 *   <li>Fehlende Zeilen im Verlauf, der Anstoß K-2028-0001 an M-2028-0001 und die Bewertung von M-2029-0001 sind
 *       Anhänge mit dem Inhalt, den die Routen der Welt schreiben ({@link AhrenbergWelt}), am Tag der Referenz; die
 *       Zeilen, die eine Route der alten Welt am Tag des Aufbaus schrieb, bekommen den Tag ihres Vorgangs.</li>
 * </ol>
 * Was weder Option A noch ein Anhang erreicht, bleibt im alten Bestand stehen: der Standort von AW-2028-0001, die
 * Begründung von EZ-2029-0001 und der Anlagetag von M-2029-0002 (26. statt 29.01.2029). Eine frische Welt hat sie
 * richtig.
 *
 * <p><b>Vor jedem Schreiben</b> wartet der Schritt, bis die Kaskade des Kundenbereichs wirklich leer ist
 * ({@link KorrekturKaskade#offen}; ein Lauf, der die Sperre nicht bekommt, meldet 0 Anlässe - eine mitlaufende Demo-API
 * hält sie oft), und prüft dann mit dem Leser der Naht ({@link BezugsbasisVergleich#fuerNaht}), dass KZ-0004 für jeden
 * Monat von 11/2026 bis 03/2029 einen Wert hat und genau in den Monaten von {@link #SCHLECHTER} „schlechter“ liegt.
 * Sonst bricht der Rundgang ab, ehe er etwas korrigiert oder beantwortet. <b>März 2029</b> (Entscheid 16, nicht in der
 * Referenzdatei) vermerkt die Naht selbst ({@link VerbesserungNaht#vermerken}) an dem Tag, an dem ihr Lauf ihn vermerkt
 * hätte ({@link #MAERZ_2029_VERMERKT}). Damit das trägt, schweigt die Naht während des Rundgangs (sonst vermerkte sie
 * jeden Monat mit der Bühnen-Uhr - Falle „Naht“; mit ihr schweigen die Anstöße am Vorgang, Pfad 1 und 2), und
 * {@code demo.sh rundgang} startet die Demo-API so lange mit stummer Naht ({@code VOLTPILOT_UEMS_VERBESSERUNG_ENABLED=false});
 * weil der Schritt erst nach leerer Kaskade endet, rechnet die API danach keinen Rückstand mit eingeschalteter Naht.
 */
final class DemoVerbessernReferenz {
    private static final UUID TENANT = AhrenbergWelt.AHRENBERG;
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final UUID ST1 = UUID.fromString("20000000-0000-0000-0000-0000000000a1");
    private static final ObjectMapper JSON = new ObjectMapper();
    /** Wann der Lauf März 2029 vermerkt hätte - wie die Referenz Dezember 2027 am 07.01.2028 um 05:12 Uhr. */
    static final String MAERZ_2029_VERMERKT = "2029-04-07T05:12:00+02:00";
    /** Die Monate, in denen KZ-0004 gegen BB-0001 „schlechter“ liegt, mit Δ in Prozent (Referenz; März 2029: Entscheid 16). */
    static final Map<String, String> SCHLECHTER = new TreeMap<>(Map.of("2027-12", "12.9", "2028-07", "2.5", "2029-03", "2.2"));
    /** Die erste und die letzte Monatszeile, die eine Fassung von BB-0001 bewertet. */
    private static final YearMonth AB = YearMonth.of(2026, 11), BIS = YearMonth.of(2029, 3);

    private final JdbcTemplate root;
    private final ApplicationContext ctx;
    private final JsonNode referenz = DemoRundgangAufbau.referenz();
    private final String ik = sub("IK");

    private DemoVerbessernReferenz(MockMvc mvc, JdbcTemplate root) {
        this.root = root;
        this.ctx = mvc.getDispatcherServlet().getWebApplicationContext();
    }

    /** Der Schritt des Rundgangs; meldet, was er geschrieben hat. */
    static void fuellen(MockMvc mvc, JdbcTemplate root) throws Exception {
        new DemoVerbessernReferenz(mvc, root).fuellen();
    }

    /**
     * Nur das Angleichen ohne Monatswerte (Demo-Korrektur, Geplantes, Verläufe, Auffälligkeiten der Referenz) - für den
     * Nachweis, dass eine frische Welt schon so dasteht, wie der Rundgang einen alten Bestand angleicht.
     *
     * @return wie viele Zeilen geschrieben wurden
     */
    static int angleichen(MockMvc mvc, JdbcTemplate root) throws Exception {
        DemoVerbessernReferenz d = new DemoVerbessernReferenz(mvc, root);
        return d.demoKorrektur() + d.geplanteAngleichen() + d.verlaeufe() + d.auffaelligkeiten();
    }

    private void fuellen() throws Exception {
        int gewartet = kaskadeLeerWarten();
        pruefeMonatsreihe();
        int korrigiert = demoKorrektur();
        int angeglichen = geplanteAngleichen();
        int verlauf = verlaeufe();
        auffaelligkeiten();
        boolean maerz = maerz2029();
        pruefeVermerke();
        System.out.println("Rundgang Verbessern: Kaskade leer" + (gewartet > 0 ? " (nach " + gewartet + " s)" : "") + ", "
                + korrigiert + " Zeilen der Demo-Korrektur, " + angeglichen + " geplante Maßnahmen angeglichen, " + verlauf
                + " Zeilen im Verlauf, Auffälligkeiten der Referenz beantwortet, März 2029 "
                + (maerz ? "vermerkt (offen)." : "stand schon."));
    }

    /** Die Auffälligkeiten der Referenz, mit dem Standort, den die Naht setzen würde. */
    private int auffaelligkeiten() {
        KennzahlService kennzahlen = ctx.getBean(KennzahlService.class);
        return AhrenbergWelt.auffaelligkeitenDerReferenz(root, TENANT, referenz, ik,
                (k, am) -> AhrenbergWelt.standortWieDieNaht(kennzahlen, TENANT, k, am));
    }

    /**
     * Bis die Kaskade des Kundenbereichs leer ist: selbst rechnen, wenn die Sperre frei ist, sonst warten (eine
     * mitlaufende Demo-API rechnet mit stummer Naht mit). Danach einmal der Regellauf der Kennzahlen.
     *
     * @return wie viele Sekunden gewartet wurde
     */
    private int kaskadeLeerWarten() throws InterruptedException {
        KorrekturKaskade kaskade = ctx.getBean(KorrekturKaskade.class);
        Instant beginn = Instant.now();
        Instant spaetestens = beginn.plus(Duration.ofMinutes(90));
        int offen;
        while ((offen = kaskade.offen(TENANT)) > 0) {
            if (Instant.now().isAfter(spaetestens)) {
                throw new IllegalStateException("Die Kaskade von Ahrenberg wird nicht leer (" + offen + " Anlässe offen) - "
                        + "erst wenn alle Monate gerechnet sind, darf der Rundgang vermerken.");
            }
            if (kaskade.lauf(Instant.now()).anlaesse() == 0) {
                Thread.sleep(5_000);
            }
        }
        ctx.getBean(KennzahlLauf.class).lauf(Instant.now());
        return (int) Duration.between(beginn, Instant.now()).toSeconds();
    }

    // ================================================================================ 1 Demo-Korrektur (Option A)

    private int demoKorrektur() {
        UUID kz5 = id("kennzahl", "KZ-0005"), bb3 = id("bezugsbasis", "BB-0003"), ez = id("energieziel", "EZ-2028-0001");
        UUID ee1 = id("energieeinsatz", "EE-1"), ee3 = id("energieeinsatz", "EE-3");
        String m1 = umgesetztBegruendung(referenz.at("/massnahmen/0")), m2 = umgesetztBegruendung(referenz.at("/massnahmen/1"));
        JsonNode m29 = referenz.at("/massnahmen_1_10/0");
        String aw = "FROM abweichung WHERE tenant_id = ? AND kennzeichen = 'AW-2026-0001' AND (kennzahl_id, bezugsbasis_id, "
                + "fassung, verantwortlich_sub, verantwortlich_name, standort_id) IS DISTINCT FROM (?, ?, 1, ?, ?, ?)";
        Object[] awWerte = {TENANT, kz5, bb3, sub("JW"), "Jonas Wendlinger", ST1};
        String ma1 = "FROM massnahme WHERE tenant_id = ? AND kennzeichen = 'M-2028-0001' AND (verantwortlich_sub, "
                + "verantwortlich_name, energieziel_id, einsatz_id, einstufung_fassung, umgesetzt_begruendung) IS DISTINCT "
                + "FROM (?, ?, ?, ?, 1, ?)";
        Object[] ma1Werte = {TENANT, sub("MD"), "Murat Demirci", ez, ee1, m1};
        String ma2 = "FROM massnahme WHERE tenant_id = ? AND kennzeichen = 'M-2028-0002' AND (herkunft_art, herkunft_kennung, "
                + "einsatz_id, einstufung_fassung, umgesetzt_begruendung) IS DISTINCT FROM ('einsatz', 'EE-3', ?, 2, ?)";
        Object[] ma2Werte = {TENANT, ee3, m2};
        String ma3 = "FROM massnahme WHERE tenant_id = ? AND kennzeichen = 'M-2029-0001' AND (umgesetzt_begruendung, "
                + "erwartete_wirkung_wortlaut) IS DISTINCT FROM (?, ?)";
        Object[] ma3Werte = {TENANT, m29.path("umgesetzt_begruendung").asText(), m29.at("/erwartete_wirkung/wortlaut").asText()};
        if (zahl("SELECT count(*) " + aw, awWerte) + zahl("SELECT count(*) " + ma1, ma1Werte)
                + zahl("SELECT count(*) " + ma2, ma2Werte) + zahl("SELECT count(*) " + ma3, ma3Werte) == 0) {
            return 0;
        }
        // Im Replica-Modus prüft niemand die Fremdschlüssel: die Ziele vorher selbst (Konten, Standort, Einstufungen).
        pruefeZiele(ee1, ee3);
        int[] n = {0};
        new TransactionTemplate(new DataSourceTransactionManager(root.getDataSource())).executeWithoutResult(t -> {
            // Nur diese vier Zeilen; jeder Wert kommt aus der Referenz oder aus einer Zeile des Kundenbereichs (die
            // Fremdschlüssel prüft im Replica-Modus niemand).
            root.execute("SET LOCAL session_replication_role = replica");
            n[0] += root.update("UPDATE abweichung SET kennzahl_id = ?, bezugsbasis_id = ?, fassung = 1, verantwortlich_sub = ?, "
                    + "verantwortlich_name = ?, verantwortlich_konto = 'benutzer', standort_id = ? WHERE id IN (SELECT id "
                    + aw + ")", kz5, bb3, sub("JW"), "Jonas Wendlinger", ST1, TENANT, kz5, bb3, sub("JW"), "Jonas Wendlinger",
                    ST1);
            n[0] += root.update("UPDATE massnahme SET verantwortlich_sub = ?, verantwortlich_name = ?, energieziel_id = ?, "
                    + "einsatz_id = ?, einstufung_fassung = 1, umgesetzt_begruendung = ? WHERE id IN (SELECT id " + ma1 + ")",
                    sub("MD"), "Murat Demirci", ez, ee1, m1, TENANT, sub("MD"), "Murat Demirci", ez, ee1, m1);
            n[0] += root.update("UPDATE massnahme SET herkunft_art = 'einsatz', herkunft_kennung = 'EE-3', einsatz_id = ?, "
                    + "einstufung_fassung = 2, umgesetzt_begruendung = ? WHERE id IN (SELECT id " + ma2 + ")", ee3, m2,
                    TENANT, ee3, m2);
            n[0] += root.update("UPDATE massnahme SET umgesetzt_begruendung = ?, erwartete_wirkung_wortlaut = ? WHERE id IN "
                    + "(SELECT id " + ma3 + ")", ma3Werte[1], ma3Werte[2], TENANT, ma3Werte[1], ma3Werte[2]);
        });
        return n[0];
    }

    /** Die Ziele der Fremdschlüssel, die die Demo-Korrektur setzt - fehlt eines, bricht sie ab, statt Waisen zu schreiben. */
    private void pruefeZiele(UUID ee1, UUID ee3) {
        List<String> fehlt = new java.util.ArrayList<>();
        for (String wer : List.of("JW", "MD")) {
            if (zahl("SELECT count(*) FROM benutzer WHERE tenant_id = ? AND sub = ?", TENANT, sub(wer)) == 0) {
                fehlt.add("Konto " + AhrenbergWelt.NAMEN.get(wer));
            }
        }
        if (zahl("SELECT count(*) FROM standort WHERE tenant_id = ? AND id = ?", TENANT, ST1) == 0) {
            fehlt.add("Standort ST-1");
        }
        for (Object[] e : List.of(new Object[] {ee1, 1, "EE-1"}, new Object[] {ee3, 2, "EE-3"})) {
            if (zahl("SELECT count(*) FROM energieeinsatz_einstufung WHERE tenant_id = ? AND einsatz_id = ? AND nummer = ?",
                    TENANT, e[0], e[1]) == 0) {
                fehlt.add("Einstufung " + e[2] + " Fassung " + e[1]);
            }
        }
        if (!fehlt.isEmpty()) {
            throw new IllegalStateException("Die Demo-Korrektur bräuchte " + fehlt + " - der Seed weicht ab, nichts geändert.");
        }
    }

    // ================================================================================ 2 Geplante Maßnahmen

    private int geplanteAngleichen() {
        JsonNode m2 = referenz.at("/massnahmen_1_10/1"), m3 = referenz.at("/massnahmen_1_10/2");
        int n = root.update("UPDATE massnahme SET titel = ?, termin = ?::date, erwartete_wirkung_wortlaut = ? WHERE tenant_id = ? "
                + "AND kennzeichen = 'M-2029-0002' AND zustand = 'geplant' AND (titel, termin, erwartete_wirkung_wortlaut) "
                + "IS DISTINCT FROM (?, ?::date, ?)", m2.path("titel").asText(), m2.path("termin").asText(),
                m2.at("/erwartete_wirkung/wortlaut").asText(), TENANT, m2.path("titel").asText(), m2.path("termin").asText(),
                m2.at("/erwartete_wirkung/wortlaut").asText());
        n += root.update("UPDATE massnahme SET erwartete_wirkung_wortlaut = ? WHERE tenant_id = ? AND kennzeichen = "
                + "'M-2029-0003' AND zustand = 'geplant' AND erwartete_wirkung_wortlaut IS DISTINCT FROM ?",
                m3.at("/erwartete_wirkung/wortlaut").asText(), TENANT, m3.at("/erwartete_wirkung/wortlaut").asText());
        // Die Zeile `massnahme_angelegt` nennt Titel und Termin der Anlage - dieselben wie die Maßnahme jetzt.
        n += root.update("UPDATE massnahme_aenderung a SET neu = a.neu || jsonb_build_object('titel', m.titel, 'termin', "
                + "m.termin::text) FROM massnahme m WHERE m.id = a.massnahme_id AND m.tenant_id = ? AND m.kennzeichen = "
                + "'M-2029-0002' AND a.art = 'massnahme_angelegt' AND (a.neu ->> 'titel', a.neu ->> 'termin') IS DISTINCT "
                + "FROM (m.titel, m.termin::text)", TENANT);
        return n;
    }

    // ================================================================================ 3 Verläufe

    private int verlaeufe() throws JsonProcessingException {
        int n = 0;
        // Die Zeilen, die eine Route der alten Welt schrieb, tragen den Tag des Aufbaus: angelegt und umgesetzt am Tag
        // ihres Vorgangs (wie AhrenbergWelt#verlaufAufDieBuehne), nur an den Maßnahmen der Referenz.
        n += root.update("UPDATE massnahme_aenderung a SET created_at = m.angelegt_am FROM massnahme m WHERE m.id = "
                + "a.massnahme_id AND m.tenant_id = ? AND m.kennzeichen IN ('M-2029-0001', 'M-2029-0002', 'M-2029-0003') AND a.art = 'massnahme_angelegt' "
                + "AND a.created_at <> m.angelegt_am", TENANT);
        n += root.update("UPDATE massnahme_aenderung a SET created_at = m.umgesetzt_gemeldet_am FROM massnahme m WHERE m.id = "
                + "a.massnahme_id AND m.tenant_id = ? AND m.kennzeichen IN ('M-2029-0001', 'M-2029-0002', 'M-2029-0003') AND a.art = 'massnahme_umgesetzt' "
                + "AND a.created_at <> m.umgesetzt_gemeldet_am", TENANT);
        // Die Zeile `massnahme_umgesetzt` nennt die Begründung der Maßnahme (nach der Demo-Korrektur von M-2029-0001).
        n += root.update("UPDATE massnahme_aenderung a SET begruendung = m.umgesetzt_begruendung FROM massnahme m WHERE m.id = "
                + "a.massnahme_id AND m.tenant_id = ? AND m.kennzeichen IN ('M-2029-0001', 'M-2029-0002', 'M-2029-0003') AND a.art = 'massnahme_umgesetzt' "
                + "AND a.begruendung IS DISTINCT FROM m.umgesetzt_begruendung", TENANT);

        JsonNode ez = referenz.at("/energieziele/0");
        Map<String, Object> ziel = zielInhalt(ez.path("wortlaut").asText(), "-5.0", "2028-01/2028-12");
        n += zeile("energieziel", "EZ-2028-0001", "energieziel_angelegt", AhrenbergWelt.EZ_2028_ANGELEGT, null, ziel,
                ez.path("begruendung").asText(), null, null, "IK");
        Map<String, Object> bewertet = new LinkedHashMap<>();
        bewertet.put("zustand", "bewertet");
        bewertet.put("bewertung_status", "bewertet");
        bewertet.put("ergebnis", "verfehlt");
        bewertet.put("vorschlag", ez.at("/bewertung/kopie/vorschlag").isTextual() ? ez.at("/bewertung/kopie/vorschlag").asText()
                : null);
        bewertet.put("pruefsumme", ez.at("/bewertung/pruefsumme").asText());
        n += zeile("energieziel", "EZ-2028-0001", "energieziel_bewertet", AhrenbergWelt.EZ_2028_BEWERTET, Map.of("zustand", "offen"),
                bewertet, ez.at("/bewertung/begruendung").asText(), null, null, "IK");
        Map<String, Object> ez29 = root.queryForMap("SELECT wortlaut, begruendung FROM energieziel WHERE tenant_id = ? AND "
                + "kennzeichen = 'EZ-2029-0001'", TENANT);
        n += zeile("energieziel", "EZ-2029-0001", "energieziel_angelegt", AhrenbergWelt.EZ_2029_ANGELEGT, null,
                zielInhalt((String) ez29.get("wortlaut"), "-4.0", "2029-03/2029-12"), (String) ez29.get("begruendung"), null,
                null, "IK");

        n += abweichung(referenz.at("/abweichungen/0"));
        n += abweichung(referenz.at("/abweichungen/1"));

        JsonNode m1 = referenz.at("/massnahmen/0"), m2 = referenz.at("/massnahmen/1");
        n += angelegt("M-2028-0001", m1, "abweichung", "AW-2028-0001", AhrenbergWelt.MASSNAHME_ANGELEGT.get("M-2028-0001"));
        n += umgesetzt("M-2028-0001", m1, AhrenbergWelt.umgesetztGemeldet(m1));
        n += anstoss("M-2028-0001", m1.at("/anstoesse/0"));
        n += bewertet("M-2028-0001", m1.at("/bewertungen/0"), AhrenbergWelt.MASSNAHME_BEWERTET.get("M-2028-0001"));
        n += angelegt("M-2028-0002", m2, "einsatz", "EE-3", AhrenbergWelt.MASSNAHME_ANGELEGT.get("M-2028-0002"));
        n += umgesetzt("M-2028-0002", m2, AhrenbergWelt.umgesetztGemeldet(m2));
        n += bewertet("M-2028-0002", m2.at("/bewertungen/0"), AhrenbergWelt.MASSNAHME_BEWERTET.get("M-2028-0002"));
        n += bewertungM2029();
        return n;
    }

    private static Map<String, Object> zielInhalt(String wortlaut, String zielwert, String zielperiode) {
        Map<String, Object> z = new LinkedHashMap<>();
        z.put("kennzahl", "KZ-0004");
        z.put("bezugsbasis", "BB-0001");
        z.put("fassung", 2);
        z.put("zielwert_prozent", zielwert);
        z.put("zielperiode", zielperiode);
        z.put("wortlaut", wortlaut);
        z.put("verantwortlich_name", "Ines Kaltenbach");
        z.put("zustand", "offen");
        return z;
    }

    /** Eröffnet, Kommentare und Aussagen, abgeschlossen - an den Augenblicken und mit dem Inhalt der Welt. */
    private int abweichung(JsonNode aw) throws JsonProcessingException {
        String k = aw.path("kennzeichen").asText();
        Map<String, Object> eroeffnet = new LinkedHashMap<>();
        eroeffnet.put("zustand", "offen");
        eroeffnet.put("herkunft", "auffaelligkeit");
        eroeffnet.put("monate", List.of(aw.path("monate").get(0).asText()));
        eroeffnet.put("frist", aw.path("frist").asText());
        eroeffnet.put("verantwortlich_name", AhrenbergWelt.NAMEN.get(aw.path("verantwortlich").asText()));
        eroeffnet.put("anlass_pruefsumme", aw.path("pruefsumme").asText());
        int n = zeile("abweichung", k, "abweichung_eroeffnet", AhrenbergWelt.abweichungEroeffnet(aw), null,
                eroeffnet, null, null, null, "IK");
        for (JsonNode v : aw.path("verlauf")) {
            String tag = v.path("am").asText();
            String am = AhrenbergWelt.abweichungEintrag(tag);
            if (v.path("art").asText().equals("kommentar")) {
                n += zeile("abweichung", k, "kommentar", am, null, null, null, v.path("text").asText(), null, "IK");
            } else if (v.path("art").asText().equals("ursache_aussage")) {
                String wer = v.path("person").asText();
                n += zeile("abweichung", k, "ursache_aussage", am, null, null, null, null,
                        new Object[] {v.path("wortlaut").asText(), sub(wer), AhrenbergWelt.NAMEN.get(wer), LocalDate.parse(tag)},
                        "IK");
            }
        }
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("zustand", "abgeschlossen");
        neu.put("ergebnis", aw.at("/abschluss/ergebnis").asText());
        if (aw.at("/abschluss/massnahme").isTextual()) {
            neu.put("massnahme", aw.at("/abschluss/massnahme").asText());
        }
        return n + zeile("abweichung", k, "abweichung_abgeschlossen", AhrenbergWelt.abweichungAbgeschlossen(aw),
                Map.of("zustand", "offen"), neu, aw.at("/abschluss/begruendung").asText(), null, null, "IK");
    }

    private int angelegt(String k, JsonNode m, String herkunft, String kennung, String am) throws JsonProcessingException {
        Map<String, Object> inhalt = new LinkedHashMap<>();
        inhalt.put("zustand", "geplant");
        inhalt.put("titel", m.path("titel").asText());
        inhalt.put("termin", m.path("termin").asText());
        inhalt.put("verantwortlich_name", AhrenbergWelt.NAMEN.get(m.path("verantwortlich").asText()));
        inhalt.put("herkunft", herkunft);
        inhalt.put("art", AhrenbergWelt.ART.get(k));
        inhalt.put("herkunft_kennung", kennung);
        if (m.path("messgrundlage").isObject()) {
            Map<String, Object> z = root.queryForMap("SELECT ausgangslage_pruefsumme FROM massnahme WHERE tenant_id = ? AND "
                    + "kennzeichen = ?", TENANT, k);
            inhalt.put("kennzahl", m.at("/messgrundlage/kennzahl").asText());
            inhalt.put("bezugsbasis", m.at("/messgrundlage/bezugsbasis").asText());
            inhalt.put("fassung", 2);
            inhalt.put("ausgangslage_pruefsumme", z.get("ausgangslage_pruefsumme"));
        } else {
            inhalt.put("messgrundlage", MassnahmeService.OHNE_KENNZEICHEN);
        }
        if (m.at("/erwartete_wirkung/prozent").isNumber()) {
            inhalt.put("erwartete_wirkung_prozent", m.at("/erwartete_wirkung/prozent").decimalValue().toPlainString());
        }
        return zeile("massnahme", k, "massnahme_angelegt", am, null, inhalt, null, null, null, "IK");
    }

    private int umgesetzt(String k, JsonNode m, String am) throws JsonProcessingException {
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("zustand", "umgesetzt");
        neu.put("umgesetzt_am", m.path("umgesetzt_am").asText());
        return zeile("massnahme", k, "massnahme_umgesetzt", am, Map.of("zustand", "geplant"), neu, umgesetztBegruendung(m),
                null, null, "IK");
    }

    /** Der Anstoß der Kaskade (gesetzt, im alten Bestand dazu die Zeile in {@code vorgang_anstoss}) und seine Antwort. */
    private int anstoss(String k, JsonNode a) throws JsonProcessingException {
        UUID massnahme = id("massnahme", k);
        String gesetztAm = OffsetDateTime.parse(a.path("am").asText()).toInstant().toString();
        String beantwortetAm = AhrenbergWelt.anstossBeantwortet(a);
        root.update("INSERT INTO vorgang_anstoss (tenant_id, massnahme_id, art, anlass_kennung, angestossen_am, created_at) "
                + "SELECT ?, ?, ?, ?, ?::timestamptz, ?::timestamptz WHERE NOT EXISTS (SELECT 1 FROM vorgang_anstoss WHERE "
                + "tenant_id = ? AND massnahme_id = ? AND art = ? AND anlass_kennung = ?)", TENANT, massnahme,
                a.path("art").asText(), a.path("anlass_kennung").asText(), gesetztAm, gesetztAm, TENANT, massnahme,
                a.path("art").asText(), a.path("anlass_kennung").asText());
        UUID id = root.queryForObject("SELECT id FROM vorgang_anstoss WHERE tenant_id = ? AND massnahme_id = ? AND art = ? "
                + "AND anlass_kennung = ?", UUID.class, TENANT, massnahme, a.path("art").asText(),
                a.path("anlass_kennung").asText());
        root.update("UPDATE vorgang_anstoss SET zustand = 'beantwortet', antwort = ?, antwort_begruendung = ?, "
                + "beantwortet_am = ?::timestamptz, beantwortet_sub = ?, beantwortet_name = 'Ines Kaltenbach', "
                + "beantwortet_rolle = 'energiemanager', beantwortet_art = 'kunde' WHERE id = ? AND zustand = 'offen'",
                a.at("/antwort/antwort").asText(), a.at("/antwort/begruendung").asText(), beantwortetAm, ik, id);
        Map<String, Object> gesetzt = new LinkedHashMap<>();
        gesetzt.put("anstoss_id", id.toString());
        gesetzt.put("art", a.path("art").asText());
        gesetzt.put("anlass_kennung", a.path("anlass_kennung").asText());
        int n = zeile("massnahme", k, "anstoss_gesetzt", gesetztAm, null, gesetzt, null, null, null, null);
        Map<String, Object> neu = new LinkedHashMap<>(gesetzt);
        neu.put("zustand", "beantwortet");
        neu.put("antwort", a.at("/antwort/antwort").asText());
        return n + zeile("massnahme", k, "anstoss_beantwortet", beantwortetAm, Map.of("zustand", "offen"), neu,
                a.at("/antwort/begruendung").asText(), null, null, "IK");
    }

    private int bewertet(String k, JsonNode b, String am) throws JsonProcessingException {
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("zustand", "bewertet");
        neu.put("stand_nr", b.path("nr").asInt(1));
        neu.put("ergebnis", b.path("ergebnis").asText());
        neu.put("pruefsumme", b.path("kopie").isObject() ? b.path("pruefsumme").asText() : null);
        return zeile("massnahme", k, "massnahme_bewertet", am, Map.of("zustand", "umgesetzt"), neu,
                b.path("begruendung").asText(), null, null, "IK");
    }

    /** M-2029-0001 „nicht messbar“ am 15.04.2029 (massnahmen_1_10) - im alten Bestand fehlt der Stand. */
    private int bewertungM2029() throws JsonProcessingException {
        JsonNode b = referenz.at("/massnahmen_1_10/0/bewertungen/0");
        String am = AhrenbergWelt.MASSNAHME_BEWERTET.get("M-2029-0001");
        UUID m = id("massnahme", "M-2029-0001");
        int n = root.update("INSERT INTO massnahme_bewertung (tenant_id, massnahme_id, ergebnis, begruendung, vieraugen, "
                + "status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am) SELECT ?, ?, ?, ?, false, "
                + "'bewertet', ?, 'Ines Kaltenbach', 'energiemanager', 'kunde', ?::timestamptz WHERE NOT EXISTS (SELECT 1 FROM "
                + "massnahme_bewertung WHERE tenant_id = ? AND massnahme_id = ?)", TENANT, m, b.path("ergebnis").asText(),
                b.path("begruendung").asText(), ik, am, TENANT, m);
        n += root.update("UPDATE massnahme SET zustand = 'bewertet' WHERE id = ? AND zustand = 'umgesetzt'", m);
        return n + bewertet("M-2029-0001", b, am);
    }

    /**
     * Eine Zeile im Verlauf, wenn an diesem Augenblick noch keine dieser Art steht - mit dem Inhalt, den die Route
     * schreibt ({@code aussage}: Wortlaut, Konto, Name, Tag; ohne {@code wer} die Kaskade).
     */
    private int zeile(String vorgang, String kennzeichen, String art, String am, Map<String, Object> alt,
            Map<String, Object> neu, String begruendung, String kommentar, Object[] aussage, String wer)
            throws JsonProcessingException {
        UUID id = id(vorgang, kennzeichen);
        if (zahl("SELECT count(*) FROM " + vorgang + "_aenderung WHERE tenant_id = ? AND " + vorgang + "_id = ? AND art = ? "
                + "AND created_at = ?::timestamptz", TENANT, id, art, am) > 0) {
            return 0;
        }
        String spalten = "tenant_id, " + vorgang + "_id, art, alt, neu, begruendung, actor_sub, actor_name, actor_rolle, "
                + "actor_art, created_at";
        String werte = "?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?::timestamptz";
        List<Object> args = new java.util.ArrayList<>(List.of(TENANT, id, art));
        args.add(alt == null ? null : JSON.writeValueAsString(alt));
        args.add(neu == null ? null : JSON.writeValueAsString(neu));
        args.add(begruendung);
        args.add(wer == null ? null : sub(wer));
        args.add(wer == null ? VorgangAnstoss.AKTEUR_KASKADE : AhrenbergWelt.NAMEN.get(wer));
        args.add(wer == null ? null : "energiemanager");
        args.add(wer == null ? "voltpilot" : "kunde");
        args.add(am);
        if (!vorgang.equals("energieziel")) {
            spalten += ", kommentar";
            werte += ", ?";
            args.add(kommentar);
        }
        if (vorgang.equals("abweichung")) {
            spalten += ", aussage_wortlaut, aussage_sub, aussage_name, aussage_am";
            werte += ", ?, ?, ?, ?";
            Object[] a = aussage == null ? new Object[4] : aussage;
            args.add(a[0]);
            args.add(a[1]);
            args.add(a[2]);
            args.add(a[3] == null ? null : java.sql.Date.valueOf((LocalDate) a[3]));
        }
        return root.update("INSERT INTO " + vorgang + "_aenderung (" + spalten + ") VALUES (" + werte + ")", args.toArray());
    }

    // ================================================================================ 4 März 2029

    /**
     * Der Leser der Naht über jeden Monat von KZ-0004, den eine Fassung von BB-0001 bewertet: „schlechter“ genau in den
     * Monaten von {@link #SCHLECHTER}, mit demselben Δ. Sonst ist die Monatsreihe des Bühnen-Bestands nicht die der
     * Referenz - dann bricht der Rundgang ab (zurück an die Demo-Füllung Auswerten), statt etwas wegzubeantworten.
     */
    private void pruefeMonatsreihe() throws Exception {
        KennzahlService kennzahlen = ctx.getBean(KennzahlService.class);
        BezugsbasisVergleich vergleich = ctx.getBean(BezugsbasisVergleich.class);
        UUID kz4 = id("kennzahl", "KZ-0004");
        Instant buehne = Instant.parse(PruefumgebungAhrenberg.BUEHNE);
        Map<String, String> schlechter = new TreeMap<>();
        List<String> ohneWert = new java.util.ArrayList<>();
        TenantContext.set(TENANT);
        try (Connection con = root.getDataSource().getConnection()) {
            JdbcTemplate t = new JdbcTemplate(new SingleConnectionDataSource(con, true));
            KennzahlService.NahtKennzahl k = kennzahlen.fuerNaht(kz4, buehne).orElseThrow();
            Map<String, KennzahlDto.Wert> werte = KennzahlWerteService.monate(t, kz4, BERLIN, AB.atDay(1), BIS.atEndOfMonth());
            java.util.Set<YearMonth> mitWert = new java.util.HashSet<>();
            werte.values().stream().filter(w -> w.wert() != null).forEach(w -> mitWert.add(YearMonth.from(w.von())));
            for (YearMonth m = AB; !m.isAfter(BIS); m = m.plusMonths(1)) {
                if (!mitWert.contains(m)) {
                    ohneWert.add(m.toString());
                }
                BezugsbasisVergleich.NahtMonat z = vergleich.fuerNaht(t, k.basis(), k.einheit(), m);
                if (z != null && z.zeile().bereinigt() != null && "schlechter".equals(z.zeile().bereinigt().urteil())) {
                    schlechter.put(m.toString(), new BigDecimal(z.zeile().bereinigt().deltaProzent())
                            .setScale(1, RoundingMode.HALF_UP).toPlainString());
                }
            }
        } finally {
            TenantContext.clear();
        }
        if (!ohneWert.isEmpty()) {
            throw new IllegalStateException("KZ-0004 hat für " + ohneWert + " noch keinen Monatswert - die Prüfung liefe "
                    + "ins Leere; erst rechnen (Kaskade, Regellauf), dann vermerken.");
        }
        if (!schlechter.equals(SCHLECHTER)) {
            throw new IllegalStateException("KZ-0004 liegt gegen BB-0001 in anderen Monaten „schlechter“ als in der "
                    + "Referenzwelt: " + schlechter + " statt " + SCHLECHTER + " - die Monatsreihe des Bühnen-Bestands "
                    + "(Demo-Füllung Auswerten) prüfen, nichts wegbeantworten.");
        }
    }

    /** März 2029 vermerkt die Naht selbst, mit dem Tag ihres Laufs - offen, wie Entscheid 16 es will. */
    private boolean maerz2029() throws Exception {
        VerbesserungNaht naht = new VerbesserungNaht(ctx.getBean(KennzahlService.class),
                ctx.getBean(BezugsbasisVergleich.class), ctx.getBean(ObjectMapper.class));
        UUID kz4 = id("kennzahl", "KZ-0004");
        KennzahlLauf.Neu maerz = new KennzahlLauf.Neu(kz4, "KZ-0004", "monat", LocalDate.of(2029, 3, 1),
                LocalDate.of(2029, 3, 31), BERLIN, 1);
        try (Connection con = root.getDataSource().getConnection()) {
            con.setAutoCommit(false);
            List<VerbesserungNaht.Vermerk> neu = naht.vermerken(con, TENANT, List.of(maerz),
                    OffsetDateTime.parse(MAERZ_2029_VERMERKT).toInstant());
            con.commit();
            return !neu.isEmpty();
        }
    }

    /**
     * Die vier Vermerke an ihrem Tag (Europe/Berlin) und mit ihrer Antwort. Stand einer schon mit dem Tag eines Laufs
     * (die Naht lief mit der Bühnen-Uhr, etwa weil die Demo-API neben dem Rundgang rechnete), ist er nicht mehr zu
     * ändern: dann bricht der Rundgang ab - sauber wird es nur mit einem Neuaufbau.
     */
    private void pruefeVermerke() {
        List<String> soll = new java.util.ArrayList<>();
        for (JsonNode r : referenz.path("auffaelligkeiten")) {
            soll.add(r.path("kennzahl").asText() + " " + r.path("periode").asText() + " "
                    + r.path("vermerkt_am").asText().substring(0, 10) + " " + r.at("/antwort/antwort").asText());
        }
        soll.add("KZ-0004 2029-03 " + MAERZ_2029_VERMERKT.substring(0, 10) + " offen");
        List<String> ist = root.queryForList("SELECT k.kennzeichen || ' ' || a.periode || ' ' || to_char(a.vermerkt_am AT "
                + "TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') || ' ' || coalesce(a.antwort, a.zustand) FROM auffaelligkeit a "
                + "JOIN kennzahl k ON k.id = a.kennzahl_id WHERE a.tenant_id = ? AND k.kennzeichen IN ('KZ-0004', 'KZ-0005') "
                + "ORDER BY a.periode", String.class, TENANT);
        if (!ist.equals(soll)) {
            throw new IllegalStateException("Die Auffälligkeiten von KZ-0004/KZ-0005 sind nicht die der Referenz: " + ist
                    + " statt " + soll + " - ein Vermerk mit dem Tag eines Laufs ist nicht mehr änderbar; die Demo neu "
                    + "aufbauen und den Rundgang mit stummer Naht der Demo-API fahren (demo.sh rundgang).");
        }
    }

    // ================================================================================ Helfer

    private UUID id(String tabelle, String kennzeichen) {
        return root.queryForObject("SELECT id FROM " + tabelle + " WHERE tenant_id = ? AND kennzeichen = ?", UUID.class,
                TENANT, kennzeichen);
    }

    private int zahl(String sql, Object... werte) {
        Integer n = root.queryForObject(sql, Integer.class, werte);
        return n == null ? 0 : n;
    }

    private static String sub(String kuerzel) {
        return AhrenbergWelt.SEED_SUBJECTS.get(kuerzel);
    }

    private static String umgesetztBegruendung(JsonNode m) {
        for (JsonNode v : m.path("verlauf")) {
            if (v.path("art").asText().equals("massnahme_umgesetzt")) {
                return v.path("begruendung").asText();
            }
        }
        return m.path("umgesetzt_begruendung").asText(null);
    }
}
