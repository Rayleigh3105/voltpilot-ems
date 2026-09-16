package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.BezugsdatenImportDto;
import com.voltpilot.api.web.dto.BezugsgroesseDto;
import com.voltpilot.api.web.dto.BezugsdatenVorlageDto;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die VORSCHAU eines Imports (UEMS AP-09 IP-12): holt, was die reine Regel {@link ImportVorschau} fragt — die
 * Bezugsgrößen des Kundenbereichs mit der Zone ihres Standorts, den wirksamen Stand je Schlüssel, die Importe
 * derselben Datei — und macht aus dem Ergebnis die Antwort mit Kundensätzen und Vorschau-Kennung.
 *
 * <p><b>Sie schreibt nichts.</b> Alles läuft in EINER Nur-Lese-Transaktion ({@code BEGIN READ ONLY}): die
 * Datenbank selbst lehnt einen Schreibversuch ab. Die Datei lebt nur für die Dauer der Anfrage im Speicher und
 * wird nirgends abgelegt (E14).
 *
 * <p><b>Der Stand je Schlüssel</b> ist der des Lesemodells {@link BezugsgroesseService#werte} (Lesart
 * {@code wirksam}) — AUFGERUFEN, nicht nachgebaut. Ein zurückgenommener Wert hat keinen Betrag (der Schlüssel ist
 * frei, §4.7). Trägt eine Kette Vier-Augen-Fassungen (Stand offen, IP-7), wird gegen ihre jüngste wirksame
 * Fassung geurteilt.
 *
 * <p><b>Welche Bezugsgröße Werte aufnimmt:</b> eine nicht archivierte mit der Wertart Periodenwert oder Stand. Ein
 * Stammdatum hat Gültigkeiten, keine Werte (E15/E17). Beides hat im geschlossenen Befund-Vokabular kein eigenes
 * Wort; die Zeile ist darum {@code bezug_unbekannt}.
 */
@Service
public class ImportVorschauService {

    private final BezugsgroesseRepository bezugsgroessen;
    private final BezugsgroesseService werte;
    private final BezugsdatenImportRepository importe;
    private final BezugsdatenVorlageService vorlagen;
    private final TransactionTemplate lesen;
    private volatile Clock uhr = Clock.systemUTC();

    public ImportVorschauService(BezugsgroesseRepository bezugsgroessen, BezugsgroesseService werte,
            BezugsdatenImportRepository importe, BezugsdatenVorlageService vorlagen,
            PlatformTransactionManager transactionManager) {
        this.bezugsgroessen = bezugsgroessen;
        this.werte = werte;
        this.importe = importe;
        this.vorlagen = vorlagen;
        this.lesen = new TransactionTemplate(transactionManager);
        this.lesen.setReadOnly(true);
    }

    /** Für Tests: die Uhr, an der „jetzt“ (Z4, E16) und die Ausstellung der Kennung hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    public BezugsdatenImportDto.Vorschau vorschau(byte[] datei, String dateiName, ImportVorschau.Zuordnung zuordnung) {
        return vorschau(datei, dateiName, zuordnung, null);
    }

    public BezugsdatenImportDto.Vorschau vorschau(byte[] datei, String dateiName, ImportVorschau.Zuordnung zuordnung,
            UUID vorlageId) {
        Instant jetzt = uhr.instant();
        UUID kundenbereich = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        return lesen.execute(status -> {
            BezugsdatenVorlageRepository.Zeile vorlage = vorlageId == null ? null : vorlagen.aktuell(vorlageId);
            ImportVorschau.Zuordnung wirksam = vorlage == null ? zuordnung : BezugsdatenZuordnung.aus(vorlage.zuordnung());
            Map<String, ImportVorschau.Ziel> ziele = ImportVorschau.nachKennzeichen(bezugsgroessen.alle().stream()
                    .filter(b -> b.archiviertAm() == null)
                    .filter(b -> "periodenwert".equals(b.wertart()) || "stand".equals(b.wertart()))
                    .map(b -> new ImportVorschau.Ziel(b.id(), b.kennzeichen(), b.wertart(), b.einheit(), b.periodeArt(),
                            ZoneId.of(bezugsgroessen.zeitzone(b.id())), 1))
                    .toList());
            Map<UUID, Map<String, BezugsdatenRegeln.Bestand>> bestand = new HashMap<>();
            ImportVorschau.Grundlagen grundlagen =
                    new ImportVorschau.Grundlagen(bezugsgroessen.vokabular().einheiten(), BezugsEinheit.UMRECHNUNGEN);
            ImportVorschau.Ergebnis e = ImportVorschau.vorschau(datei, wirksam, ziele,
                    (ziel, schluessel) -> bestand.computeIfAbsent(ziel.id(), id -> staende(ziel)).get(schluessel),
                    importe::mitFingerabdruck, grundlagen, jetzt);
            BezugsdatenVorlageDto.Verweis verweis = vorlage == null ? null
                    : new BezugsdatenVorlageDto.Verweis(vorlage.id(), vorlage.fassung(), vorlage.name());
            return antwort(e, ziele, dateiName, kundenbereich, jetzt, verweis);
        });
    }

    /** Der wirksame Stand je Schlüssel einer Bezugsgröße aus dem Lesemodell. */
    private Map<String, BezugsdatenRegeln.Bestand> staende(ImportVorschau.Ziel ziel) {
        Map<String, BezugsdatenRegeln.Bestand> aus = new HashMap<>();
        for (BezugsgroesseDto.Wert w : werte.werte(ziel.id(), null, null, "alle").werte()) {
            String schluessel = w.zeitpunkt() != null
                    ? w.zeitpunkt().toInstant().toString()
                    : BezugsPeriode.schluesselVon(w.periodeVon(), ziel.periodeArt());
            BezugsgroesseDto.Fassung gilt = null;
            if (!w.standOffen() && w.wirksameFassung() != null) {
                gilt = w.fassungen().stream().filter(f -> f.fassung() == w.wirksameFassung()).findFirst().orElse(null);
            } else if (w.standOffen()) {
                gilt = w.fassungen().stream().filter(f -> BezugsdatenRegeln.WIRKSAM.equals(f.status()) && f.betrag() != null)
                        .reduce((a, b) -> b.fassung() > a.fassung() ? b : a).orElse(null);
            }
            if (gilt != null && gilt.betrag() != null) {
                aus.put(schluessel, new BezugsdatenRegeln.Bestand(new BigDecimal(gilt.betrag()), gilt.fassung(),
                        gilt.herkunft() == null ? null : gilt.herkunft().importKennung()));
            }
        }
        return aus;
    }

