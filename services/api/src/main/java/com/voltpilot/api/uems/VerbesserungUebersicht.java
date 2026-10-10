package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.AbweichungDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.MassnahmeDto;
import com.voltpilot.api.web.dto.MessbedarfDto;
import com.voltpilot.api.web.dto.VerbesserungUebersichtDto;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * UEMS AP-18 IP-19 (F1–F3, W7, E5 = A): der Übersichts-Leser „Ziele und Maßnahmen“ — {@code GET
 * /api/v1/verbesserung/uebersicht}. Er zählt je Art und nennt je fälligem Vorgang eine Zeile; kein Läufer, kein
 * Ereignis, keine Nachricht, nichts wird gespeichert.
 *
 * <p><b>Rechnet nichts selbst:</b> Maßnahmen, Energieziele und Abweichungen kommen aus ihren Registern
 * ({@link MassnahmeService#liste}, {@link EnergiezielService#liste}, {@link AbweichungService#liste}) mit deren Frist;
 * der Messbedarf geht durch dieselbe Operation {@link VerbesserungRegeln#frist}. Der Abruf-Tag ist die Uhr der Kennzahlen ({@link KennzahlService#jetzt}) in der
 * Zeitzone des Unternehmens — dieselbe Uhr wie die Register, der Test stellt sie.
 *
 * <p><b>W7:</b> der Messbedarf (AP-16) wird nur gelesen ({@link MessbedarfService#alle}, sein Zaun): ein offener Bedarf
 * mit Frist ist überfällig ab dem Frist-Tag. Der Vertrag kennt keine Frist-Art {@code messbedarf}; der Bedarf läuft
 * durch die Art {@code abweichung} — gespeicherter Tag, offen solange {@code offen}, dieselbe Regel.
 *
 * <p><b>Zaun:</b> RLS {@code site_scope} über {@code standort_id} und die Kennzahl ({@link
 * KennzahlService#lesbareKennzahlOderNichts}); was außerhalb liegt, zählt nicht. Ein Anstoß zählt nur mit sichtbarem
 * Vorgang.
 */
@Service
public class VerbesserungUebersicht {

    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    private static final String UEBERFAELLIG = "ueberfaellig";

    private final KennzahlService kennzahlen;
    private final MassnahmeService massnahmen;
    private final EnergiezielService energieziele;
    private final AbweichungService abweichungen;
    private final MessbedarfService messbedarfe;
    private final JdbcTemplate jdbc;

    public VerbesserungUebersicht(KennzahlService kennzahlen, MassnahmeService massnahmen,
            EnergiezielService energieziele, AbweichungService abweichungen, MessbedarfService messbedarfe,
            JdbcTemplate jdbc) {
        this.kennzahlen = kennzahlen;
        this.massnahmen = massnahmen;
        this.energieziele = energieziele;
        this.abweichungen = abweichungen;
        this.messbedarfe = messbedarfe;
        this.jdbc = jdbc;
    }

    public VerbesserungUebersichtDto.Uebersicht lesen() {
        ZoneId zone = ZoneId.of(jdbc.queryForList("SELECT zeitzone FROM unternehmen LIMIT 1", String.class).stream()
                .filter(Objects::nonNull).findFirst().orElse("Europe/Berlin"));
        LocalDate abruf = LocalDate.ofInstant(kennzahlen.jetzt(), zone);
        Map<UUID, Boolean> lesbar = new HashMap<>();
        List<VerbesserungUebersichtDto.Zeile> faellig = new ArrayList<>();

        int geplant = 0;
        int massnahmeUeberfaellig = 0;
        int umgesetzt = 0;
        for (MassnahmeDto.Massnahme m : massnahmen.liste(Set.of(), null, null, null, null).massnahmen()) {
            geplant += "geplant".equals(m.zustand()) ? 1 : 0;
            umgesetzt += "umgesetzt".equals(m.zustand()) ? 1 : 0;
            if (UEBERFAELLIG.equals(m.frist().faellig())) {
                massnahmeUeberfaellig++;
                faellig.add(new VerbesserungUebersichtDto.Zeile("massnahme", m.id(), m.kennzeichen(), m.titel(),
                        m.zustand(), m.termin(), UEBERFAELLIG, m.frist().seitTagen(), m.verantwortlich().name(),
                        m.frist().satz(), m.messgrundlage() == null ? null : m.messgrundlage().kennzahl().id(),
                        m.einsatz() == null ? null : m.einsatz().id()));
            }
        }

        int laufend = 0;
        int bewertungFaellig = 0;
        for (EnergiezielDto.Energieziel z : energieziele.liste(Set.of(), null, null).energieziele()) {
            if (!sichtbar(lesbar, z.kennzahl().id()) || !"offen".equals(z.zustand())) {
                continue;
            }
            laufend++;
            if ("bewertung_faellig".equals(z.frist().faellig())) {
                bewertungFaellig++;
                faellig.add(new VerbesserungUebersichtDto.Zeile("energieziel", z.id(), z.kennzeichen(), z.wortlaut(),
                        z.zustand(), z.frist().termin(), "bewertung_faellig", z.frist().seitTagen(),
                        z.verantwortlich().name(), null, z.kennzahl().id(), null));
            }
        }

        int abweichungOffen = 0;
        int abweichungUeberfaellig = 0;
        for (AbweichungDto.Abweichung a : abweichungen.liste(Set.of(), "offen", null, null).abweichungen()) {
            abweichungOffen++;
            if (UEBERFAELLIG.equals(a.frist().faellig())) {
                abweichungUeberfaellig++;
                int seit = a.frist().seitTagen();
                String person = a.verantwortlich().name();
                faellig.add(new VerbesserungUebersichtDto.Zeile("abweichung", a.id(), a.kennzeichen(),
                        a.kennzahl().kennzeichen() + " " + a.kennzahl().name(), a.zustand(), a.frist().termin(),
                        UEBERFAELLIG, seit, person,
                        ueberfaelligSatz(a.kennzeichen(), a.zustand(), a.frist().termin(), seit, person),
                        a.kennzahl().id(), null));
            }
        }

        int auffaelligkeiten = 0;
        for (UUID kz : jdbc.queryForList("SELECT kennzahl_id FROM auffaelligkeit WHERE zustand = 'offen'", UUID.class)) {
            auffaelligkeiten += sichtbar(lesbar, kz) ? 1 : 0;
        }

        // Ein Anstoß zählt nur, wenn sein Vorgang sichtbar ist (RLS auf massnahme/energieziel) — und dessen Kennzahl.
        int anstoesse = 0;
        for (Map<String, Object> a : jdbc.queryForList("SELECT coalesce(m.kennzahl_id, z.kennzahl_id) AS kennzahl_id "
                + "FROM vorgang_anstoss v "
                + "LEFT JOIN massnahme m ON m.id = v.massnahme_id AND m.tenant_id = v.tenant_id "
                + "LEFT JOIN energieziel z ON z.id = v.energieziel_id AND z.tenant_id = v.tenant_id "
                + "WHERE v.zustand = 'offen' AND (m.id IS NOT NULL OR z.id IS NOT NULL)")) {
            UUID kz = (UUID) a.get("kennzahl_id");
            anstoesse += kz == null || sichtbar(lesbar, kz) ? 1 : 0;
        }

        int messbedarfUeberfaellig = 0;
        for (MessbedarfDto.Bedarf b : messbedarfe.alle(null).messbedarfe()) {
            if (b.frist() == null) {
                continue;
            }
            Map<String, Object> f = VerbesserungRegeln.frist(new VerbesserungRegeln.FristEingang("abweichung",
                    b.zustand(), b.frist().toString(), null, null, abruf.toString()));
            messbedarfUeberfaellig += UEBERFAELLIG.equals(f.get("faellig")) ? 1 : 0;
        }

        faellig.sort(Comparator.comparingInt(VerbesserungUebersichtDto.Zeile::seitTagen).reversed()
                .thenComparing(VerbesserungUebersichtDto.Zeile::kennzeichen));
        return new VerbesserungUebersichtDto.Uebersicht(abruf, new VerbesserungUebersichtDto.Zaehler(auffaelligkeiten,
                abweichungOffen, abweichungUeberfaellig, geplant, massnahmeUeberfaellig, umgesetzt, laufend,
                bewertungFaellig, anstoesse, messbedarfUeberfaellig), List.copyOf(faellig));
    }

    private boolean sichtbar(Map<UUID, Boolean> lesbar, UUID kennzahl) {
        return lesbar.computeIfAbsent(kennzahl, k -> kennzahlen.lesbareKennzahlOderNichts(k) != null);
    }

    /** §5.9 „Überfällig“ über die Operation {@code satz} — derselbe Satz wie im Maßnahmen-Register. */
    private static String ueberfaelligSatz(String kennzeichen, String zustand, LocalDate termin, int tage,
            String person) {
        return (String) VerbesserungRegeln.satz("ueberfaellig", Map.of("kennzeichen", kennzeichen, "zustand", zustand,
                "termin", TAG.format(termin), "tage", String.valueOf(tage), "person", person)).get("satz");
    }
}
