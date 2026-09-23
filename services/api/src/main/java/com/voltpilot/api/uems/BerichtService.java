package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.TeilansichtDienst;
import com.voltpilot.api.uems.BerichtAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.BerichtRepository.AnstossZeile;
import com.voltpilot.api.uems.BerichtRepository.EntwurfZeile;
import com.voltpilot.api.uems.BerichtRepository.Geltung;
import com.voltpilot.api.uems.BerichtRepository.Kopf;
import com.voltpilot.api.uems.BerichtRepository.StandZeile;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import javax.sql.DataSource;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Berichts-Routen (UEMS AP-12 IP-7, E4/E5/E7/E12) — Meilenstein 2 „Bericht freigebbar“: anlegen (bildet den Entwurf),
 * lesen, Entwurf mit D4-Prüfung, Vergleich gegen einen Stand (R1), Freigabe (F1–F5), Stand mit geprüfter Prüfsumme, Anstoß
 * verwerfen (R4), archivieren (V4).
 *
 * <p><b>Reihenfolge je Route:</b> Kundenbereich und Bericht (fremd 404) → Recht über {@link BerichtRechte} (fremder
 * Standort 404, fehlendes Recht 403) → erst dann die Regeln. So verrät keine 422, dass es einen Bericht gibt.
 *
 * <p><b>Die Freigabe rechnet nichts</b> (F2): sie sperrt den Bericht ({@code FOR NO KEY UPDATE}), liest den Entwurf
 * {@code FOR SHARE} (die Kaskade nimmt ihn {@code FOR UPDATE}), prüft F1 mit {@link BerichtRegeln#freigabe}, D2 und D3,
 * kopiert den Abzug in SQL Byte für Byte nach {@code bericht_stand} (Nr. = letzte + 1), friert die Quellen ein, setzt am
 * Vorgänger „ersetzt durch“, erledigt offene Anstöße und schreibt {@code bericht_freigegeben} und das Protokoll — alles in
 * einer Transaktion. Dieselbe Freigabe (Bericht, Datenstand) noch einmal ist derselbe Stand (F5).
 *
 * <p><b>D4 beim Abruf:</b> {@link BerichtRepository#aenderungenSeit} plus die Fristen, die seit dem Datenstand abliefen
 * ({@link #fristen}); ist etwas neuer, bildet {@link BerichtAbzugBildung} den Entwurf in eigener Transaktion neu
 * ({@code gebildet_von = abruf}, ohne Ereignis — B6). Standort- und Unternehmensbericht gleich (seit AP-12 IP-6).
 */
@Service
public class BerichtService {

    public static final String ZEICHEN_ENTWURF = "entwurf";
    public static final String ZEICHEN_STAND = "berichtsstand";
    public static final String ZEICHEN_REVISION = "revision_noetig";
    public static final String ZEICHEN_VERWORFEN = "anstoss_verworfen";
    /** R5 — die Vermerke eines Berichts in der Liste, als Wort. */
    public static final List<String> STAND_ZEICHEN = List.of(ZEICHEN_ENTWURF, ZEICHEN_STAND, ZEICHEN_REVISION,
            ZEICHEN_VERWORFEN);

    static final String EREIGNIS_FREIGEGEBEN = "bericht_freigegeben";
    static final String EREIGNIS_ABGERUFEN = "bericht_abgerufen";
    /** DA5 — das Format eines Abrufs ({@code bericht_abruf.format}, Meldung {@code bericht_abgerufen}). */
    static final String FORMAT_CSV = "csv";
    static final String FORMAT_PDF = "pdf";
    /** {@code gebildet_von} (bericht.md EW1) — nicht die Handlung der Route. */
    static final String GEBILDET_BEIM_ANLEGEN = "anlegen";
    static final String GEBILDET_BEIM_ABRUF = "abruf";
    static final String ZEITRAUM_ZU_ENDE = "zeitraum_zu_ende";
    static final String OFFEN = "offen";
    static final String VERWORFEN = "verworfen";
    static final int TEXT_MINDESTENS = 10;
    static final int TEXT_HOECHSTENS = 500;

    private static final Pattern MONAT = Pattern.compile("^[0-9]{4}-(0[1-9]|1[0-2])$");
    private static final Pattern JAHR = Pattern.compile("^[0-9]{4}$");
    private static final Pattern DATENGRUNDLAGE =
            Pattern.compile("^[0-9]{4}-(0[1-9]|1[0-2])(/[0-9]{4}-(0[1-9]|1[0-2]))?$");
    /** Ein Abzug als Baum: Zahlen exakt als Dezimalzahl, wie die kanonische Form sie schrieb. */
    private static final ObjectMapper ABZUG = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .setNodeFactory(JsonNodeFactory.withExactBigDecimals(true));

    private final BerichtRepository repo;
    private final KennzahlAufrufer aufrufer;
    private final BerichtAbzugBildung bildung;
    private final MessreiheEreignisRepository ereignisse;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;
    private final TeilansichtDienst umfang;
    private volatile Clock uhr = Clock.systemUTC();

    public BerichtService(BerichtRepository repo, KennzahlAufrufer aufrufer, BerichtAbzugBildung bildung,
            MessreiheEreignisRepository ereignisse, JdbcTemplate jdbc, PlatformTransactionManager transactionManager,
            ObjectMapper json, TeilansichtDienst umfang) {
        this.repo = repo;
        this.aufrufer = aufrufer;
        this.bildung = bildung;
        this.ereignisse = ereignisse;
        this.jdbc = jdbc;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
        this.umfang = umfang;
    }

    /** Für Tests: die Uhr, an der Datenstand, Freigabe, Fristen und Rechte hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Auf die Sekunde: so steht ein Datenstand im Ereignis ({@code ZEIT_UTC}) und in der Datenbank gleich. */
    Instant jetzt() {
        return uhr.instant().truncatedTo(ChronoUnit.SECONDS);
    }

    // ================================================================================ Ergebnisse

    /**
     * Ein Bericht mit seinem Vermerk aus R5 und — nur an einer energetischen Bewertung mit freigegebenem Stand — der beim
     * Abruf abgeleiteten Überprüfung (AP-16 S5/S6, IP-24); sonst {@code null}.
     */
    public record Uebersicht(Kopf kopf, Integer neuesteNr, Instant entwurfDatenstand, String standZeichen,
            String standText, Ueberpruefung ueberpruefung) {}

    /** AP-16 S5/S6: die Frist am Abruftag und die laufenden Einsätze des Unternehmens mit wirksamer Einstufung. */
    public record Ueberpruefung(BewertungFrist.Frist frist, List<BerichtRepository.EinsatzLage> einsaetze) {}

    public record Detail(Uebersicht bericht, List<StandZeile> staende, List<AnstossZeile> anstoesse) {}

    public record Entwurf(Kopf kopf, EntwurfZeile entwurf, boolean neuGebildet, List<String> teilansicht) {}

    public record Vergleich(Kopf kopf, int gegen, Instant entwurfDatenstand, List<BerichtRegeln.Abweichung> abweichungen) {}

    public record Stand(Kopf kopf, StandZeile stand, List<String> teilansicht) {}

    /** {@code neu} = diese Anfrage hat den Stand geschrieben (201); sonst war es dieselbe Freigabe (F5, 200). */
    public record Freigabe(Stand stand, boolean neu) {}

    /** Eine Ausgabe eines Stands: Dateiname nach §5.4 ({@code bericht-BR-2026-0001-nr1.csv}) und Inhalt. */
    public record Datei(String name, byte[] inhalt) {}

    public record Verworfen(Kopf kopf, AnstossZeile anstoss) {}

    /** Bericht, Urteil und Aufrufer einer Route — nach der Rechte-Prüfung. */
    private record Zugriff(Kopf kopf, DarfErgebnis darf, Benutzer benutzer, Kundenbereich kundenbereich, Instant jetzt) {}

    // ================================================================================ lesen

    /**
     * {@code GET /berichte}: die nicht archivierten Berichte, die die Person lesen darf. Darf sie nirgends einen lesen (der
     * Unterstützer), ist das 403 — kein leeres „es gibt keine“.
     */
    public List<Uebersicht> liste(ProtokollAkteur wer) {
        UUID tenant = kundenbereich();
        Instant jetzt = jetzt();
        Benutzer b = aufrufer.benutzer(wer);
        Kundenbereich k = rechteKundenbereich();
        List<Uebersicht> raus = new ArrayList<>();
        for (Kopf x : repo.berichte()) {
            if (darf(b, k, BerichtRechte.ABRUFEN, x, jetzt).darf()) {
                raus.add(uebersicht(tenant, x));
            }
        }
        if (raus.isEmpty()) {
            irgendwoLesbar(b, k, jetzt);
        }
        return raus;
    }

    /** Ein Berichtsstand, wie ihn eine Folgen-Karte nennt: „BR-2026-0001 Nr. 2“. */
    public record StandRef(String kennung, int nr) {}

    /**
     * Die Zeile „Freigegebene Berichte: …“ (AP-12 IP-9): {@code betroffen} = die gültigen Stände, die der
     * Strukturänderungs-Läufer anstieße, gälte die Änderung ab {@code giltAb}; {@code zitieren} = jeder Stand, der eine
     * Quelle des Objekts überhaupt zitiert (B12); {@code berichteVorhanden} = die Person liest hier mindestens einen Bericht.
     */
    public record Betroffen(String anlass, LocalDate giltAb, boolean berichteVorhanden, List<StandRef> betroffen,
            List<StandRef> zitieren) {}

    /**
     * {@code GET /berichte/betroffen}: dieselbe Auflösung wie der Läufer ({@link StrukturAufloesung#vorschau}) und derselbe
     * Schnitt ({@link BerichtKaskade#strukturQuellen}, {@link BerichtRegeln#betroffene(List, java.util.Collection, LocalDate)})
     * — nur ohne Protokollzeile und ohne Datenstand-Schranke, weil die Änderung noch nicht geschrieben ist. Liest nichts, was
     * die Person nicht lesen darf; darf sie nirgends einen Bericht lesen, 403 vor 404.
     */
    public Betroffen betroffen(UUID objekt, LocalDate giltAb, String anlass, ProtokollAkteur wer,
            Predicate<UUID> messstelleSichtbar) {
        UUID tenant = kundenbereich();
        Instant jetzt = jetzt();
        Benutzer b = aufrufer.benutzer(wer);
        Kundenbereich k = rechteKundenbereich();
        Set<String> lesbar = new HashSet<>();
        for (Kopf x : repo.berichte()) {
            if (darf(b, k, BerichtRechte.ABRUFEN, x, jetzt).darf()) {
                lesbar.add(x.kennung());
            }
        }
        if (lesbar.isEmpty()) {
            irgendwoLesbar(b, k, jetzt);
        }
        String art = StrukturAufloesung.objektArt(jdbc, tenant, objekt);
        // Eine Messstelle hat keinen Standort-Zaun in der Tabelle (Orte, Standorte, Anlagen hält RLS): außerhalb des
        // Zugriffs antwortet sie wie eine Kennung, die der Kundenbereich nicht kennt (AP-03 R-A1).
        if (StrukturAufloesung.MESSSTELLE.equals(art) && !messstelleSichtbar.test(objekt)) {
            art = null;
        }
        if (art == null || !StrukturAufloesung.passt(anlass, art)) {
            throw BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
        if (lesbar.isEmpty()) {
            return new Betroffen(anlass, giltAb, false, List.of(), List.of());
        }
        Set<UUID> objekte = StrukturAufloesung.vorschau(jdbc, tenant, anlass, art, objekt, giltAb);
        List<BerichtRegeln.Quelle> quellen = objekte.isEmpty() ? List.of()
                : BerichtKaskade.strukturQuellen(jdbc, tenant, objekte, giltAb, null);
        List<StandRef> betroffen = new ArrayList<>();
        for (BerichteNaht.Bericht x : BerichtRegeln.betroffene(quellen, objekte.stream().map(UUID::toString).toList(),
                giltAb)) {
            if (x.stand() == BerichteNaht.Stand.FREIGEGEBEN && lesbar.contains(x.kennung())) {
                quellen.stream().filter(q -> q.bericht().equals(x.kennung()) && q.nr() != null && !q.ersetzt())
                        .mapToInt(BerichtRegeln.Quelle::nr).max()
                        .ifPresent(nr -> betroffen.add(new StandRef(x.kennung(), nr)));
            }
        }
        Set<UUID> quellenDesObjekts = StrukturAufloesung.quellenDesObjekts(jdbc, tenant, art, objekt);
        List<StandRef> zitieren = quellenDesObjekts.isEmpty() ? List.of() : jdbc.query("SELECT DISTINCT b.kennung, "
                + "q.stand_nr FROM bericht_quelle q JOIN bericht b ON b.id = q.bericht_id AND b.tenant_id = q.tenant_id "
                + "WHERE q.tenant_id = ? AND q.stand_nr IS NOT NULL AND q.objekt_id = ANY (?::uuid[]) "
                + "ORDER BY b.kennung, q.stand_nr", (rs, i) -> new StandRef(rs.getString(1), rs.getInt(2)), tenant,
                quellenDesObjekts.stream().map(UUID::toString).toArray(String[]::new));
        return new Betroffen(anlass, giltAb, true, List.copyOf(betroffen),
                zitieren.stream().filter(s -> lesbar.contains(s.kennung())).toList());
    }

    public Detail detail(String kennung, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.ABRUFEN);
        Kopf kopf = z.kopf();
        return new Detail(uebersicht(kopf.tenant(), kopf), repo.staende(kopf.tenant(), kopf.id()),
                repo.anstoesse(kopf.tenant(), kopf.id()));
    }

    /** {@code GET …/entwurf}: D4 — aktuell lesen, sonst neu bilden (EW1, B6). */
    public Entwurf entwurf(String kennung, ProtokollAkteur wer) {
        return aktuellerEntwurf(zugriff(kennung, wer, BerichtRechte.ABRUFEN));
    }

    /** {@code GET …/entwurf/vergleich?gegen=<nr>}: R1 — der Stand zuerst (404 ohne Neubildung), dann der aktuelle Entwurf. */
    public Vergleich vergleich(String kennung, int gegen, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.ABRUFEN);
        StandZeile s = geprueft(z.kopf(), gegen);
        Entwurf e = aktuellerEntwurf(z);
        return new Vergleich(z.kopf(), gegen, e.entwurf().datenstand(),
                BerichtRegeln.abweichungen(baum(s.abzug()), baum(e.entwurf().abzug())));
    }

    /** {@code GET …/staende/{nr}}: die Prüfsumme wird geprüft, nicht nur mitgeliefert (A6). */
    public Stand stand(String kennung, int nr, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.ABRUFEN);
        return new Stand(z.kopf(), geprueft(z.kopf(), nr), teilansicht(z));
    }

    /**
     * {@code GET …/staende/{nr}/csv} (DA3, DA5): Recht {@code export.*} (G1) → Stand mit geprüfter Prüfsumme (404, 500) → die
     * Datei NUR aus dem Abzug ({@link BerichtCsv}) → Abruf und Meldung {@code bericht_abgerufen} in EINER Transaktion.
     * Scheitert das Protokoll, verlässt keine Datei den Server — einen Abruf ohne Spur gibt es nicht. Ein Entwurf hat keine
     * Datei (EW4).
     */
    public Datei csv(String kennung, int nr, ProtokollAkteur wer) {
        return ausgabe(kennung, nr, wer, BerichtRechte.CSV, FORMAT_CSV,
                (abzug, stand, jetzt, teilansicht) -> BerichtCsv.datei(abzug, stand, jetzt, wer.name(), teilansicht));
    }

    /**
     * {@code GET …/staende/{nr}/pdf} (DA2, DA5): Recht {@code bericht.standort_abrufen} bzw. {@code bericht.unternehmen} (G1) →
     * Stand mit geprüfter Prüfsumme (404, 500) → das PDF NUR aus dem Abzug und der Freigabe ({@link BerichtPdf}) → Abruf und
     * Meldung wie beim CSV. Das PDF kennt weder Abrufer noch Abrufzeit noch Teilansicht — darum ist es für jeden, der den Stand
     * abruft, byte-gleich; die Teilansicht steht nur im Protokoll. Ein Entwurf hat keins (EW4).
     */
    public Datei pdf(String kennung, int nr, ProtokollAkteur wer) {
        return ausgabe(kennung, nr, wer, BerichtRechte.PDF, FORMAT_PDF,
                (abzug, stand, jetzt, teilansicht) -> BerichtPdf.datei(abzug, stand));
    }

    /** Was eine Ausgabe baut: aus Abzug und Stand, zur Abrufzeit, mit der Teilansicht ({@code null} = unternehmensweit). */
    @FunctionalInterface
    private interface Ausgabe {
        byte[] bauen(JsonNode abzug, BerichtCsv.Stand stand, Instant jetzt, List<String> teilansicht);
    }

    /**
     * Eine Datei eines Stands (DA5): Recht → Stand mit geprüfter Prüfsumme → erst die Datei, dann Abruf und Meldung
     * {@code bericht_abgerufen} in EINER Transaktion — scheitert das Protokoll, verlässt keine Datei den Server.
     */
    private Datei ausgabe(String kennung, int nr, ProtokollAkteur wer, String handlung, String format, Ausgabe ausgabe) {
        Zugriff z = zugriff(kennung, wer, handlung);
        Kopf kopf = z.kopf();
        StandZeile s = geprueft(kopf, nr);
        Instant ersetztAm = s.ersetztDurchNr() == null ? null : repo.staende(kopf.tenant(), kopf.id()).stream()
                .filter(x -> x.nr() == s.ersetztDurchNr()).map(StandZeile::freigegebenAm).findFirst().orElseThrow();
        List<String> teilansicht = teilansicht(z);
        byte[] inhalt = ausgabe.bauen(baum(s.abzug()), new BerichtCsv.Stand(s.nr(), s.freigegebenAm(), s.freigeberName(),
                s.pruefsumme(), s.ersetztDurchNr(), ersetztAm), z.jetzt(), teilansicht);
        if (FORMAT_CSV.equals(format)) {
            String kopfzeile = umfang.exportKopf(z.benutzer(), z.kundenbereich(), z.jetzt());
            if (kopfzeile != null) {
                // Der Abzug bleibt unberührt. Nur der Abruf-Umschlag des CSV nennt die Teilansicht (R-A4).
                String csv = new String(inhalt, StandardCharsets.UTF_8);
                inhalt = ("\uFEFF# " + kopfzeile + "\r\n" + csv.substring(1)).getBytes(StandardCharsets.UTF_8);
            }
        }
        transaktion.executeWithoutResult(tx -> {
            UUID abruf = repo.abruf(kopf.tenant(), s.id(), format, teilansicht != null, wer, rolle(z.darf(), wer),
                    z.jetzt());
            ereignisAbgerufen(kopf.tenant(), kopf.kennung(), s.nr(), format, abruf, z.jetzt());
        });
        return new Datei("bericht-" + kopf.kennung() + "-nr" + s.nr() + "." + format, inhalt);
    }

    // ================================================================================ anlegen

    /**
     * {@code POST /berichte}: Vorlage (422) → Zeitraum (400) → Geltung (404, fremd ebenso) → Recht → gibt es schon (409) →
     * Messstellen im Zeitraum (422) → abgewählte Kennzahlen des Kundenbereichs (400, V3) → Bericht mit Kennung, Abwahl und
     * Entwurf in einer Transaktion.
     */
    public Uebersicht anlegen(String vorlageSchluessel, String geltungId, String zeitraum, List<UUID> abgewaehlt,
            ProtokollAkteur wer) {
        UUID tenant = kundenbereich();
        Instant jetzt = jetzt();
        BerichtRegeln.Vorlage v = BerichtRegeln.vorlage(vorlageSchluessel);
        // AP-17 IP-21a: eine Vorlage ohne Leser (Leistungsvergleich bis IP-21b) ist im Katalog, aber nicht anlegbar.
        if (v == null || BerichtRegeln.OHNE_LESER.contains(v.schluessel())) {
            throw BerichtAbgelehnt.regel(Ablehnung.VORLAGE_UNBEKANNT, BerichtRegeln.SAETZE.get(BerichtRegeln.VORLAGE_UNBEKANNT),
                    Map.of("feld", "vorlage"));
        }
        boolean standort = BerichtRegeln.STANDORT.equals(v.geltungArt());
        Geltung g = geltung(standort, geltungId);
        Benutzer b = aufrufer.benutzer(wer);
        DarfErgebnis d = Geltungsbereich.requireScope(b, rechteKundenbereich(),
                BerichtRechte.kennung(BerichtRechte.ANLEGEN, v.geltungArt(), v.schluessel()),
                standort ? g.id().toString() : null, jetzt, BerichtAbgelehnt::rechte);
        ZoneId zone = repo.zeitzone(standort ? g.id() : null);
        if (BerichtRegeln.DATENGRUNDLAGE.equals(v.zeitraumArt()) && (zeitraum == null || zeitraum.isBlank())) {
            java.time.YearMonth letzter = java.time.YearMonth.from(LocalDate.ofInstant(jetzt, zone)).minusMonths(1);
            zeitraum = letzter.minusMonths(11) + "/" + letzter;
        }
        Pattern muster = BerichtRegeln.MONAT.equals(v.zeitraumArt()) ? MONAT
                : BerichtRegeln.JAHR.equals(v.zeitraumArt()) ? JAHR : DATENGRUNDLAGE;
        if (zeitraum == null || !muster.matcher(zeitraum).matches()) {
            throw BerichtAbgelehnt.anfrage("zeitraum");
        }
        String zeitraumSchluessel = zeitraum;
        BerichtRegeln.Zeitraum zr = BerichtRegeln.zeitraum(v.zeitraumArt(), zeitraumSchluessel, zone);
        Optional<Kopf> schon = repo.berichtZu(v.schluessel(), v.geltungArt(), g.id(), zeitraumSchluessel);
        if (schon.isPresent()) {
            throw gibtEsSchon(schon.get());
        }
        // Q3 — am Standort die Messstellen seiner Orte, am Unternehmen die Netzbezugs-Zähler der Standorte, die Unternehmens-
        // und die Prozess-Messstellen (AP-12 IP-6).
        if (!BerichtRegeln.ENERGETISCHE_BEWERTUNG.equals(v.schluessel())
                && !BerichtAbzugBildung.hatMessstellen(jdbc, tenant, v.geltungArt(), g.id(), zr.ersterTag(), zr.letzterTag())) {
            LocalDate seit = BerichtAbzugBildung.bestehtSeit(jdbc, tenant, v.geltungArt(), g.id(),
                    LocalDate.ofInstant(jetzt, zone));
            throw BerichtAbgelehnt.regel(Ablehnung.KEINE_QUELLEN, BerichtRegeln.keineQuellen(g.name(), v.zeitraumArt(),
                    zeitraumSchluessel, seit != null && seit.isAfter(zr.letzterTag()) ? seit : null), Map.of("feld", "zeitraum"));
        }
        // V3 (AP-12 IP-14) — jede abgewählte Kennzahl ist eine des Kundenbereichs; eine außerhalb der Geltung ist erlaubt
        // und wirkt nicht, weil Q4 sie nie liest. Kennung → Kennzeichen für das Protokoll.
        List<UUID> kennungen = abgewaehlt == null ? List.of() : abgewaehlt.stream().distinct().toList();
        Map<UUID, String> abwahl = kennungen.isEmpty() ? Map.of() : repo.kennzahlenDesKundenbereichs(tenant, kennungen);
        if (abwahl.size() != kennungen.size()) {
            throw BerichtAbgelehnt.anfrage("kennzahlen_abgewaehlt");
        }
        String rolle = rolle(d, wer);
        String kennung;
        try {
            kennung = transaktion.execute(tx -> {
                String neueKennung = repo.kennungNeu(tenant, LocalDate.ofInstant(jetzt, zone).getYear());
                UUID id = repo.anlegen(tenant, neueKennung, v, g.id(), zeitraumSchluessel, zone, wer, jetzt);
                // Die Abwahl steht vor der ersten Bildung — schon der erste Entwurf lässt die Kennzahl weg.
                repo.abwaehlen(tenant, id, abwahl.keySet(), wer, jetzt);
                bilden(id, jetzt, GEBILDET_BEIM_ANLEGEN);
                Map<String, Object> neu = new LinkedHashMap<>();
                neu.put("kennung", neueKennung);
                neu.put("vorlage", v.schluessel());
                neu.put("geltung_art", v.geltungArt());
                neu.put("geltung_id", g.id().toString());
                neu.put("zeitraum", zeitraumSchluessel);
                if (!abwahl.isEmpty()) {
                    neu.put("kennzahlen_abgewaehlt", abwahl.values().stream().sorted().toList());
                }
                repo.protokoll(tenant, id, null, BerichtRechte.ANLEGEN, null, text(neu), null, wer, rolle, jetzt);
                return neueKennung;
            });
        } catch (DuplicateKeyException e) {
            throw repo.berichtZu(v.schluessel(), v.geltungArt(), g.id(), zeitraumSchluessel).map(BerichtService::gibtEsSchon)
                    .orElseGet(() -> BerichtAbgelehnt.von(Ablehnung.GLEICHZEITIG));
        }
        return uebersicht(tenant, repo.bericht(kennung).orElseThrow());
    }

    /** AP-16 S5 — Startwert 12; Änderung nur an der Bewertung und immer mit Begründung. */
    public Uebersicht wiedervorlageAendern(String kennung, int monate, String begruendung, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.WIEDERVORLAGE_AENDERN);
        Kopf kopf = z.kopf();
        if (!BerichtRegeln.ENERGETISCHE_BEWERTUNG.equals(kopf.vorlage())) {
            throw BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
        if (monate < 1 || monate > 120) {
            throw BerichtAbgelehnt.anfrage("wiedervorlage_monate");
        }
        pruefeBegruendung(begruendung);
        String rolle = rolle(z.darf(), wer);
        transaktion.executeWithoutResult(tx -> {
            repo.sperren(kopf.tenant(), kopf.id());
            if (kopf.wiedervorlageMonate() != monate) {
                repo.wiedervorlageAendern(kopf.tenant(), kopf.id(), monate);
                repo.protokoll(kopf.tenant(), kopf.id(), null, BerichtRechte.WIEDERVORLAGE_AENDERN,
                        text(Map.of("wiedervorlage_monate", kopf.wiedervorlageMonate())),
                        text(Map.of("wiedervorlage_monate", monate)), begruendung, wer, rolle, z.jetzt());
            }
        });
        return uebersicht(kopf.tenant(), repo.bericht(kennung).orElseThrow());
    }

    // ================================================================================ freigeben

    /** {@code POST …/freigeben} mit dem Datenstand des gesehenen Entwurfs (F1–F5). */
    public Freigabe freigeben(String kennung, Instant uebermittelt, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.FREIGEBEN);
        Kopf kopf = z.kopf();
        try {
            return transaktion.execute(tx -> freigebenInDerTransaktion(z, uebermittelt.truncatedTo(ChronoUnit.MICROS), wer));
        } catch (DuplicateKeyException e) {
            return repo.standZumDatenstand(kopf.tenant(), kopf.id(), uebermittelt)
                    .map(nr -> new Freigabe(new Stand(kopf, geprueft(kopf, nr), teilansicht(z)), false))
                    .orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.GLEICHZEITIG));
        }
    }

    private Freigabe freigebenInDerTransaktion(Zugriff z, Instant uebermittelt, ProtokollAkteur wer) {
        Kopf kopf = z.kopf();
        UUID tenant = kopf.tenant();
        Instant jetzt = z.jetzt();
        repo.sperren(tenant, kopf.id());
        Optional<Integer> schon = repo.standZumDatenstand(tenant, kopf.id(), uebermittelt);
        if (schon.isPresent()) {
            return new Freigabe(new Stand(kopf, geprueft(kopf, schon.get()), teilansicht(z)), false);
        }
        EntwurfZeile e = repo.entwurf(tenant, kopf.id(), "FOR SHARE")
                .orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        List<StandZeile> staende = repo.staende(tenant, kopf.id());
        StandZeile gueltig = staende.isEmpty() ? null : staende.get(staende.size() - 1);
        JsonNode abzug = baum(e.abzug());

        // D2 bei der Freigabe und D3: seit dem Datenstand darf sich an keiner Quelle etwas geändert haben.
        List<BerichtRegeln.Aenderung> dazwischen = new ArrayList<>(BerichtRegeln.d2(e.datenstand(),
                zeiten(abzug, "berechnet_am"), zeiten(abzug, "endgueltig_ab"), true));
        dazwischen.addAll(BerichtRegeln.d3(e.datenstand(), jetzt, aenderungenSeit(kopf, e.datenstand(), jetzt)));
        boolean gesehen = uebermittelt.equals(e.datenstand());
        List<BerichtRegeln.Abweichung> abweichungen = gesehen || gueltig == null ? List.of()
                : BerichtRegeln.abweichungen(baum(repo.stand(tenant, kopf.id(), gueltig.nr()).orElseThrow().abzug()), abzug);
        String anlass = gesehen ? null : repo.anlassDerNeubildung(tenant, kopf.kennung(), e.datenstand());
        BerichtRegeln.Freigabe f = BerichtRegeln.freigabe(new BerichtRegeln.FreigabeAntrag(kopf.zeitraumArt(),
                kopf.schluessel(), kopf.zone(), jetzt, freigabeWerte(abzug), uebermittelt,
                dazwischen.isEmpty() ? e.datenstand() : null, gueltig == null ? 0 : gueltig.nr(), anlass,
                abweichungen.size()));
        if (!f.erlaubt()) {
            throw abgelehnt(f, kopf.zone(), dazwischen, abweichungen);
        }

        int nr = f.nr();
        String rolle = rolle(z.darf(), wer);
        UUID anlassAnstoss = gueltig == null ? null : repo.anstoesse(tenant, kopf.id()).stream()
                .filter(a -> a.nr() == gueltig.nr() && OFFEN.equals(a.zustand())).map(AnstossZeile::id).findFirst()
                .orElse(null);
        repo.standEinfrieren(tenant, kopf.id(), nr, e.datenstand(), jetzt, wer, rolle, objekt(abzug.path("kopf").path("darstellung")),
                objekt(abzug.path("kopf").path("regelwerk")), kopf.vorlageFassung(), anlassAnstoss)
                .orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.GLEICHZEITIG));
        repo.quellenEinfrieren(tenant, kopf.id(), nr);
        if (gueltig != null) {
            repo.ersetzen(tenant, kopf.id(), gueltig.nr(), nr);
        }
        repo.anstoesseErledigen(tenant, kopf.id(), nr);
        StandZeile neu = repo.stand(tenant, kopf.id(), nr).orElseThrow();
        ereignisFreigegeben(tenant, kopf.kennung(), neu);
        Map<String, Object> protokoll = new LinkedHashMap<>();
        protokoll.put("nr", nr);
        protokoll.put("datenstand", neu.datenstand().toString());
        protokoll.put("pruefsumme", neu.pruefsumme());
        protokoll.put("anlass_anstoss_id", anlassAnstoss == null ? null : anlassAnstoss.toString());
        repo.protokoll(tenant, kopf.id(), nr, BerichtRechte.FREIGEBEN, null, text(protokoll), null, wer, rolle, jetzt);
        return new Freigabe(new Stand(kopf, neu, teilansicht(z)), true);
    }

    // ================================================================================ Anstoß, archivieren

    /** {@code POST …/anstoesse/{id}/verwerfen}: Anstoß des Berichts (404) → Begründung (422) → offen (409) (R4, F5). */
    public Verworfen verwerfen(String kennung, String anstossId, String begruendung, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.VERWERFEN);
        Kopf kopf = z.kopf();
        UUID id = uuid(anstossId).orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        AnstossZeile a = repo.anstoss(kopf.tenant(), kopf.id(), id)
                .orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        pruefeBegruendung(begruendung);
        if (!OFFEN.equals(a.zustand())) {
            throw BerichtAbgelehnt.von(Ablehnung.ANSTOSS_NICHT_OFFEN, Map.of("zustand", a.zustand()));
        }
        String rolle = rolle(z.darf(), wer);
        transaktion.executeWithoutResult(tx -> {
            repo.sperren(kopf.tenant(), kopf.id());
            if (!repo.verwerfen(kopf.tenant(), id, begruendung, wer, z.jetzt())) {
                throw BerichtAbgelehnt.von(Ablehnung.ANSTOSS_NICHT_OFFEN,
                        Map.of("zustand", repo.anstoss(kopf.tenant(), kopf.id(), id).orElseThrow().zustand()));
            }
            repo.protokoll(kopf.tenant(), kopf.id(), a.nr(), BerichtRechte.VERWERFEN,
                    text(Map.of("anstoss_id", id.toString(), "zustand", OFFEN)),
                    text(Map.of("anstoss_id", id.toString(), "zustand", VERWORFEN)), begruendung, wer, rolle, z.jetzt());
        });
        return new Verworfen(kopf, repo.anstoss(kopf.tenant(), kopf.id(), id).orElseThrow());
    }

    /** {@code POST …/archivieren}: verbirgt den Bericht in der Liste, die Stände bleiben lesbar (V4); ein zweites Mal ändert nichts. */
    public Uebersicht archivieren(String kennung, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.ARCHIVIEREN);
        Kopf kopf = z.kopf();
        String rolle = rolle(z.darf(), wer);
        transaktion.executeWithoutResult(tx -> {
            repo.sperren(kopf.tenant(), kopf.id());
            if (repo.archivieren(kopf.tenant(), kopf.id(), z.jetzt())) {
                Map<String, Object> alt = new LinkedHashMap<>();
                alt.put("archiviert_am", null);
                repo.protokoll(kopf.tenant(), kopf.id(), null, BerichtRechte.ARCHIVIEREN, text(alt),
                        text(Map.of("archiviert_am", z.jetzt().toString())), null, wer, rolle, z.jetzt());
            }
        });
        return uebersicht(kopf.tenant(), repo.bericht(kennung).orElseThrow());
    }

    // ================================================================================ D4 und Fristen

    /** D4 — die Änderungen an den Quellen und die abgelaufenen Fristen seit dem Datenstand; leer = der Entwurf ist aktuell. */
    List<BerichtRegeln.Aenderung> aenderungenSeit(Kopf kopf, Instant datenstand, Instant jetzt) {
        List<BerichtRegeln.Aenderung> alle = new ArrayList<>(repo.aenderungenSeit(kopf.tenant(), kopf.id(), datenstand));
        alle.addAll(fristen(BerichtRegeln.zeitraum(kopf.zeitraumArt(), kopf.schluessel(), kopf.zone()), kopf.zone(),
                datenstand, jetzt));
        return BerichtRegeln.d4(datenstand, alle);
    }

    /**
     * Was ohne neue Zeile anders geworden ist: das Ende des Zeitraums („Zeitraum läuft“ gilt nicht mehr) und jedes „endgültig
     * ab“ eines Tags im Zeitraum, das in (Datenstand, jetzt] liegt — der Endgültigkeits-Lauf ändert {@code berechnet_am}
     * nicht. Die Frist spricht {@link TagRegeln#endgueltigAb}.
     */
    static List<BerichtRegeln.Aenderung> fristen(BerichtRegeln.Zeitraum z, ZoneId zone, Instant datenstand, Instant jetzt) {
        List<BerichtRegeln.Aenderung> raus = new ArrayList<>();
        if (dazwischen(z.bis(), datenstand, jetzt)) {
            raus.add(new BerichtRegeln.Aenderung(null, ZEITRAUM_ZU_ENDE, z.bis()));
        }
        for (LocalDate tag = z.ersterTag(); !tag.isAfter(z.letzterTag()); tag = tag.plusDays(1)) {
            Instant ab = TagRegeln.endgueltigAb(TagRegeln.beginn(tag.plusDays(1), zone));
            if (dazwischen(ab, datenstand, jetzt)) {
                raus.add(new BerichtRegeln.Aenderung(null, BerichtRegeln.ENDGUELTIG_AB, ab));
            }
        }
        return raus;
    }

    private static boolean dazwischen(Instant t, Instant nach, Instant bis) {
        return t.isAfter(nach) && !t.isAfter(bis);
    }

    private Entwurf aktuellerEntwurf(Zugriff z) {
        Kopf kopf = z.kopf();
        EntwurfZeile gelesen = repo.entwurf(kopf.tenant(), kopf.id(), "")
                .orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        AtomicBoolean neu = new AtomicBoolean(false);
        EntwurfZeile e = gelesen;
        if (!aenderungenSeit(kopf, gelesen.datenstand(), z.jetzt()).isEmpty()) {
            e = transaktion.execute(tx -> {
                EntwurfZeile gesperrt = repo.entwurf(kopf.tenant(), kopf.id(), "FOR UPDATE").orElseThrow();
                if (aenderungenSeit(kopf, gesperrt.datenstand(), z.jetzt()).isEmpty()) {
                    return gesperrt; // eine andere Anfrage oder die Kaskade hat ihn eben neu gebildet
                }
                bilden(kopf.id(), z.jetzt(), GEBILDET_BEIM_ABRUF);
                neu.set(true);
                return repo.entwurf(kopf.tenant(), kopf.id(), "").orElseThrow();
            });
        }
        return new Entwurf(kopf, e, neu.get(), teilansicht(z));
    }

    /** EW3 — die Bildung auf der Verbindung DIESER Transaktion; Standort und Unternehmen (AP-12 IP-6). */
    private void bilden(UUID bericht, Instant jetzt, String gebildetVon) {
        DataSource quelle = jdbc.getDataSource();
        Connection con = DataSourceUtils.getConnection(quelle);
        try {
            bildung.bilden(con, bericht, jetzt, gebildetVon);
        } finally {
            DataSourceUtils.releaseConnection(con, quelle);
        }
    }

    // ================================================================================ Hilfen

    private Zugriff zugriff(String kennung, ProtokollAkteur wer, String handlung) {
        kundenbereich();
        Instant jetzt = jetzt();
        Kopf kopf = repo.bericht(kennung).orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        Benutzer b = aufrufer.benutzer(wer);
        Kundenbereich k = rechteKundenbereich();
        DarfErgebnis d = Geltungsbereich.requireScope(b, k,
                BerichtRechte.kennung(handlung, kopf.geltungArt(), kopf.vorlage()),
                kopf.standortId() == null ? null : kopf.standortId().toString(), jetzt, BerichtAbgelehnt::rechte);
        return new Zugriff(kopf, d, b, k, jetzt);
    }

    private static DarfErgebnis darf(Benutzer b, Kundenbereich k, String handlung, Kopf kopf, Instant jetzt) {
        return Geltungsbereich.scope(b, k, BerichtRechte.kennung(handlung, kopf.geltungArt(), kopf.vorlage()),
                kopf.standortId() == null ? null : kopf.standortId().toString(), jetzt);
    }

    /** Darf die Person irgendeinen Bericht lesen — am Unternehmen oder an einem Standort? Sonst das Nein (403 vor 404). */
    private static void irgendwoLesbar(Benutzer b, Kundenbereich k, Instant jetzt) {
        DarfErgebnis nein = Geltungsbereich.scope(b, k, BerichtRechte.UNTERNEHMEN, null, jetzt);
        if (nein.darf()) {
            return;
        }
        DarfErgebnis bewertung = Geltungsbereich.scope(b, k, BerichtRechte.BEWERTUNG, null, jetzt);
        if (bewertung.darf()) {
            return;
        }
        for (RechteAbleitung.Standort s : k.standorte()) {
            DarfErgebnis d = Geltungsbereich.scope(b, k, BerichtRechte.STANDORT_ABRUFEN, s.kennzeichen(), jetzt);
            if (d.darf()) {
                return;
            }
            if (nein.http() != 403 && d.http() == 403) {
                nein = d;
            }
        }
        throw BerichtAbgelehnt.rechte(nein);
    }

    /** Die Standorte des Kundenbereichs als Standort-IDs (Muster Kennzahl); die Kundenadministratoren kennt die API nicht. */
    private Kundenbereich rechteKundenbereich() {
        return new Kundenbereich("Kundenbereich", repo.standorte().stream()
                .map(s -> new RechteAbleitung.Standort(s.id().toString(), s.name())).toList(), List.of());
    }

    private static List<String> teilansicht(Zugriff z) {
        return BerichtRechte.teilansicht(z.benutzer(), z.kundenbereich(), z.jetzt());
    }

    /** Die Rolle, die das Recht gab — so steht sie an Stand und Protokoll. */
    private static String rolle(DarfErgebnis d, ProtokollAkteur wer) {
        return d.rolle() == null ? wer.rolle() : d.rolle().code();
    }

    private Uebersicht uebersicht(UUID tenant, Kopf x) {
        List<StandZeile> staende = repo.staende(tenant, x.id());
        Instant datenstand = repo.entwurfDatenstand(tenant, x.id()).orElse(null);
        if (staende.isEmpty()) {
            return new Uebersicht(x, null, datenstand, ZEICHEN_ENTWURF,
                    datenstand == null ? null : BerichtRegeln.entwurf(datenstand, x.zone()), null);
        }
        StandZeile gueltig = staende.get(staende.size() - 1);
        Ueberpruefung ueberpruefung = ueberpruefung(tenant, x, gueltig);
        List<AnstossZeile> anstoesse = repo.anstoesse(tenant, x.id()).stream().filter(a -> a.nr() == gueltig.nr()).toList();
        Optional<AnstossZeile> offen = anstoesse.stream().filter(a -> OFFEN.equals(a.zustand())).findFirst();
        if (offen.isPresent()) {
            return new Uebersicht(x, gueltig.nr(), datenstand, ZEICHEN_REVISION,
                    BerichtRegeln.revisionNoetig(BerichtRegeln.anlass(offen.get().anlassKennung())), ueberpruefung);
        }
        AnstossZeile letzter = anstoesse.isEmpty() ? null : anstoesse.get(anstoesse.size() - 1);
        if (letzter != null && VERWORFEN.equals(letzter.zustand())) {
            return new Uebersicht(x, gueltig.nr(), datenstand, ZEICHEN_VERWORFEN,
                    BerichtRegeln.anstossVerworfen(letzter.verworfenBegruendung()), ueberpruefung);
        }
        return new Uebersicht(x, gueltig.nr(), datenstand, ZEICHEN_STAND, BerichtRegeln.berichtsstand(gueltig.nr()),
                ueberpruefung);
    }

    /**
     * AP-16 S5/S6 (IP-24): beim Abruf abgeleitet, nie geschrieben — Frist aus dem jüngsten gültigen Stand und der
     * Wiedervorlage, „heute“ aus der injizierten Uhr in der Zone des Berichts. Archivierte Bewertungen haben keine Frist.
     */
    private Ueberpruefung ueberpruefung(UUID tenant, Kopf x, StandZeile gueltig) {
        if (!BerichtRegeln.ENERGETISCHE_BEWERTUNG.equals(x.vorlage()) || x.archiviertAm() != null) {
            return null;
        }
        LocalDate heute = LocalDate.ofInstant(jetzt(), x.zone());
        String abgeloest = BewertungFrist.abgeloestDurch(x.kennung(), repo.bewertungsStaende(tenant, x.unternehmenId()));
        BewertungFrist.Frist frist = BewertungFrist.ableiten(gueltig.nr(),
                LocalDate.ofInstant(gueltig.freigegebenAm(), x.zone()), x.wiedervorlageMonate(), heute, abgeloest);
        return new Ueberpruefung(frist, repo.einsatzLage(tenant, x.unternehmenId(), heute));
    }

    /** Ein Stand, dessen Prüfsumme über den gespeicherten Text stimmt — sonst 500 {@code abzug_beschaedigt}. */
    private StandZeile geprueft(Kopf kopf, int nr) {
        Optional<StandZeile> s = nr < 1 ? Optional.empty() : repo.stand(kopf.tenant(), kopf.id(), nr);
        if (s.isEmpty()) {
            List<StandZeile> alle = repo.staende(kopf.tenant(), kopf.id());
            StandZeile neueste = alle.isEmpty() ? null : alle.get(alle.size() - 1);
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("nr", nr);
            fakten.put("neueste_nr", neueste == null ? null : neueste.nr());
            throw BerichtAbgelehnt.regel(Ablehnung.STAND_GIBT_ES_NICHT, BerichtRegeln.standGibtEsNicht(nr,
                    neueste == null ? null : neueste.nr(), neueste == null ? null : neueste.freigegebenAm(), kopf.zone()),
                    fakten);
        }
        if (!BerichtRegeln.pruefsumme(s.get().abzug()).equals(s.get().pruefsumme())) {
            throw BerichtAbgelehnt.regel(Ablehnung.ABZUG_BESCHAEDIGT, BerichtRegeln.abzugBeschaedigt(nr), Map.of("nr", nr));
        }
        return s.get();
    }

    private Geltung geltung(boolean standort, String geltungId) {
        Optional<UUID> id = uuid(geltungId);
        Optional<Geltung> g = id.isEmpty() ? Optional.empty()
                : (standort ? repo.standorte().stream() : repo.unternehmen().stream()).filter(x -> x.id().equals(id.get()))
                        .findFirst();
        return g.orElseThrow(() -> BerichtAbgelehnt.regel(Ablehnung.GELTUNG_UNBEKANNT,
                BerichtRegeln.SAETZE.get(BerichtRegeln.GELTUNG_UNBEKANNT), Map.of("feld", "geltung_id")));
    }

    private static BerichtAbgelehnt gibtEsSchon(Kopf x) {
        return BerichtAbgelehnt.regel(Ablehnung.BERICHT_GIBT_ES_SCHON,
                BerichtRegeln.berichtGibtEsSchon(x.kennung(), x.geltungName(), x.zeitraumArt(), x.schluessel()),
                Map.of("kennung", x.kennung()));
    }

    /** Die Ablehnung einer F1-Voraussetzung mit Code, Kundensatz und Fakten; Zeitpunkte in der Zone der Geltung. */
    private static BerichtAbgelehnt abgelehnt(BerichtRegeln.Freigabe f, ZoneId zone, List<BerichtRegeln.Aenderung> dazwischen,
            List<BerichtRegeln.Abweichung> abweichungen) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        switch (f.code()) {
            case BerichtRegeln.ZEITRAUM_NICHT_ZU_ENDE -> fakten.put("moeglich_ab", mitVersatz(f.moeglichAb(), zone));
            case BerichtRegeln.WERTE_VORLAEUFIG -> {
                fakten.put("vorlaeufig", f.vorlaeufig());
                fakten.put("vorlaeufige", f.vorlaeufige());
                fakten.put("moeglich_ab", mitVersatz(f.moeglichAb(), zone));
            }
            default -> {
                fakten.put("datenstand_uebermittelt", mitVersatz(f.datenstandUebermittelt(), zone));
                fakten.put("datenstand_aktuell", mitVersatz(f.datenstandAktuell(), zone));
                fakten.put("abweichungen", abweichungen.stream().map(BerichtService::abweichung).toList());
                fakten.put("aenderungen", dazwischen.stream().map(a -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("quelle", a.quelle());
                    m.put("art", a.art());
                    m.put("zeitpunkt", mitVersatz(a.zeitpunkt(), zone));
                    return m;
                }).toList());
            }
        }
        return BerichtAbgelehnt.regel(Ablehnung.valueOf(f.code().toUpperCase(Locale.ROOT)), f.kundensatz(), fakten);
    }

    static Map<String, Object> abweichung(BerichtRegeln.Abweichung a) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("quelle", a.quelle());
        m.put("menge_art", a.mengeArt());
        m.put("vorher", a.vorher() == null ? null : a.vorher().toPlainString());
        m.put("nachher", a.nachher() == null ? null : a.nachher().toPlainString());
        m.put("version", a.version());
        m.put("anlass", a.anlass());
        return m;
    }

    /** F1 — jeder Wert und jede Kennzahl des Abzugs mit Fassung und „endgültig ab“. */
    static List<BerichtRegeln.FreigabeWert> freigabeWerte(JsonNode abzug) {
        List<BerichtRegeln.FreigabeWert> raus = new ArrayList<>();
        for (String abschnitt : List.of("werte", "kennzahlen")) {
            abzug.path(abschnitt).forEach(w -> raus.add(new BerichtRegeln.FreigabeWert(w.path("quelle").asText(),
                    w.path("name_zum_datenstand").asText(null), w.path("fassung").asText(null), zeit(w.path("endgueltig_ab")))));
        }
        return raus;
    }

    /** D2 — jeder Zeitpunkt eines Felds in Werten und Kennzahlen des Abzugs. */
    static List<Instant> zeiten(JsonNode abzug, String feld) {
        List<Instant> raus = new ArrayList<>();
        for (String abschnitt : List.of("werte", "kennzahlen")) {
            abzug.path(abschnitt).forEach(w -> {
                Instant t = zeit(w.path(feld));
                if (t != null) {
                    raus.add(t);
                }
            });
        }
        return raus;
    }

    private static Instant zeit(JsonNode n) {
        return n.isTextual() ? OffsetDateTime.parse(n.asText()).toInstant() : null;
    }

    private static String mitVersatz(Instant t, ZoneId zone) {
        return t == null ? null : t.atZone(zone).toOffsetDateTime().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
    }

    /** Die Meldung {@code bericht_freigegeben} (Urheber kunde, Bezug der Bericht) — Kennung abgeleitet, eine je Stand. */
    private void ereignisFreigegeben(UUID tenant, String kennung, StandZeile s) {
        ObjectNode e = json.createObjectNode();
        e.put("ereignis_id", UUID.nameUUIDFromBytes((EREIGNIS_FREIGEGEBEN + ":" + tenant + ":" + kennung + ":" + s.nr())
                .getBytes(StandardCharsets.UTF_8)).toString());
        e.put("art", EREIGNIS_FREIGEGEBEN);
        e.put("zeitpunkt", s.freigegebenAm().truncatedTo(ChronoUnit.SECONDS).toString());
        e.put("bericht", kennung);
        e.put("nr", s.nr());
        e.put("datenstand", s.datenstand().truncatedTo(ChronoUnit.SECONDS).toString());
        e.put("pruefsumme", s.pruefsumme());
        melden(tenant, e);
    }

    /** Die Meldung {@code bericht_abgerufen} (DA5, Urheber kunde, Bezug der Bericht) — ihre Kennung ist die des Abrufs. */
    private void ereignisAbgerufen(UUID tenant, String kennung, int nr, String format, UUID abruf, Instant jetzt) {
        ObjectNode e = json.createObjectNode();
        e.put("ereignis_id", abruf.toString());
        e.put("art", EREIGNIS_ABGERUFEN);
        e.put("zeitpunkt", jetzt.toString());
        e.put("bericht", kennung);
        e.put("nr", nr);
        e.put("format", format);
        melden(tenant, e);
    }

    private void melden(UUID tenant, ObjectNode e) {
        MessreiheEreignisRepository.Ergebnis r = ereignisse.anhaengen(tenant, null, EreignisVokabular.Urheber.KUNDE, e, null,
                null);
        if (r.ausgang() != MessreiheEreignisRepository.Ausgang.ANGEHAENGT) {
            throw new IllegalStateException(e.path("art").asText() + " nicht angehängt: " + r.ausgang() + " " + r.grund()
                    + " " + r.hinweis());
        }
    }

    private static void pruefeBegruendung(String text) {
        if (text == null || text.isBlank()) {
            throw BerichtAbgelehnt.von(Ablehnung.BEGRUENDUNG_FEHLT, Map.of("feld", "begruendung"));
        }
        int zeichen = text.codePointCount(0, text.length());
        if (zeichen < TEXT_MINDESTENS || zeichen > TEXT_HOECHSTENS) {
            throw BerichtAbgelehnt.von(Ablehnung.BEGRUENDUNG_FEHLT, Map.of("feld", "begruendung", "zeichen", zeichen));
        }
    }

    private static UUID kundenbereich() {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
        return tenant;
    }

    private static Optional<UUID> uuid(String text) {
        try {
            return text == null ? Optional.empty() : Optional.of(UUID.fromString(text));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    static JsonNode baum(String abzug) {
        try {
            return ABZUG.readTree(abzug);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Ein gespeicherter Abzug ist kein JSON", e);
        }
    }

    /** Ein Objekt des Abzugs als Text für {@code jsonb}; fehlt es, das leere Objekt. */
    private static String objekt(JsonNode n) {
        return n.isObject() ? n.toString() : "{}";
    }

    private String text(Map<String, Object> werte) {
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
