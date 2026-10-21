// -----------------------------------------------------------------------------
// Texts the integration writes outside the widget (src/widgets.js): the
// connection status, the "Test the connection" report, the errors, and what
// the bot answers in Rocket.Chat. Four languages, the four of the Gladys
// interface; German says "du", Spanish "usted". test/i18n.test.js checks
// every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './rocketchat/client.js';

export const LANGUAGE_FALLBACK = 'en';

export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];

/** Applies `render` to each language of a table of functions. */
export const each = (table, render) =>
  Object.fromEntries(Object.entries(table).map(([lang, value]) => [lang, render(value, lang)]));

// One short explanation per error kind (src/rocketchat/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.NOT_CONFIGURED]: {
    en: 'enter the server address, the user id and the token of the bot in the configuration',
    fr: "saisissez l'adresse du serveur, l'identifiant et le jeton du robot dans la configuration",
    de: 'gib die Serveradresse, die Benutzer-ID und das Token des Bots in der Konfiguration ein',
    es: 'introduzca la dirección del servidor, el ID de usuario y el token del bot en la configuración',
  },
  [ERROR_KINDS.INVALID_URL]: {
    en: 'server address not understood, e.g. https://chat.example.org',
    fr: 'adresse du serveur incomprise, ex. https://chat.example.org',
    de: 'Serveradresse nicht verstanden, z. B. https://chat.example.org',
    es: 'dirección del servidor no válida, p. ej. https://chat.example.org',
  },
  [ERROR_KINDS.NO_TOKEN]: {
    en: 'enter the user id and the personal access token of the bot account',
    fr: "saisissez l'identifiant et le jeton d'accès personnel du compte du robot",
    de: 'gib die Benutzer-ID und das persönliche Zugriffstoken des Bot-Kontos ein',
    es: 'introduzca el ID de usuario y el token de acceso personal de la cuenta del bot',
  },
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'the Rocket.Chat server does not answer',
    fr: 'le serveur Rocket.Chat ne répond pas',
    de: 'der Rocket.Chat-Server antwortet nicht',
    es: 'el servidor Rocket.Chat no responde',
  },
  [ERROR_KINDS.TIMEOUT]: {
    en: 'the Rocket.Chat server answers too slowly',
    fr: 'le serveur Rocket.Chat répond trop lentement',
    de: 'der Rocket.Chat-Server antwortet zu langsam',
    es: 'el servidor Rocket.Chat responde demasiado lento',
  },
  [ERROR_KINDS.NOT_ROCKETCHAT]: {
    en: 'no Rocket.Chat server at this address: check it',
    fr: 'pas de serveur Rocket.Chat à cette adresse : vérifiez-la',
    de: 'kein Rocket.Chat-Server unter dieser Adresse: prüfe sie',
    es: 'no hay servidor Rocket.Chat en esta dirección: revísela',
  },
  [ERROR_KINDS.TOKEN]: {
    en: 'user id or access token refused (wrong or revoked): check them',
    fr: "identifiant ou jeton d'accès refusé (erroné ou révoqué) : vérifiez-les",
    de: 'Benutzer-ID oder Zugriffstoken abgelehnt (falsch oder widerrufen): Prüf sie',
    es: 'ID de usuario o token de acceso rechazado (erróneo o revocado): revíselos',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'refused by the server: is the bot a member of this private channel?',
    fr: 'refusé par le serveur : le robot est-il membre de ce canal privé ?',
    de: 'vom Server abgelehnt: Ist der Bot Mitglied dieses privaten Kanals?',
    es: 'rechazado por el servidor: ¿es el bot miembro de este canal privado?',
  },
  [ERROR_KINDS.NOT_FOUND]: {
    en: 'channel or user not found on the server',
    fr: 'canal ou utilisateur introuvable sur le serveur',
    de: 'Kanal oder Benutzer auf dem Server nicht gefunden',
    es: 'canal o usuario no encontrado en el servidor',
  },
  [ERROR_KINDS.TOO_LONG]: {
    en: 'message too long for the server (5000 characters by default)',
    fr: 'message trop long pour le serveur (5000 caractères par défaut)',
    de: 'Nachricht zu lang für den Server (standardmäßig 5000 Zeichen)',
    es: 'mensaje demasiado largo para el servidor (5000 caracteres por defecto)',
  },
  [ERROR_KINDS.REJECTED]: {
    en: 'request refused by the server',
    fr: 'requête refusée par le serveur',
    de: 'Anfrage vom Server abgelehnt',
    es: 'solicitud rechazada por el servidor',
  },
  [ERROR_KINDS.RATE_LIMITED]: {
    en: 'too many requests: the server asks to slow down',
    fr: 'trop de requêtes : le serveur demande de ralentir',
    de: 'zu viele Anfragen: Der Server bittet um eine Pause',
    es: 'demasiadas solicitudes: el servidor pide ir más despacio',
  },
  [ERROR_KINDS.SERVER]: {
    en: 'the Rocket.Chat server answered with an error',
    fr: 'le serveur Rocket.Chat a répondu par une erreur',
    de: 'der Rocket.Chat-Server hat mit einem Fehler geantwortet',
    es: 'el servidor Rocket.Chat ha respondido con un error',
  },
};

