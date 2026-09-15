package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BezugsdatenRegeln.Bestand;
import com.voltpilot.api.uems.BezugsdatenRegeln.Fassungsverlauf;
import com.voltpilot.api.uems.BezugsdatenRegeln.Vorgang;
import com.voltpilot.api.uems.BezugsgroesseRegeln.Ablehnung;
import com.voltpilot.api.uems.BezugsgroesseRepository.WertZeile;
import com.voltpilot.api.uems.BezugsgroesseRepository.Zeile;
import com.voltpilot.api.uems.BezugswertRepository.Berichtigung;
import com.voltpilot.api.uems.BezugswertRepository.NeueFassung;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Korrektur;
import com.voltpilot.api.web.dto.BezugsgroesseDto;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Den Wert einer Bezugsgröße eingeben, berichtigen und freigeben (UEMS AP-09 IP-7: F1–F5, U5/U6, Z4, E6).
 *
 * <p><b>Keine zweite Regel-Logik.</b> Die Periode ({@link BezugsPeriode}), die Zahl ({@link BezugsdatenRegeln#zahl}),
 * die Plausibilität ({@link BezugsdatenRegeln#plausibilitaet}), der Stand der Kette ({@link BezugsdatenRegeln#fassungen}),
 * das Urteil neu · wiederholung · berichtigung ({@link BezugsdatenRegeln#urteil}) und die Ablehnungen in ihrer
 * Prüfreihenfolge ({@link BezugsgroesseRegeln#eingeben}, {@link BezugsgroesseRegeln#berichtigen}) werden AUFGERUFEN.
 * Hier steht, was die reinen Regeln nicht wissen: die Zeitzone, die gespeicherte Kette, die Vier-Augen-Einstellung,
 * der offene Vorschlag und die Kennung.
 *
 * <p><b>Vier Augen (F3, AP-08 E8):</b> aus (Vorgabe) — die Berichtigung ist sofort Fassung n + 1 (ihr Vorgang
 * {@code BK-…} ist gleich {@code freigegeben}); an — sie ist ein Vorschlag im Vorgang, der Wert bleibt, wie er ist,
 * bis eine zweite Person über {@code POST /api/v1/korrekturen/{kennung}/freigeben} freigibt ({@link #freigeben}).
 * Erst dann entsteht die Wert-Fassung — mit Urheber UND Freigeber an derselben Zeile, in der Nummerierung der Regel
 * {@code fassung} (Vertrag B5: „Jonas gibt frei → Fassung 2 wirksam“) — und das Ereignis {@code correction} mit Bezug
 * {@code bezugsgroesse} (F4). Ein Erstwert braucht beides nicht (F1).
 *
 * <p><b>Jede Ablehnung schreibt nichts:</b> geurteilt wird vor der ersten Zeile, alles in EINER Transaktion unter der
 * Sperre des Kundenbereichs. Die Vier-Augen-Einstellung wird ZUERST gesperrt ({@code FOR SHARE}), dann der
 * Kundenbereich — dieselbe Reihenfolge wie die Freigabe, damit sich die beiden nie gegenseitig warten lassen.
 */
@Service
public class BezugswertService {

    /** Pfad und Anfrage nennen die Periode selbst (Z3 {@code periode}: „2026-10“, „Oktober 2026“, „2026-W40“). */
    static final String DEUTUNG = "periode";

    /** Die Zahl kommt, wie ein Mensch sie tippt: deutsch, Punkt = Tausender (U4). */
    static final String FORMAT = BezugsdatenRegeln.ZAHLFORMAT_VORGABE;

    /** Die Entscheidung einer Berichtigung im Urteil der Zeile (§4.7): der neue Betrag ersetzt den wirksamen. */
    private static final String ERSETZEN = "ersetzen";

    private static final String FREIGEGEBEN = EreignisVokabular.KORREKTUR_STATUS.get(1);

    /** U6: gebunden ist genau EINE Einheit nur, wenn eine Messstelle der Bezug ist. */
    private static final String MESSSTELLE = "messstelle";

    private static final java.util.regex.Pattern NACHKOMMASTELLEN = java.util.regex.Pattern.compile("^[+-]?[0-9][0-9.]*,[0-9]+$");

    private final BezugsgroesseRepository bezugsgroessen;
    private final BezugswertRepository werte;
    private final MessreiheEreignisRepository ereignisse;
    private final BezugsgroesseService lesemodell;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;
    private volatile Clock uhr = Clock.systemUTC();

    public BezugswertService(BezugsgroesseRepository bezugsgroessen, BezugswertRepository werte,
            MessreiheEreignisRepository ereignisse, BezugsgroesseService lesemodell,
            PlatformTransactionManager transactionManager, ObjectMapper json) {
        this.bezugsgroessen = bezugsgroessen;
        this.werte = werte;
        this.ereignisse = ereignisse;
        this.lesemodell = lesemodell;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    /** Nur für Tests. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Was aus Pfad und Anfrage gelesen wurde, mit den Befunden der reinen Regeln. */
    private record Gelesen(ZoneId zone, BezugsPeriode.Periodendeutung periode, LocalDate periodeVon,
            LocalDate periodeBis, BezugsdatenRegeln.Zahl zahl, String wertText) {}

    /** Die gespeicherte Kette eines Schlüssels und ihr wirksamer Betrag (Regel {@code fassung}). */
    private record Stand(List<WertZeile> kette, BigDecimal wirksamerBetrag, Integer wirksameFassung) {}

    private record Ergebnis(String urteil, String kennung, LocalDate periodeVon, List<BezugsgroesseDto.Hinweis> hinweise) {}

    // ----------------------------------------------------------------------------- eingeben

    /**
     * {@code POST …/{id}/werte} — F1: ein Erstwert ist Fassung 1 ohne Begründung und ohne Freigabe; F5: derselbe
     * Betrag noch einmal ist eine Wiederholung (nichts geschrieben), ein anderer 409 {@code konflikt_anderer_wert}.
     * Nach einer Rücknahme ohne Betrag ist ein Wert wieder ein Erstwert (Fassung n + 1, Vertrag B14).
     */
    public BezugsgroesseDto.Eingabe eingeben(UUID id, String periodeText, String wertText, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        Ergebnis e = schreibe(() -> transaktion.execute(tx -> {
            Zeile b = finde(id);
            bezugsgroessen.kundenbereichSperren(tenant);
            Gelesen g = lies(b, periodeText, wertText, jetzt);
            Stand s = stand(id, g.periodeVon());
            pruefe(BezugsgroesseRegeln.eingeben(eingang(b, g, s, null, false)), b, g);
            List<BezugsgroesseDto.Hinweis> hinweise = hinweise(b, g);
            if (wiederholung(b, g, s, null)) {
                return new Ergebnis(BezugsdatenRegeln.WIEDERHOLUNG, null, g.periodeVon(), hinweise);
            }
            werte.wertSchreiben(new NeueFassung(tenant, b, g.periodeVon(), g.periodeBis(), g.zone().getId(),
                    s.kette().size() + 1, s.kette().isEmpty() ? null : s.kette().size(), Vorgang.ERSTWERT,
                    g.zahl().betrag(), null, g.wertText(), wer, null));
            return new Ergebnis(BezugsdatenRegeln.NEU, null, g.periodeVon(), hinweise);
        }));
        return antwort(id, e);
    }

    // --------------------------------------------------------------------------- berichtigen

    /**
     * {@code POST …/{id}/werte/{periode}/berichtigung} — F2: Fassung n + 1 mit Begründung; F3: bei Vier-Augen an ein
     * Vorschlag im Vorgang {@code BK-…} (der Wert bleibt, wie er ist); F4: jede wirksame Fassung ≥ 2 meldet
     * {@code correction}. Derselbe Betrag wie der wirksame ist eine Wiederholung und schreibt nichts.
     */
    public BezugsgroesseDto.Eingabe berichtigen(UUID id, String periodeText, String wertText, String begruendung,
            ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        Ergebnis e = schreibe(() -> transaktion.execute(tx -> {
            Zeile b = finde(id);
            boolean vierAugen = werte.vierAugenGesperrt(tenant);
            bezugsgroessen.kundenbereichSperren(tenant);
            Gelesen g = lies(b, periodeText, wertText, jetzt);
            Stand s = stand(id, g.periodeVon());
            boolean offen = g.periodeVon() != null && werte.offen(tenant, id, g.periodeVon()).isPresent();
            pruefe(BezugsgroesseRegeln.berichtigen(eingang(b, g, s, begruendung, offen)), b, g);
            List<BezugsgroesseDto.Hinweis> hinweise = hinweise(b, g);
            if (wiederholung(b, g, s, ERSETZEN)) {
                return new Ergebnis(BezugsdatenRegeln.WIEDERHOLUNG, null, g.periodeVon(), hinweise);
            }
            String text = begruendung.strip();
            int ersetzt = s.wirksameFassung();
            String zone = g.zone().getId();
            if (vierAugen) {
                String kennung = werte.anlegen(tenant, id, g.periodeVon(), g.periodeBis(), zone, ersetzt,
                        g.zahl().betrag(), text, g.wertText(), BezugsdatenRegeln.VORSCHLAG, null, wer);
                return new Ergebnis(BezugsdatenRegeln.VORSCHLAG, kennung, g.periodeVon(), hinweise);
            }
            int neu = s.kette().size() + 1;
            String kennung = werte.anlegen(tenant, id, g.periodeVon(), g.periodeBis(), zone, ersetzt,
                    g.zahl().betrag(), text, g.wertText(), FREIGEGEBEN, neu, wer);
            werte.wertSchreiben(new NeueFassung(tenant, b, g.periodeVon(), g.periodeBis(), zone, neu, ersetzt,
                    Vorgang.BERICHTIGUNG, g.zahl().betrag(), text, g.wertText(), wer, null));
            correction(tenant, b, g.periodeVon(), g.periodeBis(), zone, kennung, ersetzt, neu);
            return new Ergebnis(BezugsdatenRegeln.BERICHTIGUNG, kennung, g.periodeVon(), hinweise);
        }));
        return antwort(id, e);
    }

    // ----------------------------------------------------------------- freigeben (AP-08 IP-15)

    /** Der Vorgang {@code BK-…} des Kundenbereichs — für die Freigabe-Route; fremd oder unbekannt ist leer. */
    public Optional<Berichtigung> vorgang(UUID tenant, String kennung) {
        return werte.lies(tenant, kennung);
    }

    /**
     * Gibt einen Vorschlag frei — gerufen von {@link KorrekturFreigabeService#freigeben} IN dessen Transaktion, NACH
     * der Einstellungs-Sperre und den Prüfungen von Recht, Begründung und Stand. Schreibt die Entscheidung, die
     * Wert-Fassung (Urheber = Ersteller; Freigeber = wer freigibt, außer Ersteller selbst bei Vier-Augen aus) und das
     * Ereignis — alles oder nichts. Hat sich der Wert seit dem Vorschlag geändert, ist das 409 {@code gleichzeitig}.
     */
    Korrektur freigeben(UUID tenant, Berichtigung v, String begruendung, ProtokollAkteur wer, boolean vierAugen) {
        bezugsgroessen.kundenbereichSperren(tenant);
        Zeile b = bezugsgroessen.finde(v.bezugsgroesseId())
                .orElseThrow(() -> KorrekturFreigabeAbgelehnt.von(KorrekturFreigabeAbgelehnt.Ablehnung.NICHT_GEFUNDEN));
        Stand s = stand(b.id(), v.periodeVon());
        if (s.wirksamerBetrag() == null || !Objects.equals(s.wirksameFassung(), v.ersetztFassung())) {
            throw KorrekturFreigabeAbgelehnt.von(KorrekturFreigabeAbgelehnt.Ablehnung.GLEICHZEITIG);
        }
        int neu = s.kette().size() + 1;
        werte.entscheiden(tenant, v.kennung(), v.fassungen().size() + 1, FREIGEGEBEN, begruendung, vierAugen, neu, wer);
        ProtokollAkteur ersteller = v.ersteller();
        ProtokollAkteur freigeber = Objects.equals(ersteller.sub(), wer.sub()) ? null : wer;
        werte.wertSchreiben(new NeueFassung(tenant, b, v.periodeVon(), v.periodeBis(), v.zeitzone(), neu,
                v.ersetztFassung(), Vorgang.BERICHTIGUNG, v.betrag(), v.begruendung(), v.geliefertText(), ersteller,
                freigeber));
        correction(tenant, b, v.periodeVon(), v.periodeBis(), v.zeitzone(), v.kennung(), v.ersetztFassung(), neu);
        return new Korrektur(v.kennung(), null, werte.lies(tenant, v.kennung()).orElseThrow().fassungen());
    }

    // ------------------------------------------------------------------------------ Gerüst

    private Zeile finde(UUID id) {
        return bezugsgroessen.finde(id).orElseThrow(() -> BezugsgroesseAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    private Gelesen lies(Zeile b, String periodeText, String wertText, Instant jetzt) {
        ZoneId zone = ZoneId.of(bezugsgroessen.zeitzone(b.id()));
        BezugsPeriode.Periodendeutung p = b.periodeArt() == null ? null
                : BezugsdatenRegeln.periode(periodeText, null, null, DEUTUNG, b.periodeArt(), zone, jetzt);
        LocalDate von = p == null || p.befund() != null ? null : LocalDate.ofInstant(p.von(), zone);
        LocalDate bis = von == null ? null : LocalDate.ofInstant(p.bis(), zone).minusDays(1);
        String text = wertText == null ? null : wertText.strip();
        return new Gelesen(zone, p, von, bis, BezugsdatenRegeln.zahl(text, FORMAT, ganzzahlig(b.einheit())), text);
    }

    /** Die gespeicherte Kette des Schlüssels; ihren wirksamen Betrag rechnet die Regel {@code fassung}. */
    private Stand stand(UUID id, LocalDate periodeVon) {
        if (periodeVon == null) {
            return new Stand(List.of(), null, null);
        }
        List<WertZeile> kette = bezugsgroessen.werte(id, periodeVon, periodeVon).stream()
                .filter(w -> periodeVon.equals(w.periodeVon()))
                .toList();
        if (kette.isEmpty()) {
            return new Stand(kette, null, null);
        }
        Fassungsverlauf verlauf = BezugsdatenRegeln.fassungen(false, kette.stream()
                .map(w -> new Vorgang(w.vorgang(), w.betrag(), w.begruendung(), w.actorName(), null, w.createdAt(),
                        w.herkunftArt(), w.importKennung()))
                .toList());
        return new Stand(kette, verlauf.wirksamerBetrag(), kette.get(kette.size() - 1).fassung());
    }

    private static BezugsgroesseRegeln.Werteingang eingang(Zeile b, Gelesen g, Stand s, String begruendung,
            boolean vorschlagOffen) {
        return new BezugsgroesseRegeln.Werteingang(b.wertart(), b.archiviertAm() != null,
                g.periode() == null ? null : g.periode().befund(), g.zahl().befund(), g.zahl().betrag(),
                s.wirksamerBetrag(), begruendung, vorschlagOffen);
    }

    /**
     * Die Ablehnung der Regel, mit ihren Fakten. U5: verlangt die Einheit ganze Zahlen und trägt der Text Nachkommastellen
     * („48.200,5“, „48 200,5“), sagt {@code hinweis} warum — „Stück sind ganze Zahlen.“ Gelesen hat die Regel
     * {@code zahl}; hier wird nur der Satz gewählt, nicht die Zahl gedeutet.
     */
    private static void pruefe(BezugsgroesseRegeln.Urteil u, Zeile b, Gelesen g) {
        if (u.erlaubt()) {
            return;
        }
        Map<String, Object> fakten = new LinkedHashMap<>(u.fakten());
        if (u.ablehnung() == Ablehnung.ZAHL_UNLESBAR && ganzzahlig(b.einheit()) && nachkommastellen(g.wertText())) {
            fakten.put("hinweis", BezugsgroesseRegeln.GANZE_ZAHLEN.replace("{einheit}", b.einheit()));
        }
        throw new BezugsgroesseAbgelehnt(u.ablehnung(), fakten);
    }

    /** Das Urteil der Zeile (Regel {@code urteil}, §4.7): derselbe Betrag wie der wirksame ist eine Wiederholung. */
    private static boolean wiederholung(Zeile b, Gelesen g, Stand s, String entscheidung) {
        Bestand bestand = s.wirksamerBetrag() == null ? null
                : new Bestand(s.wirksamerBetrag(), s.wirksameFassung(), null);
        return BezugsdatenRegeln.WIEDERHOLUNG.equals(BezugsdatenRegeln.urteil(b.kennzeichen() + " · "
                + g.periode().schluessel(), g.zahl().betrag(), bestand, false, null, entscheidung, List.of()).urteil());
    }

    /**
     * U6 — Plausibilität ist ein HINWEIS, nie eine Ablehnung: eine Betriebszeit über der Stundenzahl der Periode. Die
     * Zahl der gebundenen Einheiten kennt der Schreibweg nur bei einer Messstelle als Bezug (× 1); sonst wird nicht
     * geraten und kein Hinweis gegeben.
     */
    private static List<BezugsgroesseDto.Hinweis> hinweise(Zeile b, Gelesen g) {
        Long stunden = g.periode() == null ? null : g.periode().stunden();
        Integer grenze = MESSSTELLE.equals(b.geltungArt()) && stunden != null ? Math.toIntExact(stunden) : null;
        String befund = BezugsdatenRegeln.plausibilitaet(g.zahl().betrag(), b.einheit(), grenze, 1);
        return BezugsdatenRegeln.WERT_UNPLAUSIBEL.equals(befund)
                ? List.of(new BezugsgroesseDto.Hinweis(befund, ImportVorschau.SAETZE.get(befund)))
                : List.of();
    }

    /** Deutsch getippte Nachkommastellen: Ziffern (mit Tausender-Trennern), ein Komma, Ziffern — Leerzeichen zählen nicht. */
    private static boolean nachkommastellen(String text) {
        return text != null && NACHKOMMASTELLEN.matcher(text.replaceAll("[\\s\\u00A0\\u202F]", "")).matches();
    }

    private static boolean ganzzahlig(String einheit) {
        return BezugsEinheit.GANZZAHL_EINHEITEN.contains(einheit);
    }

    /**
     * F4 — GENAU EINE Meldung {@code correction} je wirksamer Fassung ≥ 2: Bezug die Bezugsgröße (ihr Kennzeichen),
     * [von, bis) die Periode in ihrer Zone, die Kennung des Vorgangs, Fassung alt → neu. Die Kennung der Meldung ist
     * abgeleitet — eine Wiederholung schreibt nichts. Verwirft der Vertrag sie, ist das ein Fehler dieses Schreibwegs:
     * die Transaktion geht zurück, nichts bleibt halb.
     */
    private void correction(UUID tenant, Zeile b, LocalDate von, LocalDate bis, String zeitzone, String kennung,
            int alt, int neu) {
        ZoneId zone = ZoneId.of(zeitzone);
        ObjectNode e = json.createObjectNode();
        e.put("ereignis_id", UUID.nameUUIDFromBytes(("correction:" + tenant + ":" + kennung + ":" + FREIGEGEBEN)
                .getBytes(StandardCharsets.UTF_8)).toString());
        e.put("art", BezugsdatenRegeln.Ereignis.CORRECTION);
        e.put("von", von.atStartOfDay(zone).toInstant().toString());
        e.put("bis", bis.plusDays(1).atStartOfDay(zone).toInstant().toString());
        e.put("bezugsgroesse", b.kennzeichen());
        e.put("korrektur", kennung);
        e.put("korrektur_art", EreignisVokabular.KORREKTUR_ART_BEZUGSWERT);
        e.put("status", FREIGEGEBEN);
        e.put("fassung_alt", alt);
        e.put("fassung_neu", neu);
        MessreiheEreignisRepository.Ergebnis r = ereignisse.anhaengen(tenant, null, Urheber.KUNDE, e, null, null);
        if (r.ausgang() != MessreiheEreignisRepository.Ausgang.ANGEHAENGT) {
            throw new IllegalStateException("correction nicht angehängt: " + r.ausgang() + " " + r.grund() + " "
                    + r.hinweis());
        }
    }

    /** Die Antwort: das Urteil mit seinem Satz, die Kennung, die Hinweise und der Wert mit allen Fassungen. */
    private BezugsgroesseDto.Eingabe antwort(UUID id, Ergebnis e) {
        BezugsgroesseDto.Wert wert = lesemodell.werte(id, e.periodeVon(), e.periodeVon(), "alle").werte().stream()
                .filter(w -> e.periodeVon().equals(w.periodeVon()))
                .findFirst()
                .orElse(null);
        return new BezugsgroesseDto.Eingabe(e.urteil(), BezugsgroesseRegeln.EINGABE_SAETZE.get(e.urteil()),
                e.kennung(), e.hinweise(), wert);
    }

    /** Die Datenbank-Wand im Rennen: eine Periode, die nach der Uhr der Datenbank noch läuft (E16), ist Z4. */
    private static <T> T schreibe(Supplier<T> arbeit) {
        try {
            return arbeit.get();
        } catch (DataIntegrityViolationException e) {
            StringBuilder meldung = new StringBuilder();
            for (Throwable t = e; t != null; t = t.getCause()) {
                if (t instanceof SQLException && t.getMessage() != null) {
                    meldung.append(t.getMessage());
                }
            }
            if (meldung.toString().contains("\"bezugsgroesse_wert_abgeschlossen_chk\"")) {
                throw new BezugsgroesseAbgelehnt(Ablehnung.PERIODE_NICHT_ZU_ENDE, Map.of("feld", "periode"));
            }
            throw e;
        }
    }
}
