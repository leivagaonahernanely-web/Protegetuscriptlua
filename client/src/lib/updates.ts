export function buildUpdatesPayload(title: string, content: string) {
  return { title: title.trim(), description: content.trim() };
}

export function hasUpdatesContent(title: string, content: string) {
  const payload = buildUpdatesPayload(title, content);
  return Boolean(payload.title && payload.description);
}

export function submitUpdatesForm(title: string, content: string, mutate: (payload: ReturnType<typeof buildUpdatesPayload>) => void) {
  if (!hasUpdatesContent(title, content)) return false;
  mutate(buildUpdatesPayload(title, content));
  return true;
}
