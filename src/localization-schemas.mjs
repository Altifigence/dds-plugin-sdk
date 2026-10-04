import {LOCALIZATION_LIMITS} from './localization.mjs';
const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const locale = {type: 'string', minLength: 2, maxLength: 64, $comment: 'Runtime requires a canonical BCP 47 base tag supported by Intl.getCanonicalLocales; extensions/private-use are rejected.'};
const key = {type: 'string', minLength: 1, maxLength: 128, pattern: '^(?!constructor$|prototype$|__proto__$)[A-Za-z][A-Za-z0-9_.-]{0,127}$'};
export const LOCALIZATION_SCHEMAS = Object.freeze({
  'locale-catalog': {...object({schemaVersion: {const: 1}, defaultLocale: locale,
    messages: {type: 'object', minProperties: 1, maxProperties: LOCALIZATION_LIMITS.locales, propertyNames: locale, additionalProperties: {type: 'object', maxProperties: LOCALIZATION_LIMITS.keys, propertyNames: key, additionalProperties: {type: 'string', maxLength: LOCALIZATION_LIMITS.messageCharacters}}},
    fallbacks: {type: 'object', maxProperties: LOCALIZATION_LIMITS.locales, propertyNames: locale, additionalProperties: {type: 'array', maxItems: LOCALIZATION_LIMITS.locales, uniqueItems: true, items: locale}},
  }, ['schemaVersion', 'defaultLocale', 'messages']), 'x-maxUtf8Bytes': LOCALIZATION_LIMITS.catalogBytes,
  $comment: 'Runtime requires a nonempty default catalog and matching placeholder sets for every translation. Other locales may omit keys; unknown keys, noncanonical locales, undefined fallback targets, cycles and fallback edges from the default locale are rejected. Display cross-checks validate locale keys independently. Values are literal text; no HTML, ICU expression or remote loading.'},
  'localized-message': object({key, text: {type: 'string', maxLength: LOCALIZATION_LIMITS.formattedCharacters}, locale, requestedLocale: locale, fallback: {type: 'boolean'}, direction: {enum: ['ltr', 'rtl']}}),
});
