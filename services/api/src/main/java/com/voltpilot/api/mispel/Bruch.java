package com.voltpilot.api.mispel;

import java.math.BigDecimal;
import java.math.BigInteger;

/**
 * Eine exakte rationale Zahl für das Rechenwerk der Abgrenzungsoption (MiSpeL MP-8) — das Gegenstück zu
 * {@code fractions.Fraction} im Python-Zwilling. Die Quotienten (14)A1, (18), (30), (ZFa) … sind nicht immer
 * endliche Dezimalzahlen; gerechnet wird darum ungerundet (Vertrag, Regel {@code vergleich}), gerundet erst für
 * Anzeige und Nachweis (MP-16). Immer gekürzt, Nenner positiv.
 */
public record Bruch(BigInteger zaehler, BigInteger nenner) implements Comparable<Bruch> {

    public static final Bruch NULL = new Bruch(BigInteger.ZERO, BigInteger.ONE);
    public static final Bruch EINS = new Bruch(BigInteger.ONE, BigInteger.ONE);

    public Bruch {
        if (nenner.signum() == 0) {
            throw new ArithmeticException("Nenner 0");
        }
        if (nenner.signum() < 0) {
            zaehler = zaehler.negate();
            nenner = nenner.negate();
        }
        BigInteger g = zaehler.gcd(nenner);
        if (!g.equals(BigInteger.ONE) && g.signum() != 0) {
            zaehler = zaehler.divide(g);
            nenner = nenner.divide(g);
        }
        if (zaehler.signum() == 0) {
            nenner = BigInteger.ONE;
        }
    }

    public static Bruch von(BigDecimal d) {
        BigDecimal s = d.stripTrailingZeros();
        if (s.scale() <= 0) {
            return new Bruch(s.toBigIntegerExact(), BigInteger.ONE);
        }
        return new Bruch(s.unscaledValue(), BigInteger.TEN.pow(s.scale()));
    }

    public static Bruch von(long n) {
        return new Bruch(BigInteger.valueOf(n), BigInteger.ONE);
    }

    public Bruch plus(Bruch b) {
        return new Bruch(zaehler.multiply(b.nenner).add(b.zaehler.multiply(nenner)), nenner.multiply(b.nenner));
    }

    public Bruch minus(Bruch b) {
        return new Bruch(zaehler.multiply(b.nenner).subtract(b.zaehler.multiply(nenner)), nenner.multiply(b.nenner));
    }

    public Bruch mal(Bruch b) {
        return new Bruch(zaehler.multiply(b.zaehler), nenner.multiply(b.nenner));
    }

    public Bruch durch(Bruch b) {
        return new Bruch(zaehler.multiply(b.nenner), nenner.multiply(b.zaehler));
    }

    public int signum() {
        return zaehler.signum();
    }

    public static Bruch min(Bruch a, Bruch b) {
        return a.compareTo(b) <= 0 ? a : b;
    }

    public static Bruch max(Bruch a, Bruch b) {
        return a.compareTo(b) >= 0 ? a : b;
    }

    @Override
    public int compareTo(Bruch b) {
        return zaehler.multiply(b.nenner).compareTo(b.zaehler.multiply(nenner));
    }

    /** Die exakte Dezimalzahl, oder {@code null}, wenn der Bruch keine endliche Dezimaldarstellung hat. */
    public BigDecimal alsDezimal() {
        BigInteger n = nenner;
        int zweien = 0;
        int fuenfen = 0;
        while (n.mod(BigInteger.TWO).signum() == 0) {
            n = n.divide(BigInteger.TWO);
            zweien++;
        }
        BigInteger fuenf = BigInteger.valueOf(5);
        while (n.mod(fuenf).signum() == 0) {
            n = n.divide(fuenf);
            fuenfen++;
        }
        if (!n.equals(BigInteger.ONE)) {
            return null;
        }
        int stellen = Math.max(zweien, fuenfen);
        BigInteger erweitert = zaehler.multiply(BigInteger.TEN.pow(stellen)).divide(nenner);
        return new BigDecimal(erweitert, stellen).stripTrailingZeros();
    }

    /** Der Nachweis-Text: die exakte Dezimalzahl ({@code 0.75}), sonst der Bruch ({@code 1/3}) — nie gerundet. */
    public String text() {
        BigDecimal d = alsDezimal();
        return d != null ? d.toPlainString() : zaehler + "/" + nenner;
    }

    @Override
    public String toString() {
        return text();
    }
}
