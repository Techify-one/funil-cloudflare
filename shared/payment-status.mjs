export function initialStoredCardStatus(status) {
  const normalized = String(status || '').trim();
  if (normalized === 'approved') return 'pending';
  return normalized || 'pending';
}
