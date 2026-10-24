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
        { p: 'ValueDesk ist ein Analysewerkzeug für öffentliche Handelsdaten und eine Oberfläche, über die Nutzer selbst und in eigenem Namen auf SoDEX handeln. ValueDesk verwahrt keine Kundengelder und keine privaten Schlüssel und erbringt keine Anlageberatung. Der Handel mit Kryptowerten und Perpetual Futures ist mit hohen Risiken bis zum Totalverlust verbunden. Einzelheiten: [Nutzungsbedingungen](/terms), [Risikohinweise](/risk) und [Datenschutzerklärung](/privacy).' },
      ],
    },
    {
      title: 'Haftung für Inhalte',
      blocks: [
        { p: 'Wir erstellen die Inhalte dieser Seite mit Sorgfalt. Marktdaten, Ranglisten, Statistiken und Auswertungen berechnen wir aus öffentlichen Daten Dritter (SoDEX, Hyperliquid, Lighter, Arcus); für ihre Richtigkeit, Vollständigkeit und Aktualität übernehmen wir keine Gewähr, und sie sind keine Anlageempfehlung. Nachrichten (von SoSoValue) und Live-Streams sind Inhalte Dritter, die wir nicht prüfen und uns nicht zu eigen machen. Erfahren wir von einem rechtswidrigen Inhalt, entfernen wir ihn oder sperren den Zugang dazu, soweit er in unserem Einflussbereich liegt. Hinweise bitte an die oben genannte E-Mail-Adresse.' },
      ],
    },
    {
      title: 'Haftung für Links',
      blocks: [
        { p: 'Diese Seite enthält Links zu Websites Dritter, auf deren Inhalte wir keinen Einfluss haben. Für diese Inhalte ist der jeweilige Anbieter verantwortlich. Bei der Verlinkung waren uns keine Rechtsverstöße erkennbar; werden uns solche bekannt, entfernen wir den Link.' },
      ],
    },
    {
      title: 'Urheberrecht und Marken',
      blocks: [
        { p: 'Texte, Gestaltung, Software und Datenzusammenstellungen dieser Seite sind urheberrechtlich geschützt, soweit sie nicht unter einer offenen Lizenz veröffentlicht sind (etwa der ValueDesk-Copier unter der MIT-Lizenz). Namen, Logos und sonstige Kennzeichen von Kryptowerten, Handelsplätzen, Blockchains, Wallets, Unternehmen und Plattformen gehören ihren jeweiligen Inhabern. ValueDesk verwendet sie nur, um den jeweiligen Wert, Handelsplatz oder Dienst zu bezeichnen; das bedeutet keine Empfehlung, Förderung oder Verbindung durch den Inhaber und keine Anlageempfehlung. Inhaber, die einer Verwendung widersprechen, erreichen uns über die oben genannten Kontaktdaten; wir entfernen das Kennzeichen umgehend. Verwendete Open-Source-Software, ihre Lizenzen und die Quellen von Daten und Logos: [Licences and notices](/licenses).' },
      ],
    },
  ],
};
