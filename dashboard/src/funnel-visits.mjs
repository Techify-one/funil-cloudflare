// O cookie identifica o visitante entre recargas. Registros antigos sem cookie
// usam IP + navegador; sem nenhuma identidade, cada registro continua separado.
export function pageViewCountExpression(uniqueVisits) {
  if (!uniqueVisits) return 'COUNT(*)';
  return `COUNT(DISTINCT COALESCE(
    'session:' || NULLIF(LOWER(TRIM(session_uuid)), ''),
    CASE WHEN NULLIF(TRIM(ip), '') IS NOT NULL
      THEN 'legacy:' || TRIM(ip) || '|ua:' || COALESCE(TRIM(user_agent), '') END,
    'row:' || id
  ))`;
}
