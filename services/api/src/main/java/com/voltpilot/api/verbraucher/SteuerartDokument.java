package com.voltpilot.api.verbraucher;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.consumers.SgReady;
import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * Die PROJEKTION „Steuerart → Policy-Dokument" (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §3.3, Paket P2) - die exakte INVERSE
 * von {@link SteuerartProjektion}.
 *
 * <p><b>Rein: keine DB, kein Spring, keine Uhr</b> - dasselbe Muster wie ihre
 * Umkehrung. Was sie schreibt, muss die Umkehrung wieder lesen koennen; der
 * Rundlauf {@code projiziere(dokument(w)) == w} ist die Abnahme dieser Klasse
 * (ein Vektor je Steuerart × Typ).
 *
 * <p><b>⚠ ES ENTSTEHT KEIN ZWEITES FORMAT.</b> Herauskommt ein ganz normales
 * {@code consumer-policy.schema.json}-Dokument, das derselbe
 * {@code ConsumerPolicyValidator} pruefen und dieselbe
 * {@code ConsumerPolicyActivationService} aktivieren kann wie ein Dokument aus
 * dem Regel-Baukasten. Die Steuerart ist eine OBERFLAECHE auf der bestehenden
 * Maschine - nie eine zweite Maschine.
 *
 * <p><b>⚠ „Sofort" hat GAR KEIN Dokument</b> ({@link #dokument} liefert
 * {@code null}): das Schema verlangt {@code minItems: 1} („Empty is not a
 * policy"), und §3.3 sagt fuer diese Quelle woertlich „keine Anforderung".
 * Sofort heisst „laeuft, wie das Geraet es tut" - der Schreibpfad nimmt dafuer
 * die aktive Policy ZURUECK (der bestehende, flag-unabhaengige Stopppfad),
 * statt eine leere zu erfinden. Die Umkehrung liest genau das wieder als
 * {@code sofort} (Regel 2).
 *
 * <p><b>⚠ Die drei Felder, die hier bewusst FEHLEN</b> (§3.3 woertlich):
 * {@code grid_energy_policy}, {@code allow_storage_discharge} und
 * {@code service_rank} sind PROFIL-Felder, die die Rangliste projiziert
 * (§5, Paket P4) - die Requirement-Overrides werden nicht benutzt. Sie hier zu
 * schreiben waere eine zweite Wahrheit ueber dieselbe Frage.
 */
public final class SteuerartDokument {

    private static final JsonNodeFactory F = JsonNodeFactory.instance;

    /** Das lokale Signal der Ueberschuss-Quelle. */
    static final String SIGNAL_UEBERSCHUSS = "site.pv_surplus_kw";
    /** Das Cloud-Signal der Guenstig-Quelle (der Bezugspreis, nicht der Spot). */
    static final String SIGNAL_PREIS = "market.import_price_ct_kwh";
    /** Frische-Fenster des LOKALEN Signals (§3.3). */
    static final int MAX_AGE_S = 120;
    /** Hysterese des lokalen Signals: Rueckfall auf 0,75 × Schwelle (§3.3). */
    static final BigDecimal HYSTERESE_FAKTOR = new BigDecimal("0.75");

    private SteuerartDokument() {}

    /**
     * Das Dokument einer Steuerart, oder {@code null} fuer {@code sofort}.
     *
     * @param entityId  die Entitaet, auf die der Server stempelt
     * @param timezone  die Zone der Anlage (darf {@code null} sein)
     * @param w         der gepruefte Wunsch ({@link SteuerartSatz#pruefe})
     * @param kontext   die Fakten, aus denen Vorgaben und Ziel-Art folgen
     */
    public static ObjectNode dokument(String entityId, String timezone, SteuerartWunsch w,
            SteuerartSatz.Kontext kontext) {
        if (w == null || SteuerartProjektion.QUELLE_SOFORT.equals(w.quelle())) {
            return null;
        }
        if (SgReady.QUELLEN.contains(w.quelle())) {
            // Die SG-Ready-Vorlage wohnt bei ihrem Typ (P8) - eine zweite
            // Fassung derselben Regeln koennte von ihr abdriften.
            return SgReady.policyDocument(entityId, timezone,
                    new SgReady.Steuerart(w.quelle(), w.schwelleKw(), w.preisgrenzeCtKwh(),
                            w.mindestlaufzeitMinuten(), w.sperrzeitMinuten()));
        }
        SteuerartSatz.Vorgaben v = SteuerartSatz.vorgaben(kontext);
        ObjectNode doc = F.objectNode();
        doc.put("schema_version", "1.0");
        doc.put("entity_id", entityId);
        if (timezone != null && !timezone.isBlank()) {
            doc.put("timezone", timezone);
        }
        ArrayNode reqs = doc.putArray("requirements");
        reqs.add(quelle(w, kontext, v));
        ObjectNode ziel = ziel(w, kontext, v);
        if (ziel != null) {
            reqs.add(ziel);
        }
        return doc;
    }

    // -----------------------------------------------------------------------
    // Die Quelle
    // -----------------------------------------------------------------------

    private static ObjectNode quelle(SteuerartWunsch w, SteuerartSatz.Kontext k,
            SteuerartSatz.Vorgaben v) {
        ObjectNode r = F.objectNode();
        r.put("id", w.quelle());
        switch (w.quelle()) {
            case SteuerartProjektion.QUELLE_UEBERSCHUSS -> {
                r.put("name", "Solar-Überschuss");
                r.put("kind", "reactive");
                r.put("enforcement", "opportunistic");
                BigDecimal schwelle = w.schwelleKw() != null ? w.schwelleKw() : v.schwelleKw();
                ObjectNode c = r.putObject("condition");
                c.put("signal", SIGNAL_UEBERSCHUSS);
                c.put("operator", "gt");
                c.put("value", schwelle);
                // ⚠ Hysterese + Frische NUR am LOKALEN Signal: eine ziehende
                // Wolke darf das Geraet nicht im Takt schalten, und ein
                // veralteter Messwert ist `unknown`, nie 0.
                c.put("reset_value",
                        schwelle.multiply(HYSTERESE_FAKTOR).setScale(3, RoundingMode.HALF_UP));
                c.put("max_age_s", MAX_AGE_S);
            }
            case SteuerartProjektion.QUELLE_GUENSTIG -> {
                r.put("name", "Günstige Stunden");
                r.put("kind", "reactive");
                r.put("enforcement", "opportunistic");
                ObjectNode c = r.putObject("condition");
                c.put("signal", SIGNAL_PREIS);
                c.put("operator", "lt");
                c.put("value", w.preisgrenzeCtKwh() != null ? w.preisgrenzeCtKwh()
                        : v.preisgrenzeCtKwh());
                // ⚠ KEINE Hysterese und KEIN max_age_s: das ist ein
                // Cloud-Signal, die Fenster rechnet der Compiler vor
                // (D1 - der Validator lehnt beides dort ab).
            }
            case SteuerartProjektion.QUELLE_FESTE_ZEITEN -> {
                r.put("name", "Feste Zeiten");
                r.put("kind", "fixed_window");
                // ⚠ Feste Zeiten sind ein PFLICHTLAUF - und ein Pflichtlauf
                // erlaubt Netzstrom automatisch (§3.3). Genau das sagt die
                // Folgen-Karte, statt es zu verschweigen.
                r.put("enforcement", "must_run");
                fenster(r.putObject("recurrence"),
                        w.fenster() != null ? w.fenster() : v.fenster());
            }
            default -> throw new IllegalArgumentException("Unbekannte Quelle: " + w.quelle());
        }
        zielwert(r.putObject("target"), k);
        return r;
    }

    // -----------------------------------------------------------------------
    // Das Ziel
    // -----------------------------------------------------------------------

    private static ObjectNode ziel(SteuerartWunsch w, SteuerartSatz.Kontext k,
            SteuerartSatz.Vorgaben v) {
        if (w.ziel() == null || w.ziel().isBlank()) {
            return null;
        }
        ObjectNode r = F.objectNode();
        r.put("id", w.ziel());
        r.put("kind", "flexible_task");
        r.put("enforcement", "required_by_deadline");
        Steuerart.Fenster f = w.zielFenster();
        String bis = f != null && f.bis() != null && !f.bis().isBlank() ? f.bis()
                : v.zielUhrzeit();
        String tage = f != null && f.tage() != null && !f.tage().isBlank() ? f.tage()
                : v.zielTage();
        // ⚠ §3.2 fragt nur nach der FRIST, nicht nach dem Beginn - also setzt
        // ihn der Server, und der Dialog zeigt das entstehende Fenster
        // woertlich. Ein Fenster der Laenge 0 kann dabei nicht entstehen.
        String von = f != null && f.von() != null && !f.von().isBlank() ? f.von()
                : minusStunden(bis, v.zielFensterStunden());
        ObjectNode rec = r.putObject("recurrence");
        rec.put("days", tage);
        rec.put("from", von);
        rec.put("to", bis);
        ObjectNode demand = r.putObject("demand");
        if (SteuerartProjektion.ZIEL_BIS_UHRZEIT.equals(w.ziel())) {
            r.put("name", "Bis " + bis + " Uhr fertig");
            demand.put("energy_kwh",
                    w.zielEnergieKwh() != null ? w.zielEnergieKwh() : v.zielEnergieKwh());
        } else {
            r.put("name", "Laufzeit bis " + bis + " Uhr");
            demand.put("runtime_minutes", w.zielLaufzeitMinuten() != null
                    ? w.zielLaufzeitMinuten() : v.zielLaufzeitMinuten());
            if (w.zielAmStueck() != null) {
                demand.put("contiguous", w.zielAmStueck());
            }
        }
        zielwert(r.putObject("target"), k);
        return r;
    }

    /**
     * Das Ziel einer Anforderung (§3.3): {@code kw: rated} an einem Ladepunkt
     * mit gepflegter Nennleistung, sonst {@code on_off:true}.
     *
     * <p>Der Unterschied ist die Aussage: eine Wallbox bekommt eine LEISTUNG
     * (ihr Executor rechnet sie in Ampere um), eine Schaltlast bekommt ein
     * EIN - ihr gibt es keine Leistung vorzugeben.
     */
    private static void zielwert(ObjectNode target, SteuerartSatz.Kontext k) {
        if (VerbraucherService.istLadepunkt(k.entityType()) && k.ratedPowerKw() != null) {
            target.put("kind", "kw");
            target.put("value", k.ratedPowerKw());
            return;
        }
        target.put("kind", "on_off");
        target.put("value", true);
    }

    private static void fenster(ObjectNode rec, Steuerart.Fenster f) {
        rec.put("days", f.tage() == null || f.tage().isBlank() ? "daily" : f.tage());
        rec.put("from", f.von());
        rec.put("to", f.bis());
    }

    /** {@code HH:mm} minus {@code stunden}, ueber Mitternacht hinweg. */
    static String minusStunden(String hhmm, int stunden) {
        int h = Integer.parseInt(hhmm.substring(0, 2));
        int m = Integer.parseInt(hhmm.substring(3));
        int total = ((h * 60 + m) - stunden * 60) % (24 * 60);
        if (total < 0) {
            total += 24 * 60;
        }
        return String.format("%02d:%02d", total / 60, total % 60);
    }
}
