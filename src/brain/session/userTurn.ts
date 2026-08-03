/** A meta user message remains `role: 'user'` so provider cache markers still apply, but it never opens a
 * user turn. Keeping this distinction here prevents context consumers from each inventing their own rule. */
export function isMetaUserMessage(message: { role?: unknown; isMeta?: unknown } | undefined): boolean {
  return message?.role === 'user' && message.isMeta === true;
}

export function isUserTurn(message: { role?: unknown; isMeta?: unknown } | undefined): boolean {
  return message?.role === 'user' && !isMetaUserMessage(message);
}
