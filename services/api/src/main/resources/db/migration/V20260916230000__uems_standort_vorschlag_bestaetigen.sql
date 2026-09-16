-- UEMS AP-02 IP-10: bestätigte Vorschlagszeilen dürfen nach der atomaren Übernahme
-- entfernt werden. Vorschau bleibt SELECT; UPDATE bleibt verboten. RLS + FORCE aus
-- V20260911290000 gelten unverändert auch für DELETE.
GRANT DELETE ON standort_vorschlag TO ${appDbUser};
