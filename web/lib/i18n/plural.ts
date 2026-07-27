/** The three grammatical number forms a counted noun needs in Czech and Slovak: 1, 2–4, and 5+ (which
 *  0 also takes). Locales with a single plural — English — repeat it in `few` and `many`, so one rule
 *  serves every dictionary and no caller has to know which language it is rendering. */
interface PluralForms { one: string; few: string; many: string }

/** Pick the form matching `count`. */
export function plural(forms: PluralForms, count: number): string {
  if (count === 1) return forms.one;
  return count >= 2 && count <= 4 ? forms.few : forms.many;
}