    private static BezugsdatenImportDto.Vorschau antwort(ImportVorschau.Ergebnis e, Map<String, ImportVorschau.Ziel> ziele,
            String dateiName, UUID kundenbereich, Instant jetzt, BezugsdatenVorlageDto.Verweis vorlage) {
        Instant ausgestellt = Instant.ofEpochSecond(jetzt.getEpochSecond());
        ZoneId anzeige = BezugsdatenRegeln.ANZEIGE_ZEITZONE;
        BezugsdatenImportDto.Kennung kennung = new BezugsdatenImportDto.Kennung(
                ImportVorschau.kennung(kundenbereich, e.ergebnisFingerabdruck(), ausgestellt), ImportVorschau.VORSCHAU,
                zeit(ausgestellt, anzeige), zeit(ausgestellt.plus(ImportVorschau.GUELTIG), anzeige), e.ergebnisFingerabdruck());
        ImportVorschau.Datei d = e.datei();
        BezugsdatenImportDto.Datei datei = new BezugsdatenImportDto.Datei(dateiName, d.bytes(), d.sha256(),
                d.befund() == null ? null : befund(d.befund()), d.zusatz(),
                d.zusatz() == null ? null : CsvLeser.zusatz(d.zusatz()), d.zeile(), d.kodierung(), d.bom(),
                d.trennzeichen(), d.kopfzeile(), d.kopf(), d.spalten(), d.datenzeilen());
        BezugsdatenImportDto.FruehererImport frueher = e.fruehererImport() == null ? null
                : new BezugsdatenImportDto.FruehererImport(e.fruehererImport().kennung(), e.fruehererImport().status(),
                        zeit(e.fruehererImport().am(), anzeige));
        List<BezugsdatenImportDto.Zeile> zeilen = e.zeilen().stream().map(z -> {
            ImportVorschau.Ziel ziel = z.bezugsgroesse() == null ? null : ziele.get(z.bezugsgroesse());
            ZoneId zone = ziel == null ? anzeige : ziel.zone();
            return new BezugsdatenImportDto.Zeile(z.nr(), z.felder(), z.bezugsgroesse(), z.bezugsgroesseId(), z.schluessel(),
                    z.von() == null ? null : z.von().atZone(zone).toLocalDate(),
                    z.bis() == null ? null : z.bis().atZone(zone).toLocalDate().minusDays(1),
                    zeit(z.zeitpunkt(), zone), text(z.betrag()), z.einheit(),
                    new BezugsdatenImportDto.Geliefert(z.geliefertWert(), z.geliefertEinheit()), z.urteil(),
                    z.befunde().stream().map(ImportVorschauService::befund).toList(), z.fingerabdruck(),
                    z.bestand() == null ? null : new BezugsdatenImportDto.Bestand(text(z.bestand().betrag()),
                            z.bestand().fassung(), z.bestand().importKennung()));
        }).toList();
        BezugsdatenRegeln.Importergebnis i = e.importergebnis();
        BezugsdatenRegeln.Zaehler n = i.zaehler();
        BezugsdatenImportDto.Import imp = new BezugsdatenImportDto.Import(i.status(),
                new BezugsdatenImportDto.Zaehler(n.zeilen(), n.neu(), n.wiederholung(), n.konflikt(), n.berichtigung(),
                        n.uebersprungen(), n.abgelehnt(), n.mitHinweis()),
                i.uebernahmeMoeglich(), i.importDatensatz(), i.bestaetigung(), i.aenderungen(),
                i.befunde().stream().map(ImportVorschauService::befund).toList());
        return new BezugsdatenImportDto.Vorschau(kennung, vorlage, datei, frueher, zeilen, imp);
    }

    private static BezugsdatenImportDto.Befund befund(String befund) {
        return new BezugsdatenImportDto.Befund(befund, ImportVorschau.satz(befund),
                BezugsdatenRegeln.HINWEIS_BEFUNDE.contains(befund));
    }

    private static OffsetDateTime zeit(Instant t, ZoneId zone) {
        return t == null ? null : t.atZone(zone).toOffsetDateTime();
    }

    /** Dezimaltext ohne Exponent und ohne nachlaufende Nullen: 312400, nicht 3.124E+5. */
    private static String text(BigDecimal b) {
        return b == null ? null : b.signum() == 0 ? "0" : b.stripTrailingZeros().toPlainString();
    }
}