/** The explanation of an error, in one language. */
export function errorText(err, language) {
  const text = ERROR_TEXT[err?.kind] ?? ERROR_TEXT[ERROR_KINDS.SERVER];
  return pick(text, language);
}

/** The explanation of an error, in the four languages. */
export const errorTexts = (err) =>
  each(ERROR_TEXT[err?.kind] ?? ERROR_TEXT[ERROR_KINDS.SERVER], (text) => text);

// The connection status of the Configuration screen when some watched channels
// or allowed people could not be found (the bot works with the others).
export const PARTIAL_STATUS = {
  en: (failed) => `Connected, but not found or not joined: ${failed}`,
  fr: (failed) => `Connecté, mais introuvables ou non rejoints : ${failed}`,
  de: (failed) => `Verbunden, aber nicht gefunden oder nicht beigetreten: ${failed}`,
  es: (failed) => `Conectado, pero no encontrados o sin acceso: ${failed}`,
};

// The report of the "Test the connection" action (and of the widget button).
export const REPORT_TEXT = {
  en: {
    connected: (user) => `Connected as @${user}.`,
    channels: (joined, total) => `Watched channels joined: ${joined}/${total}.`,
    noChannels: 'No watched channel yet.',
    users: (found, total) => `Allowed people found: ${found}/${total}.`,
    noUsers: 'No allowed person: the bot answers nobody.',
    failed: (error) => `Connection failed: ${error}.`,
  },
  fr: {
    connected: (user) => `Connecté en tant que @${user}.`,
    channels: (joined, total) => `Canaux surveillés rejoints : ${joined}/${total}.`,
    noChannels: 'Aucun canal surveillé pour l’instant.',
    users: (found, total) => `Personnes autorisées trouvées : ${found}/${total}.`,
    noUsers: 'Aucune personne autorisée : le robot ne répond à personne.',
    failed: (error) => `Échec de la connexion : ${error}.`,
  },
  de: {
    connected: (user) => `Verbunden als @${user}.`,
    channels: (joined, total) => `Beobachtete Kanäle beigetreten: ${joined}/${total}.`,
    noChannels: 'Noch kein beobachteter Kanal.',
    users: (found, total) => `Erlaubte Personen gefunden: ${found}/${total}.`,
    noUsers: 'Keine erlaubte Person: Der Bot antwortet niemandem.',
    failed: (error) => `Verbindung fehlgeschlagen: ${error}.`,
  },
  es: {
    connected: (user) => `Conectado como @${user}.`,
    channels: (joined, total) => `Canales vigilados a los que se ha unido: ${joined}/${total}.`,
    noChannels: 'Todavía no hay ningún canal vigilado.',
    users: (found, total) => `Personas autorizadas encontradas: ${found}/${total}.`,
    noUsers: 'Ninguna persona autorizada: el bot no responde a nadie.',
    failed: (error) => `Fallo de conexión: ${error}.`,
  },
};

// What the bot writes in Rocket.Chat, in a direct message.
export const BOT_TEXT = {
  en: {
    linked: (name) =>
      `Hello ${name}! Your Rocket.Chat account is now linked to Gladys: write to me here.`,
    notLinked:
      'Your Rocket.Chat account is not linked to Gladys yet. In Gladys, open Integrations → Rocket.Chat → Configuration, click "Generate a link code", then send me the code here.',
    unavailable: 'Gladys cannot read your message right now, please try again later.',
  },
  fr: {
    linked: (name) =>
      `Bonjour ${name} ! Votre compte Rocket.Chat est lié à Gladys : écrivez-moi ici.`,
    notLinked:
      'Votre compte Rocket.Chat n’est pas encore lié à Gladys. Dans Gladys, ouvrez Intégrations → Rocket.Chat → Configuration, cliquez sur « Générer un code de liaison », puis envoyez-moi le code ici.',
    unavailable: 'Gladys ne peut pas lire votre message pour l’instant, réessayez plus tard.',
  },
  de: {
    linked: (name) =>
      `Hallo ${name}! Dein Rocket.Chat-Konto ist jetzt mit Gladys verknüpft: Schreib mir hier.`,
    notLinked:
      'Dein Rocket.Chat-Konto ist noch nicht mit Gladys verknüpft. Öffne in Gladys Integrationen → Rocket.Chat → Konfiguration, klicke auf „Verknüpfungscode generieren“ und schick mir dann den Code hier.',
    unavailable: 'Gladys kann deine Nachricht gerade nicht lesen, versuch es später noch einmal.',
  },
  es: {
    linked: (name) =>
      `¡Hola ${name}! Su cuenta Rocket.Chat está vinculada a Gladys: escríbame aquí.`,
    notLinked:
      'Su cuenta Rocket.Chat aún no está vinculada a Gladys. En Gladys, abra Integraciones → Rocket.Chat → Configuración, pulse «Generar un código de vinculación» y envíeme el código aquí.',
    unavailable: 'Gladys no puede leer su mensaje en este momento, inténtelo más tarde.',
  },
};
