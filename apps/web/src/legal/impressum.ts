/**
 * Impressum - DRAFT for the owner to complete (see model.ts for the markers).
 *
 * § 5 DDG (Digitale-Dienste-Gesetz, since 14 May 2024 in place of § 5 TMG) and,
 * only if the site carries journalistic-editorial content, § 18 Abs. 2 MStV.
 * Nothing about the provider is invented here: every fact is a placeholder.
 * The EU online dispute resolution platform (ODR) is not linked: Regulation
 * (EU) 2024/3228 repealed the ODR regulation and the platform closed on
 * 20 July 2025, so the old link duty is gone.
 */
import type { LegalDoc } from './model';

export const IMPRESSUM: LegalDoc = {
  page: 'impressum',
  title: 'Impressum',
  lang: 'de',
  updated: '[[OWNER: Datum, z. B. 1. November 2026]]',
  sections: [
    {
      title: 'Angaben gemäß § 5 DDG',
      blocks: [
        {
          lines: [
            '[[OWNER: Vor- und Nachname, oder Firma mit Rechtsform (z. B. „Muster GmbH“)]]',
            '[[OWNER: Straße und Hausnummer - eine ladungsfähige Anschrift, kein Postfach]]',
            '[[OWNER: Postleitzahl und Ort]]',
            '[[OWNER: Land]]',
          ],
        },
      ],
    },
    {
      title: 'Vertreten durch',
      blocks: [
        { p: '[[OWNER: nur bei einer Gesellschaft: die vertretungsberechtigten Personen (z. B. Geschäftsführer). Als Einzelperson diesen Abschnitt löschen.]]' },
      ],
    },
    {
      title: 'Kontakt',
      blocks: [
        {
          lines: [
            'E-Mail: [[OWNER: E-Mail-Adresse]]',
            'Telefon: [[OWNER: Telefonnummer - oder ein anderer schneller, unmittelbarer Kontaktweg, z. B. ein Kontaktformular]]',
          ],
        },
      ],
    },
    {
      title: 'Registereintrag',
      blocks: [
        {
          lines: [
            'Registergericht: [[OWNER: z. B. Amtsgericht ... - ohne Eintrag im Handels-, Vereins- oder Partnerschaftsregister diesen Abschnitt löschen]]',
            'Registernummer: [[OWNER: z. B. HRB ...]]',
          ],
        },
      ],
    },
    {
      title: 'Umsatzsteuer',
      blocks: [
        { p: 'Umsatzsteuer-Identifikationsnummer gemäß § 27a UStG: [[OWNER: DE... - oder die Wirtschafts-Identifikationsnummer nach § 139c AO; ohne beides diesen Abschnitt löschen]]' },
      ],
    },
    {
      title: 'Aufsichtsbehörde',
      blocks: [
        { p: '[[OWNER: nur falls die Tätigkeit einer behördlichen Zulassung bedarf: die zuständige Aufsichtsbehörde mit Anschrift. Sonst diesen Abschnitt löschen.]]' },
      ],
    },
    {
      title: 'Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV',
      blocks: [
        { p: '[[OWNER: nur falls die Seite journalistisch-redaktionelle Inhalte anbietet: Name und Anschrift der verantwortlichen Person. Sonst diesen Abschnitt löschen.]]' },
      ],
    },
    {
      title: 'Verbraucherstreitbeilegung',
      blocks: [
        { p: 'Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen. [[OWNER: prüfen und bestätigen (§ 36 VSBG) - oder ändern, falls eine Teilnahme zugesagt wird]]' },
      ],
    },
    {
      title: 'Hinweis',
      blocks: [
        { p: 'ValueDesk ist ein Analysewerkzeug für öffentliche Handelsdaten und eine Oberfläche, über die Nutzer selbst und in eigenem Namen auf SoDEX handeln. ValueDesk verwahrt keine Kundengelder und keine privaten Schlüssel und erbringt keine Anlageberatung. Einzelheiten: [Nutzungsbedingungen](/terms) und [Datenschutzerklärung](/privacy).' },
      ],
    },
  ],
};
